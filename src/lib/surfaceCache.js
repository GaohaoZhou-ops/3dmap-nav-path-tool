const INPUT_MAGIC = 'ATLSPC01';
const OUTPUT_MAGIC = 'ATLSRF01';
const INPUT_HEADER_SIZE = 20;
const SURFACE_RECORD_SIZE = 9;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const exactBytes = (array) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

const responseJson = async (response, fallback) => {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(payload?.error || `${fallback}（${response.status}）`);
  return payload;
};

const abortableDelay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('操作已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('操作已取消', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function sha256ArrayBuffer(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256 地图指纹');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveSourceHash(mapData) {
  if (HASH_PATTERN.test(mapData?.sourceHash || '')) {
    return { sourceHash: mapData.sourceHash, sourceHashKind: mapData.sourceHashKind || 'file' };
  }
  const positions = mapData?.geometry?.getAttribute('position')?.array;
  if (!positions?.byteLength) throw new Error('缺少可用于建面的地图坐标');
  const buffer = exactBytes(positions).slice().buffer;
  return {
    sourceHash: await sha256ArrayBuffer(buffer),
    sourceHashKind: 'geometry-fallback',
  };
}

function packColors(attribute) {
  if (!attribute?.array?.length || attribute.itemSize < 3) return null;
  const source = attribute.array;
  if (source instanceof Uint8Array && attribute.itemSize === 3) {
    return exactBytes(source);
  }
  const packed = new Uint8Array(attribute.count * 3);
  let scale = source.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  if (source.BYTES_PER_ELEMENT !== 1) {
    const sampleLength = Math.min(source.length, 4096);
    for (let index = 0; index < sampleLength; index += 1) {
      if (Math.abs(source[index]) > 1.5) {
        scale = 1;
        break;
      }
    }
  }
  for (let point = 0; point < attribute.count; point += 1) {
    const sourceOffset = point * attribute.itemSize;
    const targetOffset = point * 3;
    packed[targetOffset] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset] * scale)),
    );
    packed[targetOffset + 1] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 1] * scale)),
    );
    packed[targetOffset + 2] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 2] * scale)),
    );
  }
  return packed;
}

function createBuildPayload(mapData) {
  const geometry = mapData?.geometry;
  const positionAttribute = geometry?.getAttribute('position');
  const sourcePositions = positionAttribute?.array;
  if (!sourcePositions?.length || positionAttribute.itemSize !== 3) {
    throw new Error('点云坐标无法提交给本地建面服务');
  }
  const positions = sourcePositions instanceof Float32Array
    ? exactBytes(sourcePositions)
    : exactBytes(Float32Array.from(sourcePositions));
  const colors = packColors(geometry.getAttribute('color'));
  const header = new ArrayBuffer(INPUT_HEADER_SIZE);
  const headerBytes = new Uint8Array(header);
  headerBytes.set(new TextEncoder().encode(INPUT_MAGIC), 0);
  const headerView = new DataView(header);
  headerView.setUint32(8, 1, true);
  headerView.setUint32(12, positionAttribute.count, true);
  headerView.setUint32(16, colors ? 1 : 0, true);
  return new Blob(
    colors ? [header, positions, colors] : [header, positions],
    { type: 'application/vnd.atlas.point-buffer' },
  );
}

function parseSurface(buffer, expectedHash) {
  if (buffer.byteLength < 16) throw new Error('结构面缓存文件过短');
  const view = new DataView(buffer);
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  const version = view.getUint32(8, true);
  const metadataLength = view.getUint32(12, true);
  if (magic !== OUTPUT_MAGIC || version !== 1 || metadataLength > buffer.byteLength - 16) {
    throw new Error('结构面缓存格式或版本无效');
  }
  let metadata;
  try {
    metadata = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 16, metadataLength)),
    );
  } catch {
    throw new Error('结构面缓存元数据损坏');
  }
  if (metadata.sourceHash !== expectedHash || !Number.isInteger(metadata.cellCount)) {
    throw new Error('结构面缓存与当前地图不匹配');
  }
  const expectedSize = 16 + metadataLength + metadata.cellCount * SURFACE_RECORD_SIZE;
  if (buffer.byteLength !== expectedSize) throw new Error('结构面缓存单元数据不完整');
  const centers = new Float32Array(metadata.cellCount * 3);
  const colors = new Uint8Array(metadata.cellCount * 3);
  const origin = metadata.gridOrigin;
  const voxelSize = Number(metadata.voxelSize);
  let offset = 16 + metadataLength;
  for (let index = 0; index < metadata.cellCount; index += 1) {
    const target = index * 3;
    centers[target] = origin[0] + (view.getUint16(offset, true) + 0.5) * voxelSize;
    centers[target + 1] = origin[1] + (view.getUint16(offset + 2, true) + 0.5) * voxelSize;
    centers[target + 2] = origin[2] + (view.getUint16(offset + 4, true) + 0.5) * voxelSize;
    colors[target] = view.getUint8(offset + 6);
    colors[target + 1] = view.getUint8(offset + 7);
    colors[target + 2] = view.getUint8(offset + 8);
    offset += SURFACE_RECORD_SIZE;
  }
  return { metadata, centers, colors };
}

async function readStatus(sourceHash, signal) {
  const response = await fetch(`/__atlas/surfaces/${sourceHash}/status`, {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  return responseJson(response, '无法读取结构面缓存状态');
}

export async function loadOrBuildSurface(mapData, options = {}) {
  const { signal, onProgress } = options;
  onProgress?.({ status: 'hashing', progress: 0.02, phase: '核对地图 SHA-256' });
  const identity = await resolveSourceHash(mapData);
  const { sourceHash } = identity;
  let status = await readStatus(sourceHash, signal);
  const wasCached = status.status === 'ready';

  if (status.status === 'missing' || status.status === 'error') {
    onProgress?.({
      status: 'uploading',
      progress: 0.05,
      phase: '提交点云快照',
      detail: '仅用于本次建面，生成后立即删除',
      sourceHash,
      ...identity,
    });
    const payload = createBuildPayload(mapData);
    const response = await fetch(`/__atlas/surfaces/${sourceHash}/build`, {
      method: 'POST',
      signal,
      body: payload,
      headers: { 'Content-Type': payload.type, Accept: 'application/json' },
    });
    status = await responseJson(response, '无法启动本地结构面生成');
  }

  while (status.status === 'building') {
    onProgress?.({ ...status, status: 'building', sourceHash, ...identity });
    await abortableDelay(420, signal);
    status = await readStatus(sourceHash, signal);
  }
  if (status.status !== 'ready') {
    throw new Error(status.error || '本地结构面没有生成有效结果');
  }

  onProgress?.({
    ...status,
    status: 'loading',
    progress: 0.94,
    phase: status.cacheHit || wasCached ? '读取哈希缓存' : '装载新结构面',
    sourceHash,
    ...identity,
  });
  const meshResponse = await fetch(status.meshUrl, {
    signal,
    cache: 'force-cache',
    headers: { Accept: 'application/vnd.atlas.surface' },
  });
  if (!meshResponse.ok) throw new Error(`结构面缓存读取失败（${meshResponse.status}）`);
  const surface = parseSurface(await meshResponse.arrayBuffer(), sourceHash);
  return {
    ...surface,
    sourceHash,
    sourceHashKind: identity.sourceHashKind,
    cacheHit: Boolean(status.cacheHit || wasCached),
  };
}
