import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  buildTeachingSurfaceCoverageMask,
  createTeachingSurfaceProjectionOverlay,
  createTeachingVisionCoverageVolume,
  disposeTeachingSurfaceProjectionOverlay,
  TEACHING_SURFACE_PROJECTION_MODE,
  VISION_COVERAGE_EMPTY_CELL_MODE,
} from '../src/lib/visionCoverage.js';

const positions = new THREE.Float32BufferAttribute([
  -0.35, 0, 0.60, // In front of a measured surface: covered.
  0.35, 0, 0.70, // Empty depth cell: omitted because it never hit a surface.
  -0.35, 0, 1.05, // Behind the first measured surface: occluded.
  1.20, 0, 0.60, // Outside the optical field of view.
], 3);

const identity = new THREE.Matrix4();
const preparedFrame = {
  worldToCamera: Float64Array.from(identity.elements),
  tangentX: 1,
  tangentY: 1,
  grid: {
    columns: 2,
    rows: 1,
    near: 0.3,
    far: 1.3,
    horizontalFov: 90,
    verticalFov: 90,
    depths: [0.8, 1.3],
    surfaceDepths: [0.8, null],
    sampleCellCount: 2,
    surfaceCellCount: 1,
    rangeLimitedCellCount: 1,
    renderCellCount: 1,
    minimumDepth: 0.8,
    maximumDepth: 0.8,
  },
};

const { mask, coveredPointCount } = buildTeachingSurfaceCoverageMask(
  positions,
  [preparedFrame],
);

assert.equal(TEACHING_SURFACE_PROJECTION_MODE, 'continuous-surface-hit-envelope');
assert.equal(VISION_COVERAGE_EMPTY_CELL_MODE, 'omit-unhit-cells');
assert.equal(coveredPointCount, 1);
assert.deepEqual([...mask], [1, 0, 0, 0]);
assert.equal(Math.max(...mask), 1);

const meshGeometry = new THREE.BufferGeometry();
meshGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  -1, -1, 0.6,
  1, -1, 0.6,
  0, 1, 0.6,
], 3));
meshGeometry.setIndex([0, 1, 2]);
const projection = createTeachingSurfaceProjectionOverlay(
  meshGeometry,
  [preparedFrame],
  { opacity: 0.05 },
);
assert.ok(projection);
assert.equal(projection.mesh.geometry, meshGeometry);
assert.equal(projection.mesh.name, 'teaching-surface-continuous-projection');
assert.equal(
  projection.mesh.userData.coverageProjection.rasterization,
  'per-fragment-depth-atlas',
);
assert.equal(projection.mesh.userData.coverageProjection.binaryUnion, true);
assert.equal(
  projection.mesh.userData.coverageProjection.emptyCellMode,
  'omit-unhit-cells',
);
assert.match(projection.material.fragmentShader, /vAtlasCoverageWorldPosition/);
assert.match(projection.material.fragmentShader, /stopDepth <= 0\.0/);
assert.equal(projection.material.uniforms.atlasCoverageOpacity.value, 0.05);
assert.ok(Math.abs(projection.textures[1].image.data[0] - 0.8) < 1e-6);
assert.equal(projection.textures[1].image.data[1], 0);
disposeTeachingSurfaceProjectionOverlay(projection);
meshGeometry.dispose();

const volume = createTeachingVisionCoverageVolume({
  key: 'surface-hit-volume',
  poseId: 'pose-1',
  side: 'left',
  frame: {
    opticalPose: {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    },
    pointCloud: {},
  },
}, { grid: preparedFrame.grid });
assert.ok(volume);
assert.equal(volume.userData.coverage.emptyCellMode, 'omit-unhit-cells');
assert.equal(volume.userData.coverage.sampleCellCount, 2);
assert.equal(volume.userData.coverage.renderCellCount, 1);
assert.equal(volume.userData.coverage.rangeLimitedCellCount, 1);
const volumeMesh = volume.getObjectByName('surface-truncated-vision-volume');
const volumeOutline = volume.getObjectByName('vision-volume-outer-silhouette');
assert.equal(volumeMesh.geometry.index.count, 18);
assert.equal(volumeOutline.geometry.getAttribute('position').count, 16);
volume.traverse((child) => {
  child.geometry?.dispose?.();
  if (Array.isArray(child.material)) {
    child.material.forEach((material) => material?.dispose?.());
  } else {
    child.material?.dispose?.();
  }
});

const emptyGrid = {
  ...preparedFrame.grid,
  depths: [1.3, 1.3],
  surfaceDepths: [null, null],
  surfaceCellCount: 0,
  rangeLimitedCellCount: 2,
  renderCellCount: 0,
  minimumDepth: null,
  maximumDepth: null,
};
const emptyVolume = createTeachingVisionCoverageVolume({
  key: 'no-surface-contact',
  poseId: 'pose-2',
  side: 'right',
  frame: {
    opticalPose: {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    },
    pointCloud: {},
  },
}, { grid: emptyGrid });
assert.ok(emptyVolume);
assert.equal(emptyVolume.userData.coverage.hasSurfaceContact, false);
assert.equal(emptyVolume.userData.coverage.volumeCount, 0);
assert.ok(emptyVolume.getObjectByName('captured-optical-center'));
assert.ok(emptyVolume.getObjectByName('captured-optical-coordinate-frame'));
assert.equal(emptyVolume.getObjectByName('surface-truncated-vision-volume'), undefined);
assert.equal(emptyVolume.getObjectByName('vision-volume-outer-silhouette'), undefined);
emptyVolume.traverse((child) => {
  child.geometry?.dispose?.();
  if (Array.isArray(child.material)) {
    child.material.forEach((material) => material?.dispose?.());
  } else {
    child.material?.dispose?.();
  }
});

console.log('vision coverage projection smoke test passed');
