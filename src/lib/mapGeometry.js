const MAP_TOPOLOGY_VERSION = 2;

export const MESH_RENDER_QUALITY_OPTIONS = Object.freeze([
  {
    id: 'auto',
    label: '自动',
    shortLabel: 'AUTO',
    triangleBudget: null,
    rgbPointBudget: 140_000,
    description: '大于 150 万面时自动切换为均衡档',
  },
  {
    id: 'performance',
    label: '流畅',
    shortLabel: 'FAST',
    triangleBudget: 180_000,
    rgbPointBudget: 80_000,
    description: '最多渲染 18 万个三角面',
  },
  {
    id: 'balanced',
    label: '均衡',
    shortLabel: 'BAL',
    triangleBudget: 650_000,
    rgbPointBudget: 180_000,
    description: '最多渲染 65 万个三角面',
  },
  {
    id: 'detail',
    label: '精细',
    shortLabel: 'FINE',
    triangleBudget: 2_000_000,
    rgbPointBudget: 300_000,
    description: '最多渲染 200 万个三角面',
  },
  {
    id: 'full',
    label: '全量',
    shortLabel: 'FULL',
    triangleBudget: Number.POSITIVE_INFINITY,
    rgbPointBudget: 360_000,
    description: '显示文件中的全部三角面，超大地图可能卡顿',
  },
]);

const MESH_RENDER_QUALITY_BY_ID = new Map(
  MESH_RENDER_QUALITY_OPTIONS.map((option) => [option.id, option]),
);

export const normalizeMeshRenderQuality = (value) => (
  MESH_RENDER_QUALITY_BY_ID.has(value) ? value : 'auto'
);

export const resolveMeshRenderQuality = (value, rawFaceCount) => {
  const requestedId = normalizeMeshRenderQuality(value);
  const faceCount = Math.max(0, Math.floor(Number(rawFaceCount) || 0));
  const requested = MESH_RENDER_QUALITY_BY_ID.get(requestedId);
  const automaticFull = requestedId === 'auto' && faceCount <= 1_500_000;
  const effectiveId = requestedId === 'auto'
    ? automaticFull ? 'full' : 'balanced'
    : requestedId;
  const effective = MESH_RENDER_QUALITY_BY_ID.get(effectiveId);
  const triangleBudget = requestedId === 'auto' && !automaticFull
    ? MESH_RENDER_QUALITY_BY_ID.get('balanced').triangleBudget
    : effective.triangleBudget;
  const renderedFaceCount = Math.min(
    faceCount,
    Number.isFinite(triangleBudget) ? triangleBudget : faceCount,
  );
  return {
    requestedId,
    requestedLabel: requested.label,
    effectiveId,
    effectiveLabel: effective.label,
    faceCount,
    triangleBudget,
    renderedFaceCount,
    rgbPointBudget: requestedId === 'auto'
      ? requested.rgbPointBudget
      : effective.rgbPointBudget,
    isFull: renderedFaceCount >= faceCount,
  };
};

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

const uniformTraversalStep = (pointCount) => {
  if (pointCount <= 1) return 1;
  let step = Math.max(1, Math.floor(pointCount * 0.61803398875));
  while (greatestCommonDivisor(step, pointCount) !== 1) step += 1;
  return step;
};

export const createUniformMeshIndex = (indexAttribute, rawTargetFaceCount) => {
  const source = indexAttribute?.array || indexAttribute;
  const sourceIndexCount = indexAttribute?.count ?? source?.length ?? 0;
  const faceCount = Math.floor(sourceIndexCount / 3);
  const targetFaceCount = Math.min(
    faceCount,
    Math.max(0, Math.floor(Number(rawTargetFaceCount) || 0)),
  );
  if (!source || !faceCount || !targetFaceCount) return new Uint32Array(0);
  if (targetFaceCount >= faceCount) return source;

  const IndexArray = source instanceof Uint16Array ? Uint16Array : Uint32Array;
  const sampled = new IndexArray(targetFaceCount * 3);
  const step = uniformTraversalStep(faceCount);
  let sourceFace = 0;
  for (let targetFace = 0; targetFace < targetFaceCount; targetFace += 1) {
    const sourceOffset = sourceFace * 3;
    const targetOffset = targetFace * 3;
    sampled[targetOffset] = source[sourceOffset];
    sampled[targetOffset + 1] = source[sourceOffset + 1];
    sampled[targetOffset + 2] = source[sourceOffset + 2];
    sourceFace += step;
    if (sourceFace >= faceCount) sourceFace -= faceCount;
  }
  return sampled;
};

export const createUniformPointOrder = (pointCount) => {
  const count = Math.max(0, Math.floor(Number(pointCount) || 0));
  const order = new Uint32Array(count);
  if (!count) return order;

  const step = uniformTraversalStep(count);
  let sourceIndex = 0;
  for (let index = 0; index < count; index += 1) {
    order[index] = sourceIndex;
    sourceIndex += step;
    if (sourceIndex >= count) sourceIndex -= count;
  }
  return order;
};

const createUnreferencedPointOrder = (referenced, unreferencedPointCount) => {
  const pointCount = referenced.length;
  const order = new Uint32Array(unreferencedPointCount);
  if (!unreferencedPointCount) return order;

  const step = uniformTraversalStep(pointCount);
  let sourceIndex = 0;
  let writeIndex = 0;
  for (let visited = 0; visited < pointCount; visited += 1) {
    if (!referenced[sourceIndex]) {
      order[writeIndex] = sourceIndex;
      writeIndex += 1;
    }
    sourceIndex += step;
    if (sourceIndex >= pointCount) sourceIndex -= pointCount;
  }
  return order;
};

const pointOnlyTopology = (pointCount, invalidIndexCount = 0) => ({
  version: MAP_TOPOLOGY_VERSION,
  hasMesh: false,
  faceCount: 0,
  meshIndexCount: 0,
  referencedPointCount: 0,
  unreferencedPointCount: pointCount,
  invalidIndexCount,
  meshBounds: null,
  renderStrategy: 'points-only',
});

export function prepareMapGeometryTopology(geometry) {
  const positionCount = geometry?.getAttribute?.('position')?.count || 0;
  const indexAttribute = geometry?.getIndex?.() || null;
  const indexCount = indexAttribute?.count || 0;
  const cached = geometry?.userData?.mapTopology;
  const cachedPointOrder = geometry?.userData?.pointRenderOrder;
  if (
    cached?.version === MAP_TOPOLOGY_VERSION
    && cached.positionCount === positionCount
    && cached.sourceIndexCount === indexCount
    && cachedPointOrder instanceof Uint32Array
  ) {
    return cached;
  }

  if (!geometry?.userData || !positionCount || indexCount < 3) {
    const topology = {
      ...pointOnlyTopology(positionCount),
      positionCount,
      sourceIndexCount: indexCount,
    };
    if (geometry?.userData) {
      geometry.userData.mapTopology = topology;
      geometry.userData.pointRenderOrder = createUniformPointOrder(positionCount);
    }
    return topology;
  }

  const meshIndexCount = Math.floor(indexCount / 3) * 3;
  const sourceIndices = indexAttribute.array;
  const positionAttribute = geometry.getAttribute('position');
  const positionArray = positionAttribute?.array;
  const directPositionRead = Boolean(
    positionArray
    && !positionAttribute.isInterleavedBufferAttribute
    && positionAttribute.itemSize >= 3,
  );
  const positionStride = positionAttribute?.itemSize || 3;
  const referenced = new Uint8Array(positionCount);
  let referencedPointCount = 0;
  let invalidIndexCount = 0;
  let meshMinX = Number.POSITIVE_INFINITY;
  let meshMinY = Number.POSITIVE_INFINITY;
  let meshMinZ = Number.POSITIVE_INFINITY;
  let meshMaxX = Number.NEGATIVE_INFINITY;
  let meshMaxY = Number.NEGATIVE_INFINITY;
  let meshMaxZ = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < meshIndexCount; offset += 1) {
    const vertexIndex = Number(sourceIndices[offset]);
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= positionCount) {
      invalidIndexCount += 1;
      continue;
    }
    if (!referenced[vertexIndex]) {
      referenced[vertexIndex] = 1;
      referencedPointCount += 1;
      const positionOffset = vertexIndex * positionStride;
      const x = directPositionRead
        ? positionArray[positionOffset]
        : positionAttribute.getX(vertexIndex);
      const y = directPositionRead
        ? positionArray[positionOffset + 1]
        : positionAttribute.getY(vertexIndex);
      const z = directPositionRead
        ? positionArray[positionOffset + 2]
        : positionAttribute.getZ(vertexIndex);
      if (Number.isFinite(x + y + z)) {
        meshMinX = Math.min(meshMinX, x);
        meshMinY = Math.min(meshMinY, y);
        meshMinZ = Math.min(meshMinZ, z);
        meshMaxX = Math.max(meshMaxX, x);
        meshMaxY = Math.max(meshMaxY, y);
        meshMaxZ = Math.max(meshMaxZ, z);
      }
    }
  }

  if (invalidIndexCount || !referencedPointCount) {
    const topology = {
      ...pointOnlyTopology(positionCount, invalidIndexCount),
      positionCount,
      sourceIndexCount: indexCount,
    };
    geometry.userData.mapTopology = topology;
    geometry.userData.pointRenderOrder = createUniformPointOrder(positionCount);
    return topology;
  }

  const unreferencedPointCount = positionCount - referencedPointCount;
  const meshBounds = Number.isFinite(meshMinX + meshMinY + meshMinZ + meshMaxX + meshMaxY + meshMaxZ)
    ? {
        min: { x: meshMinX, y: meshMinY, z: meshMinZ },
        max: { x: meshMaxX, y: meshMaxY, z: meshMaxZ },
      }
    : null;
  const topology = {
    version: MAP_TOPOLOGY_VERSION,
    hasMesh: true,
    positionCount,
    sourceIndexCount: indexCount,
    faceCount: meshIndexCount / 3,
    meshIndexCount,
    referencedPointCount,
    unreferencedPointCount,
    invalidIndexCount: 0,
    meshBounds,
    renderStrategy: unreferencedPointCount
      ? 'indexed-mesh+unreferenced-points'
      : 'indexed-mesh-only',
  };
  geometry.userData.mapTopology = topology;
  geometry.userData.pointRenderOrder = createUnreferencedPointOrder(
    referenced,
    unreferencedPointCount,
  );
  return topology;
}
