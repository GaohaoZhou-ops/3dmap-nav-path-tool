import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import {
  Box,
  Camera,
  Cloud,
  Focus,
  Gauge,
  Maximize2,
  Minus,
  Move3D,
  Plus,
  Rotate3D,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import CameraTeachingControls from './CameraTeachingControls.jsx';
import {
  createUniformMeshIndex,
  MESH_RENDER_QUALITY_OPTIONS,
  prepareMapGeometryTopology,
  resolveMeshRenderQuality,
} from '../lib/mapGeometry.js';

export const ZIVID_M70_PROFILE = Object.freeze({
  model: 'Zivid 2 M70',
  nativeWidth: 1944,
  nativeHeight: 1200,
  near: 0.3,
  focus: 0.7,
  far: 1.3,
  horizontalFov: 56.6,
  verticalFov: 35.6,
  focusWidthMm: 754,
  focusHeightMm: 449,
});

const CAMERA_POINT_BUDGET = 360_000;
const MAX_DIGITAL_ZOOM = 24;
const TEACHING_CAPTURE_WIDTH = 640;
const TEACHING_CAPTURE_HEIGHT = Math.round(
  TEACHING_CAPTURE_WIDTH * (ZIVID_M70_PROFILE.nativeHeight / ZIVID_M70_PROFILE.nativeWidth),
);
const TEACHING_CAPTURE_POINT_BUDGET = 16_000;
const CAMERA_MESH_REGION_POSITION_STEP = 0.3;
const CAMERA_MESH_REGION_QUATERNION_STEP = 0.1;
const CAMERA_NEIGHBORHOOD_POSITION_STEP = 0.5;
const CAMERA_POINT_NEIGHBORHOOD_RADIUS = 2.15;
const CAMERA_FACE_NEIGHBORHOOD_RADIUS = 2.65;
const CAMERA_NEIGHBORHOOD_CACHE_LIMIT = 4;
const CAMERA_SURFACE_FOV_MARGIN = 0.08;
const ZIVID_SPACEMOUSE_COMMAND_INTERVAL_MS = 85;
const ZIVID_SPACEMOUSE_INPUT_STALE_MS = 180;
const ZIVID_SPACEMOUSE_LINEAR_SPEED = 0.2;
const ZIVID_SPACEMOUSE_ANGULAR_SPEED = 48;
const ZIVID_SPACEMOUSE_HUD_HOLD_MS = 1000;
const MAIN_VIEW_PREVIEW_FPS = 12;
const MAIN_VIEW_PREVIEW_FRAME_INTERVAL_MS = 1000 / MAIN_VIEW_PREVIEW_FPS;
const MAIN_VIEW_PREVIEW_MAX_ZOOM = 8;
const MAIN_VIEW_PREVIEW_CONTROL_EVENT = 'atlas-main-view-preview-control';
const ZIVID_SPACEMOUSE_AXES = Object.freeze(['x', 'y', 'z', 'roll', 'pitch', 'yaw']);
const ZIVID_SPACEMOUSE_ACTIONS = Object.freeze({
  x: {
    code: 'X', group: 'XYZ', positive: ['near', '前进 · 靠近'], negative: ['far', '后退 · 远离'],
  },
  y: {
    code: 'Y', group: 'XYZ', positive: ['left', '向左'], negative: ['right', '向右'],
  },
  z: {
    code: 'Z', group: 'XYZ', positive: ['up', '向上'], negative: ['down', '向下'],
  },
  roll: {
    code: 'ROLL', group: 'RPY', positive: ['roll-left', '左翻滚'], negative: ['roll-right', '右翻滚'],
  },
  pitch: {
    code: 'PITCH', group: 'RPY', positive: ['pitch-down', '前倾'], negative: ['pitch-up', '后仰'],
  },
  yaw: {
    code: 'YAW', group: 'RPY', positive: ['yaw-left', '左偏航'], negative: ['yaw-right', '右偏航'],
  },
});
const CAMERA_SURFACE_GRID_BY_QUALITY = Object.freeze({
  performance: { columns: 38, rows: 24 },
  balanced: { columns: 54, rows: 34 },
  detail: { columns: 72, rows: 45 },
  full: { columns: 92, rows: 57 },
});
const ROS_OPTICAL_TO_THREE_CAMERA = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI,
);

const isM70Robot = (robot, loadState) => {
  if (loadState?.status !== 'loaded' || Number(loadState?.zividCount) < 1) return false;
  const identity = [
    robot?.id,
    robot?.name,
    robot?.fileName,
    robot?.relativePath,
    loadState?.name,
  ].filter(Boolean).join(' ');
  return /(?:zivid[\s_-]*)?(?:2[\s_-]*)?m70/i.test(identity);
};

const compactNumber = (value) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value || 0);
};

const normalizedInversePose = (pose) => {
  if (!pose?.position || !pose?.quaternion) return null;
  const px = Number(pose.position.x || 0);
  const py = Number(pose.position.y || 0);
  const pz = Number(pose.position.z || 0);
  const rawX = Number(pose.quaternion.x || 0);
  const rawY = Number(pose.quaternion.y || 0);
  const rawZ = Number(pose.quaternion.z || 0);
  const rawW = Number(pose.quaternion.w ?? 1);
  const length = Math.hypot(rawX, rawY, rawZ, rawW);
  if (!Number.isFinite(px + py + pz + length) || length < 1e-8) return null;
  return {
    px,
    py,
    pz,
    qx: -rawX / length,
    qy: -rawY / length,
    qz: -rawZ / length,
    qw: rawW / length,
  };
};

const cameraMeshRegionKeyForPose = (pose) => {
  const inverse = normalizedInversePose(pose);
  if (!inverse) return 'waiting-for-optical-frame';
  const quaternionSign = inverse.qw < 0 ? -1 : 1;
  const quantize = (value, step) => Math.round(value / step);
  return [
    quantize(inverse.px, CAMERA_MESH_REGION_POSITION_STEP),
    quantize(inverse.py, CAMERA_MESH_REGION_POSITION_STEP),
    quantize(inverse.pz, CAMERA_MESH_REGION_POSITION_STEP),
    quantize(-inverse.qx * quaternionSign, CAMERA_MESH_REGION_QUATERNION_STEP),
    quantize(-inverse.qy * quaternionSign, CAMERA_MESH_REGION_QUATERNION_STEP),
    quantize(-inverse.qz * quaternionSign, CAMERA_MESH_REGION_QUATERNION_STEP),
    quantize(inverse.qw * quaternionSign, CAMERA_MESH_REGION_QUATERNION_STEP),
  ].join(':');
};

const cameraNeighborhoodCell = (inversePose) => {
  const quantize = (value) => Math.round(value / CAMERA_NEIGHBORHOOD_POSITION_STEP);
  const ix = quantize(inversePose.px);
  const iy = quantize(inversePose.py);
  const iz = quantize(inversePose.pz);
  return {
    key: `${ix}:${iy}:${iz}`,
    x: ix * CAMERA_NEIGHBORHOOD_POSITION_STEP,
    y: iy * CAMERA_NEIGHBORHOOD_POSITION_STEP,
    z: iz * CAMERA_NEIGHBORHOOD_POSITION_STEP,
  };
};

const touchCacheEntry = (entries, key, value, limit = CAMERA_NEIGHBORHOOD_CACHE_LIMIT) => {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > limit) {
    entries.delete(entries.keys().next().value);
  }
  return value;
};

const directPositionReader = (positionAttribute) => {
  const array = positionAttribute?.array;
  const direct = Boolean(
    array
    && !positionAttribute.isInterleavedBufferAttribute
    && positionAttribute.itemSize >= 3,
  );
  const stride = positionAttribute?.itemSize || 3;
  return (index) => {
    if (!direct) {
      return [
        positionAttribute.getX(index),
        positionAttribute.getY(index),
        positionAttribute.getZ(index),
      ];
    }
    const offset = index * stride;
    return [array[offset], array[offset + 1], array[offset + 2]];
  };
};

const cameraPointNeighborhood = (sourceGeometry, sourceOrder, inversePose) => {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  if (!sourcePosition?.count || !inversePose) return new Uint32Array(0);
  const order = sourceOrder instanceof Uint32Array ? sourceOrder : null;
  const availableCount = order?.length || sourcePosition.count;
  const cell = cameraNeighborhoodCell(inversePose);
  const cacheKey = `${cell.key}:${availableCount}:${order ? 'subset' : 'all'}`;
  let cache = sourceGeometry.userData.zividPointNeighborhoodCache;
  if (
    cache?.version !== 1
    || cache.positionAttribute !== sourcePosition
    || cache.sourceOrder !== order
  ) {
    cache = {
      version: 1,
      positionAttribute: sourcePosition,
      sourceOrder: order,
      entries: new Map(),
    };
    sourceGeometry.userData.zividPointNeighborhoodCache = cache;
  }
  const cached = cache.entries.get(cacheKey);
  if (cached) return touchCacheEntry(cache.entries, cacheKey, cached);

  const positionArray = sourcePosition.array;
  const directPositionRead = Boolean(
    positionArray
    && !sourcePosition.isInterleavedBufferAttribute
    && sourcePosition.itemSize >= 3,
  );
  const positionStride = sourcePosition.itemSize || 3;
  const radiusSquared = CAMERA_POINT_NEIGHBORHOOD_RADIUS ** 2;
  const selected = [];
  for (let orderIndex = 0; orderIndex < availableCount; orderIndex += 1) {
    const sourceIndex = order ? order[orderIndex] : orderIndex;
    const positionOffset = sourceIndex * positionStride;
    const x = directPositionRead
      ? positionArray[positionOffset]
      : sourcePosition.getX(sourceIndex);
    const dx = x - cell.x;
    if (Math.abs(dx) > CAMERA_POINT_NEIGHBORHOOD_RADIUS) continue;
    const y = directPositionRead
      ? positionArray[positionOffset + 1]
      : sourcePosition.getY(sourceIndex);
    const dy = y - cell.y;
    if (Math.abs(dy) > CAMERA_POINT_NEIGHBORHOOD_RADIUS) continue;
    const z = directPositionRead
      ? positionArray[positionOffset + 2]
      : sourcePosition.getZ(sourceIndex);
    const dz = z - cell.z;
    if (Math.abs(dz) > CAMERA_POINT_NEIGHBORHOOD_RADIUS) continue;
    if ((dx * dx) + (dy * dy) + (dz * dz) <= radiusSquared) selected.push(sourceIndex);
  }
  return touchCacheEntry(cache.entries, cacheKey, Uint32Array.from(selected));
};

const cameraNeighborhoodIntersectsMesh = (meshBounds, inversePose) => {
  if (!meshBounds?.min || !meshBounds?.max || !inversePose) return true;
  const distanceToInterval = (value, minimum, maximum) => (
    value < minimum ? minimum - value : value > maximum ? value - maximum : 0
  );
  const dx = distanceToInterval(inversePose.px, meshBounds.min.x, meshBounds.max.x);
  const dy = distanceToInterval(inversePose.py, meshBounds.min.y, meshBounds.max.y);
  const dz = distanceToInterval(inversePose.pz, meshBounds.min.z, meshBounds.max.z);
  return ((dx * dx) + (dy * dy) + (dz * dz)) <= CAMERA_FACE_NEIGHBORHOOD_RADIUS ** 2;
};

const rotateIntoCamera = (x, y, z, inversePose) => {
  const vx = x - inversePose.px;
  const vy = y - inversePose.py;
  const vz = z - inversePose.pz;
  const tx = 2 * (inversePose.qy * vz - inversePose.qz * vy);
  const ty = 2 * (inversePose.qz * vx - inversePose.qx * vz);
  const tz = 2 * (inversePose.qx * vy - inversePose.qy * vx);
  return {
    x: vx + inversePose.qw * tx + (inversePose.qy * tz - inversePose.qz * ty),
    y: vy + inversePose.qw * ty + (inversePose.qz * tx - inversePose.qx * tz),
    z: vz + inversePose.qw * tz + (inversePose.qx * ty - inversePose.qy * tx),
  };
};

const circumcircleContains = (a, b, c, point) => {
  const denominator = 2 * (
    a.x * (b.y - c.y)
    + b.x * (c.y - a.y)
    + c.x * (a.y - b.y)
  );
  if (Math.abs(denominator) < 1e-10) return false;
  const aLength = (a.x * a.x) + (a.y * a.y);
  const bLength = (b.x * b.x) + (b.y * b.y);
  const cLength = (c.x * c.x) + (c.y * c.y);
  const centerX = (
    aLength * (b.y - c.y)
    + bLength * (c.y - a.y)
    + cLength * (a.y - b.y)
  ) / denominator;
  const centerY = (
    aLength * (c.x - b.x)
    + bLength * (a.x - c.x)
    + cLength * (b.x - a.x)
  ) / denominator;
  const radiusSquared = ((centerX - a.x) ** 2) + ((centerY - a.y) ** 2);
  const pointDistanceSquared = ((centerX - point.x) ** 2) + ((centerY - point.y) ** 2);
  return pointDistanceSquared <= radiusSquared + 1e-8;
};

const triangulateProjectedSurface = (surfacePoints) => {
  if (surfacePoints.length < 3) return [];
  const points = [
    ...surfacePoints,
    { x: -20, y: -20 },
    { x: 20, y: -20 },
    { x: 0, y: 20 },
  ];
  const sourceCount = surfacePoints.length;
  let triangles = [[sourceCount, sourceCount + 1, sourceCount + 2]];

  for (let pointIndex = 0; pointIndex < sourceCount; pointIndex += 1) {
    const point = points[pointIndex];
    const retained = [];
    const boundary = new Map();
    for (const triangle of triangles) {
      if (!circumcircleContains(
        points[triangle[0]],
        points[triangle[1]],
        points[triangle[2]],
        point,
      )) {
        retained.push(triangle);
        continue;
      }
      for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
        const left = triangle[edgeIndex];
        const right = triangle[(edgeIndex + 1) % 3];
        const key = left < right ? `${left}:${right}` : `${right}:${left}`;
        const edge = boundary.get(key);
        if (edge) edge.count += 1;
        else boundary.set(key, { left, right, count: 1 });
      }
    }
    triangles = retained;
    boundary.forEach((edge) => {
      if (edge.count === 1) triangles.push([edge.left, edge.right, pointIndex]);
    });
  }
  return triangles.filter((triangle) => triangle.every((index) => index < sourceCount));
};

const createCameraSurfaceGeometry = (sourceGeometry, qualityPlan, pose) => {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  const inversePose = normalizedInversePose(pose);
  if (!sourcePosition?.count || !inversePose) return null;
  const sourceColor = sourceGeometry.getAttribute('color');
  const hasRgb = sourceColor?.count === sourcePosition.count;
  const sourceOrder = sourceGeometry.userData.pointRenderOrder;
  const neighborhood = cameraPointNeighborhood(
    sourceGeometry,
    sourceOrder instanceof Uint32Array ? sourceOrder : null,
    inversePose,
  );
  const effectiveQuality = qualityPlan.faceCount > 0
    ? qualityPlan.effectiveId || 'balanced'
    : 'balanced';
  const gridPlan = CAMERA_SURFACE_GRID_BY_QUALITY[effectiveQuality]
    || CAMERA_SURFACE_GRID_BY_QUALITY.balanced;
  const gridCellCount = gridPlan.columns * gridPlan.rows;
  const selectedIndices = new Int32Array(gridCellCount);
  selectedIndices.fill(-1);
  const selectedDepths = new Float32Array(gridCellCount);
  selectedDepths.fill(Number.POSITIVE_INFINITY);
  const projectedX = new Float32Array(gridCellCount);
  const projectedY = new Float32Array(gridCellCount);
  const tangentX = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.verticalFov / 2));
  const projectionLimit = 1 + CAMERA_SURFACE_FOV_MARGIN;
  const readPosition = directPositionReader(sourcePosition);
  let candidatePointCount = 0;
  let strictVisiblePointCount = 0;

  for (let neighborhoodIndex = 0; neighborhoodIndex < neighborhood.length; neighborhoodIndex += 1) {
    const sourceIndex = neighborhood[neighborhoodIndex];
    const [x, y, z] = readPosition(sourceIndex);
    const local = rotateIntoCamera(x, y, z, inversePose);
    if (local.z < ZIVID_M70_PROFILE.near || local.z > ZIVID_M70_PROFILE.far) continue;
    const normalizedX = local.x / Math.max(local.z * tangentX, 1e-6);
    const normalizedY = local.y / Math.max(local.z * tangentY, 1e-6);
    if (Math.abs(normalizedX) > projectionLimit || Math.abs(normalizedY) > projectionLimit) continue;
    candidatePointCount += 1;
    if (Math.abs(normalizedX) <= 1 && Math.abs(normalizedY) <= 1) strictVisiblePointCount += 1;
    const column = THREE.MathUtils.clamp(
      Math.floor(((normalizedX + projectionLimit) / (projectionLimit * 2)) * gridPlan.columns),
      0,
      gridPlan.columns - 1,
    );
    const row = THREE.MathUtils.clamp(
      Math.floor(((normalizedY + projectionLimit) / (projectionLimit * 2)) * gridPlan.rows),
      0,
      gridPlan.rows - 1,
    );
    const cellIndex = row * gridPlan.columns + column;
    if (local.z >= selectedDepths[cellIndex]) continue;
    selectedDepths[cellIndex] = local.z;
    selectedIndices[cellIndex] = sourceIndex;
    projectedX[cellIndex] = normalizedX;
    projectedY[cellIndex] = normalizedY;
  }

  const surfacePoints = [];
  for (let cellIndex = 0; cellIndex < gridCellCount; cellIndex += 1) {
    const sourceIndex = selectedIndices[cellIndex];
    if (sourceIndex < 0) continue;
    const [x, y, z] = readPosition(sourceIndex);
    surfacePoints.push({
      x: projectedX[cellIndex],
      y: projectedY[cellIndex],
      depth: selectedDepths[cellIndex],
      sourceIndex,
      worldX: x,
      worldY: y,
      worldZ: z,
    });
  }

  const pointPositions = new Float32Array(surfacePoints.length * 3);
  const pointColors = hasRgb ? new Uint8Array(surfacePoints.length * 3) : null;
  const encodeColor = (value) => {
    const numeric = Number(value) || 0;
    return Math.round(THREE.MathUtils.clamp(numeric > 1 ? numeric : numeric * 255, 0, 255));
  };
  surfacePoints.forEach((point, index) => {
    const offset = index * 3;
    pointPositions[offset] = point.worldX;
    pointPositions[offset + 1] = point.worldY;
    pointPositions[offset + 2] = point.worldZ;
    if (pointColors) {
      pointColors[offset] = encodeColor(sourceColor.getX(point.sourceIndex));
      pointColors[offset + 1] = encodeColor(sourceColor.getY(point.sourceIndex));
      pointColors[offset + 2] = encodeColor(sourceColor.getZ(point.sourceIndex));
    }
  });
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
  if (pointColors) pointGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3, true));
  pointGeometry.userData.bufferStrategy = 'camera-local-depth-binned-surfels';

  const candidateTriangles = triangulateProjectedSurface(surfacePoints);
  const nominalAngularSpacing = Math.sqrt(
    (4 * tangentX * tangentY) / Math.max(surfacePoints.length, 1),
  );
  const maximumAngularEdge = THREE.MathUtils.clamp(
    nominalAngularSpacing * 5.5,
    0.04,
    0.28,
  );
  const acceptedTriangles = candidateTriangles.filter((triangle) => {
    const vertices = triangle.map((index) => surfacePoints[index]);
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const left = vertices[edgeIndex];
      const right = vertices[(edgeIndex + 1) % 3];
      const angularEdge = Math.hypot(
        (left.x - right.x) * tangentX,
        (left.y - right.y) * tangentY,
      );
      if (angularEdge > maximumAngularEdge) return false;
      const minimumDepth = Math.min(left.depth, right.depth);
      if (Math.abs(left.depth - right.depth) > Math.max(0.06, minimumDepth * 0.18)) return false;
      const worldEdge = Math.hypot(
        left.worldX - right.worldX,
        left.worldY - right.worldY,
        left.worldZ - right.worldZ,
      );
      if (worldEdge > Math.max(0.14, minimumDepth * 0.45)) return false;
    }
    return true;
  });

  let meshGeometry = null;
  let meshBufferByteLength = 0;
  if (acceptedTriangles.length) {
    const meshPositions = new Float32Array(acceptedTriangles.length * 9);
    const meshColors = hasRgb ? new Uint8Array(acceptedTriangles.length * 9) : null;
    acceptedTriangles.forEach((triangle, triangleIndex) => {
      triangle.forEach((pointIndex, cornerIndex) => {
        const point = surfacePoints[pointIndex];
        const offset = (triangleIndex * 3 + cornerIndex) * 3;
        meshPositions[offset] = point.worldX;
        meshPositions[offset + 1] = point.worldY;
        meshPositions[offset + 2] = point.worldZ;
        if (meshColors) {
          meshColors[offset] = encodeColor(sourceColor.getX(point.sourceIndex));
          meshColors[offset + 1] = encodeColor(sourceColor.getY(point.sourceIndex));
          meshColors[offset + 2] = encodeColor(sourceColor.getZ(point.sourceIndex));
        }
      });
    });
    meshGeometry = new THREE.BufferGeometry();
    meshGeometry.setAttribute('position', new THREE.BufferAttribute(meshPositions, 3));
    if (meshColors) meshGeometry.setAttribute('color', new THREE.BufferAttribute(meshColors, 3, true));
    meshGeometry.computeVertexNormals();
    meshGeometry.userData.bufferStrategy = 'camera-local-depth-triangulation';
    meshBufferByteLength = meshPositions.byteLength + (meshColors?.byteLength || 0);
  }

  return {
    pointGeometry,
    meshGeometry,
    hasRgb,
    neighborhoodPointCount: neighborhood.length,
    candidatePointCount,
    strictVisiblePointCount,
    renderPointCount: surfacePoints.length,
    renderTriangleCount: acceptedTriangles.length,
    bufferByteLength: pointPositions.byteLength
      + (pointColors?.byteLength || 0)
      + meshBufferByteLength,
    selectionMode: 'camera-local-depth-surface',
  };
};

const createCameraGeometry = (
  sourceGeometry,
  {
    pointBudget = CAMERA_POINT_BUDGET,
    sourceOrder = null,
    bufferStrategy = 'dedicated-downsample',
  } = {},
) => {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  if (!sourcePosition?.count) return null;
  const pointCount = sourcePosition.count;
  const availablePointCount = sourceOrder instanceof Uint32Array
    ? sourceOrder.length
    : pointCount;
  const renderCount = Math.min(availablePointCount, Math.max(0, pointBudget));
  const sourceColor = sourceGeometry.getAttribute('color');
  const hasRgb = sourceColor?.count === pointCount;
  const positions = new Float32Array(renderCount * 3);
  const colors = hasRgb ? new Uint8Array(renderCount * 3) : null;
  const encodeColor = (value) => {
    const numeric = Number(value) || 0;
    return Math.round(THREE.MathUtils.clamp(numeric > 1 ? numeric : numeric * 255, 0, 255));
  };

  for (let index = 0; index < renderCount; index += 1) {
    const orderIndex = renderCount === availablePointCount
      ? index
      : Math.min(
          availablePointCount - 1,
          Math.floor(((index + 0.5) * availablePointCount) / renderCount),
        );
    const sourceIndex = sourceOrder instanceof Uint32Array
      ? sourceOrder[orderIndex]
      : orderIndex;
    const targetOffset = index * 3;
    positions[targetOffset] = sourcePosition.getX(sourceIndex);
    positions[targetOffset + 1] = sourcePosition.getY(sourceIndex);
    positions[targetOffset + 2] = sourcePosition.getZ(sourceIndex);
    if (colors) {
      colors[targetOffset] = encodeColor(sourceColor.getX(sourceIndex));
      colors[targetOffset + 1] = encodeColor(sourceColor.getY(sourceIndex));
      colors[targetOffset + 2] = encodeColor(sourceColor.getZ(sourceIndex));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geometry.boundingBox = sourceGeometry.boundingBox?.clone() || null;
  geometry.boundingSphere = sourceGeometry.boundingSphere?.clone() || null;
  geometry.userData.bufferStrategy = bufferStrategy;
  return {
    geometry,
    pointCount,
    availablePointCount,
    renderCount,
    hasRgb,
    bufferByteLength: positions.byteLength + (colors?.byteLength || 0),
  };
};

const createCameraMeshGeometry = (sourceGeometry, qualityPlan, pose) => {
  const topology = prepareMapGeometryTopology(sourceGeometry);
  const sourcePosition = sourceGeometry?.getAttribute('position');
  const sourceIndex = sourceGeometry?.getIndex();
  if (!topology.hasMesh || !sourcePosition?.count || !sourceIndex?.count) return null;

  const faceBudget = Math.min(topology.faceCount, qualityPlan.renderedFaceCount);
  if (!faceBudget) return null;
  const sourceColor = sourceGeometry.getAttribute('color');
  const hasRgb = sourceColor?.count === sourcePosition.count;
  const inversePose = normalizedInversePose(pose);
  const candidateFaceCount = topology.faceCount;
  const selectionMode = inversePose ? 'camera-global-mesh-lod' : 'uniform-global-fallback';

  if (
    inversePose
    && !cameraNeighborhoodIntersectsMesh(topology.meshBounds, inversePose)
  ) {
    return {
      geometry: null,
      sourceFaceCount: topology.faceCount,
      candidateFaceCount: 0,
      renderFaceCount: 0,
      selectionMode: 'camera-mesh-bounds-rejected',
      hasRgb,
      bufferByteLength: 0,
      sourceBufferReused: false,
    };
  }

  const sampledIndices = createUniformMeshIndex(sourceIndex, faceBudget);
  const renderFaceCount = Math.min(faceBudget, Math.floor((sampledIndices?.length || 0) / 3));
  if (!renderFaceCount) {
    return {
      geometry: null,
      sourceFaceCount: topology.faceCount,
      candidateFaceCount,
      renderFaceCount: 0,
      selectionMode,
      hasRgb,
      bufferByteLength: 0,
      sourceBufferReused: false,
    };
  }

  let lodCache = sourceGeometry.userData.zividCameraMeshLodCache;
  if (
    lodCache?.version !== 1
    || lodCache.positionAttribute !== sourcePosition
    || lodCache.indexAttribute !== sourceIndex
    || lodCache.colorAttribute !== sourceColor
  ) {
    lodCache = {
      version: 1,
      positionAttribute: sourcePosition,
      indexAttribute: sourceIndex,
      colorAttribute: sourceColor,
      entries: new Map(),
    };
    sourceGeometry.userData.zividCameraMeshLodCache = lodCache;
  }
  const lodCacheKey = `${renderFaceCount}:${hasRgb ? 'rgb' : 'mono'}`;
  let packedBuffers = lodCache.entries.get(lodCacheKey);
  const sourceBufferReused = Boolean(packedBuffers);
  if (packedBuffers) {
    packedBuffers = touchCacheEntry(lodCache.entries, lodCacheKey, packedBuffers, 2);
  }
  const positions = packedBuffers?.positions || new Float32Array(renderFaceCount * 9);
  const colors = packedBuffers?.colors || (hasRgb ? new Uint8Array(renderFaceCount * 9) : null);
  const encodeColor = (value) => {
    const numeric = Number(value) || 0;
    return Math.round(THREE.MathUtils.clamp(numeric > 1 ? numeric : numeric * 255, 0, 255));
  };
  if (!sourceBufferReused) {
    for (let outputFace = 0; outputFace < renderFaceCount; outputFace += 1) {
      const sourceFaceOffset = outputFace * 3;
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceVertex = sampledIndices[sourceFaceOffset + corner];
        const outputOffset = (outputFace * 3 + corner) * 3;
        positions[outputOffset] = sourcePosition.getX(sourceVertex);
        positions[outputOffset + 1] = sourcePosition.getY(sourceVertex);
        positions[outputOffset + 2] = sourcePosition.getZ(sourceVertex);
        if (colors) {
          colors[outputOffset] = encodeColor(sourceColor.getX(sourceVertex));
          colors[outputOffset + 1] = encodeColor(sourceColor.getY(sourceVertex));
          colors[outputOffset + 2] = encodeColor(sourceColor.getZ(sourceVertex));
        }
      }
    }
    touchCacheEntry(lodCache.entries, lodCacheKey, { positions, colors }, 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geometry.boundingBox = sourceGeometry.boundingBox?.clone() || null;
  geometry.boundingSphere = sourceGeometry.boundingSphere?.clone() || null;
  geometry.userData.bufferStrategy = 'dedicated-uniform-triangle-lod';
  return {
    geometry,
    sourceFaceCount: topology.faceCount,
    candidateFaceCount,
    renderFaceCount,
    selectionMode,
    hasRgb,
    bufferByteLength: positions.byteLength + (colors?.byteLength || 0),
    sourceBufferReused,
  };
};

const createDepthMaterial = () => new THREE.ShaderMaterial({
  uniforms: {
    uPointSize: { value: 2 },
    uNear: { value: ZIVID_M70_PROFILE.near },
    uFar: { value: ZIVID_M70_PROFILE.far },
  },
  vertexShader: `
    uniform float uPointSize;
    varying float vDepth;
    void main() {
      vec4 cameraPosition = modelViewMatrix * vec4(position, 1.0);
      vDepth = -cameraPosition.z;
      gl_Position = projectionMatrix * cameraPosition;
      gl_PointSize = uPointSize;
    }
  `,
  fragmentShader: `
    uniform float uNear;
    uniform float uFar;
    varying float vDepth;

    vec3 depthPalette(float t) {
      vec3 nearCoral = vec3(1.0, 0.31, 0.23);
      vec3 amber = vec3(1.0, 0.78, 0.24);
      vec3 cyan = vec3(0.16, 0.87, 0.90);
      vec3 farBlue = vec3(0.20, 0.39, 1.0);
      if (t < 0.34) return mix(nearCoral, amber, smoothstep(0.0, 0.34, t));
      if (t < 0.68) return mix(amber, cyan, smoothstep(0.34, 0.68, t));
      return mix(cyan, farBlue, smoothstep(0.68, 1.0, t));
    }

    void main() {
      if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
      float normalizedDepth = clamp((vDepth - uNear) / max(uFar - uNear, 0.0001), 0.0, 1.0);
      gl_FragColor = vec4(depthPalette(normalizedDepth), 1.0);
    }
  `,
  depthTest: true,
  depthWrite: true,
  transparent: false,
  toneMapped: false,
});

const byteArrayToBase64 = (value) => {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
};

const uint16LittleEndianBase64 = (values) => {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((value, index) => {
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = value >>> 8;
  });
  return byteArrayToBase64(bytes);
};

const dataUrlByteLength = (value) => {
  const encoded = String(value || '').split(',', 2)[1] || '';
  if (!encoded) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
};

const captureCanvasImage = (canvas) => {
  const preferred = canvas.toDataURL('image/webp', 0.84);
  const dataUrl = preferred.startsWith('data:image/webp')
    ? preferred
    : canvas.toDataURL('image/png');
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
  return {
    encoding: 'data-url',
    mimeType,
    width: canvas.width,
    height: canvas.height,
    byteLength: dataUrlByteLength(dataUrl),
    dataUrl,
  };
};

const normalizedCameraPoseSnapshot = (pose, side) => {
  if (!pose?.position || !pose?.quaternion) return null;
  const quaternionW = Number(pose.quaternion.w ?? 1);
  return {
    frameName: String(
      pose.frameName || `zivid_${side === 'right' ? 'right' : 'left'}_optical_frame`,
    ),
    position: {
      x: Number(pose.position.x) || 0,
      y: Number(pose.position.y) || 0,
      z: Number(pose.position.z) || 0,
    },
    quaternion: {
      x: Number(pose.quaternion.x) || 0,
      y: Number(pose.quaternion.y) || 0,
      z: Number(pose.quaternion.z) || 0,
      w: Number.isFinite(quaternionW) ? quaternionW : 1,
    },
  };
};

const captureVisiblePointCloud = (
  sourceGeometry,
  pose,
  pointBudget = TEACHING_CAPTURE_POINT_BUDGET,
) => {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  const inversePose = normalizedInversePose(pose);
  if (!sourcePosition?.count || !inversePose) {
    throw new Error('点云或相机光学位姿尚未准备完成');
  }
  const sourceColor = sourceGeometry.getAttribute('color');
  const hasRgb = sourceColor?.count === sourcePosition.count;
  const neighborhood = cameraPointNeighborhood(sourceGeometry, null, inversePose);
  const readPosition = directPositionReader(sourcePosition);
  const tangentX = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.verticalFov / 2));
  const visible = [];

  for (let index = 0; index < neighborhood.length; index += 1) {
    const sourceIndex = neighborhood[index];
    const [worldX, worldY, worldZ] = readPosition(sourceIndex);
    const local = rotateIntoCamera(worldX, worldY, worldZ, inversePose);
    if (
      local.z < ZIVID_M70_PROFILE.near
      || local.z > ZIVID_M70_PROFILE.far
      || Math.abs(local.x) > local.z * tangentX
      || Math.abs(local.y) > local.z * tangentY
    ) {
      continue;
    }
    visible.push({ sourceIndex, worldX, worldY, worldZ, local });
  }

  const capturedPointCount = Math.min(
    visible.length,
    Math.max(0, Math.floor(Number(pointBudget) || 0)),
  );
  const localPositions = new Float32Array(capturedPointCount * 3);
  const worldPositions = new Float32Array(capturedPointCount * 3);
  const colors = new Uint8Array(capturedPointCount * 3);
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const encodeColor = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(THREE.MathUtils.clamp(parsed > 1 ? parsed : parsed * 255, 0, 255));
  };

  for (let captureIndex = 0; captureIndex < capturedPointCount; captureIndex += 1) {
    const visibleIndex = capturedPointCount === visible.length
      ? captureIndex
      : Math.min(
          visible.length - 1,
          Math.floor(((captureIndex + 0.5) * visible.length) / capturedPointCount),
        );
    const point = visible[visibleIndex];
    const offset = captureIndex * 3;
    const localValues = [point.local.x, point.local.y, point.local.z];
    localPositions.set(localValues, offset);
    worldPositions.set([point.worldX, point.worldY, point.worldZ], offset);
    localValues.forEach((value, axis) => {
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    });
    colors[offset] = hasRgb ? encodeColor(sourceColor.getX(point.sourceIndex), 184) : 184;
    colors[offset + 1] = hasRgb ? encodeColor(sourceColor.getY(point.sourceIndex), 198) : 198;
    colors[offset + 2] = hasRgb ? encodeColor(sourceColor.getZ(point.sourceIndex), 199) : 199;
  }

  if (!capturedPointCount) {
    minimum.fill(0);
    maximum.fill(0);
  }
  const scale = minimum.map((value, axis) => {
    const span = maximum[axis] - value;
    return span > 0 ? span / 65535 : 0;
  });
  const quantizedPositions = new Uint16Array(capturedPointCount * 3);
  for (let index = 0; index < localPositions.length; index += 1) {
    const axis = index % 3;
    quantizedPositions[index] = scale[axis] > 0
      ? Math.round(THREE.MathUtils.clamp(
          (localPositions[index] - minimum[axis]) / scale[axis],
          0,
          65535,
        ))
      : 0;
  }

  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.BufferAttribute(worldPositions, 3));
  previewGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  previewGeometry.userData.bufferStrategy = 'teaching-capture-visible-points';

  return {
    previewGeometry,
    pointCloud: {
      coordinateFrame: String(pose.frameName || 'camera-optical-frame'),
      convention: 'x-right/y-down/z-forward',
      pointCount: capturedPointCount,
      visiblePointCount: visible.length,
      sourcePointCount: sourcePosition.count,
      sampleMethod: capturedPointCount < visible.length ? 'uniform-visible-lod' : 'all-visible',
      positionEncoding: 'uint16-le/base64',
      positionComponents: ['x', 'y', 'z'],
      positionOffset: minimum,
      positionScale: scale,
      positionData: uint16LittleEndianBase64(quantizedPositions),
      colorEncoding: 'rgb8/base64',
      colorData: byteArrayToBase64(colors),
      hasSourceRgb: hasRgb,
      byteLength: quantizedPositions.byteLength + colors.byteLength,
    },
  };
};

const renderTeachingCaptureImages = (
  sourceGeometry,
  pose,
  qualityPlan,
  pointCloudGeometry,
) => {
  const topology = prepareMapGeometryTopology(sourceGeometry);
  const cameraSurfaceGeometry = createCameraSurfaceGeometry(sourceGeometry, qualityPlan, pose);
  const globalRgbFallbackGeometry = !cameraSurfaceGeometry
    ? createCameraGeometry(sourceGeometry, {
        pointBudget: qualityPlan.rgbPointBudget,
        sourceOrder: sourceGeometry.userData.pointRenderOrder,
        bufferStrategy: 'teaching-capture-rgb-fallback',
      })
    : null;
  const rgbCameraGeometry = cameraSurfaceGeometry
    ? {
        geometry: cameraSurfaceGeometry.pointGeometry,
        renderCount: cameraSurfaceGeometry.renderPointCount,
        hasRgb: cameraSurfaceGeometry.hasRgb,
      }
    : globalRgbFallbackGeometry;
  const cameraMeshGeometry = topology.hasMesh
    ? createCameraMeshGeometry(sourceGeometry, qualityPlan, pose)
    : null;
  let renderer = null;
  let rgbMaterial = null;
  let depthMaterial = null;
  let rgbMeshMaterial = null;
  let reconstructedSurfaceMaterial = null;

  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x02080b, 1);
    renderer.setPixelRatio(1);
    renderer.setSize(TEACHING_CAPTURE_WIDTH, TEACHING_CAPTURE_HEIGHT, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02080b);
    const camera = new THREE.PerspectiveCamera(
      ZIVID_M70_PROFILE.verticalFov,
      TEACHING_CAPTURE_WIDTH / TEACHING_CAPTURE_HEIGHT,
      ZIVID_M70_PROFILE.near,
      ZIVID_M70_PROFILE.far,
    );
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.quaternion
      .set(
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      )
      .normalize()
      .multiply(ROS_OPTICAL_TO_THREE_CAMERA);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const surfaceAmbientLight = new THREE.HemisphereLight(0xe8fbff, 0x081115, 1.35);
    const surfaceHeadLight = new THREE.DirectionalLight(0xffffff, 1.7);
    surfaceHeadLight.position.set(0, 0, 0);
    surfaceHeadLight.target.position.set(0, 0, -1);
    camera.add(surfaceHeadLight, surfaceHeadLight.target);
    scene.add(camera, surfaceAmbientLight);

    rgbMaterial = new THREE.PointsMaterial({
      color: rgbCameraGeometry?.hasRgb ? 0xffffff : 0xb8c6c7,
      size: THREE.MathUtils.clamp(
        Math.sqrt(
          (TEACHING_CAPTURE_WIDTH * TEACHING_CAPTURE_HEIGHT)
          / Math.max(cameraSurfaceGeometry?.strictVisiblePointCount || rgbCameraGeometry?.renderCount || 1, 1),
        ) * 1.45,
        2.8,
        20,
      ),
      sizeAttenuation: false,
      vertexColors: Boolean(rgbCameraGeometry?.hasRgb),
      depthTest: true,
      depthWrite: true,
      depthFunc: topology.hasMesh ? THREE.LessDepth : THREE.LessEqualDepth,
      toneMapped: false,
    });
    depthMaterial = createDepthMaterial();
    depthMaterial.uniforms.uPointSize.value = 2.35;
    const points = new THREE.Points(rgbCameraGeometry?.geometry || pointCloudGeometry, rgbMaterial);
    points.frustumCulled = false;
    points.renderOrder = 2;
    points.visible = Boolean(
      rgbCameraGeometry?.renderCount
      && !cameraSurfaceGeometry?.renderTriangleCount,
    );
    scene.add(points);

    let rgbMesh = null;
    if (cameraMeshGeometry?.geometry) {
      rgbMeshMaterial = new THREE.MeshBasicMaterial({
        color: cameraMeshGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
        vertexColors: cameraMeshGeometry.hasRgb,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        toneMapped: false,
      });
      rgbMesh = new THREE.Mesh(cameraMeshGeometry.geometry, rgbMeshMaterial);
      rgbMesh.frustumCulled = false;
      rgbMesh.renderOrder = 1;
      scene.add(rgbMesh);
    }

    let reconstructedSurface = null;
    if (cameraSurfaceGeometry?.meshGeometry) {
      reconstructedSurfaceMaterial = new THREE.MeshStandardMaterial({
        color: cameraSurfaceGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
        vertexColors: cameraSurfaceGeometry.hasRgb,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        roughness: 0.92,
        metalness: 0,
        toneMapped: false,
      });
      reconstructedSurface = new THREE.Mesh(
        cameraSurfaceGeometry.meshGeometry,
        reconstructedSurfaceMaterial,
      );
      reconstructedSurface.frustumCulled = false;
      reconstructedSurface.renderOrder = 1;
      scene.add(reconstructedSurface);
    }

    renderer.render(scene, camera);
    renderer.getContext().finish?.();
    const rgb = captureCanvasImage(renderer.domElement);

    if (rgbMesh) rgbMesh.visible = false;
    if (reconstructedSurface) reconstructedSurface.visible = false;
    points.geometry = pointCloudGeometry;
    points.material = depthMaterial;
    points.visible = Boolean(pointCloudGeometry?.getAttribute('position')?.count);
    renderer.render(scene, camera);
    renderer.getContext().finish?.();
    const pointCloudPreview = captureCanvasImage(renderer.domElement);

    return {
      rgb,
      pointCloudPreview,
      rgbSurfaceMode: topology.hasMesh
        ? 'embedded-mesh+local-surface'
        : 'local-surface',
      renderedMeshFaceCount: cameraMeshGeometry?.renderFaceCount || 0,
      reconstructedTriangleCount: cameraSurfaceGeometry?.renderTriangleCount || 0,
    };
  } finally {
    cameraSurfaceGeometry?.pointGeometry?.dispose();
    cameraSurfaceGeometry?.meshGeometry?.dispose();
    globalRgbFallbackGeometry?.geometry?.dispose();
    cameraMeshGeometry?.geometry?.dispose();
    rgbMaterial?.dispose();
    depthMaterial?.dispose();
    rgbMeshMaterial?.dispose();
    reconstructedSurfaceMaterial?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss?.();
  }
};

const captureZividTeachingVision = async ({
  mapData,
  cameraPoses,
  meshRenderQuality,
}) => {
  const sourceGeometry = mapData?.geometry;
  if (!sourceGeometry?.getAttribute('position')?.count) {
    throw new Error('当前地图没有可采集的点云数据');
  }
  const capturedAt = new Date().toISOString();
  const poses = Object.fromEntries(
    ['left', 'right'].map((side) => [
      side,
      normalizedCameraPoseSnapshot(cameraPoses?.[side], side),
    ]),
  );
  if (!poses.left || !poses.right) {
    throw new Error('左右 Zivid 光学坐标系尚未同步完成');
  }
  const topology = prepareMapGeometryTopology(sourceGeometry);
  const qualityPlan = resolveMeshRenderQuality(meshRenderQuality, topology.faceCount);
  const frames = {};
  let storageByteLength = 0;

  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  for (const side of ['left', 'right']) {
    const pose = poses[side];
    const pointCapture = captureVisiblePointCloud(sourceGeometry, pose);
    try {
      const images = renderTeachingCaptureImages(
        sourceGeometry,
        pose,
        qualityPlan,
        pointCapture.previewGeometry,
      );
      const frameByteLength = pointCapture.pointCloud.byteLength
        + images.rgb.byteLength
        + images.pointCloudPreview.byteLength;
      storageByteLength += frameByteLength;
      frames[side] = {
        side,
        capturedAt,
        opticalPose: pose,
        rgb: images.rgb,
        pointCloud: {
          ...pointCapture.pointCloud,
          preview: images.pointCloudPreview,
        },
        rendering: {
          quality: qualityPlan.effectiveId,
          rgbSurfaceMode: images.rgbSurfaceMode,
          renderedMeshFaceCount: images.renderedMeshFaceCount,
          reconstructedTriangleCount: images.reconstructedTriangleCount,
        },
        byteLength: frameByteLength,
      };
    } finally {
      pointCapture.previewGeometry.dispose();
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  return {
    version: 1,
    status: 'complete',
    cameraModel: ZIVID_M70_PROFILE.model,
    capturedAt,
    imageResolution: [TEACHING_CAPTURE_WIDTH, TEACHING_CAPTURE_HEIGHT],
    calibration: {
      projection: 'perspective',
      nativeResolution: [ZIVID_M70_PROFILE.nativeWidth, ZIVID_M70_PROFILE.nativeHeight],
      horizontalFov: ZIVID_M70_PROFILE.horizontalFov,
      verticalFov: ZIVID_M70_PROFILE.verticalFov,
      workingNear: ZIVID_M70_PROFILE.near,
      workingFar: ZIVID_M70_PROFILE.far,
    },
    pointBudgetPerCamera: TEACHING_CAPTURE_POINT_BUDGET,
    map: {
      fileName: String(mapData?.name || ''),
      sourceHash: mapData?.sourceHash ? String(mapData.sourceHash) : null,
    },
    quality: {
      requested: qualityPlan.requestedId,
      effective: qualityPlan.effectiveId,
    },
    frames,
    storageByteLength,
  };
};

const estimateVisiblePoints = (geometry, pose) => {
  const attribute = geometry?.getAttribute('position');
  if (!attribute?.count || !pose?.position || !pose?.quaternion) {
    return { checked: 0, estimated: 0 };
  }
  const sampleTarget = 18_000;
  const stride = Math.max(1, Math.ceil(attribute.count / sampleTarget));
  const qx = -Number(pose.quaternion.x || 0);
  const qy = -Number(pose.quaternion.y || 0);
  const qz = -Number(pose.quaternion.z || 0);
  const qw = Number(pose.quaternion.w ?? 1);
  const px = Number(pose.position.x || 0);
  const py = Number(pose.position.y || 0);
  const pz = Number(pose.position.z || 0);
  const tangentX = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.verticalFov / 2));
  let checked = 0;
  let visible = 0;

  for (let index = 0; index < attribute.count; index += stride) {
    const vx = attribute.getX(index) - px;
    const vy = attribute.getY(index) - py;
    const vz = attribute.getZ(index) - pz;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    const localX = vx + qw * tx + (qy * tz - qz * ty);
    const localY = vy + qw * ty + (qz * tx - qx * tz);
    const localZ = vz + qw * tz + (qx * ty - qy * tx);
    checked += 1;
    if (
      localZ >= ZIVID_M70_PROFILE.near
      && localZ <= ZIVID_M70_PROFILE.far
      && Math.abs(localX) <= localZ * tangentX
      && Math.abs(localY) <= localZ * tangentY
    ) {
      visible += 1;
    }
  }
  return {
    checked,
    estimated: Math.min(attribute.count, Math.round((visible / Math.max(checked, 1)) * attribute.count)),
  };
};

const poseLabel = (pose) => {
  if (!pose?.position) return '等待 optical frame';
  const { x, y, z } = pose.position;
  return `X ${x.toFixed(2)} · Y ${y.toFixed(2)} · Z ${z.toFixed(2)}`;
};

const EMPTY_CAMERA_MESH_STATS = Object.freeze({
  candidateFaceCount: 0,
  renderFaceCount: 0,
  selectionMode: 'none',
  surfaceCandidatePointCount: 0,
  surfacePointCount: 0,
  surfaceTriangleCount: 0,
  surfaceSelectionMode: 'none',
});

function MainViewportThumbnail({ sourceCanvasRef }) {
  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const fallbackCanvasRef = useRef(null);
  const previewDragRef = useRef(null);
  const previewControlCountRef = useRef(0);
  const [preview, setPreview] = useState({ status: 'waiting', transport: 'none' });
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewZoomOrigin, setPreviewZoomOrigin] = useState({ x: 50, y: 50 });
  const [previewInteractionMode, setPreviewInteractionMode] = useState('rotate');
  const [previewDragging, setPreviewDragging] = useState(false);

  useEffect(() => {
    let disposed = false;
    let sourceCanvas = null;
    let stream = null;
    let retryTimer = null;
    let readinessTimer = null;
    let videoFrameId = null;
    let snapshotFrameId = null;
    let lastSnapshotAt = Number.NEGATIVE_INFINITY;
    let frameCount = 0;
    let streamReady = false;
    let snapshotActive = false;

    const updateFrameMetadata = () => {
      const root = rootRef.current;
      if (!root || !sourceCanvas) return;
      frameCount += 1;
      root.dataset.previewFrameCount = String(frameCount);
      root.dataset.previewSourceWidth = String(sourceCanvas.width || 0);
      root.dataset.previewSourceHeight = String(sourceCanvas.height || 0);
      root.dataset.sourceViewSignature = sourceCanvas.dataset.viewSignature || '';
      root.dataset.sourceRobotOrigin = sourceCanvas.dataset.robotOrigin || '';
    };

    const stopStream = () => {
      if (videoFrameId !== null && videoRef.current?.cancelVideoFrameCallback) {
        videoRef.current.cancelVideoFrameCallback(videoFrameId);
      }
      videoFrameId = null;
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
    };

    const startSnapshotFallback = () => {
      if (disposed || snapshotActive || !sourceCanvas) return;
      snapshotActive = true;
      stopStream();
      setPreview({ status: 'connecting', transport: 'canvas-copy' });

      const paint = (timestamp) => {
        if (disposed || !snapshotActive) return;
        if (timestamp - lastSnapshotAt >= MAIN_VIEW_PREVIEW_FRAME_INTERVAL_MS) {
          const canvas = fallbackCanvasRef.current;
          const source = sourceCanvasRef?.current || sourceCanvas;
          if (!source?.isConnected) {
            setPreview({ status: 'waiting', transport: 'canvas-copy' });
          } else if (canvas) {
            sourceCanvas = source;
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
            const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
            const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            try {
              const context = canvas.getContext('2d', { alpha: false });
              const sourceWidth = Math.max(1, source.width || source.clientWidth);
              const sourceHeight = Math.max(1, source.height || source.clientHeight);
              const scale = Math.min(width / sourceWidth, height / sourceHeight);
              const drawWidth = sourceWidth * scale;
              const drawHeight = sourceHeight * scale;
              const offsetX = (width - drawWidth) / 2;
              const offsetY = (height - drawHeight) / 2;
              context.fillStyle = '#020709';
              context.fillRect(0, 0, width, height);
              context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
              updateFrameMetadata();
              setPreview((current) => current.status === 'live'
                ? current
                : { status: 'live', transport: 'canvas-copy' });
            } catch {
              snapshotActive = false;
              setPreview({ status: 'unavailable', transport: 'canvas-copy' });
              return;
            }
          }
          lastSnapshotAt = timestamp;
        }
        snapshotFrameId = window.requestAnimationFrame(paint);
      };
      snapshotFrameId = window.requestAnimationFrame(paint);
    };

    const connect = () => {
      if (disposed) return;
      sourceCanvas = sourceCanvasRef?.current
        || document.querySelector('.three-canvas');
      if (!sourceCanvas?.isConnected) {
        setPreview({ status: 'waiting', transport: 'none' });
        retryTimer = window.setTimeout(connect, 220);
        return;
      }

      const root = rootRef.current;
      if (root) {
        root.dataset.previewSource = sourceCanvas.classList.contains('three-canvas')
          ? 'three-canvas'
          : 'canvas';
        root.dataset.previewSourceWidth = String(sourceCanvas.width || 0);
        root.dataset.previewSourceHeight = String(sourceCanvas.height || 0);
      }

      if (typeof sourceCanvas.captureStream !== 'function') {
        startSnapshotFallback();
        return;
      }

      try {
        stream = sourceCanvas.captureStream(MAIN_VIEW_PREVIEW_FPS);
        const video = videoRef.current;
        if (!video || !stream.getVideoTracks().length) {
          startSnapshotFallback();
          return;
        }
        setPreview({ status: 'connecting', transport: 'capture-stream' });
        video.srcObject = stream;

        const markStreamReady = () => {
          if (disposed || snapshotActive) return;
          if (streamReady) {
            updateFrameMetadata();
            return;
          }
          streamReady = true;
          updateFrameMetadata();
          setPreview({ status: 'live', transport: 'capture-stream' });
        };
        video.addEventListener('loadeddata', markStreamReady, { once: true });
        video.addEventListener('playing', markStreamReady, { once: true });

        if (typeof video.requestVideoFrameCallback === 'function') {
          const observeFrame = () => {
            if (disposed || snapshotActive) return;
            markStreamReady();
            videoFrameId = video.requestVideoFrameCallback(observeFrame);
          };
          videoFrameId = video.requestVideoFrameCallback(observeFrame);
        }

        const playRequest = video.play();
        playRequest?.catch?.(() => startSnapshotFallback());
        readinessTimer = window.setTimeout(() => {
          if (!streamReady) startSnapshotFallback();
        }, 1800);
      } catch {
        startSnapshotFallback();
      }
    };

    connect();
    return () => {
      disposed = true;
      snapshotActive = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (readinessTimer) window.clearTimeout(readinessTimer);
      if (snapshotFrameId !== null) window.cancelAnimationFrame(snapshotFrameId);
      stopStream();
    };
  }, [sourceCanvasRef]);

  const statusLabel = preview.status === 'live'
    ? `LIVE · ${MAIN_VIEW_PREVIEW_FPS} FPS`
    : preview.status === 'unavailable'
      ? 'UNAVAILABLE'
      : 'SYNCING';

  const changePreviewZoom = (change) => {
    setPreviewZoom((current) => THREE.MathUtils.clamp(
      typeof change === 'function' ? change(current) : change,
      1,
      MAIN_VIEW_PREVIEW_MAX_ZOOM,
    ));
  };

  const resetPreviewZoom = () => {
    setPreviewZoom(1);
    setPreviewZoomOrigin({ x: 50, y: 50 });
  };

  const handlePreviewWheel = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target.closest('button')) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) {
      setPreviewZoomOrigin({
        x: THREE.MathUtils.clamp(((event.clientX - bounds.left) / bounds.width) * 100, 0, 100),
        y: THREE.MathUtils.clamp(((event.clientY - bounds.top) / bounds.height) * 100, 0, 100),
      });
    }
    changePreviewZoom((current) => current * Math.exp(-event.deltaY * 0.0018));
  };

  const dispatchPreviewControl = (kind, deltaX, deltaY, frame) => {
    const sourceCanvas = sourceCanvasRef?.current
      || document.querySelector('.three-canvas');
    if (!sourceCanvas?.isConnected || (!deltaX && !deltaY)) return;
    previewControlCountRef.current += 1;
    sourceCanvas.dispatchEvent(new CustomEvent(MAIN_VIEW_PREVIEW_CONTROL_EVENT, {
      detail: {
        kind,
        deltaX,
        deltaY,
        sourceWidth: Math.max(frame?.clientWidth || 1, 1),
        sourceHeight: Math.max(frame?.clientHeight || 1, 1),
      },
    }));
    if (rootRef.current) {
      rootRef.current.dataset.previewControlCount = String(previewControlCountRef.current);
      rootRef.current.dataset.previewLastControl = kind;
    }
  };

  const finishPreviewDrag = (frame, pointerId, state = 'ended') => {
    previewDragRef.current = null;
    if (frame?.hasPointerCapture?.(pointerId)) {
      try {
        frame.releasePointerCapture(pointerId);
      } catch {
        // The browser can release capture before React receives pointercancel.
      }
    }
    setPreviewDragging(false);
    if (rootRef.current) rootRef.current.dataset.previewGestureState = state;
  };

  const handlePreviewPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    const effectiveMode = event.shiftKey ? 'pan' : previewInteractionMode;
    previewDragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      effectiveMode,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPreviewDragging(true);
    if (rootRef.current) {
      rootRef.current.dataset.previewGestureState = 'active';
      rootRef.current.dataset.previewEffectiveMode = effectiveMode;
    }
  };

  const handlePreviewPointerMove = (event) => {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < bounds.left
      || event.clientX > bounds.right
      || event.clientY < bounds.top
      || event.clientY > bounds.bottom;
    if (outside) {
      finishPreviewDrag(event.currentTarget, event.pointerId, 'cancelled-on-leave');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const effectiveMode = event.shiftKey ? 'pan' : drag.effectiveMode;
    if (rootRef.current) rootRef.current.dataset.previewEffectiveMode = effectiveMode;
    dispatchPreviewControl(effectiveMode, deltaX, deltaY, event.currentTarget);
  };

  return (
    <aside
      ref={rootRef}
      className={`zivid-main-view-preview is-${preview.status} uses-${preview.transport}`}
      aria-label="主3D视角缩略图"
      data-preview-status={preview.status}
      data-preview-transport={preview.transport}
      data-preview-fps={MAIN_VIEW_PREVIEW_FPS}
      data-preview-frame-count="0"
      data-preview-zoom={previewZoom.toFixed(2)}
      data-preview-max-zoom={MAIN_VIEW_PREVIEW_MAX_ZOOM}
      data-preview-interaction-mode={previewInteractionMode}
      data-preview-effective-mode={previewInteractionMode}
      data-preview-dragging={previewDragging ? 'true' : 'false'}
      data-preview-control-count={String(previewControlCountRef.current)}
      style={{
        '--main-preview-zoom': previewZoom,
        '--main-preview-origin-x': `${previewZoomOrigin.x}%`,
        '--main-preview-origin-y': `${previewZoomOrigin.y}%`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header>
        <span><Box size={11} /><strong>主 3D 视角</strong><small>MAP FRAME</small></span>
        <b aria-live="polite"><i />{statusLabel}</b>
      </header>
      <div
        className={`zivid-main-view-preview__frame is-${previewInteractionMode} ${previewDragging ? 'is-dragging' : ''}`}
        title={`${previewInteractionMode === 'rotate' ? '拖拽旋转' : '拖拽平移'} · Shift 临时平移 · 滚轮缩放 · 双击恢复 1×`}
        onWheel={handlePreviewWheel}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handlePreviewPointerDown}
        onPointerMove={handlePreviewPointerMove}
        onPointerUp={(event) => {
          if (previewDragRef.current?.pointerId !== event.pointerId) return;
          event.stopPropagation();
          finishPreviewDrag(event.currentTarget, event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (previewDragRef.current?.pointerId !== event.pointerId) return;
          finishPreviewDrag(event.currentTarget, event.pointerId, 'cancelled');
        }}
        onPointerLeave={(event) => {
          if (previewDragRef.current?.pointerId !== event.pointerId) return;
          finishPreviewDrag(event.currentTarget, event.pointerId, 'cancelled-on-leave');
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!event.target.closest('button')) resetPreviewZoom();
        }}
      >
        <video ref={videoRef} muted autoPlay playsInline aria-hidden="true" />
        <canvas ref={fallbackCanvasRef} aria-hidden="true" />
        <div className="zivid-main-view-preview__grid" aria-hidden="true" />
        {preview.status !== 'live' && (
          <div className="zivid-main-view-preview__empty">
            <Focus size={13} />
            <span>{preview.status === 'unavailable' ? '主视角不可用' : '正在同步主视角'}</span>
          </div>
        )}
        <div
          className="zivid-main-view-preview__zoom"
          role="group"
          aria-label="主3D视角缩放"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label="缩小主3D视角"
            title="缩小主 3D 视角"
            disabled={previewZoom <= 1.001}
            onClick={() => changePreviewZoom((current) => current / 1.55)}
          >
            <Minus size={11} />
          </button>
          <button
            type="button"
            className="is-readout"
            aria-label="重置主3D视角缩放"
            title="恢复 1×"
            disabled={previewZoom <= 1.001}
            onClick={resetPreviewZoom}
          >
            <RotateCcw size={9} />
            <b>{previewZoom.toFixed(1)}×</b>
          </button>
          <button
            type="button"
            aria-label="放大主3D视角"
            title="放大主 3D 视角"
            disabled={previewZoom >= MAIN_VIEW_PREVIEW_MAX_ZOOM - 0.001}
            onClick={() => changePreviewZoom((current) => current * 1.55)}
          >
            <Plus size={11} />
          </button>
        </div>
        <div
          className="zivid-main-view-preview__modes"
          role="group"
          aria-label="主3D视角交互模式"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={previewInteractionMode === 'rotate' ? 'is-active' : ''}
            aria-label="主3D视角旋转模式"
            aria-pressed={previewInteractionMode === 'rotate'}
            title="左键拖拽旋转主 3D 视角"
            onClick={() => setPreviewInteractionMode('rotate')}
          >
            <Rotate3D size={10} />旋转
          </button>
          <button
            type="button"
            className={previewInteractionMode === 'pan' ? 'is-active' : ''}
            aria-label="主3D视角平移模式"
            aria-pressed={previewInteractionMode === 'pan'}
            title="左键拖拽平移主 3D 视角"
            onClick={() => setPreviewInteractionMode('pan')}
          >
            <Move3D size={10} />平移
          </button>
        </div>
        <div className="zivid-main-view-preview__axes" aria-hidden="true">
          <i className="x">X</i><i className="y">Y</i><i className="z">Z</i>
        </div>
      </div>
    </aside>
  );
}

export default function ZividCameraPanel({
  mapData,
  robot,
  robotLoadState,
  cameraPoses = {},
  activeSide: controlledActiveSide,
  onActiveSideChange,
  teachingMode = 'pose',
  cameraTeachingEnabled = false,
  cameraTeachingResult,
  meshRenderQuality = 'auto',
  onMeshRenderQualityChange,
  spaceMouseInputRef,
  mainViewportCanvasRef,
  jointControlOpen = false,
  onExpandedChange,
  onOpenJointControl,
  onCameraTeachingMove,
  onCaptureProviderChange,
}) {
  const enabled = isM70Robot(robot, robotLoadState);
  const [internalActiveSide, setInternalActiveSide] = useState('left');
  const activeSide = ['left', 'right'].includes(controlledActiveSide)
    ? controlledActiveSide
    : internalActiveSide;
  const [renderMode, setRenderMode] = useState('rgb');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [spaceMouseViewEnabled, setSpaceMouseViewEnabled] = useState(false);
  const [spaceMouseStatus, setSpaceMouseStatus] = useState({
    connected: false,
    calibrated: false,
    calibrating: false,
    controlEnabled: true,
    mode: 'xyz',
    selectedAxis: 'x',
    controlTarget: 'viewport',
  });
  const [spaceMouseHud, setSpaceMouseHud] = useState({
    visible: false,
    active: false,
    axis: 'x',
    code: 'X',
    group: 'XYZ',
    label: '前进 · 靠近',
    value: 0,
    inputCount: 0,
  });
  const [dragging, setDragging] = useState(false);
  const [rendererStatus, setRendererStatus] = useState('waiting');
  const [cameraMeshStats, setCameraMeshStats] = useState(EMPTY_CAMERA_MESH_STATS);
  const mountRef = useRef(null);
  const poseRef = useRef(null);
  const cameraPosesRef = useRef(cameraPoses);
  const renderModeRef = useRef(renderMode);
  const viewRef = useRef({ zoom, pan });
  const dragRef = useRef(null);
  const onCameraTeachingMoveRef = useRef(onCameraTeachingMove);
  const cameraTeachingResultRef = useRef(cameraTeachingResult);
  const spaceMouseHudTimerRef = useRef(null);
  const spaceMouseHudVisibleRef = useRef(false);
  const spaceMouseInputCountRef = useRef(0);
  const spaceMouseStatusSignatureRef = useRef('');
  const activePose = cameraPoses?.[activeSide] || null;
  const hasRgb = Boolean(mapData?.geometry?.getAttribute('color'));
  const meshInfo = mapData?.meshInfo || mapData?.geometry?.userData?.mapTopology || null;
  const hasEmbeddedMesh = Boolean(meshInfo?.hasMesh && meshInfo.faceCount > 0);
  const meshQualityPlan = resolveMeshRenderQuality(
    meshRenderQuality,
    meshInfo?.faceCount,
  );
  const liveCameraMeshRegionKey = useMemo(
    () => cameraMeshRegionKeyForPose(activePose),
    [activePose],
  );
  const [settledCameraMeshRegionKey, setSettledCameraMeshRegionKey] = useState(
    liveCameraMeshRegionKey,
  );
  const builtCameraMeshRegionKeyRef = useRef('');
  const frustumStats = useMemo(
    () => estimateVisiblePoints(mapData?.geometry, activePose),
    [activePose, mapData?.geometry],
  );

  poseRef.current = activePose;
  cameraPosesRef.current = cameraPoses;
  renderModeRef.current = renderMode;
  viewRef.current = { zoom, pan };
  onCameraTeachingMoveRef.current = onCameraTeachingMove;
  cameraTeachingResultRef.current = cameraTeachingResult;
  spaceMouseHudVisibleRef.current = spaceMouseHud.visible;

  useEffect(() => {
    if (!enabled && expanded) setExpanded(false);
  }, [enabled, expanded]);

  useEffect(() => {
    if (!mapData?.geometry) setCameraMeshStats(EMPTY_CAMERA_MESH_STATS);
  }, [mapData?.geometry]);

  useEffect(() => {
    if (!mapData?.geometry || liveCameraMeshRegionKey === builtCameraMeshRegionKeyRef.current) {
      return undefined;
    }
    const settleTimer = window.setTimeout(() => {
      setSettledCameraMeshRegionKey(liveCameraMeshRegionKey);
    }, 280);
    return () => window.clearTimeout(settleTimer);
  }, [liveCameraMeshRegionKey, mapData?.geometry]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [activeSide]);

  useEffect(() => {
    if (zoom <= 1.0001 && (pan.x !== 0 || pan.y !== 0)) setPan({ x: 0, y: 0 });
  }, [pan.x, pan.y, zoom]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return undefined;
    const syncStatus = () => {
      const input = spaceMouseInputRef?.current || {};
      const nextStatus = {
        connected: Boolean(input.connected),
        calibrated: Boolean(input.calibrated),
        calibrating: Boolean(input.calibrating),
        controlEnabled: input.controlEnabled !== false,
        mode: input.mode === 'rpy' ? 'rpy' : 'xyz',
        selectedAxis: ZIVID_SPACEMOUSE_AXES.includes(input.selectedAxis)
          ? input.selectedAxis
          : input.mode === 'rpy' ? 'yaw' : 'x',
        controlTarget: input.controlTarget === 'zivid-camera'
          ? 'zivid-camera'
          : 'viewport',
      };
      const signature = Object.values(nextStatus).join('|');
      if (signature !== spaceMouseStatusSignatureRef.current) {
        spaceMouseStatusSignatureRef.current = signature;
        setSpaceMouseStatus(nextStatus);
      }
    };
    syncStatus();
    const statusTimer = window.setInterval(syncStatus, 100);
    return () => window.clearInterval(statusTimer);
  }, [expanded, spaceMouseInputRef]);

  useEffect(() => {
    const deviceUnavailable = !spaceMouseStatus.connected
      || !spaceMouseStatus.calibrated
      || spaceMouseStatus.calibrating;
    if (
      spaceMouseViewEnabled
      && (!expanded || !cameraTeachingEnabled || deviceUnavailable)
    ) {
      setSpaceMouseViewEnabled(false);
    }
  }, [
    cameraTeachingEnabled,
    expanded,
    spaceMouseStatus.calibrated,
    spaceMouseStatus.calibrating,
    spaceMouseStatus.connected,
    spaceMouseViewEnabled,
  ]);

  useEffect(() => {
    if (!spaceMouseInputRef || !expanded || !spaceMouseViewEnabled) return undefined;
    const current = spaceMouseInputRef.current || {};
    spaceMouseInputRef.current = {
      ...current,
      controlTarget: 'zivid-camera',
      controlTargetSide: activeSide,
      controlTargetRevision: Number(current.controlTargetRevision || 0) + 1,
      revision: Number(current.revision || 0) + 1,
    };

    return () => {
      const latest = spaceMouseInputRef.current || {};
      if (
        latest.controlTarget !== 'zivid-camera'
        || latest.controlTargetSide !== activeSide
      ) return;
      spaceMouseInputRef.current = {
        ...latest,
        controlTarget: 'viewport',
        controlTargetSide: null,
        controlTargetRevision: Number(latest.controlTargetRevision || 0) + 1,
        motionActive: false,
        axes: Object.fromEntries(ZIVID_SPACEMOUSE_AXES.map((axis) => [axis, 0])),
        timestamp: 0,
        revision: Number(latest.revision || 0) + 1,
      };
    };
  }, [activeSide, expanded, spaceMouseInputRef, spaceMouseViewEnabled]);

  useEffect(() => {
    if (!expanded || !spaceMouseViewEnabled || !spaceMouseInputRef) return undefined;
    let frameId = 0;
    let lastCommandAt = performance.now() - ZIVID_SPACEMOUSE_COMMAND_INTERVAL_MS;
    let motionWasActive = false;

    const setCanvasState = (state = {}) => {
      const canvas = mountRef.current?.querySelector('.zivid-camera-canvas');
      if (!canvas) return;
      canvas.dataset.spacemouseViewEnabled = 'true';
      canvas.dataset.spacemouseControlTarget = 'zivid-camera';
      canvas.dataset.spacemouseControlModel = 'optical-frame-ik';
      canvas.dataset.spacemouseZoomPolicy = 'mouse-only';
      canvas.dataset.spacemouseSelectedAxis = state.axis || '';
      canvas.dataset.spacemouseMotionState = state.motionState || 'idle';
      canvas.dataset.spacemouseInputCount = String(spaceMouseInputCountRef.current);
      canvas.dataset.spacemouseCommandIntervalMs = String(
        ZIVID_SPACEMOUSE_COMMAND_INTERVAL_MS,
      );
      if (state.action) canvas.dataset.spacemouseLastAction = state.action;
    };

    const markHudInactive = () => {
      if (
        !motionWasActive
        && (!spaceMouseHudVisibleRef.current || spaceMouseHudTimerRef.current)
      ) return;
      motionWasActive = false;
      setSpaceMouseHud((current) => (
        current.active ? { ...current, active: false, value: 0 } : current
      ));
      if (!spaceMouseHudTimerRef.current) {
        spaceMouseHudTimerRef.current = window.setTimeout(() => {
          spaceMouseHudTimerRef.current = null;
          spaceMouseHudVisibleRef.current = false;
          setSpaceMouseHud((current) => ({ ...current, visible: false, active: false }));
        }, ZIVID_SPACEMOUSE_HUD_HOLD_MS);
      }
    };

    const consumeInput = (now) => {
      const input = spaceMouseInputRef.current || {};
      const selectedAxis = ZIVID_SPACEMOUSE_AXES.includes(input.selectedAxis)
        ? input.selectedAxis
        : input.mode === 'rpy' ? 'yaw' : 'x';
      const actionMeta = ZIVID_SPACEMOUSE_ACTIONS[selectedAxis];
      const value = THREE.MathUtils.clamp(Number(input.axes?.[selectedAxis]) || 0, -1, 1);
      const inputReady = Boolean(
        input.controlTarget === 'zivid-camera'
        && input.controlTargetSide === activeSide
        && input.connected
        && input.calibrated
        && !input.calibrating
        && input.controlEnabled !== false
        && input.motionActive
        && now - Number(input.timestamp || 0) <= ZIVID_SPACEMOUSE_INPUT_STALE_MS
        && Math.abs(value) > 0.0001
        && actionMeta
      );

      if (!inputReady) {
        setCanvasState({ axis: selectedAxis, motionState: 'idle' });
        markHudInactive();
        frameId = requestAnimationFrame(consumeInput);
        return;
      }

      motionWasActive = true;
      if (spaceMouseHudTimerRef.current) {
        window.clearTimeout(spaceMouseHudTimerRef.current);
        spaceMouseHudTimerRef.current = null;
      }
      const [action, label] = value >= 0 ? actionMeta.positive : actionMeta.negative;
      setCanvasState({ axis: selectedAxis, motionState: 'active', action });

      const solving = cameraTeachingResultRef.current?.status === 'solving';
      if (!solving && now - lastCommandAt >= ZIVID_SPACEMOUSE_COMMAND_INTERVAL_MS) {
        const elapsedSeconds = THREE.MathUtils.clamp(
          (now - lastCommandAt) / 1000,
          0.05,
          0.14,
        );
        const magnitude = Math.abs(value);
        const linearStep = THREE.MathUtils.clamp(
          magnitude * ZIVID_SPACEMOUSE_LINEAR_SPEED * elapsedSeconds,
          0.001,
          0.04,
        );
        const angularStep = THREE.MathUtils.clamp(
          magnitude * ZIVID_SPACEMOUSE_ANGULAR_SPEED * elapsedSeconds,
          0.2,
          6,
        );
        lastCommandAt = now;
        spaceMouseInputCountRef.current += 1;
        spaceMouseHudVisibleRef.current = true;
        setSpaceMouseHud({
          visible: true,
          active: true,
          axis: selectedAxis,
          code: actionMeta.code,
          group: actionMeta.group,
          label,
          value,
          inputCount: spaceMouseInputCountRef.current,
        });
        setCanvasState({ axis: selectedAxis, motionState: 'active', action });
        onCameraTeachingMoveRef.current?.({
          side: activeSide,
          action,
          linearStep,
          angularStep,
          source: 'spacemouse',
          inputMagnitude: magnitude,
        });
      }
      frameId = requestAnimationFrame(consumeInput);
    };

    frameId = requestAnimationFrame(consumeInput);
    return () => {
      cancelAnimationFrame(frameId);
      if (spaceMouseHudTimerRef.current) {
        window.clearTimeout(spaceMouseHudTimerRef.current);
        spaceMouseHudTimerRef.current = null;
      }
      spaceMouseHudVisibleRef.current = false;
      setSpaceMouseHud((current) => ({ ...current, visible: false, active: false, value: 0 }));
      const canvas = mountRef.current?.querySelector('.zivid-camera-canvas');
      if (canvas) {
        canvas.dataset.spacemouseViewEnabled = 'false';
        canvas.dataset.spacemouseControlTarget = 'viewport';
        canvas.dataset.spacemouseMotionState = 'idle';
      }
    };
  }, [activeSide, expanded, spaceMouseInputRef, spaceMouseViewEnabled]);

  useEffect(() => {
    if (!onCaptureProviderChange) return undefined;
    if (!enabled || !mapData?.geometry) {
      onCaptureProviderChange(null);
      return undefined;
    }
    const provider = () => captureZividTeachingVision({
      mapData,
      cameraPoses: cameraPosesRef.current,
      meshRenderQuality,
    });
    onCaptureProviderChange(provider);
    return () => onCaptureProviderChange(null);
  }, [enabled, mapData, meshRenderQuality, onCaptureProviderChange]);

  useEffect(() => {
    const mount = mountRef.current;
    const sourceGeometry = mapData?.geometry;
    if (!enabled || !mount || !sourceGeometry) return undefined;

    const topology = prepareMapGeometryTopology(sourceGeometry);
    const qualityPlan = resolveMeshRenderQuality(meshRenderQuality, topology.faceCount);
    const cameraGeometry = createCameraGeometry(sourceGeometry);
    if (!cameraGeometry) return undefined;
    const cameraSurfaceGeometry = createCameraSurfaceGeometry(
      sourceGeometry,
      qualityPlan,
      poseRef.current,
    );
    const globalRgbFallbackGeometry = !cameraSurfaceGeometry
      ? createCameraGeometry(sourceGeometry, {
          pointBudget: qualityPlan.rgbPointBudget,
          sourceOrder: sourceGeometry.userData.pointRenderOrder,
          bufferStrategy: 'dedicated-rgb-point-fallback-lod',
        })
      : null;
    const rgbCameraGeometry = cameraSurfaceGeometry
      ? {
          geometry: cameraSurfaceGeometry.pointGeometry,
          renderCount: cameraSurfaceGeometry.renderPointCount,
          hasRgb: cameraSurfaceGeometry.hasRgb,
          bufferByteLength: 0,
        }
      : globalRgbFallbackGeometry || cameraGeometry;
    const cameraMeshGeometry = topology.hasMesh
      ? createCameraMeshGeometry(sourceGeometry, qualityPlan, poseRef.current)
      : null;
    builtCameraMeshRegionKeyRef.current = cameraMeshRegionKeyForPose(poseRef.current);
    const {
      geometry,
      pointCount,
      renderCount,
      bufferByteLength,
    } = cameraGeometry;
    const rgbPointRenderCount = rgbCameraGeometry?.renderCount || 0;
    const rgbMeshFaceCount = cameraMeshGeometry?.renderFaceCount || 0;
    const rgbMeshCandidateFaceCount = cameraMeshGeometry?.candidateFaceCount || 0;
    const meshSelectionMode = cameraMeshGeometry?.selectionMode || 'none';
    setCameraMeshStats({
      candidateFaceCount: rgbMeshCandidateFaceCount,
      renderFaceCount: rgbMeshFaceCount,
      selectionMode: meshSelectionMode,
      surfaceCandidatePointCount: cameraSurfaceGeometry?.candidatePointCount || 0,
      surfacePointCount: cameraSurfaceGeometry?.renderPointCount || 0,
      surfaceTriangleCount: cameraSurfaceGeometry?.renderTriangleCount || 0,
      surfaceSelectionMode: cameraSurfaceGeometry?.selectionMode || 'none',
    });
    const cameraBufferByteLength = bufferByteLength
      + (cameraSurfaceGeometry?.bufferByteLength || 0)
      + (globalRgbFallbackGeometry?.bufferByteLength || 0)
      + (cameraMeshGeometry?.bufferByteLength || 0);
    setRendererStatus('waiting');
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.warn('Zivid 相机仿真视图初始化失败', error);
      setRendererStatus('error');
      geometry.dispose();
      cameraSurfaceGeometry?.pointGeometry?.dispose();
      cameraSurfaceGeometry?.meshGeometry?.dispose();
      globalRgbFallbackGeometry?.geometry?.dispose();
      cameraMeshGeometry?.geometry?.dispose();
      return undefined;
    }

    renderer.setClearColor(0x02080b, 1);
    const pixelRatioCap = {
      performance: 0.85,
      balanced: 1.15,
      detail: 1.45,
      full: 1.75,
    }[qualityPlan.effectiveId] || 1.15;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'zivid-camera-canvas';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'Zivid 2 M70 仿真相机画面');
    renderer.domElement.dataset.cameraReady = 'true';
    renderer.domElement.dataset.sourcePointCount = String(pointCount);
    renderer.domElement.dataset.renderPointCount = String(renderCount);
    renderer.domElement.dataset.downsampled = renderCount < pointCount ? 'true' : 'false';
    renderer.domElement.dataset.rgbRenderPointCount = String(rgbPointRenderCount);
    renderer.domElement.dataset.rgbSurfaceCandidatePointCount = String(
      cameraSurfaceGeometry?.candidatePointCount || 0,
    );
    renderer.domElement.dataset.rgbSurfacePointCount = String(
      cameraSurfaceGeometry?.renderPointCount || 0,
    );
    renderer.domElement.dataset.rgbSurfaceTriangleCount = String(
      cameraSurfaceGeometry?.renderTriangleCount || 0,
    );
    renderer.domElement.dataset.rgbSurfaceSelection = cameraSurfaceGeometry?.selectionMode || 'none';
    renderer.domElement.dataset.sourceMeshFaceCount = String(topology.faceCount);
    renderer.domElement.dataset.cameraMeshCandidateFaceCount = String(rgbMeshCandidateFaceCount);
    renderer.domElement.dataset.renderMeshFaceCount = String(rgbMeshFaceCount);
    renderer.domElement.dataset.cameraMeshSelection = meshSelectionMode;
    renderer.domElement.dataset.meshRenderQuality = qualityPlan.requestedId;
    renderer.domElement.dataset.meshRenderQualityEffective = qualityPlan.effectiveId;
    renderer.domElement.dataset.rgbSurfaceMode = topology.hasMesh
      ? 'embedded-mesh+local-surface'
      : 'local-surface';
    renderer.domElement.dataset.rgbPointLayer = topology.hasMesh
      ? 'local-unreferenced-vertices'
      : 'local-map-points';
    renderer.domElement.dataset.rgbPointsDepthPolicy = topology.hasMesh
      ? 'strictly-in-front-of-mesh'
      : 'standard';
    renderer.domElement.dataset.gpuBufferStrategy = [
      geometry.userData.bufferStrategy,
      cameraMeshGeometry?.geometry?.userData?.bufferStrategy,
      cameraSurfaceGeometry?.meshGeometry?.userData?.bufferStrategy,
      cameraSurfaceGeometry?.pointGeometry?.userData?.bufferStrategy,
    ].filter(Boolean).join('+');
    renderer.domElement.dataset.cameraBufferBytes = String(cameraBufferByteLength);
    renderer.domElement.dataset.sourceBufferReused = 'false';
    renderer.domElement.dataset.pixelRatioCap = String(pixelRatioCap);
    renderer.domElement.dataset.spacemouseViewEnabled = 'false';
    renderer.domElement.dataset.spacemouseControlTarget = 'viewport';
    renderer.domElement.dataset.spacemouseControlModel = 'optical-frame-ik';
    renderer.domElement.dataset.spacemouseZoomPolicy = 'mouse-only';
    renderer.domElement.dataset.spacemouseMotionState = 'idle';
    renderer.domElement.dataset.spacemouseInputCount = String(spaceMouseInputCountRef.current);
    mount.replaceChildren(renderer.domElement);

    let contextAvailable = true;
    let announcedReady = false;
    let lastRenderSignature = '';
    const handleContextLost = (event) => {
      event.preventDefault();
      contextAvailable = false;
      renderer.domElement.dataset.contextState = 'lost';
      setRendererStatus('context-lost');
    };
    const handleContextRestored = () => {
      contextAvailable = true;
      announcedReady = false;
      lastRenderSignature = '';
      renderer.domElement.dataset.contextState = 'restored';
      setRendererStatus('ready');
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02080b);
    const camera = new THREE.PerspectiveCamera(
      ZIVID_M70_PROFILE.verticalFov,
      1,
      ZIVID_M70_PROFILE.near,
      ZIVID_M70_PROFILE.far,
    );
    camera.matrixAutoUpdate = true;
    const surfaceAmbientLight = new THREE.HemisphereLight(0xe8fbff, 0x081115, 1.35);
    const surfaceHeadLight = new THREE.DirectionalLight(0xffffff, 1.7);
    surfaceHeadLight.position.set(0, 0, 0);
    surfaceHeadLight.target.position.set(0, 0, -1);
    camera.add(surfaceHeadLight, surfaceHeadLight.target);
    scene.add(camera, surfaceAmbientLight);
    const rgbMaterial = new THREE.PointsMaterial({
      color: rgbCameraGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
      size: expanded ? 5 : 4,
      sizeAttenuation: false,
      vertexColors: rgbCameraGeometry.hasRgb,
      depthTest: true,
      depthWrite: true,
      depthFunc: topology.hasMesh ? THREE.LessDepth : THREE.LessEqualDepth,
      toneMapped: false,
    });
    const depthMaterial = createDepthMaterial();
    const points = new THREE.Points(rgbCameraGeometry?.geometry || geometry, rgbMaterial);
    points.frustumCulled = false;
    points.renderOrder = 2;
    let rgbMesh = null;
    let rgbMeshMaterial = null;
    if (cameraMeshGeometry?.geometry) {
      rgbMeshMaterial = new THREE.MeshBasicMaterial({
        color: cameraMeshGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
        vertexColors: cameraMeshGeometry.hasRgb,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        toneMapped: false,
      });
      rgbMesh = new THREE.Mesh(cameraMeshGeometry.geometry, rgbMeshMaterial);
      rgbMesh.name = 'zivid-rgb-embedded-map-mesh';
      rgbMesh.frustumCulled = false;
      rgbMesh.renderOrder = 1;
      scene.add(rgbMesh);
    }
    let reconstructedSurface = null;
    let reconstructedSurfaceMaterial = null;
    if (cameraSurfaceGeometry?.meshGeometry) {
      reconstructedSurfaceMaterial = new THREE.MeshStandardMaterial({
        color: cameraSurfaceGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
        vertexColors: cameraSurfaceGeometry.hasRgb,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        roughness: 0.92,
        metalness: 0,
        toneMapped: false,
      });
      reconstructedSurface = new THREE.Mesh(
        cameraSurfaceGeometry.meshGeometry,
        reconstructedSurfaceMaterial,
      );
      reconstructedSurface.name = 'zivid-rgb-local-reconstructed-surface';
      reconstructedSurface.frustumCulled = false;
      reconstructedSurface.renderOrder = 1;
      scene.add(reconstructedSurface);
    }
    scene.add(points);

    let width = 1;
    let height = 1;
    const resize = () => {
      width = Math.max(1, mount.clientWidth);
      height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      depthMaterial.uniforms.uPointSize.value = (expanded ? 2.3 : 1.85)
        * renderer.getPixelRatio();
      const visibleSurfacePointCount = Math.max(
        1,
        cameraSurfaceGeometry?.strictVisiblePointCount
          || cameraSurfaceGeometry?.renderPointCount
          || rgbPointRenderCount,
      );
      rgbMaterial.size = THREE.MathUtils.clamp(
        Math.sqrt((width * height) / visibleSurfacePointCount) * 1.45,
        expanded ? 2.2 : 2.8,
        expanded ? 26 : 20,
      );
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frameId = 0;
    const render = () => {
      const pose = poseRef.current;
      const currentView = viewRef.current;
      const renderSignature = [
        width,
        height,
        renderModeRef.current,
        Number(currentView.zoom) || 1,
        Number(currentView.pan.x) || 0,
        Number(currentView.pan.y) || 0,
        pose?.position?.x || 0,
        pose?.position?.y || 0,
        pose?.position?.z || 0,
        pose?.quaternion?.x || 0,
        pose?.quaternion?.y || 0,
        pose?.quaternion?.z || 0,
        pose?.quaternion?.w ?? 1,
      ].join('|');
      if (renderSignature === lastRenderSignature) {
        frameId = requestAnimationFrame(render);
        return;
      }
      lastRenderSignature = renderSignature;
      if (pose?.position && pose?.quaternion) {
        camera.position.set(pose.position.x, pose.position.y, pose.position.z);
        camera.quaternion
          .set(
            pose.quaternion.x,
            pose.quaternion.y,
            pose.quaternion.z,
            pose.quaternion.w,
          )
          .normalize()
          .multiply(ROS_OPTICAL_TO_THREE_CAMERA);
      }

      const currentZoom = THREE.MathUtils.clamp(
        Number(currentView.zoom) || 1,
        1,
        MAX_DIGITAL_ZOOM,
      );
      camera.clearViewOffset();
      camera.aspect = width / height;
      if (currentZoom > 1.0001) {
        const fullWidth = Math.max(width, Math.round(width * currentZoom));
        const fullHeight = Math.max(height, Math.round(height * currentZoom));
        const maxOffsetX = fullWidth - width;
        const maxOffsetY = fullHeight - height;
        const offsetX = Math.round(
          maxOffsetX * (0.5 + THREE.MathUtils.clamp(currentView.pan.x, -1, 1) * 0.5),
        );
        const offsetY = Math.round(
          maxOffsetY * (0.5 + THREE.MathUtils.clamp(currentView.pan.y, -1, 1) * 0.5),
        );
        camera.setViewOffset(fullWidth, fullHeight, offsetX, offsetY, width, height);
      } else {
        camera.updateProjectionMatrix();
      }

      const pointCloudMode = renderModeRef.current === 'pointcloud';
      points.geometry = pointCloudMode
        ? geometry
        : rgbCameraGeometry?.geometry || geometry;
      points.material = pointCloudMode ? depthMaterial : rgbMaterial;
      points.visible = pointCloudMode || (
        rgbPointRenderCount > 0
        && !cameraSurfaceGeometry?.renderTriangleCount
      );
      if (rgbMesh) rgbMesh.visible = !pointCloudMode;
      if (reconstructedSurface) reconstructedSurface.visible = !pointCloudMode;
      renderer.domElement.dataset.renderMode = renderModeRef.current;
      renderer.domElement.dataset.rgbMeshVisible = rgbMesh && !pointCloudMode ? 'true' : 'false';
      renderer.domElement.dataset.rgbReconstructedSurfaceVisible = reconstructedSurface
        && !pointCloudMode ? 'true' : 'false';
      renderer.domElement.dataset.activePointCount = String(
        pointCloudMode ? renderCount : rgbPointRenderCount,
      );
      renderer.domElement.dataset.cameraSide = activeSide;
      renderer.domElement.dataset.opticalFrame = pose?.frameName || '';
      renderer.domElement.dataset.digitalZoom = currentZoom.toFixed(2);
      renderer.domElement.dataset.panX = Number(currentView.pan.x || 0).toFixed(4);
      renderer.domElement.dataset.panY = Number(currentView.pan.y || 0).toFixed(4);
      if (contextAvailable) {
        try {
          renderer.render(scene, camera);
          if (!announcedReady) {
            announcedReady = true;
            renderer.domElement.dataset.contextState = 'ready';
            setRendererStatus('ready');
          }
        } catch (error) {
          console.warn('Zivid 相机仿真视图渲染失败', error);
          contextAvailable = false;
          renderer.domElement.dataset.contextState = 'error';
          setRendererStatus('error');
        }
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost, false);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored, false);
      points.material = null;
      points.geometry = null;
      geometry.dispose();
      cameraSurfaceGeometry?.pointGeometry?.dispose();
      cameraSurfaceGeometry?.meshGeometry?.dispose();
      globalRgbFallbackGeometry?.geometry?.dispose();
      cameraMeshGeometry?.geometry?.dispose();
      rgbMaterial.dispose();
      depthMaterial.dispose();
      rgbMeshMaterial?.dispose();
      reconstructedSurfaceMaterial?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [
    activeSide,
    enabled,
    expanded,
    mapData?.geometry,
    meshRenderQuality,
    settledCameraMeshRegionKey,
  ]);

  if (!enabled) return null;

  const changeZoom = (nextValue) => {
    setZoom((current) => THREE.MathUtils.clamp(
      typeof nextValue === 'function' ? nextValue(current) : nextValue,
      1,
      MAX_DIGITAL_ZOOM,
    ));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const spaceMouseDeviceReady = Boolean(
    spaceMouseStatus.connected
    && spaceMouseStatus.calibrated
    && !spaceMouseStatus.calibrating,
  );
  const spaceMouseSwitchReady = Boolean(
    spaceMouseDeviceReady
    && cameraTeachingEnabled
    && activePose,
  );
  const selectedSpaceMouseMeta = ZIVID_SPACEMOUSE_ACTIONS[spaceMouseStatus.selectedAxis]
    || ZIVID_SPACEMOUSE_ACTIONS.x;
  const spaceMouseSwitchState = !spaceMouseStatus.connected
    ? '未连接'
    : spaceMouseStatus.calibrating
      ? '标定中'
      : !spaceMouseStatus.calibrated
        ? '待标定'
        : !cameraTeachingEnabled
          ? '示教未就绪'
          : !spaceMouseStatus.controlEnabled
            ? '已暂停'
            : spaceMouseViewEnabled ? '正在控制' : '可启用';
  const spaceMouseSwitchTitle = !spaceMouseStatus.connected
    ? '请先使用顶部“检测3D鼠标”连接 SpaceMouse'
    : !spaceMouseStatus.calibrated || spaceMouseStatus.calibrating
      ? '请先完成 SpaceMouse 标定'
      : !cameraTeachingEnabled
        ? '请先新建匹配当前地图与机器人的示教任务'
        : spaceMouseViewEnabled
          ? '关闭后 SpaceMouse 将恢复控制主 3D 视角'
          : '驱动当前 Zivid optical frame 与机械臂 IK；缩放仍只由鼠标控制';

  const panel = (
    <section
      className={`zivid-camera-panel ${expanded ? 'is-expanded' : ''} ${teachingMode === 'camera' ? 'has-teaching-controls' : ''}`}
      aria-label="Zivid 2 M70 相机视图"
      data-zivid-model="zivid-2-m70"
      data-camera-side={activeSide}
      data-render-mode={renderMode}
      data-renderer-status={rendererStatus}
      data-rgb-surface-mode={hasEmbeddedMesh ? 'embedded-mesh+local-surface' : 'local-surface'}
      data-mesh-render-quality={meshQualityPlan.requestedId}
      data-camera-mesh-selection={cameraMeshStats.selectionMode}
      data-camera-mesh-candidate-face-count={cameraMeshStats.candidateFaceCount}
      data-rendered-mesh-face-count={cameraMeshStats.renderFaceCount}
      data-rgb-surface-candidate-point-count={cameraMeshStats.surfaceCandidatePointCount}
      data-rgb-surface-point-count={cameraMeshStats.surfacePointCount}
      data-rgb-surface-triangle-count={cameraMeshStats.surfaceTriangleCount}
      data-rgb-surface-selection={cameraMeshStats.surfaceSelectionMode}
      data-horizontal-fov={ZIVID_M70_PROFILE.horizontalFov}
      data-vertical-fov={ZIVID_M70_PROFILE.verticalFov}
      data-working-near={ZIVID_M70_PROFILE.near}
      data-working-far={ZIVID_M70_PROFILE.far}
      data-native-resolution={`${ZIVID_M70_PROFILE.nativeWidth}x${ZIVID_M70_PROFILE.nativeHeight}`}
      data-optical-frame={activePose?.frameName || ''}
      data-visible-point-estimate={frustumStats.estimated}
      data-zoom={zoom.toFixed(2)}
      data-camera-teaching-mode={teachingMode === 'camera' ? 'active' : 'hidden'}
      data-spacemouse-view-enabled={spaceMouseViewEnabled ? 'true' : 'false'}
      data-spacemouse-ready={spaceMouseSwitchReady ? 'true' : 'false'}
      data-spacemouse-control-target={spaceMouseViewEnabled ? 'zivid-camera' : 'viewport'}
      data-spacemouse-selected-axis={spaceMouseStatus.selectedAxis}
      data-spacemouse-control-model="optical-frame-ik"
      data-spacemouse-zoom-policy="mouse-only"
      data-spacemouse-input-count={spaceMouseHud.inputCount}
      data-main-view-preview={expanded ? 'visible' : 'hidden'}
    >
      <header className="zivid-camera-panel__header">
        <div className="zivid-camera-panel__identity">
          <span><Camera size={13} /></span>
          <div>
            <small>END-EFFECTOR VISION · SIM</small>
            <strong>Zivid 2 M70</strong>
          </div>
        </div>
        <div className="zivid-camera-panel__live"><i /> OPTICAL LINK</div>
        {expanded && (
          <button
            type="button"
            className={`zivid-camera-joint-toggle ${jointControlOpen ? 'is-active' : ''}`}
            aria-label={jointControlOpen ? '全关节控制已打开' : '打开全关节控制'}
            aria-pressed={jointControlOpen}
            title={jointControlOpen
              ? '全关节控制浮窗已打开'
              : '打开全关节控制浮窗，并在观察相机画面时调整机器人姿态'}
            disabled={!onOpenJointControl}
            onClick={() => onOpenJointControl?.()}
          >
            <SlidersHorizontal size={13} />
            <span>
              <strong>关节调整</strong>
              <small>{jointControlOpen ? '窗口已打开' : '打开控制卡片'}</small>
            </span>
          </button>
        )}
        {expanded && (
          <button
            type="button"
            className={`zivid-camera-spacemouse-toggle ${spaceMouseViewEnabled ? 'is-active' : ''} ${!spaceMouseStatus.controlEnabled ? 'is-paused' : ''}`}
            aria-label={spaceMouseViewEnabled
              ? '关闭 SpaceMouse 相机视角控制'
              : '启用 SpaceMouse 相机视角控制'}
            aria-pressed={spaceMouseViewEnabled}
            title={spaceMouseSwitchTitle}
            disabled={!spaceMouseViewEnabled && !spaceMouseSwitchReady}
            onClick={() => {
              if (!spaceMouseViewEnabled && !spaceMouseSwitchReady) return;
              setSpaceMouseViewEnabled((current) => !current);
            }}
          >
            <Move3D size={13} />
            <span>
              <strong>SpaceMouse 视角</strong>
              <small>{spaceMouseSwitchState}</small>
            </span>
            <em
              className={`zivid-camera-spacemouse-axis ${spaceMouseHud.active ? 'is-moving' : ''}`}
              data-axis={spaceMouseStatus.selectedAxis}
              data-axis-code={selectedSpaceMouseMeta.code}
              aria-hidden="true"
            >
              <small>{selectedSpaceMouseMeta.group}</small>
              <b>{spaceMouseStatus.controlEnabled ? selectedSpaceMouseMeta.code : 'PAUSE'}</b>
            </em>
            <i aria-hidden="true"><b /></i>
          </button>
        )}
        <button
          type="button"
          className="zivid-camera-expand"
          aria-label={expanded ? '关闭 Zivid 相机大图' : '放大 Zivid 相机视图'}
          title={expanded ? '关闭大图' : '放大查看'}
          onClick={() => {
            const nextExpanded = !expanded;
            onExpandedChange?.(nextExpanded);
            setExpanded(nextExpanded);
          }}
        >
          {expanded ? <X size={14} /> : <Maximize2 size={13} />}
        </button>
      </header>

      <div className="zivid-camera-toolbar">
        <div className="zivid-camera-sides" role="group" aria-label="选择末端相机">
          {['left', 'right'].map((side) => (
            <button
              type="button"
              key={side}
              className={activeSide === side ? 'is-active' : ''}
              aria-pressed={activeSide === side}
              onClick={() => {
                setInternalActiveSide(side);
                onActiveSideChange?.(side);
                resetView();
              }}
            >
              {side === 'left' ? '左臂 M70' : '右臂 M70'}
            </button>
          ))}
        </div>
        <div className="zivid-camera-modes" role="group" aria-label="相机渲染模式">
          <button
            type="button"
            className={renderMode === 'rgb' ? 'is-active' : ''}
            aria-pressed={renderMode === 'rgb'}
            onClick={() => setRenderMode('rgb')}
          >
            <Camera size={11} /> RGB
          </button>
          <button
            type="button"
            className={renderMode === 'pointcloud' ? 'is-active' : ''}
            aria-pressed={renderMode === 'pointcloud'}
            onClick={() => setRenderMode('pointcloud')}
          >
            <Cloud size={11} /> 点云
          </button>
        </div>
        {hasEmbeddedMesh && (
          <label
            className={`zivid-camera-quality tone-${meshQualityPlan.effectiveId}`}
            title={`主 3D 与相机同步：${meshQualityPlan.renderedFaceCount.toLocaleString('zh-CN')} / ${meshQualityPlan.faceCount.toLocaleString('zh-CN')} 面`}
          >
            <Gauge size={11} />
            <select
              aria-label="相机网格渲染质量"
              value={meshQualityPlan.requestedId}
              onChange={(event) => onMeshRenderQualityChange?.(event.target.value)}
            >
              {MESH_RENDER_QUALITY_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}{option.id === 'auto' ? '（推荐）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div
        className={`zivid-camera-viewport ${dragging ? 'is-dragging' : ''}`}
        aria-label="M70 相机画面交互区"
        onWheel={(event) => {
          event.preventDefault();
          changeZoom((current) => current * Math.exp(-event.deltaY * 0.0018));
        }}
        onDoubleClick={resetView}
        onPointerDown={(event) => {
          if (event.target.closest('button')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            pan,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || zoom <= 1) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setPan({
            x: THREE.MathUtils.clamp(
              drag.pan.x - ((event.clientX - drag.x) * 2) / Math.max(bounds.width, 1),
              -1,
              1,
            ),
            y: THREE.MathUtils.clamp(
              drag.pan.y - ((event.clientY - drag.y) * 2) / Math.max(bounds.height, 1),
              -1,
              1,
            ),
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div ref={mountRef} className="zivid-camera-render-mount" />
        <div className="zivid-camera-scan-grid" aria-hidden="true" />
        {expanded && (
          <MainViewportThumbnail sourceCanvasRef={mainViewportCanvasRef} />
        )}
        {expanded && (
          <div
            className={`zivid-camera-spacemouse-hud ${spaceMouseHud.visible ? 'is-visible' : ''} ${spaceMouseHud.active ? 'is-active' : ''}`}
            aria-label="SpaceMouse 相机控制轴"
            aria-hidden={!spaceMouseHud.visible}
            data-axis={spaceMouseHud.axis}
            data-motion-state={spaceMouseHud.active ? 'active' : 'hold'}
            data-input-count={spaceMouseHud.inputCount}
          >
            <span>{spaceMouseHud.group}</span>
            <strong>{spaceMouseHud.code}</strong>
            <div>
              <b>{spaceMouseHud.label}</b>
              <i>
                <em style={{ width: `${Math.round(Math.abs(spaceMouseHud.value) * 100)}%` }} />
              </i>
            </div>
          </div>
        )}
        <div className="zivid-camera-reticle" aria-hidden="true"><span /><i /></div>
        <div className="zivid-camera-corner top-left" aria-hidden="true" />
        <div className="zivid-camera-corner top-right" aria-hidden="true" />
        <div className="zivid-camera-corner bottom-left" aria-hidden="true" />
        <div className="zivid-camera-corner bottom-right" aria-hidden="true" />
        <div className="zivid-camera-frame-meta top">
          <span>
            {renderMode === 'rgb'
              ? hasEmbeddedMesh ? 'RGB NATIVE + LOCAL SURFACE' : 'RGB LOCAL SURFACE'
              : 'XYZ DEPTH CLOUD'}
          </span>
          <strong>{activeSide === 'left' ? 'CAM-L' : 'CAM-R'}</strong>
        </div>
        <div className="zivid-camera-frame-meta bottom">
          <span>{poseLabel(activePose)}</span>
          <strong>{zoom.toFixed(1)}×</strong>
        </div>
        {!activePose && (
          <div className="zivid-camera-empty"><Focus size={17} /> 正在同步光学坐标系</div>
        )}
        {rendererStatus === 'error' && (
          <div className="zivid-camera-empty"><Focus size={15} /> 相机渲染器不可用 · 主界面仍可操作</div>
        )}
        {rendererStatus === 'context-lost' && (
          <div className="zivid-camera-empty"><Focus size={15} /> 相机显存正在恢复 · 主界面仍可操作</div>
        )}
        {activePose
          && frustumStats.checked > 0
          && frustumStats.estimated === 0
          && (renderMode === 'pointcloud' || !hasEmbeddedMesh) && (
          <div className="zivid-camera-empty is-quiet"><Focus size={15} /> 当前视锥内暂无地图回波</div>
        )}
        {renderMode === 'rgb' && !hasRgb && (
          <div className="zivid-camera-rgb-warning">
            地图无 RGB 通道 · 灰度显示
          </div>
        )}
        {renderMode === 'rgb'
          && activePose
          && cameraMeshStats.candidateFaceCount === 0
          && cameraMeshStats.surfaceTriangleCount === 0
          && cameraMeshStats.surfacePointCount === 0 && (
          <div className="zivid-camera-empty is-quiet"><Focus size={15} /> 当前视锥内暂无可渲染表面</div>
        )}
        {renderMode === 'pointcloud' && (
          <div className="zivid-depth-legend" aria-label="点云深度色标">
            <span>0.30 m</span><i /><span>1.30 m</span>
          </div>
        )}
        <div className="zivid-camera-zoom-controls" role="group" aria-label="相机画面缩放">
          <button
            type="button"
            aria-label="缩小相机画面"
            title="缩小"
            disabled={zoom <= 1}
            onClick={() => changeZoom((current) => current / 1.55)}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            aria-label="重置相机缩放"
            title="重置缩放和拖拽偏移"
            disabled={zoom <= 1 && pan.x === 0 && pan.y === 0}
            onClick={resetView}
          >
            <RotateCcw size={12} />
          </button>
          <button
            type="button"
            aria-label="放大相机画面"
            title="放大"
            disabled={zoom >= MAX_DIGITAL_ZOOM}
            onClick={() => changeZoom((current) => current * 1.55)}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {teachingMode === 'camera' && (
        <CameraTeachingControls
          enabled={cameraTeachingEnabled}
          activeSide={activeSide}
          cameraPoses={cameraPoses}
          result={cameraTeachingResult}
          onMove={onCameraTeachingMove}
        />
      )}

      <div className="zivid-camera-specs">
        <span><small>NATIVE</small>{ZIVID_M70_PROFILE.nativeWidth} × {ZIVID_M70_PROFILE.nativeHeight}</span>
        <span><small>FOV @ 0.70 m</small>{ZIVID_M70_PROFILE.focusWidthMm} × {ZIVID_M70_PROFILE.focusHeightMm} mm</span>
        <span><small>WORKING DIST.</small>{ZIVID_M70_PROFILE.near.toFixed(2)}—{ZIVID_M70_PROFILE.far.toFixed(2)} m</span>
      </div>
      <footer className="zivid-camera-panel__footer">
        <span><i /> 仿真视图 · RGB 实体表面 / XYZ 点云</span>
        <span>FOV {ZIVID_M70_PROFILE.horizontalFov.toFixed(1)}° × {ZIVID_M70_PROFILE.verticalFov.toFixed(1)}°</span>
        <strong>
          {renderMode === 'rgb'
            ? cameraMeshStats.renderFaceCount + cameraMeshStats.surfaceTriangleCount > 0
              ? `${compactNumber(cameraMeshStats.renderFaceCount + cameraMeshStats.surfaceTriangleCount)} TRI`
              : cameraMeshStats.surfacePointCount > 0
                ? `${compactNumber(cameraMeshStats.surfacePointCount)} SURF`
                : 'NO SURFACE'
            : `≈ ${compactNumber(frustumStats.estimated)} PTS`}
        </strong>
      </footer>
    </section>
  );

  if (!expanded) return panel;
  return createPortal(
    <div
      className="zivid-camera-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Zivid 2 M70 相机大图"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setExpanded(false);
      }}
    >
      {panel}
    </div>,
    document.body,
  );
}
