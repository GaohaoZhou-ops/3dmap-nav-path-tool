import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  buildTeachingSurfaceCoverageMask,
  createTeachingSurfaceProjectionOverlay,
  disposeTeachingSurfaceProjectionOverlay,
  TEACHING_SURFACE_PROJECTION_MODE,
} from '../src/lib/visionCoverage.js';

const positions = new THREE.Float32BufferAttribute([
  -0.35, 0, 0.60, // In front of a measured surface: covered.
  0.35, 0, 0.70, // Empty depth cell: covered continuously up to maximum range.
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
    depths: [0.8, 1.3],
    surfaceDepths: [0.8, null],
  },
};

const { mask, coveredPointCount } = buildTeachingSurfaceCoverageMask(
  positions,
  [preparedFrame],
);

assert.equal(TEACHING_SURFACE_PROJECTION_MODE, 'continuous-frustum-front-envelope');
assert.equal(coveredPointCount, 2);
assert.deepEqual([...mask], [1, 1, 0, 0]);
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
assert.match(projection.material.fragmentShader, /vAtlasCoverageWorldPosition/);
assert.equal(projection.material.uniforms.atlasCoverageOpacity.value, 0.05);
disposeTeachingSurfaceProjectionOverlay(projection);
meshGeometry.dispose();

console.log('vision coverage projection smoke test passed');
