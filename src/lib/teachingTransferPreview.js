import * as THREE from 'three';
import { createUniformMeshIndex } from './mapGeometry.js';

export const transferBoundsBox = (bounds) => new THREE.Box3(
  new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
  new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
);

// Compact preview buffers keep another full map out of GPU memory. The source
// buffers and the geometry used by the actual conversion are never modified.
export function createTransferPreviewLayer(map, { color, pointBudget = 160000, faceBudget = 180000, highlight = false }) {
  const group = new THREE.Group();
  const positions = new Float32Array(map.positionBuffer);
  const step = Math.max(1, Math.ceil(positions.length / 3 / pointBudget));
  const points = new Float32Array(Math.ceil(positions.length / 3 / step) * 3);
  for (let index = 0, offset = 0; index < positions.length; index += step * 3, offset += 3) {
    points.set(positions.subarray(index, index + 3), offset);
  }
  const selection = {
    active: { value: false },
    min: { value: new THREE.Vector3() },
    max: { value: new THREE.Vector3() },
  };
  const materialWithSelection = (material) => {
    if (!highlight) return material;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.transferSelected = selection.active;
      shader.uniforms.transferMin = selection.min;
      shader.uniforms.transferMax = selection.max;
      shader.vertexShader = `varying vec3 transferPosition;\n${shader.vertexShader}`
        .replace('#include <project_vertex>', 'transferPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
      shader.fragmentShader = `varying vec3 transferPosition;\nuniform bool transferSelected;\nuniform vec3 transferMin;\nuniform vec3 transferMax;\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (transferSelected && all(greaterThanEqual(transferPosition, transferMin)) && all(lessThanEqual(transferPosition, transferMax))) {
            diffuseColor.rgb = vec3(0.64, 0.46, 1.0);
          }`);
    };
    material.customProgramCacheKey = () => 'teaching-transfer-selection-v1';
    return material;
  };
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  group.add(new THREE.Points(pointGeometry, materialWithSelection(new THREE.PointsMaterial({
    color, size: 2.2, sizeAttenuation: false, depthWrite: true,
  }))));
  let faceCount = 0;
  if (map.indexBuffer instanceof ArrayBuffer) {
    const source = map.indexComponentType === 'uint16' ? new Uint16Array(map.indexBuffer) : new Uint32Array(map.indexBuffer);
    const indices = createUniformMeshIndex(source, Math.min(source.length / 3, faceBudget));
    const vertices = new Float32Array(indices.length * 3);
    for (let index = 0; index < indices.length; index += 1) {
      vertices.set(positions.subarray(indices[index] * 3, indices[index] * 3 + 3), index * 3);
    }
    if (vertices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, materialWithSelection(new THREE.MeshStandardMaterial({
        color, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.04,
        flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }))));
      faceCount = indices.length / 3;
    }
  }
  group.userData.previewPoints = points.length / 3;
  group.userData.previewFaces = faceCount;
  group.userData.setSelection = (bounds) => {
    selection.active.value = Boolean(bounds);
    if (bounds) {
      selection.min.value.set(bounds.min.x, bounds.min.y, bounds.min.z);
      selection.max.value.set(bounds.max.x, bounds.max.y, bounds.max.z);
    }
  };
  return group;
}

export function disposeTransferPreview(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
