import { createHash } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const HEADER_LIMIT = 1024 * 1024;
const POINTS_PER_CHUNK = 262_144;
const PROPERTY_TYPES = new Map([
  ['char', { bytes: 1 }],
  ['int8', { bytes: 1 }],
  ['uchar', { bytes: 1 }],
  ['uint8', { bytes: 1 }],
  ['short', { bytes: 2 }],
  ['int16', { bytes: 2 }],
  ['ushort', { bytes: 2 }],
  ['uint16', { bytes: 2 }],
  ['int', { bytes: 4 }],
  ['int32', { bytes: 4 }],
  ['uint', { bytes: 4 }],
  ['uint32', { bytes: 4 }],
  ['float', { bytes: 4, read: 'readFloatLE', write: 'writeFloatLE' }],
  ['float32', { bytes: 4, read: 'readFloatLE', write: 'writeFloatLE' }],
  ['double', { bytes: 8, read: 'readDoubleLE', write: 'writeDoubleLE' }],
  ['float64', { bytes: 8, read: 'readDoubleLE', write: 'writeDoubleLE' }],
]);

const [sourceArgument, shiftArgument] = process.argv.slice(2);

function parseHeader(buffer) {
  const headerSource = buffer.toString('ascii');
  const match = /end_header\r?\n/.exec(headerSource);
  if (!match) throw new Error(`PLY 文件头超过 ${HEADER_LIMIT} bytes 或缺少 end_header`);
  const headerLength = match.index + match[0].length;
  const header = headerSource.slice(0, headerLength);
  if (!/^ply\r?\n/.test(header) || !/^format binary_little_endian 1\.0$/m.test(header)) {
    throw new Error('仅支持 binary_little_endian 1.0 PLY');
  }
  if (/^comment AtlasRoute ground alignment:/m.test(header)) {
    throw new Error('该 PLY 已包含 AtlasRoute 地面对齐记录，拒绝重复平移');
  }

  const lines = header.split(/\r?\n/);
  let inVertexElement = false;
  let vertexCount = 0;
  let stride = 0;
  let zOffset = null;
  let zType = null;
  for (const line of lines) {
    const elementMatch = /^element\s+(\S+)\s+(\d+)$/.exec(line);
    if (elementMatch) {
      inVertexElement = elementMatch[1] === 'vertex';
      if (inVertexElement) vertexCount = Number(elementMatch[2]);
      continue;
    }
    if (!inVertexElement || !line.startsWith('property ')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts[1] === 'list') throw new Error('vertex 元素不支持列表属性');
    const type = PROPERTY_TYPES.get(parts[1]);
    if (!type) throw new Error(`不支持的 PLY 属性类型：${parts[1]}`);
    if (parts[2] === 'z') {
      zOffset = stride;
      zType = type;
    }
    stride += type.bytes;
  }
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0 || !stride || zOffset === null) {
    throw new Error('PLY 顶点数量、步长或 Z 属性无效');
  }
  if (!zType.read || !zType.write) throw new Error('PLY 的 Z 属性必须是 float 或 double');
  return { header, headerLength, vertexCount, stride, zOffset, zType };
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error('写入临时 PLY 时没有取得进展');
    written += result.bytesWritten;
  }
}

async function main() {
  const sourcePath = path.resolve(sourceArgument || '');
  const shift = Number(shiftArgument);
  if (!sourceArgument || !Number.isFinite(shift) || Math.abs(shift) > 10_000) {
    throw new Error('用法：node scripts/align_ply_z.mjs <map.ply> <z-shift-meters>');
  }

  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) throw new Error('目标 PLY 不是普通文件');
  const temporaryPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}.atlas-z-align-${process.pid}.tmp`,
  );
  const input = await open(sourcePath, 'r');
  let output;
  try {
    const headerProbe = Buffer.alloc(Math.min(HEADER_LIMIT, sourceStats.size));
    const probeResult = await input.read(headerProbe, 0, headerProbe.length, 0);
    const layout = parseHeader(headerProbe.subarray(0, probeResult.bytesRead));
    const vertexBytes = layout.vertexCount * layout.stride;
    if (layout.headerLength + vertexBytes > sourceStats.size) {
      throw new Error('PLY 顶点数据长度超过文件实际大小');
    }

    const lineEnding = layout.header.includes('\r\n') ? '\r\n' : '\n';
    const marker = `comment AtlasRoute ground alignment: z += ${shift.toFixed(8)} m; local ground at x=0,y=0 is z=0${lineEnding}`;
    const endHeaderIndex = layout.header.lastIndexOf('end_header');
    const nextHeader = Buffer.from(
      `${layout.header.slice(0, endHeaderIndex)}${marker}${layout.header.slice(endHeaderIndex)}`,
      'ascii',
    );

    output = await open(temporaryPath, 'wx', sourceStats.mode);
    const originalHash = createHash('sha256');
    const alignedHash = createHash('sha256');
    const originalHeader = Buffer.from(layout.header, 'ascii');
    originalHash.update(originalHeader);
    alignedHash.update(nextHeader);
    await writeAll(output, nextHeader, 0);

    const chunkPointCount = Math.max(1, Math.floor(POINTS_PER_CHUNK));
    let inputOffset = layout.headerLength;
    let outputOffset = nextHeader.length;
    let remainingPoints = layout.vertexCount;
    let sourceMinZ = Number.POSITIVE_INFINITY;
    let sourceMaxZ = Number.NEGATIVE_INFINITY;
    let alignedMinZ = Number.POSITIVE_INFINITY;
    let alignedMaxZ = Number.NEGATIVE_INFINITY;

    while (remainingPoints > 0) {
      const points = Math.min(remainingPoints, chunkPointCount);
      const chunk = Buffer.allocUnsafe(points * layout.stride);
      const result = await input.read(chunk, 0, chunk.length, inputOffset);
      if (result.bytesRead !== chunk.length) throw new Error('PLY 顶点数据读取不完整');
      originalHash.update(chunk);
      for (let index = 0; index < points; index += 1) {
        const offset = index * layout.stride + layout.zOffset;
        const originalZ = chunk[layout.zType.read](offset);
        if (!Number.isFinite(originalZ)) continue;
        const alignedZ = originalZ + shift;
        chunk[layout.zType.write](alignedZ, offset);
        sourceMinZ = Math.min(sourceMinZ, originalZ);
        sourceMaxZ = Math.max(sourceMaxZ, originalZ);
        alignedMinZ = Math.min(alignedMinZ, alignedZ);
        alignedMaxZ = Math.max(alignedMaxZ, alignedZ);
      }
      alignedHash.update(chunk);
      await writeAll(output, chunk, outputOffset);
      inputOffset += chunk.length;
      outputOffset += chunk.length;
      remainingPoints -= points;
    }

    while (inputOffset < sourceStats.size) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, sourceStats.size - inputOffset));
      const result = await input.read(chunk, 0, chunk.length, inputOffset);
      if (!result.bytesRead) throw new Error('PLY 尾部数据读取不完整');
      const bytes = chunk.subarray(0, result.bytesRead);
      originalHash.update(bytes);
      alignedHash.update(bytes);
      await writeAll(output, bytes, outputOffset);
      inputOffset += bytes.length;
      outputOffset += bytes.length;
    }

    await output.sync();
    await output.close();
    output = null;
    await rename(temporaryPath, sourcePath);

    process.stdout.write(`${JSON.stringify({
      file: sourcePath,
      vertexCount: layout.vertexCount,
      stride: layout.stride,
      shift,
      sourceBoundsZ: [sourceMinZ, sourceMaxZ],
      alignedBoundsZ: [alignedMinZ, alignedMaxZ],
      sourceBytes: sourceStats.size,
      alignedBytes: outputOffset,
      sourceSha256: originalHash.digest('hex'),
      alignedSha256: alignedHash.digest('hex'),
    }, null, 2)}\n`);
  } catch (error) {
    await output?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await input.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
