import * as THREE from 'three';

export const VISION_COVERAGE_MODE = 'surface-truncated-optical-frusta';
export const VISION_COVERAGE_SURFACE_STOP = 'first-point-depth-grid';

const DEFAULT_GRID_COLUMNS = 14;
const DEFAULT_GRID_ROWS = 9;
const MINIMUM_DEPTH = 1e-4;
const DEFAULT_SURFACE_TINT_MINIMUM_TOLERANCE = 0.018;
const DEFAULT_SURFACE_TINT_MAXIMUM_TOLERANCE = 0.12;
const DEFAULT_SURFACE_TINT_RELATIVE_TOLERANCE = 0.025;
const DEFAULT_SURFACE_TINT_CELL_TOLERANCE = 0.72;
const CAMERA_SIDE_COLORS = Object.freeze({
  left: 0x59dbe8,
  right: 0xf4c95d,
});

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const base64Bytes = (value) => {
  const encoded = String(value || '').trim();
  if (!encoded || typeof globalThis.atob !== 'function') return new Uint8Array();
  try {
    const binary = globalThis.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
};

export const decodeTeachingPointCloudPositions = (pointCloud) => {
  if (!pointCloud || !/uint16-le/i.test(String(pointCloud.positionEncoding || ''))) {
    return new Float32Array();
  }
  const bytes = base64Bytes(pointCloud.positionData);
  const pointCount = Math.min(
    Math.max(0, Math.floor(finiteNumber(pointCloud.pointCount))),
    Math.floor(bytes.byteLength / 6),
  );
  if (!pointCount) return new Float32Array();
  const offset = [0, 1, 2].map((axis) => finiteNumber(pointCloud.positionOffset?.[axis]));
  const scale = [0, 1, 2].map((axis) => finiteNumber(pointCloud.positionScale?.[axis]));
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(pointCount * 3);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const componentIndex = pointIndex * 3 + axis;
      positions[componentIndex] = offset[axis]
        + source.getUint16(componentIndex * 2, true) * scale[axis];
    }
  }
  return positions;
};

const firstSurfaceDepth = (values) => {
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  const robustIndex = values.length >= 6
    ? Math.min(values.length - 1, Math.floor(values.length * 0.08))
    : 0;
  return values[robustIndex];
};

const fillInteriorDepthHoles = (depths, columns, rows) => {
  let current = depths;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = [...current];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (current[index] !== null) continue;
        const neighbors = [];
        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            if (!rowOffset && !columnOffset) continue;
            const neighborRow = row + rowOffset;
            const neighborColumn = column + columnOffset;
            if (
              neighborRow < 0
              || neighborRow >= rows
              || neighborColumn < 0
              || neighborColumn >= columns
            ) continue;
            const depth = current[neighborRow * columns + neighborColumn];
            if (depth !== null) neighbors.push(depth);
          }
        }
        if (neighbors.length >= 3) {
          neighbors.sort((left, right) => left - right);
          next[index] = neighbors[Math.floor(neighbors.length / 2)];
        }
      }
    }
    current = next;
  }
  return current;
};

export const buildVisionCoverageDepthGrid = (
  pointCloud,
  calibration,
  options = {},
) => {
  const columns = Math.max(4, Math.floor(finiteNumber(
    options.columns,
    DEFAULT_GRID_COLUMNS,
  )));
  const rows = Math.max(3, Math.floor(finiteNumber(options.rows, DEFAULT_GRID_ROWS)));
  const horizontalFov = THREE.MathUtils.clamp(
    finiteNumber(calibration?.horizontalFov, 56.6),
    1,
    175,
  );
  const verticalFov = THREE.MathUtils.clamp(
    finiteNumber(calibration?.verticalFov, 35.6),
    1,
    175,
  );
  const near = Math.max(
    MINIMUM_DEPTH,
    finiteNumber(calibration?.workingNear, 0.3),
  );
  const far = Math.max(near, finiteNumber(calibration?.workingFar, 1.3));
  const tangentX = Math.tan(THREE.MathUtils.degToRad(horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(verticalFov / 2));
  const buckets = Array.from({ length: columns * rows }, () => []);
  const positions = decodeTeachingPointCloudPositions(pointCloud);

  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x + y + z) || z < near || z > far) continue;
    const normalizedX = x / Math.max(z * tangentX, MINIMUM_DEPTH);
    const normalizedY = y / Math.max(z * tangentY, MINIMUM_DEPTH);
    if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) continue;
    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((normalizedX + 1) / 2) * columns)),
    );
    const row = Math.min(
      rows - 1,
      Math.max(0, Math.floor(((normalizedY + 1) / 2) * rows)),
    );
    buckets[row * columns + column].push(z);
  }

  const measuredDepths = buckets.map(firstSurfaceDepth);
  const surfaceDepths = fillInteriorDepthHoles(measuredDepths, columns, rows);
  const surfaceCellCount = surfaceDepths.filter((value) => Number.isFinite(value)).length;
  const depths = surfaceDepths.map((value) => Number.isFinite(value) ? value : far);
  const finiteDepths = depths.filter((value) => Number.isFinite(value));
  return {
    columns,
    rows,
    horizontalFov,
    verticalFov,
    near,
    far,
    depths,
    surfaceDepths,
    measuredCellCount: measuredDepths.filter((value) => value !== null).length,
    surfaceCellCount,
    rangeLimitedCellCount: depths.length - surfaceCellCount,
    renderCellCount: finiteDepths.length,
    pointCount: positions.length / 3,
    minimumDepth: finiteDepths.length ? Math.min(...finiteDepths) : null,
    maximumDepth: finiteDepths.length ? Math.max(...finiteDepths) : null,
  };
};

const addTriangle = (target, first, second, third) => {
  target.push(...first, ...second, ...third);
};

const addQuad = (target, first, second, third, fourth) => {
  addTriangle(target, first, second, third);
  addTriangle(target, first, third, fourth);
};

const localSurfacePoint = (normalizedX, normalizedY, depth, tangentX, tangentY) => [
  normalizedX * tangentX * depth,
  normalizedY * tangentY * depth,
  depth,
];

const buildCoverageGeometry = (grid) => {
  const positions = [];
  const tangentX = Math.tan(THREE.MathUtils.degToRad(grid.horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(grid.verticalFov / 2));
  const origin = [0, 0, 0];
  const cellDepth = (column, row) => (
    column < 0 || column >= grid.columns || row < 0 || row >= grid.rows
      ? null
      : grid.depths[row * grid.columns + column]
  );
  const cellCorners = (column, row, depth) => {
    const x0 = -1 + (column / grid.columns) * 2;
    const x1 = -1 + ((column + 1) / grid.columns) * 2;
    const y0 = -1 + (row / grid.rows) * 2;
    const y1 = -1 + ((row + 1) / grid.rows) * 2;
    return [
      localSurfacePoint(x0, y0, depth, tangentX, tangentY),
      localSurfacePoint(x1, y0, depth, tangentX, tangentY),
      localSurfacePoint(x1, y1, depth, tangentX, tangentY),
      localSurfacePoint(x0, y1, depth, tangentX, tangentY),
    ];
  };

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const depth = cellDepth(column, row);
      if (!Number.isFinite(depth)) continue;
      const corners = cellCorners(column, row, depth);
      addQuad(positions, corners[0], corners[1], corners[2], corners[3]);

      if (column === 0 || !Number.isFinite(cellDepth(column - 1, row))) {
        addTriangle(positions, origin, corners[3], corners[0]);
      }
      if (
        column === grid.columns - 1
        || !Number.isFinite(cellDepth(column + 1, row))
      ) {
        addTriangle(positions, origin, corners[1], corners[2]);
      }
      if (row === 0 || !Number.isFinite(cellDepth(column, row - 1))) {
        addTriangle(positions, origin, corners[0], corners[1]);
      }
      if (
        row === grid.rows - 1
        || !Number.isFinite(cellDepth(column, row + 1))
      ) {
        addTriangle(positions, origin, corners[2], corners[3]);
      }

      const rightDepth = cellDepth(column + 1, row);
      if (Number.isFinite(rightDepth) && Math.abs(rightDepth - depth) > 1e-4) {
        const rightCorners = cellCorners(column + 1, row, rightDepth);
        addQuad(positions, corners[1], rightCorners[0], rightCorners[3], corners[2]);
      }
      const lowerDepth = cellDepth(column, row + 1);
      if (Number.isFinite(lowerDepth) && Math.abs(lowerDepth - depth) > 1e-4) {
        const lowerCorners = cellCorners(column, row + 1, lowerDepth);
        addQuad(positions, corners[3], corners[2], lowerCorners[1], lowerCorners[0]);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

export const collectTeachingVisionCoverageFrames = (tasks) => (
  (Array.isArray(tasks) ? tasks : []).flatMap((task) => (
    (task?.parkingPoints || []).flatMap((parkingPoint) => (
      (parkingPoint?.poses || []).flatMap((pose) => (
        ['left', 'right'].flatMap((side) => {
          const capture = pose?.cameraCapture;
          const frame = capture?.frames?.[side];
          if (!frame?.opticalPose || !frame?.pointCloud) return [];
          return [{
            key: [task.id, parkingPoint.id, pose.id, side].filter(Boolean).join(':'),
            taskId: task.id,
            parkingPointId: parkingPoint.id,
            poseId: pose.id,
            poseName: pose.name,
            side,
            calibration: capture.calibration,
            frame,
          }];
        })
      ))
    ))
  ))
);

export const prepareTeachingVisionCoverageFrames = (records, options = {}) => (
  (Array.isArray(records) ? records : []).flatMap((record) => {
    const pose = record?.frame?.opticalPose;
    if (!pose?.position || !pose?.quaternion) return [];
    const quaternion = new THREE.Quaternion(
      finiteNumber(pose.quaternion.x),
      finiteNumber(pose.quaternion.y),
      finiteNumber(pose.quaternion.z),
      finiteNumber(pose.quaternion.w, 1),
    );
    if (quaternion.lengthSq() < 1e-12) quaternion.identity();
    else quaternion.normalize();
    const worldToCamera = new THREE.Matrix4()
      .compose(
        new THREE.Vector3(
          finiteNumber(pose.position.x),
          finiteNumber(pose.position.y),
          finiteNumber(pose.position.z),
        ),
        quaternion,
        new THREE.Vector3(1, 1, 1),
      )
      .invert();
    const grid = buildVisionCoverageDepthGrid(
      record.frame.pointCloud,
      record.calibration,
      options,
    );
    return [{
      record,
      grid,
      worldToCamera: Float64Array.from(worldToCamera.elements),
      tangentX: Math.tan(THREE.MathUtils.degToRad(grid.horizontalFov / 2)),
      tangentY: Math.tan(THREE.MathUtils.degToRad(grid.verticalFov / 2)),
    }];
  })
);

export const markTeachingSurfaceCoverageRange = (
  positionAttribute,
  preparedFrames,
  targetMask,
  startPoint = 0,
  endPoint = positionAttribute?.count || 0,
  options = {},
) => {
  const positions = positionAttribute?.array;
  const itemSize = Math.max(3, Number(positionAttribute?.itemSize) || 3);
  const pointCount = Math.min(
    Number(positionAttribute?.count) || 0,
    Math.floor((positions?.length || 0) / itemSize),
    targetMask?.length || 0,
  );
  if (!pointCount || !Array.isArray(preparedFrames) || !preparedFrames.length) return 0;

  const minimumTolerance = Math.max(0, finiteNumber(
    options.minimumTolerance,
    DEFAULT_SURFACE_TINT_MINIMUM_TOLERANCE,
  ));
  const maximumTolerance = Math.max(minimumTolerance, finiteNumber(
    options.maximumTolerance,
    DEFAULT_SURFACE_TINT_MAXIMUM_TOLERANCE,
  ));
  const relativeTolerance = Math.max(0, finiteNumber(
    options.relativeTolerance,
    DEFAULT_SURFACE_TINT_RELATIVE_TOLERANCE,
  ));
  const cellTolerance = Math.max(0, finiteNumber(
    options.cellTolerance,
    DEFAULT_SURFACE_TINT_CELL_TOLERANCE,
  ));
  const firstPoint = Math.max(0, Math.floor(finiteNumber(startPoint)));
  const lastPoint = Math.min(
    pointCount,
    Math.max(firstPoint, Math.floor(finiteNumber(endPoint, pointCount))),
  );
  let newlyCovered = 0;

  for (let pointIndex = firstPoint; pointIndex < lastPoint; pointIndex += 1) {
    if (targetMask[pointIndex] >= 1) continue;
    const sourceOffset = pointIndex * itemSize;
    const worldX = positions[sourceOffset];
    const worldY = positions[sourceOffset + 1];
    const worldZ = positions[sourceOffset + 2];
    if (!Number.isFinite(worldX + worldY + worldZ)) continue;

    for (let frameIndex = 0; frameIndex < preparedFrames.length; frameIndex += 1) {
      const frame = preparedFrames[frameIndex];
      const matrix = frame.worldToCamera;
      const grid = frame.grid;
      const localX = matrix[0] * worldX
        + matrix[4] * worldY
        + matrix[8] * worldZ
        + matrix[12];
      const localY = matrix[1] * worldX
        + matrix[5] * worldY
        + matrix[9] * worldZ
        + matrix[13];
      const localZ = matrix[2] * worldX
        + matrix[6] * worldY
        + matrix[10] * worldZ
        + matrix[14];
      if (localZ < grid.near || localZ > grid.far) continue;

      const normalizedX = localX / Math.max(localZ * frame.tangentX, MINIMUM_DEPTH);
      const normalizedY = localY / Math.max(localZ * frame.tangentY, MINIMUM_DEPTH);
      if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) continue;
      const column = Math.min(
        grid.columns - 1,
        Math.max(0, Math.floor(((normalizedX + 1) / 2) * grid.columns)),
      );
      const row = Math.min(
        grid.rows - 1,
        Math.max(0, Math.floor(((normalizedY + 1) / 2) * grid.rows)),
      );
      const surfaceDepth = grid.surfaceDepths[row * grid.columns + column];
      if (!Number.isFinite(surfaceDepth)) continue;

      const cellWidth = (2 * frame.tangentX * surfaceDepth) / grid.columns;
      const cellHeight = (2 * frame.tangentY * surfaceDepth) / grid.rows;
      const adaptiveTolerance = Math.max(
        minimumTolerance,
        surfaceDepth * relativeTolerance,
        Math.hypot(cellWidth, cellHeight) * cellTolerance,
      );
      const tolerance = Math.min(maximumTolerance, adaptiveTolerance);
      if (
        localZ >= surfaceDepth - tolerance
        && localZ <= surfaceDepth + tolerance
      ) {
        targetMask[pointIndex] = 1;
        newlyCovered += 1;
        break;
      }
    }
  }
  return newlyCovered;
};

export const buildTeachingSurfaceCoverageMask = (
  positionAttribute,
  preparedFrames,
  options = {},
) => {
  const mask = new Float32Array(Math.max(0, Number(positionAttribute?.count) || 0));
  const coveredPointCount = markTeachingSurfaceCoverageRange(
    positionAttribute,
    preparedFrames,
    mask,
    0,
    mask.length,
    options,
  );
  return { mask, coveredPointCount };
};

export const createTeachingVisionCoverageVolume = (record, options = {}) => {
  const pose = record?.frame?.opticalPose;
  if (!pose?.position || !pose?.quaternion) return null;
  const grid = options.grid || buildVisionCoverageDepthGrid(
    record.frame.pointCloud,
    record.calibration,
    options,
  );
  if (!grid.renderCellCount) return null;

  const color = CAMERA_SIDE_COLORS[record.side] || CAMERA_SIDE_COLORS.left;
  const geometry = buildCoverageGeometry(grid);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: record.side === 'right' ? 0.085 : 0.095,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'surface-truncated-vision-volume';
  mesh.renderOrder = 8;

  const edgesGeometry = new THREE.EdgesGeometry(geometry, 32);
  const edgesMaterial = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.34,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
  edges.name = 'vision-volume-surface-edges';
  edges.renderOrder = 9;

  const opticalMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 12, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  opticalMarker.name = 'captured-optical-center';
  opticalMarker.renderOrder = 10;

  const group = new THREE.Group();
  group.name = `teaching-vision-coverage:${record.key || record.side}`;
  group.position.set(
    finiteNumber(pose.position.x),
    finiteNumber(pose.position.y),
    finiteNumber(pose.position.z),
  );
  group.quaternion.set(
    finiteNumber(pose.quaternion.x),
    finiteNumber(pose.quaternion.y),
    finiteNumber(pose.quaternion.z),
    finiteNumber(pose.quaternion.w, 1),
  ).normalize();
  group.userData.coverage = {
    key: record.key,
    poseId: record.poseId,
    side: record.side,
    mode: VISION_COVERAGE_MODE,
    surfaceStop: VISION_COVERAGE_SURFACE_STOP,
    ...grid,
    depths: undefined,
    surfaceDepths: undefined,
  };
  group.add(mesh, edges, opticalMarker);
  return group;
};
