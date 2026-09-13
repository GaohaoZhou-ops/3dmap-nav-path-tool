const DEFAULT_CELL_SIZE = 0.12;
const MAX_RAW_POINTS = 700_000;
const MAX_MESH_FACES = 180_000;
const MAX_MESH_SAMPLES = 360_000;
const MESH_SAMPLE_SPACING = 0.075;

let indexedPositions = new Float32Array(0);
let gridNext = new Int32Array(0);
let gridHead = new Map();
let cellSize = DEFAULT_CELL_SIZE;
let sourcePointCount = 0;
let meshSampleCount = 0;

const greatestCommonDivisor = (left, right) => {
  let a = Math.max(1, Math.floor(Math.abs(left)));
  let b = Math.max(1, Math.floor(Math.abs(right)));
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const uniformStep = (count) => {
  if (count <= 1) return 1;
  let step = Math.max(1, Math.floor(count * 0.61803398875));
  while (greatestCommonDivisor(step, count) !== 1) step += 1;
  return step;
};

const hashCell = (x, y, z) => (
  ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
);

const pointAt = (positions, index) => {
  const offset = index * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
};

const appendMeshSamples = (target, positions, indices) => {
  const faceCount = Math.floor((indices?.length || 0) / 3);
  if (!faceCount) return 0;
  const selectedFaceCount = Math.min(faceCount, MAX_MESH_FACES);
  const faceStep = uniformStep(faceCount);
  let faceIndex = 0;
  let added = 0;
  for (let selected = 0; selected < selectedFaceCount && added < MAX_MESH_SAMPLES; selected += 1) {
    const offset = faceIndex * 3;
    const ia = Number(indices[offset]);
    const ib = Number(indices[offset + 1]);
    const ic = Number(indices[offset + 2]);
    if (
      Number.isInteger(ia) && Number.isInteger(ib) && Number.isInteger(ic)
      && ia >= 0 && ib >= 0 && ic >= 0
      && ia * 3 + 2 < positions.length
      && ib * 3 + 2 < positions.length
      && ic * 3 + 2 < positions.length
    ) {
      const a = pointAt(positions, ia);
      const b = pointAt(positions, ib);
      const c = pointAt(positions, ic);
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const ac = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      const divisions = Math.max(
        2,
        Math.min(5, Math.ceil(Math.max(ab, ac, bc) / MESH_SAMPLE_SPACING)),
      );
      for (let row = 1; row < divisions && added < MAX_MESH_SAMPLES; row += 1) {
        for (let column = 1; column < divisions - row && added < MAX_MESH_SAMPLES; column += 1) {
          const u = row / divisions;
          const v = column / divisions;
          const w = 1 - u - v;
          target.push(
            a[0] * w + b[0] * u + c[0] * v,
            a[1] * w + b[1] * u + c[1] * v,
            a[2] * w + b[2] * u + c[2] * v,
          );
          added += 1;
        }
      }
      if (added < MAX_MESH_SAMPLES) {
        target.push(
          (a[0] + b[0] + c[0]) / 3,
          (a[1] + b[1] + c[1]) / 3,
          (a[2] + b[2] + c[2]) / 3,
        );
        added += 1;
      }
    }
    faceIndex += faceStep;
    if (faceIndex >= faceCount) faceIndex -= faceCount;
  }
  return added;
};

const initializeIndex = ({ positions, indices, requestedCellSize }) => {
  const startedAt = performance.now();
  const sourcePositions = positions instanceof Float32Array
    ? positions
    : new Float32Array(positions || 0);
  const sourceIndices = indices instanceof Uint32Array
    ? indices
    : new Uint32Array(indices || 0);
  sourcePointCount = Math.floor(sourcePositions.length / 3);
  cellSize = Math.max(0.04, Math.min(0.25, Number(requestedCellSize) || DEFAULT_CELL_SIZE));

  const selectedPointCount = Math.min(sourcePointCount, MAX_RAW_POINTS);
  const step = uniformStep(sourcePointCount);
  const packed = [];
  let sourceIndex = 0;
  for (let targetIndex = 0; targetIndex < selectedPointCount; targetIndex += 1) {
    const offset = sourceIndex * 3;
    const x = sourcePositions[offset];
    const y = sourcePositions[offset + 1];
    const z = sourcePositions[offset + 2];
    if (Number.isFinite(x + y + z)) packed.push(x, y, z);
    sourceIndex += step;
    if (sourceIndex >= sourcePointCount) sourceIndex -= sourcePointCount;
  }
  meshSampleCount = appendMeshSamples(packed, sourcePositions, sourceIndices);
  indexedPositions = Float32Array.from(packed);
  const indexedPointCount = indexedPositions.length / 3;
  gridNext = new Int32Array(indexedPointCount);
  gridNext.fill(-1);
  gridHead = new Map();
  for (let index = 0; index < indexedPointCount; index += 1) {
    const offset = index * 3;
    const cellX = Math.floor(indexedPositions[offset] / cellSize);
    const cellY = Math.floor(indexedPositions[offset + 1] / cellSize);
    const cellZ = Math.floor(indexedPositions[offset + 2] / cellSize);
    const hash = hashCell(cellX, cellY, cellZ);
    gridNext[index] = gridHead.get(hash) ?? -1;
    gridHead.set(hash, index);
  }

  self.postMessage({
    type: 'ready',
    sourcePointCount,
    indexedPointCount,
    meshSampleCount,
    cellSize,
    bucketCount: gridHead.size,
    buildMs: performance.now() - startedAt,
  });
};

const pointToObbDistance = (x, y, z, proxy) => {
  const dx = x - proxy.center[0];
  const dy = y - proxy.center[1];
  const dz = z - proxy.center[2];
  const axes = proxy.axes;
  const outsideX = Math.max(
    Math.abs(dx * axes[0] + dy * axes[1] + dz * axes[2]) - proxy.halfSize[0],
    0,
  );
  const outsideY = Math.max(
    Math.abs(dx * axes[3] + dy * axes[4] + dz * axes[5]) - proxy.halfSize[1],
    0,
  );
  const outsideZ = Math.max(
    Math.abs(dx * axes[6] + dy * axes[7] + dz * axes[8]) - proxy.halfSize[2],
    0,
  );
  return Math.hypot(outsideX, outsideY, outsideZ);
};

const nearestDistanceForProxy = (proxy, threshold) => {
  const minCellX = Math.floor((proxy.aabbMin[0] - threshold) / cellSize);
  const minCellY = Math.floor((proxy.aabbMin[1] - threshold) / cellSize);
  const minCellZ = Math.floor((proxy.aabbMin[2] - threshold) / cellSize);
  const maxCellX = Math.floor((proxy.aabbMax[0] + threshold) / cellSize);
  const maxCellY = Math.floor((proxy.aabbMax[1] + threshold) / cellSize);
  const maxCellZ = Math.floor((proxy.aabbMax[2] + threshold) / cellSize);
  const visitedHashes = new Set();
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const hash = hashCell(cellX, cellY, cellZ);
        if (visitedHashes.has(hash)) continue;
        visitedHashes.add(hash);
        let pointIndex = gridHead.get(hash) ?? -1;
        while (pointIndex >= 0) {
          const offset = pointIndex * 3;
          const x = indexedPositions[offset];
          const y = indexedPositions[offset + 1];
          const z = indexedPositions[offset + 2];
          if (
            x >= proxy.aabbMin[0] - threshold && x <= proxy.aabbMax[0] + threshold
            && y >= proxy.aabbMin[1] - threshold && y <= proxy.aabbMax[1] + threshold
            && z >= proxy.aabbMin[2] - threshold && z <= proxy.aabbMax[2] + threshold
          ) {
            minimumDistance = Math.min(
              minimumDistance,
              pointToObbDistance(x, y, z, proxy),
            );
            if (minimumDistance <= 0) return 0;
          }
          pointIndex = gridNext[pointIndex];
        }
      }
    }
  }
  return minimumDistance;
};

const checkCollision = ({ proxies, threshold, contactMargin, revision }) => {
  const startedAt = performance.now();
  const safeThreshold = Math.max(0.01, Number(threshold) || 0.1);
  const safeContactMargin = Math.max(0, Number(contactMargin) || 0);
  const linkDistances = new Map();
  (proxies || []).forEach((proxy) => {
    if (
      !proxy?.linkName
      || !proxy.center?.every(Number.isFinite)
      || !proxy.axes?.every(Number.isFinite)
      || !proxy.halfSize?.every(Number.isFinite)
    ) return;
    const distance = nearestDistanceForProxy(proxy, safeThreshold);
    const previous = linkDistances.get(proxy.linkName) ?? Number.POSITIVE_INFINITY;
    if (distance < previous) linkDistances.set(proxy.linkName, distance);
  });

  const collisionLinks = [];
  const nearLinks = [];
  let minimumDistance = Number.POSITIVE_INFINITY;
  linkDistances.forEach((distance, linkName) => {
    minimumDistance = Math.min(minimumDistance, distance);
    if (distance <= safeContactMargin) collisionLinks.push(linkName);
    else if (distance < safeThreshold) nearLinks.push(linkName);
  });
  collisionLinks.sort();
  nearLinks.sort();
  self.postMessage({
    type: 'result',
    revision,
    collisionLinks,
    nearLinks,
    minimumDistance: Number.isFinite(minimumDistance) ? minimumDistance : null,
    checkedProxyCount: proxies?.length || 0,
    checkMs: performance.now() - startedAt,
  });
};

self.onmessage = (event) => {
  try {
    if (event.data?.type === 'init') initializeIndex(event.data);
    if (event.data?.type === 'check') checkCollision(event.data);
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error?.message || '干涉检测 Worker 执行失败',
    });
  }
};

