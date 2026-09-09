import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const INPUT_MAGIC = Buffer.from('ATLSPC01');
const OUTPUT_MAGIC = Buffer.from('ATLSRF01');
const INPUT_HEADER_SIZE = 20;
const SURFACE_FORMAT_VERSION = 1;
const TARGET_CELL_COUNT = 180_000;
const MAX_CELL_COUNT = 324_000;
const MAX_FILLED_CELL_COUNT = 225_000;
const RECORD_SIZE = 9;

const [inputPath, outputPath, metadataPath, sourceHash = ''] = process.argv.slice(2);

const report = (progress, phase, detail = '') => {
  process.stdout.write(`${JSON.stringify({ progress, phase, detail })}\n`);
};

const fail = (message) => {
  throw new Error(message);
};

function readInput(payload) {
  if (payload.length < INPUT_HEADER_SIZE || !payload.subarray(0, 8).equals(INPUT_MAGIC)) {
    fail('结构面输入格式无效');
  }
  const version = payload.readUInt32LE(8);
  const pointCount = payload.readUInt32LE(12);
  const flags = payload.readUInt32LE(16);
  const hasColors = Boolean(flags & 1);
  if (version !== 1 || !pointCount) fail('结构面输入版本或点数无效');
  const positionByteLength = pointCount * 3 * 4;
  const colorByteLength = hasColors ? pointCount * 3 : 0;
  const expectedSize = INPUT_HEADER_SIZE + positionByteLength + colorByteLength;
  if (payload.length !== expectedSize) {
    fail(`结构面输入长度不匹配：${payload.length} / ${expectedSize}`);
  }
  return {
    payload,
    pointCount,
    hasColors,
    positionOffset: INPUT_HEADER_SIZE,
    colorOffset: INPUT_HEADER_SIZE + positionByteLength,
  };
}

function measureBounds(input) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let validPointCount = 0;
  for (let index = 0; index < input.pointCount; index += 1) {
    const offset = input.positionOffset + index * 12;
    const x = input.payload.readFloatLE(offset);
    const y = input.payload.readFloatLE(offset + 4);
    const z = input.payload.readFloatLE(offset + 8);
    if (![x, y, z].every(Number.isFinite)) continue;
    validPointCount += 1;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  if (!validPointCount) fail('点云中没有可用于建面的有限坐标');
  return { min, max, validPointCount };
}

function buildCells(input, bounds, voxelSize) {
  const dimensions = bounds.max.map((value, axis) =>
    Math.max(1, Math.ceil((value - bounds.min[axis]) / voxelSize) + 1));
  if (Math.max(...dimensions) > 65_534) fail('自适应体素尺寸超出结构面索引范围');

  const [sizeX, sizeY, sizeZ] = dimensions;
  const xyStride = sizeX * sizeY;
  const cellLookup = new Map();
  const keys = new Float64Array(MAX_CELL_COUNT);
  const cellX = new Uint16Array(MAX_CELL_COUNT);
  const cellY = new Uint16Array(MAX_CELL_COUNT);
  const cellZ = new Uint16Array(MAX_CELL_COUNT);
  const colorR = new Float64Array(MAX_CELL_COUNT);
  const colorG = new Float64Array(MAX_CELL_COUNT);
  const colorB = new Float64Array(MAX_CELL_COUNT);
  const samples = new Uint32Array(MAX_CELL_COUNT);
  let cellCount = 0;

  for (let pointIndex = 0; pointIndex < input.pointCount; pointIndex += 1) {
    const positionOffset = input.positionOffset + pointIndex * 12;
    const x = input.payload.readFloatLE(positionOffset);
    const y = input.payload.readFloatLE(positionOffset + 4);
    const z = input.payload.readFloatLE(positionOffset + 8);
    if (![x, y, z].every(Number.isFinite)) continue;
    const ix = Math.min(sizeX - 1, Math.max(0, Math.floor((x - bounds.min[0]) / voxelSize)));
    const iy = Math.min(sizeY - 1, Math.max(0, Math.floor((y - bounds.min[1]) / voxelSize)));
    const iz = Math.min(sizeZ - 1, Math.max(0, Math.floor((z - bounds.min[2]) / voxelSize)));
    const key = ix + iy * sizeX + iz * xyStride;
    let cellIndex = cellLookup.get(key);
    if (cellIndex === undefined) {
      if (cellCount >= MAX_CELL_COUNT) {
        return { overflow: true, cellCount, dimensions };
      }
      cellIndex = cellCount;
      cellCount += 1;
      cellLookup.set(key, cellIndex);
      keys[cellIndex] = key;
      cellX[cellIndex] = ix;
      cellY[cellIndex] = iy;
      cellZ[cellIndex] = iz;
    }
    if (input.hasColors) {
      const colorOffset = input.colorOffset + pointIndex * 3;
      colorR[cellIndex] += input.payload[colorOffset];
      colorG[cellIndex] += input.payload[colorOffset + 1];
      colorB[cellIndex] += input.payload[colorOffset + 2];
    }
    samples[cellIndex] += 1;
  }

  return {
    overflow: false,
    cellCount,
    dimensions,
    cellLookup,
    keys,
    cellX,
    cellY,
    cellZ,
    colorR,
    colorG,
    colorB,
    samples,
  };
}

function bridgeSingleCellGaps(cells) {
  const initialCellCount = cells.cellCount;
  const [sizeX, sizeY, sizeZ] = cells.dimensions;
  const xyStride = sizeX * sizeY;
  const directions = [
    { delta: 1, canBridge: (x) => x + 2 < sizeX },
    { delta: sizeX, canBridge: (_x, y) => y + 2 < sizeY },
    { delta: xyStride, canBridge: (_x, _y, z) => z + 2 < sizeZ },
  ];

  for (let index = 0; index < initialCellCount; index += 1) {
    const ix = cells.cellX[index];
    const iy = cells.cellY[index];
    const iz = cells.cellZ[index];
    const key = cells.keys[index];
    for (const direction of directions) {
      if (!direction.canBridge(ix, iy, iz)) continue;
      const farIndex = cells.cellLookup.get(key + direction.delta * 2);
      const middleKey = key + direction.delta;
      if (farIndex === undefined || cells.cellLookup.has(middleKey)) continue;
      if (cells.cellCount >= MAX_FILLED_CELL_COUNT) return cells.cellCount - initialCellCount;

      const nextIndex = cells.cellCount;
      cells.cellCount += 1;
      cells.cellLookup.set(middleKey, nextIndex);
      cells.keys[nextIndex] = middleKey;
      cells.cellX[nextIndex] = ix + Number(direction.delta === 1);
      cells.cellY[nextIndex] = iy + Number(direction.delta === sizeX);
      cells.cellZ[nextIndex] = iz + Number(direction.delta === xyStride);
      const leftSamples = Math.max(1, cells.samples[index]);
      const rightSamples = Math.max(1, cells.samples[farIndex]);
      cells.colorR[nextIndex] = (
        cells.colorR[index] / leftSamples + cells.colorR[farIndex] / rightSamples
      ) / 2;
      cells.colorG[nextIndex] = (
        cells.colorG[index] / leftSamples + cells.colorG[farIndex] / rightSamples
      ) / 2;
      cells.colorB[nextIndex] = (
        cells.colorB[index] / leftSamples + cells.colorB[farIndex] / rightSamples
      ) / 2;
      cells.samples[nextIndex] = 1;
    }
  }
  return cells.cellCount - initialCellCount;
}

function encodeSurface(input, bounds, cells, voxelSize, buildDurationMs) {
  const order = Array.from({ length: cells.cellCount }, (_, index) => index);
  order.sort((left, right) => cells.keys[left] - cells.keys[right]);
  const filledCellCount = cells.cellCount - cells.inputCellCount;
  const metadata = {
    format: 'atlas-voxel-surface',
    formatVersion: SURFACE_FORMAT_VERSION,
    algorithm: 'adaptive-voxel-surface-fusion-v1',
    sourceHash,
    sourcePointCount: input.pointCount,
    validPointCount: bounds.validPointCount,
    cellCount: cells.cellCount,
    sourceCellCount: cells.inputCellCount,
    filledCellCount,
    triangleCount: cells.cellCount * 12,
    voxelSize,
    overlapScale: 1.08,
    gridOrigin: bounds.min,
    gridDimensions: cells.dimensions,
    sourceBounds: { min: bounds.min, max: bounds.max },
    buildDurationMs,
    createdAt: new Date().toISOString(),
  };
  const metadataBuffer = Buffer.from(JSON.stringify(metadata));
  const output = Buffer.allocUnsafe(16 + metadataBuffer.length + cells.cellCount * RECORD_SIZE);
  OUTPUT_MAGIC.copy(output, 0);
  output.writeUInt32LE(SURFACE_FORMAT_VERSION, 8);
  output.writeUInt32LE(metadataBuffer.length, 12);
  metadataBuffer.copy(output, 16);
  let offset = 16 + metadataBuffer.length;
  for (const index of order) {
    output.writeUInt16LE(cells.cellX[index], offset);
    output.writeUInt16LE(cells.cellY[index], offset + 2);
    output.writeUInt16LE(cells.cellZ[index], offset + 4);
    const sampleCount = Math.max(1, cells.samples[index]);
    output[offset + 6] = input.hasColors
      ? Math.max(0, Math.min(255, Math.round(cells.colorR[index] / sampleCount)))
      : 159;
    output[offset + 7] = input.hasColors
      ? Math.max(0, Math.min(255, Math.round(cells.colorG[index] / sampleCount)))
      : 199;
    output[offset + 8] = input.hasColors
      ? Math.max(0, Math.min(255, Math.round(cells.colorB[index] / sampleCount)))
      : 202;
    offset += RECORD_SIZE;
  }
  return { output, metadata };
}

async function main() {
  if (!inputPath || !outputPath || !metadataPath || !/^[a-f0-9]{64}$/.test(sourceHash)) {
    fail('结构面缓存任务参数无效');
  }
  const startedAt = Date.now();
  report(0.06, '读取点云快照');
  const payload = await readFile(inputPath);
  const input = readInput(payload);
  report(0.14, '测量空间边界', `${input.pointCount.toLocaleString('zh-CN')} 点`);
  const bounds = measureBounds(input);
  const span = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const diagonal = Math.max(Math.hypot(...span), 1e-6);
  const divisions = Math.min(
    2048,
    Math.max(48, Math.round(Math.sqrt(bounds.validPointCount) * 1.25)),
  );
  let voxelSize = diagonal / divisions;
  let cells;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    report(
      0.22 + attempt * 0.08,
      '融合扫描体素',
      `网格 ${voxelSize.toFixed(4)} m`,
    );
    cells = buildCells(input, bounds, voxelSize);
    if (cells.overflow) {
      voxelSize *= 1.42;
      continue;
    }
    if (cells.cellCount > TARGET_CELL_COUNT) {
      voxelSize *= Math.max(1.08, Math.sqrt(cells.cellCount / TARGET_CELL_COUNT) * 1.035);
      continue;
    }
    break;
  }
  if (!cells || cells.overflow || cells.cellCount > MAX_CELL_COUNT) {
    fail('点云结构过于复杂，无法在安全的网格预算内完成建面');
  }
  cells.inputCellCount = cells.cellCount;
  report(0.76, '闭合微小扫描间隙', `${cells.cellCount.toLocaleString('zh-CN')} 体素`);
  const filled = bridgeSingleCellGaps(cells);
  report(0.86, '压缩三角结构面', `补合 ${filled.toLocaleString('zh-CN')} 个间隙`);
  const { output, metadata } = encodeSurface(
    input,
    bounds,
    cells,
    voxelSize,
    Date.now() - startedAt,
  );
  const compressed = gzipSync(output, { level: 9 });
  metadata.uncompressedBytes = output.length;
  metadata.compressedBytes = compressed.length;
  metadata.compression = 'gzip';
  await writeFile(outputPath, compressed);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  report(1, '结构面缓存完成', `${cells.cellCount.toLocaleString('zh-CN')} 单元`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
