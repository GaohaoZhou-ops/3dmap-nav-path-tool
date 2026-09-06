import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  Box,
  Crosshair,
  Gauge,
  Minus,
  MousePointer2,
  Move3D,
  Palette,
  Plus,
  Rotate3D,
  RotateCcw,
} from 'lucide-react';

const RESOLUTION_LEVELS = [
  { ratio: 0.05, label: '极速', tone: 'turbo' },
  { ratio: 0.1, label: '性能', tone: 'performance' },
  { ratio: 0.25, label: '性能', tone: 'performance' },
  { ratio: 0.5, label: '均衡', tone: 'balanced' },
  { ratio: 0.75, label: '高精', tone: 'precision' },
  { ratio: 1, label: '原始', tone: 'native' },
];

const DEFAULT_RESOLUTION_INDEX = RESOLUTION_LEVELS.length - 1;

const greatestCommonDivisor = (left, right) => {
  let a = left;
  let b = right;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

// A modular permutation keeps every prefix spread across the full source cloud.
// One shared index buffer lets resolution changes update only the GPU draw range.
const createUniformPointOrder = (pointCount) => {
  const order = new Uint32Array(pointCount);
  if (!pointCount) return order;

  let step = Math.max(1, Math.floor(pointCount * 0.61803398875));
  while (greatestCommonDivisor(step, pointCount) !== 1) step += 1;

  let sourceIndex = 0;
  for (let index = 0; index < pointCount; index += 1) {
    order[index] = sourceIndex;
    sourceIndex += step;
    if (sourceIndex >= pointCount) sourceIndex -= pointCount;
  }
  return order;
};

const formatPointCount = (count) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  return String(count);
};

const formatHeight = (value) => (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2));

// Keep the source buffer untouched and perform elevation coloring in the GPU.
// The five stops match the on-screen scale from low (blue) to high (coral).
const installHeightColorShader = (material, bounds, enabled) => {
  material.userData.heightColorEnabled = enabled;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasHeightColorEnabled = {
      value: material.userData.heightColorEnabled ? 1 : 0,
    };
    shader.uniforms.atlasHeightMin = { value: bounds.min.z };
    shader.uniforms.atlasHeightMax = { value: bounds.max.z };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vAtlasHeight;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAtlasHeight = transformed.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vAtlasHeight;
uniform float atlasHeightColorEnabled;
uniform float atlasHeightMin;
uniform float atlasHeightMax;

vec3 atlasHeightPalette(float heightValue) {
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
        '#include <color_fragment>',
        `#include <color_fragment>
if (atlasHeightColorEnabled > 0.5) {
  diffuseColor.rgb = atlasHeightPalette(vAtlasHeight);
}`,
      );
    material.userData.heightColorShader = shader;
  };
  material.customProgramCacheKey = () => 'atlas-height-color-v1';
};

const statusColor = (status) => {
  if (status === 'connected') return 0x5ee59a;
  if (status === 'unreachable') return 0xf4c95d;
  return 0x59dbe8;
};

const disposeObject = (object) => {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
};

const createLabelSprite = (text, color, worldHeight, wide = false) => {
  const canvas = document.createElement('canvas');
  canvas.width = wide ? 256 : 72;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(5, 14, 17, 0.88)';
  context.fillRect(1, 1, canvas.width - 2, canvas.height - 2);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  context.fillStyle = color;
  context.font = wide ? '600 21px monospace' : '700 30px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
  sprite.renderOrder = 20;
  return sprite;
};

export default function PointCloudViewer({
  mapData,
  heightRange,
  waypoints,
  edges,
  selectedWaypointId,
  colorMode = 'source',
  onColorModeChange,
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const sliceGroupRef = useRef(null);
  const routeGroupRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const displayGeometryRef = useRef(null);
  const cloudMaterialRef = useRef(null);
  const colorModeRef = useRef(colorMode);
  colorModeRef.current = colorMode;
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [resolutionIndex, setResolutionIndex] = useState(DEFAULT_RESOLUTION_INDEX);

  const sourcePointCount = mapData?.geometry?.getAttribute('position')?.count || 0;
  const resolution = RESOLUTION_LEVELS[resolutionIndex];
  const renderedPointCount = sourcePointCount
    ? Math.max(1, Math.round(sourcePointCount * resolution.ratio))
    : 0;
  const isHeightColor = colorMode === 'height';
  const heightMin = mapData?.bounds?.min?.z ?? 0;
  const heightMax = mapData?.bounds?.max?.z ?? 1;
  const heightLegendTicks = [1, 0.75, 0.5, 0.25, 0].map(
    (ratio) => heightMin + (heightMax - heightMin) * ratio,
  );

  useEffect(() => {
    const mount = mountRef.current;
    const geometry = mapData?.geometry;
    if (!mount || !geometry) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071014);
    scene.fog = new THREE.FogExp2(0x071014, 0.0032);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'three-canvas';
    mount.appendChild(renderer.domElement);

    const bounds = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    const center = sphere.center;
    const radius = Math.max(sphere.radius, 1);
    const overviewNear = Math.max(radius / 2000, 0.01);
    const detailMinDistance = Math.max(radius * 1e-6, 1e-6);
    const detailMinNear = Math.max(radius * 1e-8, 1e-8);
    const camera = new THREE.PerspectiveCamera(46, 1, overviewNear, radius * 30);
    camera.up.set(0, 0, 1);
    camera.position.set(
      center.x - radius * 0.6,
      center.y - radius * 0.85,
      center.z + radius * 0.48,
    );

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.rotateSpeed = 1.35;
    controls.zoomSpeed = 1.1;
    controls.panSpeed = 0.28;
    controls.staticMoving = true;
    controls.minDistance = detailMinDistance;
    controls.maxDistance = radius * 6;
    renderer.domElement.dataset.controlMode = 'free-trackball';
    renderer.domElement.dataset.zoomMode = 'deep-detail';
    renderer.domElement.dataset.minCameraDistance = detailMinDistance.toPrecision(8);
    controlsRef.current = controls;
    cameraRef.current = camera;

    const displayGeometry = new THREE.BufferGeometry();
    Object.entries(geometry.attributes).forEach(([name, attribute]) => {
      displayGeometry.setAttribute(name, attribute);
    });
    displayGeometry.setIndex(
      new THREE.BufferAttribute(createUniformPointOrder(geometry.getAttribute('position').count), 1),
    );
    displayGeometry.boundingBox = geometry.boundingBox?.clone() || null;
    displayGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;
    displayGeometryRef.current = displayGeometry;

    const overviewPointSize = Math.max(radius / 1200, 0.035);
    const material = new THREE.PointsMaterial({
      size: overviewPointSize,
      sizeAttenuation: true,
      vertexColors: Boolean(geometry.getAttribute('color')),
      color: geometry.getAttribute('color') ? 0xffffff : 0x9fc7ca,
      transparent: true,
      opacity: 0.92,
    });
    installHeightColorShader(material, bounds, colorModeRef.current === 'height');
    cloudMaterialRef.current = material;
    renderer.domElement.dataset.colorMode = colorModeRef.current;
    const cloud = new THREE.Points(displayGeometry, material);
    scene.add(cloud);

    // Keep close-up points crisp and move the near clipping plane with the camera.
    const syncDetailView = () => {
      const distance = camera.position.distanceTo(controls.target);
      const nextNear = Math.max(detailMinNear, Math.min(overviewNear, distance / 250));
      const nextFar = Math.max(radius * 8, distance + radius * 4);
      const pointSizeScale = Math.min(1, Math.max(distance / (radius * 0.35), 1e-6));

      material.size = overviewPointSize * pointSizeScale;
      if (camera.near !== nextNear || camera.far !== nextFar) {
        camera.near = nextNear;
        camera.far = nextFar;
        camera.updateProjectionMatrix();
      }

      renderer.domElement.dataset.cameraDistance = distance.toPrecision(8);
      renderer.domElement.dataset.cameraNear = nextNear.toPrecision(8);
    };
    controls.addEventListener('change', syncDetailView);

    const size = new THREE.Vector3();
    bounds.getSize(size);
    const gridSize = Math.max(size.x, size.y, 10);
    const grid = new THREE.GridHelper(gridSize, 40, 0x3f7478, 0x173035);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center.x, center.y, bounds.min.z - Math.max(size.z * 0.03, 0.03));
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    scene.add(grid);

    const originGroup = new THREE.Group();
    originGroup.name = 'world-coordinate-origin';
    originGroup.position.set(0, 0, 0);
    const axisLength = Math.max(Math.min(radius * 0.11, 12), 1.5);
    const axes = new THREE.AxesHelper(axisLength);
    axes.material.depthTest = false;
    axes.material.transparent = true;
    axes.material.opacity = 0.96;
    axes.renderOrder = 18;

    const originDot = new THREE.Mesh(
      new THREE.SphereGeometry(axisLength * 0.045, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0xf4f7ef, depthTest: false }),
    );
    originDot.renderOrder = 19;
    const originRing = new THREE.Mesh(
      new THREE.RingGeometry(axisLength * 0.075, axisLength * 0.105, 32),
      new THREE.MeshBasicMaterial({
        color: 0x59dbe8,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    originRing.renderOrder = 18;

    const originLabel = createLabelSprite('O  (0, 0, 0)', '#dffcff', axisLength * 0.18, true);
    originLabel.position.set(axisLength * 0.15, axisLength * 0.15, axisLength * 0.13);
    const xLabel = createLabelSprite('X', '#ef6f6c', axisLength * 0.14);
    xLabel.position.set(axisLength * 1.08, 0, 0);
    const yLabel = createLabelSprite('Y', '#75d08f', axisLength * 0.14);
    yLabel.position.set(0, axisLength * 1.08, 0);
    const zLabel = createLabelSprite('Z', '#70b7e7', axisLength * 0.14);
    zLabel.position.set(0, 0, axisLength * 1.08);
    originGroup.add(axes, originDot, originRing, originLabel, xLabel, yLabel, zLabel);
    scene.add(originGroup);
    renderer.domElement.dataset.coordinateOrigin = '0,0,0';

    const sliceGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    scene.add(sliceGroup, routeGroup);
    sliceGroupRef.current = sliceGroup;
    routeGroupRef.current = routeGroup;
    sceneRef.current = scene;

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      controls.handleResize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    syncDetailView();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.removeEventListener('change', syncDetailView);
      controls.dispose();
      displayGeometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      disposeObject(originGroup);
      disposeObject(sliceGroup);
      disposeObject(routeGroup);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      sliceGroupRef.current = null;
      routeGroupRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      displayGeometryRef.current = null;
      if (cloudMaterialRef.current === material) cloudMaterialRef.current = null;
    };
  }, [mapData?.geometry]);

  useEffect(() => {
    const material = cloudMaterialRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!material || !canvas) return;

    const enabled = colorMode === 'height';
    material.userData.heightColorEnabled = enabled;
    const shader = material.userData.heightColorShader;
    if (shader) shader.uniforms.atlasHeightColorEnabled.value = enabled ? 1 : 0;
    canvas.dataset.colorMode = enabled ? 'height' : 'source';
  }, [colorMode, mapData?.geometry]);

  useEffect(() => {
    const displayGeometry = displayGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!displayGeometry || !canvas || !sourcePointCount) return;

    displayGeometry.setDrawRange(0, renderedPointCount);
    canvas.dataset.resolutionPercent = String(Math.round(resolution.ratio * 100));
    canvas.dataset.renderPointCount = String(renderedPointCount);
  }, [renderedPointCount, resolution.ratio, sourcePointCount]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.mouseButtons.LEFT =
      interactionMode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.domElement.dataset.interactionMode = interactionMode;
  }, [interactionMode, mapData?.geometry]);

  useEffect(() => {
    const group = sliceGroupRef.current;
    const bounds = mapData?.geometry?.boundingBox;
    if (!group || !bounds) return;
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }

    const size = new THREE.Vector3();
    bounds.getSize(size);
    const thickness = Math.max(heightRange[1] - heightRange[0], 0.015);
    const geometry = new THREE.BoxGeometry(size.x, size.y, thickness);
    const fill = new THREE.MeshBasicMaterial({
      color: 0x36cbd4,
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, fill);
    mesh.position.set(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (heightRange[0] + heightRange[1]) / 2,
    );
    group.add(mesh);

    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x50dce6,
      transparent: true,
      opacity: 0.42,
    });
    const outline = new THREE.LineSegments(edgesGeometry, lineMaterial);
    outline.position.copy(mesh.position);
    group.add(outline);
  }, [heightRange, mapData?.geometry]);

  useEffect(() => {
    const group = routeGroupRef.current;
    const sphere = mapData?.geometry?.boundingSphere;
    if (!group || !sphere) return;
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }

    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    const radius = Math.max(sphere.radius * 0.006, 0.12);

    edges.forEach((edge) => {
      const source = pointById.get(edge.from);
      const target = pointById.get(edge.to);
      if (!source || !target) return;
      const start = new THREE.Vector3(source.pose.x, source.pose.y, source.pose.z + radius * 0.25);
      const end = new THREE.Vector3(target.pose.x, target.pose.y, target.pose.z + radius * 0.25);
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 0.001) return;
      direction.normalize();
      const arrow = new THREE.ArrowHelper(
        direction,
        start,
        length,
        statusColor(edge.status),
        Math.min(radius * 2.1, length * 0.24),
        radius * 0.72,
      );
      group.add(arrow);
    });

    waypoints.forEach((point) => {
      const selected = point.id === selectedWaypointId;
      const geometry = new THREE.SphereGeometry(radius * (selected ? 1.34 : 1), 16, 12);
      const material = new THREE.MeshBasicMaterial({
        color: selected ? 0xffa94d : 0xffd166,
        depthTest: false,
      });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(point.pose.x, point.pose.y, point.pose.z);
      marker.renderOrder = 10;
      group.add(marker);
    });
  }, [edges, mapData?.geometry, selectedWaypointId, waypoints]);

  const focusOrigin = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(0, 0, 0);
    camera.position.copy(offset);
    controls.update();
  };

  return (
    <div className="point-cloud-view" ref={mountRef}>
      {!mapData?.geometry && (
        <div className="viewer-placeholder">
          <div className="placeholder-orbit">
            <Box size={34} strokeWidth={1.3} />
          </div>
          <strong>等待点云地图</strong>
          <span>加载 PLY 文件后，这里会生成可旋转、缩放和平移的三维场景</span>
        </div>
      )}
      {mapData?.geometry && (
        <>
          <div className="viewer-tool-switch" role="toolbar" aria-label="三维视图操作模式">
            <button
              type="button"
              className={interactionMode === 'rotate' ? 'is-active' : ''}
              onClick={() => setInteractionMode('rotate')}
              title="左键拖拽旋转"
            >
              <Rotate3D size={13} /> 旋转
            </button>
            <button
              type="button"
              className={interactionMode === 'pan' ? 'is-active' : ''}
              onClick={() => setInteractionMode('pan')}
              title="左键拖拽平移"
            >
              <Move3D size={13} /> 平移
            </button>
            <button type="button" onClick={focusOrigin} title="将三维视图中心定位到坐标原点">
              <Crosshair size={13} /> 原点
            </button>
          </div>
          <div
            className="viewer-resolution-control"
            role="group"
            aria-label="点云显示分辨率"
            title="仅调整 3D 显示采样，不改变 2D 截面和导航数据"
          >
            <div
              className={`resolution-readout tone-${resolution.tone}`}
              role="status"
              aria-label={`3D 点云分辨率 ${Math.round(resolution.ratio * 100)}%，渲染 ${renderedPointCount.toLocaleString('zh-CN')} 个点`}
            >
              <Gauge size={14} />
              <span>
                <small>{resolution.label}</small>
                <strong>{Math.round(resolution.ratio * 100)}%</strong>
              </span>
              <em>{formatPointCount(renderedPointCount)} PTS</em>
            </div>
            <button
              type="button"
              aria-label="降低点云分辨率"
              title="降低分辨率，提高浏览性能"
              disabled={resolutionIndex === 0}
              onClick={() => setResolutionIndex((current) => Math.max(0, current - 1))}
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              aria-label="提高点云分辨率"
              title="提高分辨率，显示更多原始点"
              disabled={resolutionIndex === DEFAULT_RESOLUTION_INDEX}
              onClick={() =>
                setResolutionIndex((current) => Math.min(DEFAULT_RESOLUTION_INDEX, current + 1))
              }
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              className="resolution-reset"
              aria-label="重置点云分辨率"
              title="重置为 100% 原始分辨率"
              disabled={resolutionIndex === DEFAULT_RESOLUTION_INDEX}
              onClick={() => setResolutionIndex(DEFAULT_RESOLUTION_INDEX)}
            >
              <RotateCcw size={12} />
              <span>重置</span>
            </button>
            <button
              type="button"
              className={`height-color-toggle ${isHeightColor ? 'is-active' : ''}`}
              aria-label="按高度渲染点云"
              aria-pressed={isHeightColor}
              title={isHeightColor ? '恢复点云原始颜色' : '按 Z 轴高度显示渐变颜色'}
              onClick={() => onColorModeChange?.(isHeightColor ? 'source' : 'height')}
            >
              <Palette size={12} />
              <span>高程色</span>
            </button>
          </div>
          {isHeightColor && (
            <aside className="height-color-legend" aria-label="点云高程比例尺">
              <div className="height-color-legend__heading">
                <span>ELEVATION</span>
                <strong>Z · m</strong>
              </div>
              <div className="height-color-legend__scale">
                <div className="height-color-legend__bar" aria-hidden="true" />
                <div className="height-color-legend__ticks">
                  {heightLegendTicks.map((value, index) => (
                    <span key={`${index}-${value}`}>{formatHeight(value)}</span>
                  ))}
                </div>
              </div>
              <div className="height-color-legend__footer">
                <span>LOW</span>
                <i />
                <span>HIGH</span>
              </div>
            </aside>
          )}
          <div className="viewer-help">
            <span>
              {interactionMode === 'pan' ? <Move3D size={12} /> : <Rotate3D size={12} />}
              左键{interactionMode === 'pan' ? '拖拽平移' : '自由旋转'}
            </span>
            <span><MousePointer2 size={12} /> 右键始终平移 · 滚轮深度缩放</span>
            <span><Gauge size={12} /> 分辨率仅影响 3D 显示</span>
          </div>
        </>
      )}
    </div>
  );
}
