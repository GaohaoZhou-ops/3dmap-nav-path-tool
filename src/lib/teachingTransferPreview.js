import * as THREE from 'three';
import { createUniformMeshIndex, resolveMeshRenderQuality } from './mapGeometry.js';

export const TRANSFER_COLOR_MODES = [
  { id: 'layer', label: '分层色' },
  { id: 'source', label: '原始色' },
  { id: 'height', label: '高程色' },
  { id: 'white', label: '纯白色' },
];

export const transferBoundsBox = (bounds) => new THREE.Box3(
  new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
  new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
);

// Compact preview buffers keep another full map out of GPU memory. The source
// buffers and the geometry used by the actual conversion are never modified.
export function createTransferPreviewLayer(map, { color, pointBudget = 160000, highlight = false }) {
  const group = new THREE.Group();
  const positions = new Float32Array(map.positionBuffer);
  const sourceColors = map.colorBuffer instanceof ArrayBuffer && map.colorBuffer.byteLength === positions.length
    ? new Uint8Array(map.colorBuffer) : null;
  const step = Math.max(1, Math.ceil(positions.length / 3 / pointBudget));
  const points = new Float32Array(Math.ceil(positions.length / 3 / step) * 3);
  const pointColors = sourceColors ? new Uint8Array(points.length) : null;
  for (let index = 0, offset = 0; index < positions.length; index += step * 3, offset += 3) {
    points.set(positions.subarray(index, index + 3), offset);
    pointColors?.set(sourceColors.subarray(index, index + 3), offset);
  }
  const selection = {
    active: { value: false },
    min: { value: new THREE.Vector3() },
    max: { value: new THREE.Vector3() },
  };
  const display = {
    mode: { value: 0 },
    layerColor: { value: new THREE.Color(color) },
    heightRange: { value: new THREE.Vector2(map.bounds.min.z, map.bounds.max.z) },
  };
  const previewMaterial = (material) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.transferSelected = selection.active;
      shader.uniforms.transferMin = selection.min;
      shader.uniforms.transferMax = selection.max;
      shader.uniforms.transferColorMode = display.mode;
      shader.uniforms.transferLayerColor = display.layerColor;
      shader.uniforms.transferHeightRange = display.heightRange;
      shader.vertexShader = `varying vec3 transferPosition;\n${shader.vertexShader}`
        .replace('#include <project_vertex>', 'transferPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
      shader.fragmentShader = `varying vec3 transferPosition;
uniform bool transferSelected;
uniform vec3 transferMin;
uniform vec3 transferMax;
uniform float transferColorMode;
uniform vec3 transferLayerColor;
uniform vec2 transferHeightRange;
vec3 transferHeightColor(float height) {
  float t = clamp((height - transferHeightRange.x) / max(transferHeightRange.y - transferHeightRange.x, 0.000001), 0.0, 1.0);
  vec3 blue = vec3(0.0176, 0.0685, 0.2159), cyan = vec3(0.0212, 0.3916, 0.6308);
  vec3 green = vec3(0.0908, 0.6514, 0.3325), amber = vec3(0.9047, 0.5841, 0.1095), coral = vec3(1.0, 0.1620, 0.1560);
  if (t < 0.25) return mix(blue, cyan, smoothstep(0.0, 0.25, t));
  if (t < 0.50) return mix(cyan, green, smoothstep(0.25, 0.50, t));
  if (t < 0.75) return mix(green, amber, smoothstep(0.50, 0.75, t));
  return mix(amber, coral, smoothstep(0.75, 1.0, t));
}
${shader.fragmentShader}`
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (transferColorMode < 0.5) diffuseColor.rgb = transferLayerColor;
          else if (transferColorMode > 2.5) diffuseColor.rgb = vec3(1.0);
          else if (transferColorMode > 1.5) diffuseColor.rgb = transferHeightColor(transferPosition.z);
          if (transferSelected && all(greaterThanEqual(transferPosition, transferMin)) && all(lessThanEqual(transferPosition, transferMax))) {
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.64, 0.46, 1.0), transferColorMode < 0.5 ? 1.0 : 0.25);
          }`);
    };
    material.customProgramCacheKey = () => 'teaching-transfer-display-v2';
    return material;
  };
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  if (pointColors) pointGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3, true));
  const baseColor = sourceColors ? 0xffffff : color;
  group.add(new THREE.Points(pointGeometry, previewMaterial(new THREE.PointsMaterial({
    color: baseColor, vertexColors: Boolean(sourceColors), size: 2.2, sizeAttenuation: false, depthWrite: true,
  }))));
  const sourceIndices = map.indexBuffer instanceof ArrayBuffer
    ? map.indexComponentType === 'uint16' ? new Uint16Array(map.indexBuffer) : new Uint32Array(map.indexBuffer) : null;
  const faceCount = Math.floor((sourceIndices?.length || 0) / 3);
  const surface = faceCount ? new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial(new THREE.MeshStandardMaterial({
    color: baseColor, vertexColors: Boolean(sourceColors), side: THREE.DoubleSide, roughness: 0.85, metalness: 0.04,
    flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }))) : null;
  if (surface) group.add(surface);
  let renderedFaces = 0;
  const updateMesh = (count) => {
    if (!surface || count === renderedFaces) return;
    const indices = createUniformMeshIndex(sourceIndices, count);
    const vertices = new Float32Array(indices.length * 3);
    const colors = sourceColors ? new Uint8Array(vertices.length) : null;
    for (let index = 0; index < indices.length; index += 1) {
      vertices.set(positions.subarray(indices[index] * 3, indices[index] * 3 + 3), index * 3);
      colors?.set(sourceColors.subarray(indices[index] * 3, indices[index] * 3 + 3), index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.computeVertexNormals();
    surface.geometry.dispose();
    surface.geometry = geometry;
    renderedFaces = indices.length / 3;
  };
  group.userData.previewPoints = points.length / 3;
  group.userData.hasSourceColors = Boolean(sourceColors);
  group.userData.hasMesh = Boolean(surface);
  group.userData.setDisplay = ({ colorMode = 'layer', meshQuality = 'performance', heightBounds = map.bounds } = {}) => {
    display.mode.value = Math.max(0, TRANSFER_COLOR_MODES.findIndex(({ id }) => id === colorMode));
    display.heightRange.value.set(heightBounds.min.z, heightBounds.max.z);
    if (surface) {
      surface.visible = meshQuality !== 'off';
      if (surface.visible) updateMesh(resolveMeshRenderQuality(meshQuality, faceCount).renderedFaceCount);
    }
    group.userData.previewFaces = surface?.visible ? renderedFaces : 0;
  };
  group.userData.setSelection = (bounds) => {
    selection.active.value = highlight && Boolean(bounds);
    if (bounds) {
      selection.min.value.set(bounds.min.x, bounds.min.y, bounds.min.z);
      selection.max.value.set(bounds.max.x, bounds.max.y, bounds.max.z);
    }
  };
  group.userData.setDisplay();
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
