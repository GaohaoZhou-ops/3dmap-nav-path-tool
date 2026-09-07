import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const colorModeValue = (mode) => (mode === 'height' ? 1 : mode === 'white' ? 2 : 0);

const installSliceShader = (material, heightRange, bounds, colorMode) => {
  material.userData.sliceRange = [...heightRange];
  material.userData.pointColorMode = colorMode;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasSliceMin = { value: material.userData.sliceRange[0] };
    shader.uniforms.atlasSliceMax = { value: material.userData.sliceRange[1] };
    shader.uniforms.atlasPointColorMode = {
      value: colorModeValue(material.userData.pointColorMode),
    };
    shader.uniforms.atlasHeightMin = { value: bounds.min.z };
    shader.uniforms.atlasHeightMax = { value: bounds.max.z };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vAtlasSliceZ;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAtlasSliceZ = transformed.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vAtlasSliceZ;
uniform float atlasSliceMin;
uniform float atlasSliceMax;
uniform float atlasPointColorMode;
uniform float atlasHeightMin;
uniform float atlasHeightMax;

vec3 atlasSliceHeightPalette(float heightValue) {
  float t = clamp(
    (heightValue - atlasHeightMin) / max(atlasHeightMax - atlasHeightMin, 0.000001),
    0.0,
    1.0
  );
  vec3 lowBlue = vec3(0.0176, 0.0685, 0.2159);
  vec3 cyan = vec3(0.0212, 0.3916, 0.6308);
  vec3 green = vec3(0.0908, 0.6514, 0.3325);
  vec3 amber = vec3(0.9047, 0.5841, 0.1095);
  vec3 highCoral = vec3(1.0, 0.1620, 0.1560);
  if (t < 0.25) return mix(lowBlue, cyan, smoothstep(0.0, 0.25, t));
  if (t < 0.50) return mix(cyan, green, smoothstep(0.25, 0.50, t));
  if (t < 0.75) return mix(green, amber, smoothstep(0.50, 0.75, t));
  return mix(amber, highCoral, smoothstep(0.75, 1.0, t));
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (vAtlasSliceZ < atlasSliceMin || vAtlasSliceZ > atlasSliceMax) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (atlasPointColorMode > 1.5) {
  diffuseColor.rgb = vec3(1.0);
} else if (atlasPointColorMode > 0.5) {
  diffuseColor.rgb = atlasSliceHeightPalette(vAtlasSliceZ);
}`,
      )
      .replace(
        '#include <alphatest_fragment>',
        `float atlasPointRadius = length(gl_PointCoord - vec2(0.5));
if (atlasPointRadius > 0.5) discard;
diffuseColor.a *= 1.0 - smoothstep(0.32, 0.5, atlasPointRadius);
#include <alphatest_fragment>`,
      );
    material.userData.sliceShader = shader;
  };
  material.customProgramCacheKey = () => 'atlas-vector-slice-color-v2';
};

export default function VectorPointLayer({
  geometry,
  bounds,
  width,
  height,
  view,
  heightRange,
  colorMode,
}) {
  const canvasRef = useRef(null);
  const renderStateRef = useRef(null);
  const sliceRangeRef = useRef(heightRange);
  sliceRangeRef.current = heightRange;
  const sourcePointCount = geometry?.getAttribute('position')?.count || 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geometry || !bounds) return undefined;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.sortObjects = false;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    camera.up.set(0, 1, 0);

    // Attribute buffers remain in original map coordinates. No raster projection
    // or pre-sized texture is created, so every zoom level resolves the source points.
    const vectorGeometry = new THREE.BufferGeometry();
    Object.entries(geometry.attributes).forEach(([name, attribute]) => {
      vectorGeometry.setAttribute(name, attribute);
    });
    vectorGeometry.boundingBox = geometry.boundingBox?.clone() || null;
    vectorGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;

    const hasVertexColors = Boolean(geometry.getAttribute('color'));
    const material = new THREE.PointsMaterial({
      size: 1.65,
      sizeAttenuation: false,
      vertexColors: hasVertexColors,
      color: hasVertexColors ? 0x8fc4c8 : 0x71cbd2,
      transparent: true,
      opacity: 0.86,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    installSliceShader(material, sliceRangeRef.current, bounds, colorMode);

    const points = new THREE.Points(vectorGeometry, material);
    points.frustumCulled = false;
    scene.add(points);
    renderStateRef.current = { renderer, scene, camera, material, vectorGeometry };

    return () => {
      vectorGeometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderStateRef.current?.renderer === renderer) renderStateRef.current = null;
    };
  }, [bounds, geometry]);

  useEffect(() => {
    const state = renderStateRef.current;
    if (!state || !bounds || width < 2 || height < 2 || view.scale <= 0) return;
    const { renderer, scene, camera, material } = state;
    const halfWorldWidth = width / view.scale / 2;
    const halfWorldHeight = height / view.scale / 2;
    const zSpan = Math.max(bounds.max.z - bounds.min.z, 0.001);
    const cameraZ = bounds.max.z + Math.max(zSpan, 1) + 1;

    renderer.setSize(width, height, false);
    camera.left = -halfWorldWidth;
    camera.right = halfWorldWidth;
    camera.top = halfWorldHeight;
    camera.bottom = -halfWorldHeight;
    camera.near = 0.01;
    camera.far = Math.max(zSpan * 3 + 4, 16);
    camera.position.set(view.centerX, view.centerY, cameraZ);
    camera.lookAt(view.centerX, view.centerY, bounds.min.z - 1);
    camera.updateProjectionMatrix();

    material.userData.sliceRange = [...heightRange];
    material.userData.pointColorMode = colorMode;
    const shader = material.userData.sliceShader;
    if (shader) {
      shader.uniforms.atlasSliceMin.value = heightRange[0];
      shader.uniforms.atlasSliceMax.value = heightRange[1];
      shader.uniforms.atlasPointColorMode.value = colorModeValue(colorMode);
    }
    renderer.render(scene, camera);
  }, [bounds, colorMode, height, heightRange, view.centerX, view.centerY, view.scale, width]);

  return (
    <canvas
      ref={canvasRef}
      className="map2d-vector-canvas"
      data-render-mode="vector-coordinate-webgl"
      data-source-point-count={sourcePointCount}
      data-view-scale={view.scale}
      data-view-center-x={view.centerX}
      data-view-center-y={view.centerY}
      data-world-units-per-pixel={1 / Math.max(view.scale, 0.001)}
      data-point-size-css="1.65"
      data-slice-min={heightRange[0]}
      data-slice-max={heightRange[1]}
      data-color-mode={colorMode}
      aria-label="二维矢量点云截面"
    />
  );
}
