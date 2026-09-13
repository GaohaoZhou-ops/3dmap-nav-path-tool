const MAP_TOPOLOGY_VERSION = 1;

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
  const referenced = new Uint8Array(positionCount);
  let referencedPointCount = 0;
  let invalidIndexCount = 0;
  for (let offset = 0; offset < meshIndexCount; offset += 1) {
    const vertexIndex = Number(sourceIndices[offset]);
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= positionCount) {
      invalidIndexCount += 1;
      continue;
    }
    if (!referenced[vertexIndex]) {
      referenced[vertexIndex] = 1;
      referencedPointCount += 1;
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

