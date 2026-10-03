import assert from 'node:assert/strict';
import { createTransferPreviewLayer, disposeTransferPreview } from '../src/lib/teachingTransferPreview.js';
import { teachingTransferFixture } from './teaching_transfer_helpers.mjs';

// RGB must follow exactly the same sampled vertices as positions, both for
// points and for indexed triangles, without changing the saved geometry.
const map = teachingTransferFixture().map;
const original = structuredClone(map);
const layer = createTransferPreviewLayer(map, { color: 0x789b9f, pointBudget: 3, highlight: true });
const points = layer.children.find((object) => object.isPoints);
const mesh = layer.children.find((object) => object.isMesh);
assert.deepEqual([...points.geometry.attributes.color.array], [255, 0, 0, 0, 0, 255, 0, 100, 200]);
assert.equal(points.geometry.attributes.color.normalized, true);
assert.deepEqual([...mesh.geometry.attributes.color.array], [...new Uint8Array(map.colorBuffer)]);
const geometry = mesh.geometry;
for (const colorMode of ['source', 'height', 'white', 'layer']) {
  layer.userData.setDisplay({ colorMode });
  assert.equal(mesh.geometry, geometry, 'Color changes must retain geometry');
}
layer.userData.setDisplay({ meshQuality: 'off' });
assert.equal(mesh.visible, false);
assert.equal(points.visible, true);
assert.equal(layer.userData.previewFaces, 0);
layer.userData.setDisplay({ meshQuality: 'full' });
assert.equal(mesh.visible, true);
assert.equal(layer.userData.previewFaces, 2);
assert.equal(mesh.geometry, geometry);
assert.deepEqual(map, original);
disposeTransferPreview(layer);

// A quality change must actually change the triangle budget and release the
// old GPU geometry. Closing/reopening Mesh must not rebuild the same buffers.
const largeMap = structuredClone(map);
const indices = new Uint32Array(180_006 * 3);
for (let index = 0; index < indices.length; index += 1) indices[index] = index % 6;
largeMap.indexBuffer = indices.buffer;
largeMap.indexComponentType = 'uint32';
const largeLayer = createTransferPreviewLayer(largeMap, { color: 0x789b9f });
const largeMesh = largeLayer.children.find((object) => object.isMesh);
assert.equal(largeLayer.userData.previewFaces, 180_000);
let disposed = false;
largeMesh.geometry.addEventListener('dispose', () => { disposed = true; });
largeLayer.userData.setDisplay({ meshQuality: 'full' });
assert.equal(disposed, true);
assert.equal(largeLayer.userData.previewFaces, 180_006);
assert.equal(largeMesh.geometry.attributes.position.count, 180_006 * 3);
assert.deepEqual([...largeMesh.geometry.attributes.color.array.slice(-18)], [...new Uint8Array(map.colorBuffer)]);
const fullGeometry = largeMesh.geometry;
largeLayer.userData.setDisplay({ meshQuality: 'off' });
largeLayer.userData.setDisplay({ meshQuality: 'auto' });
assert.equal(largeMesh.geometry, fullGeometry);
disposeTransferPreview(largeLayer);

// Pure point clouds and projects without RGB remain usable in every mode.
const plainMap = { ...map, colorBuffer: null, indexBuffer: null };
const plainLayer = createTransferPreviewLayer(plainMap, { color: 0x789b9f });
assert.equal(plainLayer.userData.hasSourceColors, false);
assert.equal(plainLayer.userData.hasMesh, false);
for (const colorMode of ['source', 'height', 'white', 'layer']) {
  plainLayer.userData.setDisplay({ colorMode });
  assert.equal(plainLayer.userData.previewFaces, 0);
  assert.equal(plainLayer.children[0].visible, true);
}
disposeTransferPreview(plainLayer);
console.log('transfer_preview_rgb_sampling_and_source_preservation=ok');
console.log('transfer_preview_mesh_quality_visibility_and_disposal=ok');
console.log('transfer_preview_uncolored_point_cloud=ok');
