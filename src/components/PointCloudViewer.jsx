import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  Box,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Keyboard,
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
const AUTO_POINT_BUDGET = 1_000_000;
const DETAIL_DOLLY_FLOOR_RATIO = 1e-5;
// Kept below the float32 projection ceiling while providing 30 orders of
// optical detail range beyond the precision-safe dolly floor.
const MAX_OPTICAL_ZOOM = 1e30;
const WAYPOINT_VOLUME_RATIO = 0.2;
const WAYPOINT_RADIUS_SCALE = Math.cbrt(WAYPOINT_VOLUME_RATIO);
const WAYPOINT_FOCUS_DISTANCE_RATIO = 0.17;
const WAYPOINT_DEFAULT_COLOR = '#ffd166';
const WAYPOINT_SELECTED_BODY_COLOR = '#59dbe8';
const WAYPOINT_SELECTED_HALO_COLOR = '#9b8cff';
const MIN_WAYPOINT_SCREEN_DIAMETER = 8;
const MAX_WAYPOINT_LOD_SCALE = 24;
const ROS_AXIS_SCREEN_LENGTH = 68;
const MIN_ROS_AXIS_LOD_SCALE = 1e-30;
const PICK_DRAG_THRESHOLD = 5;
const KEYBOARD_TAP_DURATION = 0.065;
const KEYBOARD_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const KEYBOARD_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyI',
  'KeyJ',
  'KeyK',
  'KeyL',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);
const KEYBOARD_KEY_CODES = {
  w: 'KeyW',
  a: 'KeyA',
  s: 'KeyS',
  d: 'KeyD',
  i: 'KeyI',
  j: 'KeyJ',
  k: 'KeyK',
  l: 'KeyL',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  shift: 'ShiftLeft',
};

const KEYBOARD_ROTATION_ACTIONS = {
  KeyI: 'pitch-up',
  KeyJ: 'yaw-left',
  KeyK: 'pitch-down',
  KeyL: 'yaw-right',
  ArrowLeft: 'roll-left',
  ArrowRight: 'roll-right',
};

const KEYBOARD_VERTICAL_ACTIONS = {
  ArrowUp: 'z-up',
  ArrowDown: 'z-down',
};

const movementCodeForEvent = (event) =>
  KEYBOARD_CONTROL_CODES.has(event.code)
    ? event.code
    : KEYBOARD_KEY_CODES[String(event.key || '').toLowerCase()] || null;

const readViewVector = (value) => {
  if (!value) return null;
  const x = Number(Array.isArray(value) ? value[0] : value.x);
  const y = Number(Array.isArray(value) ? value[1] : value.y);
  const z = Number(Array.isArray(value) ? value[2] : value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
};

const normalizeCameraView = (value) => {
  if (!value || typeof value !== 'object') return null;
  const position = readViewVector(value.position);
  const target = readViewVector(value.target);
  const up = readViewVector(value.up);
  const zoom = Number(value.zoom);
  const projectionX = Number(value.projectionOffset?.x ?? value.precisionPan?.x ?? 0);
  const projectionY = Number(value.projectionOffset?.y ?? value.precisionPan?.y ?? 0);
  if (
    !position
    || !target
    || !up
    || !Number.isFinite(zoom)
    || zoom <= 0
    || !Number.isFinite(projectionX)
    || !Number.isFinite(projectionY)
  ) {
    return null;
  }
  const viewDistance = Math.hypot(
    position.x - target.x,
    position.y - target.y,
    position.z - target.z,
  );
  if (viewDistance < 1e-12 || Math.hypot(up.x, up.y, up.z) < 1e-12) return null;
  return {
    position,
    target,
    up,
    zoom: THREE.MathUtils.clamp(zoom, 1, MAX_OPTICAL_ZOOM),
    projectionOffset: { x: projectionX, y: projectionY },
  };
};

const cameraViewSignature = (view) => {
  const normalized = normalizeCameraView(view);
  if (!normalized) return '';
  return [
    normalized.position.x,
    normalized.position.y,
    normalized.position.z,
    normalized.target.x,
    normalized.target.y,
    normalized.target.z,
    normalized.up.x,
    normalized.up.y,
    normalized.up.z,
    normalized.zoom,
    normalized.projectionOffset.x,
    normalized.projectionOffset.y,
  ].map((value) => value.toExponential(12)).join('|');
};

const adaptiveResolutionIndex = (pointCount) => {
  if (!pointCount || pointCount <= AUTO_POINT_BUDGET) return DEFAULT_RESOLUTION_INDEX;
  for (let index = DEFAULT_RESOLUTION_INDEX - 1; index >= 0; index -= 1) {
    if (Math.round(pointCount * RESOLUTION_LEVELS[index].ratio) <= AUTO_POINT_BUDGET) {
      return index;
    }
  }
  return 0;
};

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

const colorModeValue = (mode) => (mode === 'height' ? 1 : mode === 'white' ? 2 : 0);
const POINT_COLOR_MODES = [
  { id: 'height', label: '高程色' },
  { id: 'source', label: '原始色' },
  { id: 'white', label: '纯白色' },
];

// Keep the source buffer untouched and perform all three color modes in the GPU.
// The five height stops match the on-screen scale from low (blue) to high (coral).
const installPointColorShader = (material, bounds, colorMode) => {
  material.userData.pointColorMode = colorMode;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasPointColorMode = {
      value: colorModeValue(material.userData.pointColorMode),
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
uniform float atlasPointColorMode;
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
if (atlasPointColorMode > 1.5) {
  diffuseColor.rgb = vec3(1.0);
} else if (atlasPointColorMode > 0.5) {
  diffuseColor.rgb = atlasHeightPalette(vAtlasHeight);
}`,
      );
    material.userData.pointColorShader = shader;
  };
  material.customProgramCacheKey = () => 'atlas-point-color-v2';
};

const statusColor = (status, selected = false) => {
  if (selected) return 0xb7f8ff;
  if (status === 'connected') return 0x5ee59a;
  if (status === 'unreachable') return 0xf4c95d;
  return 0x59dbe8;
};

const tagSelectionTarget = (object, type, id) => {
  object.traverse((child) => {
    child.userData.selectionType = type;
    child.userData.selectionId = id;
  });
};

const selectionForObject = (object) => {
  let current = object;
  while (current) {
    if (current.userData?.selectionType && current.userData?.selectionId) {
      return {
        type: current.userData.selectionType,
        id: current.userData.selectionId,
      };
    }
    current = current.parent;
  }
  return null;
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

const createRosAxisLabel = (text, color, worldHeight) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.font = '700 36px "SFMono-Regular", Menlo, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0, 0, 0, 0.92)';
  context.shadowBlur = 5;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight, worldHeight, 1);
  sprite.renderOrder = 20;
  return sprite;
};

const createRosAxisArrow = (direction, color, length, shaftRadius) => {
  const group = new THREE.Group();
  const shaftLength = length * 0.76;
  const headLength = length - shaftLength;
  const material = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
    material,
  );
  shaft.position.y = shaftLength / 2;
  shaft.renderOrder = 18;

  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(0, shaftRadius * 3.15, headLength, 16),
    material.clone(),
  );
  head.position.y = shaftLength + headLength / 2;
  head.renderOrder = 18;
  group.add(shaft, head);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return group;
};

export default function PointCloudViewer({
  mapData,
  heightRange,
  waypoints,
  edges,
  selectedWaypointId,
  selectedEdgeId,
  colorMode = 'height',
  onColorModeChange,
  showWaypoints = true,
  onShowWaypointsChange,
  onSelectWaypoint,
  onSelectEdge,
  onClearSelection,
  focusRequest,
  initialView,
  onViewChange,
  resetRequest,
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const sliceGroupRef = useRef(null);
  const routeGroupRef = useRef(null);
  const waypointGroupRef = useRef(null);
  const selectedWaypointPulseRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const displayGeometryRef = useRef(null);
  const cloudMaterialRef = useRef(null);
  const colorModeRef = useRef(colorMode);
  const onSelectWaypointRef = useRef(onSelectWaypoint);
  const onSelectEdgeRef = useRef(onSelectEdge);
  const onClearSelectionRef = useRef(onClearSelection);
  const pressedKeysRef = useRef(new Set());
  const keyboardImpulseRef = useRef(new Set());
  const precisionPanRef = useRef(null);
  const focusAnimationRef = useRef(null);
  const pointerInteractionRef = useRef(null);
  const viewActionsRef = useRef(null);
  const initialViewRef = useRef(initialView);
  const onViewChangeRef = useRef(onViewChange);
  const appliedInitialViewRef = useRef(null);
  const appliedResetRevisionRef = useRef(0);
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [shiftPanArmed, setShiftPanArmed] = useState(false);
  const interactionModeRef = useRef(interactionMode);
  colorModeRef.current = colorMode;
  onSelectWaypointRef.current = onSelectWaypoint;
  onSelectEdgeRef.current = onSelectEdge;
  onClearSelectionRef.current = onClearSelection;
  initialViewRef.current = initialView;
  onViewChangeRef.current = onViewChange;
  interactionModeRef.current = interactionMode;
  const [manualResolution, setManualResolution] = useState({ mapKey: null, index: null });

  const sourcePointCount = mapData?.geometry?.getAttribute('position')?.count || 0;
  const resolutionMapKey = mapData?.mapId || mapData?.geometry?.uuid || null;
  const suggestedResolutionIndex = adaptiveResolutionIndex(sourcePointCount);
  const hasManualResolution =
    manualResolution.mapKey === resolutionMapKey
    && Number.isInteger(manualResolution.index);
  const resolutionIndex = hasManualResolution
    ? manualResolution.index
    : suggestedResolutionIndex;
  const resolutionSelection = hasManualResolution
    ? 'manual'
    : resolutionIndex < DEFAULT_RESOLUTION_INDEX
      ? 'auto'
      : 'native';
  const resolution = RESOLUTION_LEVELS[resolutionIndex];
  const renderedPointCount = sourcePointCount
    ? Math.max(1, Math.round(sourcePointCount * resolution.ratio))
    : 0;
  const isHeightColor = colorMode === 'height';
  const colorModeIndex = Math.max(
    0,
    POINT_COLOR_MODES.findIndex((option) => option.id === colorMode),
  );
  const colorModeMeta = POINT_COLOR_MODES[colorModeIndex];
  const nextColorMode = POINT_COLOR_MODES[(colorModeIndex + 1) % POINT_COLOR_MODES.length];
  const heightMin = mapData?.bounds?.min?.z ?? 0;
  const heightMax = mapData?.bounds?.max?.z ?? 1;
  const heightLegendTicks = [1, 0.75, 0.5, 0.25, 0].map(
    (ratio) => heightMin + (heightMax - heightMin) * ratio,
  );
  const chooseResolution = (nextIndex) => {
    setManualResolution({
      mapKey: resolutionMapKey,
      index: Math.max(0, Math.min(DEFAULT_RESOLUTION_INDEX, nextIndex)),
    });
  };

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
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '三维点云交互画布');
    renderer.domElement.setAttribute(
      'aria-keyshortcuts',
      'W A S D I J K L ArrowUp ArrowDown ArrowLeft ArrowRight Shift+W Shift+A Shift+S Shift+D Shift+I Shift+J Shift+K Shift+L Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight',
    );
    renderer.domElement.dataset.geometrySource =
      mapData.geometrySource || geometry.userData.geometrySource || 'ply-parse';
    mount.appendChild(renderer.domElement);

    const bounds = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    const center = sphere.center;
    const radius = Math.max(sphere.radius, 1);
    const overviewNear = Math.max(radius / 2000, 0.01);
    const detailDollyFloor = Math.max(radius * DETAIL_DOLLY_FLOOR_RATIO, 1e-7);
    const minimumEffectiveDistance = detailDollyFloor / MAX_OPTICAL_ZOOM;
    const detailMinNear = Math.max(radius * 1e-10, 1e-10);
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
    // Wheel zoom is handled below so its response remains useful at microscopic distances.
    controls.noZoom = true;
    // Native Trackball panning eventually rounds down to zero at extreme optical
    // zoom. Pointer panning below uses a world/projection hybrid instead.
    controls.noPan = true;
    controls.staticMoving = true;
    // WASD/IJKL are owned by the application. Disable TrackballControls' legacy
    // A/S/D keyboard modes so movement and rotation keys cannot change its state.
    controls.keys = [];
    controls.minDistance = detailDollyFloor;
    controls.maxDistance = radius * 6;
    renderer.domElement.dataset.controlMode = 'free-trackball';
    renderer.domElement.dataset.zoomMode = 'hybrid-continuous-detail';
    renderer.domElement.dataset.keyboardPlane = 'xy-z-locked';
    renderer.domElement.dataset.keyboardVerticalAxis = 'arrow-up:+z,arrow-down:-z';
    renderer.domElement.dataset.keyboardLookMode = 'ijkl-orbit-target';
    renderer.domElement.dataset.keyboardLookKeys = 'i:up,j:left,k:down,l:right';
    renderer.domElement.dataset.keyboardRollMode = 'arrow-left-right-view-axis';
    renderer.domElement.dataset.keyboardRollKeys = 'arrowleft:left,arrowright:right';
    renderer.domElement.dataset.keyboardPanMode = 'world-with-precision-offset';
    renderer.domElement.dataset.keyboardPanImplementation = 'world';
    renderer.domElement.dataset.keyboardPrecisionMovementCount = '0';
    renderer.domElement.dataset.keyboardRotationSpeed = '72deg/s';
    renderer.domElement.dataset.minCameraDistance = detailDollyFloor.toPrecision(8);
    renderer.domElement.dataset.minEffectiveDistance = minimumEffectiveDistance.toExponential(6);
    renderer.domElement.dataset.maxOpticalZoom = MAX_OPTICAL_ZOOM.toExponential(0);
    renderer.domElement.dataset.cameraFov = String(camera.fov);
    controlsRef.current = controls;
    cameraRef.current = camera;
    const defaultCameraView = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      zoom: 1,
      projectionOffset: { x: 0, y: 0 },
    };
    const projectionPan = { x: 0, y: 0 };

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
    installPointColorShader(material, bounds, colorModeRef.current);
    cloudMaterialRef.current = material;
    renderer.domElement.dataset.colorMode = colorModeRef.current;
    const cloud = new THREE.Points(displayGeometry, material);
    scene.add(cloud);

    const zoomBoostForDistance = (effectiveDistance) => {
      const detailOrders = Math.max(
        0,
        Math.log10(radius / Math.max(effectiveDistance, minimumEffectiveDistance)),
      );
      return Math.min(3.5, 1 + detailOrders * 0.24);
    };

    // Dolly toward the target first, then continue optically before floating-point
    // precision can collapse camera.position onto controls.target.
    const syncDetailView = () => {
      const distance = camera.position.distanceTo(controls.target);
      const opticalZoom = Math.max(camera.zoom, 1);
      const effectiveDistance = distance / opticalZoom;
      const nextNear = Math.max(detailMinNear, Math.min(overviewNear, distance / 1000));
      const nextFar = Math.max(radius * 8, distance + radius * 4);
      const normalizedDistance = Math.max(effectiveDistance / (radius * 0.35), 1e-24);
      const pointSizeScale = Math.min(1, Math.max(normalizedDistance ** 0.82, 2e-5));

      material.size = overviewPointSize * pointSizeScale;
      if (camera.near !== nextNear || camera.far !== nextFar) {
        camera.near = nextNear;
        camera.far = nextFar;
        camera.updateProjectionMatrix();
      }

      renderer.domElement.dataset.cameraDistance = distance.toPrecision(8);
      renderer.domElement.dataset.effectiveCameraDistance = effectiveDistance.toExponential(8);
      renderer.domElement.dataset.cameraNear = nextNear.toPrecision(8);
      renderer.domElement.dataset.opticalZoom = opticalZoom.toExponential(8);
      renderer.domElement.dataset.zoomStage = opticalZoom > 1.000001 ? 'optical' : 'dolly';
      renderer.domElement.dataset.zoomBoost = zoomBoostForDistance(effectiveDistance).toFixed(3);
      renderer.domElement.dataset.pointSize = material.size.toPrecision(8);
      renderer.domElement.dataset.cameraX = camera.position.x.toPrecision(10);
      renderer.domElement.dataset.cameraY = camera.position.y.toPrecision(10);
      renderer.domElement.dataset.cameraZ = camera.position.z.toPrecision(10);
      renderer.domElement.dataset.targetX = controls.target.x.toPrecision(10);
      renderer.domElement.dataset.targetY = controls.target.y.toPrecision(10);
      renderer.domElement.dataset.targetZ = controls.target.z.toPrecision(10);
      renderer.domElement.dataset.cameraUpX = camera.up.x.toPrecision(10);
      renderer.domElement.dataset.cameraUpY = camera.up.y.toPrecision(10);
      renderer.domElement.dataset.cameraUpZ = camera.up.z.toPrecision(10);
    };

    const progressiveWheelZoom = (event) => {
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= Math.max(renderer.domElement.clientHeight, 1);
      }
      if (!Number.isFinite(delta) || delta === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      if (!distance) return;
      const effectiveDistance = distance / Math.max(camera.zoom, 1);
      const normalizedDelta = Math.sign(delta) * Math.min(Math.abs(delta), 160);
      const factor = Math.exp(
        normalizedDelta * 0.0017 * zoomBoostForDistance(effectiveDistance),
      );
      const nextEffectiveDistance = THREE.MathUtils.clamp(
        effectiveDistance * factor,
        minimumEffectiveDistance,
        controls.maxDistance,
      );
      const nextDistance = Math.max(nextEffectiveDistance, detailDollyFloor);
      const nextOpticalZoom = Math.min(
        MAX_OPTICAL_ZOOM,
        nextDistance / nextEffectiveDistance,
      );
      camera.position.copy(controls.target).addScaledVector(offset.normalize(), nextDistance);
      camera.zoom = nextOpticalZoom;
      camera.updateProjectionMatrix();
      controls.update();
      syncDetailView();
      reportCameraView();
    };
    renderer.domElement.addEventListener('wheel', progressiveWheelZoom, {
      passive: false,
      capture: true,
    });

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
    originGroup.name = 'ros-rviz-coordinate-origin';
    originGroup.position.set(0, 0, 0);
    const axisLength = THREE.MathUtils.clamp(radius * 0.14, 1, 8);
    originGroup.userData.baseAxisLength = axisLength;
    const shaftRadius = axisLength * 0.025;
    const rosAxisColors = {
      x: { hex: 0xf0443e, css: '#f0443e' },
      y: { hex: 0x38c75a, css: '#38c75a' },
      z: { hex: 0x3c82f6, css: '#3c82f6' },
    };
    const xAxis = createRosAxisArrow(
      new THREE.Vector3(1, 0, 0),
      rosAxisColors.x.hex,
      axisLength,
      shaftRadius,
    );
    const yAxis = createRosAxisArrow(
      new THREE.Vector3(0, 1, 0),
      rosAxisColors.y.hex,
      axisLength,
      shaftRadius,
    );
    const zAxis = createRosAxisArrow(
      new THREE.Vector3(0, 0, 1),
      rosAxisColors.z.hex,
      axisLength,
      shaftRadius,
    );
    const originJoint = new THREE.Mesh(
      new THREE.SphereGeometry(shaftRadius * 1.55, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0xe9edf0,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    originJoint.renderOrder = 19;

    const labelSize = axisLength * 0.16;
    const xLabel = createRosAxisLabel('X', rosAxisColors.x.css, labelSize);
    xLabel.position.set(axisLength * 1.09, 0, 0);
    const yLabel = createRosAxisLabel('Y', rosAxisColors.y.css, labelSize);
    yLabel.position.set(0, axisLength * 1.09, 0);
    const zLabel = createRosAxisLabel('Z', rosAxisColors.z.css, labelSize);
    zLabel.position.set(0, 0, axisLength * 1.09);
    originGroup.add(xAxis, yAxis, zAxis, originJoint, xLabel, yLabel, zLabel);
    scene.add(originGroup);
    renderer.domElement.dataset.coordinateOrigin = '0,0,0';
    renderer.domElement.dataset.coordinateOriginStyle = 'ros-rviz';
    renderer.domElement.dataset.coordinateAxisColors = 'x:red,y:green,z:blue';

    const sliceGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    const waypointGroup = new THREE.Group();
    routeGroup.name = 'directed-route-edges';
    waypointGroup.name = 'navigation-waypoint-markers';
    scene.add(sliceGroup, routeGroup, waypointGroup);
    sliceGroupRef.current = sliceGroup;
    routeGroupRef.current = routeGroup;
    waypointGroupRef.current = waypointGroup;
    sceneRef.current = scene;

    const raycaster = new THREE.Raycaster();
    const normalizedPointer = new THREE.Vector2();
    let pointerStart = null;

    const applyProjectionPan = () => {
      const width = Math.max(renderer.domElement.clientWidth, 1);
      const height = Math.max(renderer.domElement.clientHeight, 1);
      if (Math.abs(projectionPan.x) < 1e-9 && Math.abs(projectionPan.y) < 1e-9) {
        camera.clearViewOffset();
      } else {
        camera.setViewOffset(
          width,
          height,
          projectionPan.x,
          projectionPan.y,
          width,
          height,
        );
      }
      camera.updateProjectionMatrix();
      renderer.domElement.dataset.precisionPanX = projectionPan.x.toFixed(3);
      renderer.domElement.dataset.precisionPanY = projectionPan.y.toFixed(3);
    };

    const clearProjectionPan = () => {
      projectionPan.x = 0;
      projectionPan.y = 0;
      applyProjectionPan();
      renderer.domElement.dataset.panImplementation = 'world';
    };

    const captureCameraView = () => ({
      version: 1,
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      zoom: Math.max(camera.zoom, 1),
      projectionOffset: { x: projectionPan.x, y: projectionPan.y },
    });
    let lastReportedView = '';
    const reportCameraView = (force = false) => {
      const nextView = captureCameraView();
      const signature = cameraViewSignature(nextView);
      if (!signature || (!force && signature === lastReportedView)) return;
      lastReportedView = signature;
      renderer.domElement.dataset.viewSignature = signature;
      onViewChangeRef.current?.(nextView);
    };
    const applyCameraView = (candidate, state = 'restored') => {
      const nextView = normalizeCameraView(candidate);
      if (!nextView) return false;
      camera.position.set(nextView.position.x, nextView.position.y, nextView.position.z);
      controls.target.set(nextView.target.x, nextView.target.y, nextView.target.z);
      camera.up.set(nextView.up.x, nextView.up.y, nextView.up.z).normalize();
      camera.zoom = nextView.zoom;
      projectionPan.x = nextView.projectionOffset.x;
      projectionPan.y = nextView.projectionOffset.y;
      applyProjectionPan();
      controls.update();
      syncDetailView();
      renderer.domElement.dataset.viewState = state;
      renderer.domElement.dataset.viewRestored = state === 'restored' ? 'true' : 'false';
      reportCameraView(true);
      return true;
    };
    const resetCameraView = () => {
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
      }
      applyCameraView(defaultCameraView, 'reset');
      renderer.domElement.dataset.viewResetCount = String(
        Number(renderer.domElement.dataset.viewResetCount || 0) + 1,
      );
    };
    const onControlsChange = () => {
      syncDetailView();
      reportCameraView();
    };
    precisionPanRef.current = { clear: clearProjectionPan };
    viewActionsRef.current = {
      apply: applyCameraView,
      capture: captureCameraView,
      reset: resetCameraView,
    };
    const restoredCameraView = normalizeCameraView(initialViewRef.current);
    if (restoredCameraView) {
      appliedInitialViewRef.current = initialViewRef.current;
      applyCameraView(restoredCameraView, 'restored');
    } else {
      clearProjectionPan();
      renderer.domElement.dataset.viewState = 'default';
      renderer.domElement.dataset.viewRestored = 'false';
      syncDetailView();
      reportCameraView(true);
    }
    controls.addEventListener('change', onControlsChange);

    const getPanMetrics = () => {
      const height = Math.max(renderer.domElement.clientHeight, 1);
      const distance = camera.position.distanceTo(controls.target);
      const effectiveDistance = distance / Math.max(camera.zoom, 1);
      const unitsPerPixel =
        (2 * effectiveDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
        / height;
      const largestCoordinate = Math.max(
        1,
        radius,
        Math.abs(camera.position.x),
        Math.abs(camera.position.y),
        Math.abs(camera.position.z),
        Math.abs(controls.target.x),
        Math.abs(controls.target.y),
        Math.abs(controls.target.z),
      );
      const representableFloor = Number.EPSILON * largestCoordinate * 64;
      return { effectiveDistance, height, representableFloor, unitsPerPixel };
    };

    const needsPrecisionPanForDistance = (intendedWorldDistance, metrics) =>
      camera.zoom > 32
      || intendedWorldDistance <= metrics.representableFloor
      || Math.abs(projectionPan.x) > 1e-9
      || Math.abs(projectionPan.y) > 1e-9;

    const panByPixels = (deltaX, deltaY) => {
      if (!deltaX && !deltaY) return null;
      const metrics = getPanMetrics();
      const intendedWorldDistance = metrics.unitsPerPixel * Math.hypot(deltaX, deltaY);
      const needsPrecisionPan = needsPrecisionPanForDistance(intendedWorldDistance, metrics);

      if (needsPrecisionPan) {
        // setViewOffset is measured in screen pixels, so it remains responsive
        // even when a world-space delta is smaller than machine precision.
        projectionPan.x -= deltaX;
        projectionPan.y -= deltaY;
        applyProjectionPan();
        reportCameraView();
        renderer.domElement.dataset.panImplementation = 'precision-offset';
      } else {
        camera.updateMatrixWorld(true);
        const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const translation = cameraRight
          .multiplyScalar(-deltaX * metrics.unitsPerPixel)
          .add(cameraUp.multiplyScalar(deltaY * metrics.unitsPerPixel));
        camera.position.add(translation);
        controls.target.add(translation);
        controls.update();
        syncDetailView();
        renderer.domElement.dataset.panImplementation = 'world';
      }
      renderer.domElement.dataset.panMovementCount = String(
        Number(renderer.domElement.dataset.panMovementCount || 0) + 1,
      );
      return renderer.domElement.dataset.panImplementation;
    };

    const selectionAtPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);

      if (waypointGroup.visible) {
        const waypointHit = raycaster.intersectObjects(waypointGroup.children, true)[0];
        const waypointSelection = waypointHit
          ? selectionForObject(waypointHit.object)
          : null;
        if (waypointSelection) return waypointSelection;
      }

      const edgeHit = raycaster.intersectObjects(routeGroup.children, true)[0];
      return edgeHit ? selectionForObject(edgeHit.object) : null;
    };

    const updatePickHover = (event) => {
      const selection = selectionAtPointer(event);
      renderer.domElement.classList.toggle('is-pick-hover', Boolean(selection));
      renderer.domElement.dataset.hoverPickType = selection?.type || 'none';
      renderer.domElement.dataset.hoverPickId = selection?.id || '';
    };

    const cancelPointerGesture = (event, reason = 'cancelled') => {
      const pointerId = event?.pointerId ?? pointerStart?.id;
      const hadActiveGesture = Boolean(pointerStart) || controls.state !== -1;
      pointerStart = null;
      controls.state = -1;

      const capturedPointerIds = controls._pointers?.map((pointer) => pointer.pointerId) || [];
      const pointerIds = new Set([
        ...capturedPointerIds,
        ...(Number.isFinite(pointerId) ? [pointerId] : []),
      ]);
      pointerIds.forEach((id) => {
        if (!renderer.domElement.hasPointerCapture?.(id)) return;
        try {
          renderer.domElement.releasePointerCapture(id);
        } catch {
          // The browser may already have released capture while crossing the edge.
        }
      });
      if (controls._pointers) controls._pointers.length = 0;
      controls._pointerPositions = {};
      renderer.domElement.removeEventListener('pointermove', controls._onPointerMove);
      renderer.domElement.removeEventListener('pointerup', controls._onPointerUp);
      renderer.domElement.classList.remove('is-pick-hover', 'is-panning');
      renderer.domElement.dataset.pointerGestureState = hadActiveGesture ? reason : 'idle';
      if (hadActiveGesture) {
        renderer.domElement.dataset.pointerGestureCancelCount = String(
          Number(renderer.domElement.dataset.pointerGestureCancelCount || 0) + 1,
        );
      }
      return hadActiveGesture;
    };

    const promotePointerToShiftPan = () => {
      if (
        !pointerStart
        || pointerStart.button !== 0
        || pointerStart.panGesture
        || interactionModeRef.current !== 'rotate'
      ) {
        return false;
      }

      // A drag may already belong to TrackballControls when Shift is pressed
      // after pointerdown. Stop only its native gesture while retaining pointer
      // capture for the precision pan implementation below.
      controls.state = -1;
      controls.keyState = -1;
      if (controls._pointers) controls._pointers.length = 0;
      controls._pointerPositions = {};
      renderer.domElement.removeEventListener('pointermove', controls._onPointerMove);
      renderer.domElement.removeEventListener('pointerup', controls._onPointerUp);
      pointerStart.panGesture = true;
      pointerStart.shiftPanOverride = true;
      renderer.domElement.dataset.lastPointerGesture = 'shift-pan';
      renderer.domElement.dataset.effectiveInteractionMode = 'shift-pan';
      renderer.domElement.dataset.shiftPanActivationCount = String(
        Number(renderer.domElement.dataset.shiftPanActivationCount || 0) + 1,
      );
      return true;
    };
    pointerInteractionRef.current = { activateShiftPan: promotePointerToShiftPan };

    const onPickPointerDown = (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
        renderer.domElement.dataset.synchronizedFocusState = 'interrupted';
      }
      const shiftPressed =
        event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight');
      const shiftPanOverride =
        event.button === 0
        && interactionModeRef.current === 'rotate'
        && shiftPressed;
      const panGesture =
        event.button === 2
        || (event.button === 0 && interactionModeRef.current === 'pan')
        || shiftPanOverride;
      if (shiftPanOverride) {
        setShiftPanArmed(true);
        event.stopImmediatePropagation();
      }
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        button: event.button,
        panGesture,
        shiftPanOverride,
        moved: false,
      };
      if (panGesture) {
        event.preventDefault();
        renderer.domElement.setPointerCapture?.(event.pointerId);
      }
      renderer.domElement.dataset.lastPointerGesture = shiftPanOverride
        ? 'shift-pan'
        : panGesture ? 'pan' : 'rotate-or-pick';
      renderer.domElement.dataset.pointerGestureState = 'active';
      renderer.domElement.classList.remove('is-pick-hover');
    };
    const onPickPointerMove = (event) => {
      if (pointerStart?.id === event.pointerId) {
        const rect = renderer.domElement.getBoundingClientRect();
        const outside =
          event.clientX < rect.left
          || event.clientX > rect.right
          || event.clientY < rect.top
          || event.clientY > rect.bottom;
        if (outside) {
          cancelPointerGesture(event, 'cancelled-on-leave');
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const liveShiftPressed =
          event.shiftKey
          || pressedKeysRef.current.has('ShiftLeft')
          || pressedKeysRef.current.has('ShiftRight');
        if (
          liveShiftPressed
          && interactionModeRef.current === 'rotate'
          && promotePointerToShiftPan()
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        pointerStart.moved =
          pointerStart.moved
          || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
            > PICK_DRAG_THRESHOLD;
        if (pointerStart.panGesture && pointerStart.moved) {
          panByPixels(
            event.clientX - pointerStart.lastX,
            event.clientY - pointerStart.lastY,
          );
          renderer.domElement.classList.add('is-panning');
        }
        pointerStart.lastX = event.clientX;
        pointerStart.lastY = event.clientY;
        return;
      }
      updatePickHover(event);
    };
    const onPickPointerUp = (event) => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      const start = pointerStart;
      pointerStart = null;
      renderer.domElement.dataset.pointerGestureState = 'ended';
      renderer.domElement.classList.remove('is-panning');
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      if (
        start.button !== 0
        ||
        start.moved
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > PICK_DRAG_THRESHOLD
      ) {
        return;
      }

      const selection = selectionAtPointer(event);
      renderer.domElement.dataset.lastPickType = selection?.type || 'none';
      renderer.domElement.dataset.lastPickId = selection?.id || '';
      if (selection?.type === 'waypoint') onSelectWaypointRef.current?.(selection.id);
      else if (selection?.type === 'edge') onSelectEdgeRef.current?.(selection.id);
      else onClearSelectionRef.current?.();
    };
    const resetPickPointer = (event) => {
      cancelPointerGesture(event, 'cancelled-by-browser');
    };
    const onPickPointerLeave = (event) => {
      if (pointerStart?.id === event.pointerId) {
        cancelPointerGesture(event, 'cancelled-on-leave');
        return;
      }
      renderer.domElement.classList.remove('is-pick-hover');
    };

    renderer.domElement.addEventListener('pointerdown', onPickPointerDown, true);
    renderer.domElement.addEventListener('pointermove', onPickPointerMove, true);
    renderer.domElement.addEventListener('pointerup', onPickPointerUp);
    renderer.domElement.addEventListener('pointercancel', resetPickPointer);
    renderer.domElement.addEventListener('pointerleave', onPickPointerLeave);

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      applyProjectionPan();
      controls.handleResize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    syncDetailView();

    const frameClock = new THREE.Clock();
    const worldUp = new THREE.Vector3(0, 0, 1);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
    const verticalMovement = new THREE.Vector3();
    const screenRight = new THREE.Vector3();
    const screenUp = new THREE.Vector3();
    const cameraOffset = new THREE.Vector3();
    const lookForward = new THREE.Vector3();
    const lookRight = new THREE.Vector3();
    const rollAxis = new THREE.Vector3();
    const keyboardRotation = new THREE.Quaternion();
    const waypointCameraPosition = new THREE.Vector3();
    const originCameraPosition = new THREE.Vector3();
    renderer.setAnimationLoop(() => {
      const deltaSeconds = Math.min(frameClock.getDelta(), 0.05);
      const pressedKeys = pressedKeysRef.current;
      const keyboardImpulses = keyboardImpulseRef.current;
      let keyboardMoved = false;
      if (pressedKeys.size || keyboardImpulses.size) {
        const keyActive = (code) => pressedKeys.has(code) || keyboardImpulses.has(code);
        camera.getWorldDirection(forward);
        forward.z = 0;
        if (forward.lengthSq() < 1e-12) forward.set(0, 1, 0);
        else forward.normalize();
        right.crossVectors(forward, worldUp).normalize();
        const forwardInput = Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
        const strafeInput = Number(keyActive('KeyD')) - Number(keyActive('KeyA'));
        const verticalInput = Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
        movement.copy(forward).multiplyScalar(forwardInput);
        movement.addScaledVector(right, strafeInput);

        if (movement.lengthSq() > 0) {
          const metrics = getPanMetrics();
          const baseSpeed = THREE.MathUtils.clamp(
            metrics.effectiveDistance * 0.75,
            radius * 1e-8,
            radius * 0.4,
          );
          const speedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 3 : 1;
          const hasTapImpulse =
            keyboardImpulses.has('KeyW')
            || keyboardImpulses.has('KeyA')
            || keyboardImpulses.has('KeyS')
            || keyboardImpulses.has('KeyD');
          const movementDuration = hasTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const worldStep = baseSpeed * speedMultiplier * movementDuration;
          movement.normalize();

          if (needsPrecisionPanForDistance(worldStep, metrics)) {
            // At high optical zoom, adding the tiny XY delta to camera/target can
            // disappear when Three.js uploads float32 view matrices. Express the
            // same projected motion as pixels instead; setViewOffset remains
            // responsive throughout the full optical zoom range.
            camera.updateMatrixWorld(true);
            screenRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
            screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
            const pixelStep =
              (0.75 * speedMultiplier * movementDuration * metrics.height)
              / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
            let deltaX = -movement.dot(screenRight) * pixelStep;
            let deltaY = movement.dot(screenUp) * pixelStep;
            const projectedPixels = Math.hypot(deltaX, deltaY);
            const minimumPerceptiblePixels = pixelStep * 0.28;

            // A world-XY forward vector becomes almost parallel to the view at a
            // level camera angle. Its true screen projection then approaches zero,
            // so retain its direction and provide a small, reversible visual step.
            if (projectedPixels < minimumPerceptiblePixels && forwardInput) {
              if (projectedPixels > 1e-9) {
                const boost = minimumPerceptiblePixels / projectedPixels;
                deltaX *= boost;
                deltaY *= boost;
              } else {
                deltaY = -Math.sign(forwardInput) * minimumPerceptiblePixels;
              }
            }

            const implementation = panByPixels(deltaX, deltaY);
            renderer.domElement.dataset.keyboardPanImplementation = implementation;
            renderer.domElement.dataset.keyboardPrecisionPixels = Math.hypot(
              deltaX,
              deltaY,
            ).toFixed(3);
            renderer.domElement.dataset.keyboardPrecisionMovementCount = String(
              Number(renderer.domElement.dataset.keyboardPrecisionMovementCount || 0) + 1,
            );
          } else {
            movement.multiplyScalar(worldStep);
            camera.position.add(movement);
            controls.target.add(movement);
            renderer.domElement.dataset.keyboardPanImplementation = 'world';
          }
          keyboardMoved = true;
        }

        if (verticalInput) {
          const distance = camera.position.distanceTo(controls.target);
          const effectiveDistance = distance / Math.max(camera.zoom, 1);
          const baseSpeed = THREE.MathUtils.clamp(
            effectiveDistance * 0.75,
            radius * 1e-8,
            radius * 0.4,
          );
          const speedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 3 : 1;
          const hasTapImpulse =
            keyboardImpulses.has('ArrowUp') || keyboardImpulses.has('ArrowDown');
          const movementDuration = hasTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          verticalMovement
            .copy(worldUp)
            .multiplyScalar(verticalInput * baseSpeed * speedMultiplier * movementDuration);
          camera.position.add(verticalMovement);
          controls.target.add(verticalMovement);
          keyboardMoved = true;
        }

        const yawInput = Number(keyActive('KeyJ')) - Number(keyActive('KeyL'));
        const pitchInput = Number(keyActive('KeyI')) - Number(keyActive('KeyK'));
        const rollInput = Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
        if (yawInput || pitchInput || rollInput) {
          const hasRotationTapImpulse =
            keyboardImpulses.has('KeyI')
            || keyboardImpulses.has('KeyJ')
            || keyboardImpulses.has('KeyK')
            || keyboardImpulses.has('KeyL')
            || keyboardImpulses.has('ArrowLeft')
            || keyboardImpulses.has('ArrowRight');
          const rotationDuration = hasRotationTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const rotationSpeedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 1.8 : 1;
          const rotationStep =
            KEYBOARD_ROTATION_SPEED * rotationSpeedMultiplier * rotationDuration;

          cameraOffset.copy(camera.position).sub(controls.target);
          if (yawInput) {
            keyboardRotation.setFromAxisAngle(worldUp, yawInput * rotationStep);
            cameraOffset.applyQuaternion(keyboardRotation);
            camera.up.applyQuaternion(keyboardRotation);
          }
          if (pitchInput) {
            lookForward.copy(cameraOffset).multiplyScalar(-1).normalize();
            lookRight.crossVectors(lookForward, camera.up).normalize();
            if (lookRight.lengthSq() > 1e-12) {
              keyboardRotation.setFromAxisAngle(lookRight, pitchInput * rotationStep);
              cameraOffset.applyQuaternion(keyboardRotation);
              camera.up.applyQuaternion(keyboardRotation);
            }
          }
          if (rollInput && cameraOffset.lengthSq() > 1e-12) {
            // Rotate only the camera's up vector around the backward viewing
            // axis. Positive input tilts the camera top toward screen-left.
            rollAxis.copy(cameraOffset).normalize();
            keyboardRotation.setFromAxisAngle(rollAxis, rollInput * rotationStep);
            camera.up.applyQuaternion(keyboardRotation);
          }
          camera.up.normalize();
          camera.position.copy(controls.target).add(cameraOffset);
          keyboardMoved = true;
        }
      }
      keyboardImpulses.clear();
      controls.update();
      if (keyboardMoved) {
        syncDetailView();
        // TrackballControls emits change events for position changes, but a
        // pure roll only changes camera.up and therefore needs an explicit save.
        reportCameraView();
      }

      camera.updateMatrixWorld(true);
      const focalPixels =
        (Math.max(renderer.domElement.clientHeight, 1) / 2)
        / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      originCameraPosition.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
      const originDepth = -originCameraPosition.z;
      if (originDepth > 1e-9) {
        const naturalAxisPixels =
          (originGroup.userData.baseAxisLength * camera.zoom * focalPixels)
          / originDepth;
        const originLodScale = THREE.MathUtils.clamp(
          ROS_AXIS_SCREEN_LENGTH / Math.max(naturalAxisPixels, 1e-30),
          MIN_ROS_AXIS_LOD_SCALE,
          1,
        );
        originGroup.scale.setScalar(originLodScale);
        renderer.domElement.dataset.coordinateAxisScale = originLodScale.toExponential(5);
        renderer.domElement.dataset.coordinateAxisScreenLength = (
          naturalAxisPixels * originLodScale
        ).toFixed(2);
      }

      if (waypointGroup.visible && waypointGroup.children.length) {
        let smallestDiameter = Number.POSITIVE_INFINITY;
        let largestLodScale = 1;
        waypointGroup.children.forEach((markerGroup) => {
          waypointCameraPosition
            .copy(markerGroup.position)
            .applyMatrix4(camera.matrixWorldInverse);
          const depth = -waypointCameraPosition.z;
          if (depth <= 1e-9) {
            markerGroup.scale.setScalar(1);
            return;
          }
          const naturalDiameter =
            (2 * (markerGroup.userData.baseRadius || 0) * camera.zoom * focalPixels)
            / depth;
          const lodScale = THREE.MathUtils.clamp(
            MIN_WAYPOINT_SCREEN_DIAMETER / Math.max(naturalDiameter, 1e-9),
            1,
            MAX_WAYPOINT_LOD_SCALE,
          );
          markerGroup.scale.setScalar(lodScale);
          const renderedDiameter = naturalDiameter * lodScale;
          markerGroup.userData.screenDiameter = renderedDiameter;
          smallestDiameter = Math.min(smallestDiameter, renderedDiameter);
          largestLodScale = Math.max(largestLodScale, lodScale);
        });
        renderer.domElement.dataset.smallestWaypointScreenDiameter =
          Number.isFinite(smallestDiameter) ? smallestDiameter.toFixed(2) : '0';
        renderer.domElement.dataset.waypointMaxLodScale = largestLodScale.toFixed(3);
      }

      const selectedHalo = selectedWaypointPulseRef.current;
      if (selectedHalo) {
        const pulse = 1.06 + Math.sin(performance.now() * 0.0042) * 0.12;
        selectedHalo.scale.setScalar(pulse);
        selectedHalo.material.opacity = 0.22 + ((pulse - 0.94) / 0.24) * 0.34;
        renderer.domElement.dataset.selectedWaypointPulse = pulse.toFixed(3);
      }
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('wheel', progressiveWheelZoom, true);
      renderer.domElement.removeEventListener('pointerdown', onPickPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', onPickPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', onPickPointerUp);
      renderer.domElement.removeEventListener('pointercancel', resetPickPointer);
      renderer.domElement.removeEventListener('pointerleave', onPickPointerLeave);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      displayGeometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      disposeObject(originGroup);
      disposeObject(sliceGroup);
      disposeObject(routeGroup);
      disposeObject(waypointGroup);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      sliceGroupRef.current = null;
      routeGroupRef.current = null;
      waypointGroupRef.current = null;
      selectedWaypointPulseRef.current = null;
      if (precisionPanRef.current?.clear === clearProjectionPan) {
        precisionPanRef.current = null;
      }
      if (viewActionsRef.current?.reset === resetCameraView) {
        viewActionsRef.current = null;
      }
      if (pointerInteractionRef.current?.activateShiftPan === promotePointerToShiftPan) {
        pointerInteractionRef.current = null;
      }
      controlsRef.current = null;
      cameraRef.current = null;
      displayGeometryRef.current = null;
      if (cloudMaterialRef.current === material) cloudMaterialRef.current = null;
    };
  }, [mapData?.geometry]);

  useEffect(() => {
    if (!initialView || appliedInitialViewRef.current === initialView) return;
    if (viewActionsRef.current?.apply?.(initialView, 'restored')) {
      appliedInitialViewRef.current = initialView;
    }
  }, [initialView, mapData?.geometry]);

  useEffect(() => {
    const revision = Number(resetRequest?.revision) || 0;
    if (!revision || revision === appliedResetRevisionRef.current || !mapData?.geometry) return;
    appliedResetRevisionRef.current = revision;
    viewActionsRef.current?.reset?.();
  }, [mapData?.geometry, resetRequest]);

  useEffect(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const canvas = controls?.domElement;
    const sphere = mapData?.geometry?.boundingSphere;
    if (!focusRequest || !controls || !camera || !canvas || !sphere) return undefined;

    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    let target = null;
    let subjectSpan = 0;
    if (focusRequest.type === 'waypoint') {
      const point = pointById.get(focusRequest.id);
      if (point) target = new THREE.Vector3(point.pose.x, point.pose.y, point.pose.z);
    } else if (focusRequest.type === 'edge') {
      const edge = edges.find((item) => item.id === focusRequest.id);
      const source = edge ? pointById.get(edge.from) : null;
      const destination = edge ? pointById.get(edge.to) : null;
      if (source && destination) {
        const start = new THREE.Vector3(source.pose.x, source.pose.y, source.pose.z);
        const end = new THREE.Vector3(
          destination.pose.x,
          destination.pose.y,
          destination.pose.z,
        );
        target = start.clone().add(end).multiplyScalar(0.5);
        subjectSpan = start.distanceTo(end);
      }
    }
    if (!target) return undefined;

    if (focusAnimationRef.current) cancelAnimationFrame(focusAnimationRef.current);
    precisionPanRef.current?.clear?.();
    const startTarget = controls.target.clone();
    const startPosition = camera.position.clone();
    const startZoom = Math.max(camera.zoom, 1);
    const viewDirection = startPosition.clone().sub(startTarget);
    if (viewDirection.lengthSq() < 1e-18) viewDirection.set(-0.5, -0.8, 0.45);
    viewDirection.normalize();
    const routeScale = Math.max(sphere.radius * 0.006, 0.12);
    const desiredDistance = THREE.MathUtils.clamp(
      focusRequest.type === 'edge'
        ? Math.max(subjectSpan * 1.45, sphere.radius * 0.12, routeScale * 12)
        : Math.max(sphere.radius * WAYPOINT_FOCUS_DISTANCE_RATIO, routeScale * 12),
      controls.minDistance * 2,
      controls.maxDistance * 0.82,
    );
    const endPosition = target.clone().addScaledVector(viewDirection, desiredDistance);
    const startedAt = performance.now();
    const duration = 560;

    canvas.dataset.synchronizedFocusType = focusRequest.type;
    canvas.dataset.synchronizedFocusId = focusRequest.id;
    canvas.dataset.synchronizedFocusRevision = String(focusRequest.revision);
    canvas.dataset.synchronizedFocusState = 'animating';
    canvas.dataset.synchronizedFocusTargetDistance = desiredDistance.toPrecision(8);
    if (focusRequest.type === 'waypoint') {
      canvas.dataset.waypointFocusDistanceRatio = String(WAYPOINT_FOCUS_DISTANCE_RATIO);
    }

    const animateFocus = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      controls.target.lerpVectors(startTarget, target, eased);
      camera.position.lerpVectors(startPosition, endPosition, eased);
      camera.zoom = Math.exp(Math.log(startZoom) * (1 - eased));
      camera.updateProjectionMatrix();
      controls.update();
      canvas.dataset.synchronizedFocusProgress = progress.toFixed(3);
      if (progress < 1) {
        focusAnimationRef.current = requestAnimationFrame(animateFocus);
      } else {
        focusAnimationRef.current = null;
        canvas.dataset.synchronizedFocusState = 'settled';
      }
    };
    focusAnimationRef.current = requestAnimationFrame(animateFocus);

    return () => {
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
      }
    };
  }, [focusRequest, mapData?.geometry]);

  useEffect(() => {
    const material = cloudMaterialRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!material || !canvas) return;

    material.userData.pointColorMode = colorMode;
    const shader = material.userData.pointColorShader;
    if (shader) shader.uniforms.atlasPointColorMode.value = colorModeValue(colorMode);
    canvas.dataset.colorMode = colorMode;
  }, [colorMode, mapData?.geometry]);

  useEffect(() => {
    const displayGeometry = displayGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!displayGeometry || !canvas || !sourcePointCount) return;

    displayGeometry.setDrawRange(0, renderedPointCount);
    canvas.dataset.resolutionPercent = String(Math.round(resolution.ratio * 100));
    canvas.dataset.renderPointCount = String(renderedPointCount);
    canvas.dataset.resolutionSelection = resolutionSelection;
    canvas.dataset.autoPointBudget = String(AUTO_POINT_BUDGET);
  }, [renderedPointCount, resolution.ratio, resolutionSelection, sourcePointCount]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const temporaryShiftPan = interactionMode === 'rotate' && shiftPanArmed;
    controls.mouseButtons.LEFT =
      interactionMode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.domElement.dataset.interactionMode = interactionMode;
    controls.domElement.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
    controls.domElement.dataset.effectiveInteractionMode = temporaryShiftPan
      ? 'shift-pan'
      : interactionMode;
    controls.domElement.dataset.keyboardEnabled = 'true';
    controls.domElement.dataset.keyboardMode = 'always-on';
  }, [interactionMode, mapData?.geometry, shiftPanArmed]);

  useEffect(() => {
    if (!mapData?.geometry) return undefined;
    const resetKeys = (updateUi = true) => {
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      if (updateUi) setShiftPanArmed(false);
      const canvas = controlsRef.current?.domElement;
      if (canvas) {
        canvas.dataset.shiftPanArmed = 'false';
        canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
      }
    };
    const onKeyDown = (event) => {
      const code = movementCodeForEvent(event);
      if (!code) return;
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase();
      if (
        target?.isContentEditable
        || tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || event.metaKey
        || event.ctrlKey
        || event.altKey
      ) {
        return;
      }
      const isActionKey = code !== 'ShiftLeft' && code !== 'ShiftRight';
      if (isActionKey) event.preventDefault();
      pressedKeysRef.current.add(code);
      if (!event.repeat && isActionKey) keyboardImpulseRef.current.add(code);
      const canvas = controlsRef.current?.domElement;
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        const temporaryShiftPan = interactionModeRef.current === 'rotate';
        setShiftPanArmed(temporaryShiftPan);
        if (canvas) {
          canvas.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
          canvas.dataset.effectiveInteractionMode = temporaryShiftPan
            ? 'shift-pan'
            : interactionModeRef.current;
        }
        if (temporaryShiftPan) pointerInteractionRef.current?.activateShiftPan?.();
      }
      if (canvas && isActionKey) {
        canvas.dataset.lastKeyboardKey = code.startsWith('Key') ? code.slice(3) : code;
        if (KEYBOARD_ROTATION_ACTIONS[code]) {
          canvas.dataset.lastKeyboardRotation = KEYBOARD_ROTATION_ACTIONS[code];
        }
        if (KEYBOARD_VERTICAL_ACTIONS[code]) {
          canvas.dataset.lastKeyboardVertical = KEYBOARD_VERTICAL_ACTIONS[code];
        }
        canvas.dataset.keyboardInputCount = String(
          Number(canvas.dataset.keyboardInputCount || 0) + 1,
        );
      }
    };
    const onKeyUp = (event) => {
      const code = movementCodeForEvent(event);
      if (!code) return;
      pressedKeysRef.current.delete(code);
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        const shiftStillPressed =
          pressedKeysRef.current.has('ShiftLeft')
          || pressedKeysRef.current.has('ShiftRight');
        const temporaryShiftPan = shiftStillPressed && interactionModeRef.current === 'rotate';
        setShiftPanArmed(temporaryShiftPan);
        const canvas = controlsRef.current?.domElement;
        if (canvas) {
          canvas.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
          canvas.dataset.effectiveInteractionMode = temporaryShiftPan
            ? 'shift-pan'
            : interactionModeRef.current;
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') resetKeys();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', resetKeys);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', resetKeys);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resetKeys(false);
    };
  }, [mapData?.geometry]);

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

    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.sliceMode = 'range';
      canvas.dataset.sliceGeometry = 'box';
      canvas.dataset.sliceMin = Number(heightRange[0]).toPrecision(10);
      canvas.dataset.sliceMax = Number(heightRange[1]).toPrecision(10);
      canvas.dataset.sliceSpan = Math.max(0, heightRange[1] - heightRange[0]).toPrecision(10);
    }
  }, [heightRange, mapData?.geometry]);

  useEffect(() => {
    const group = routeGroupRef.current;
    const waypointGroup = waypointGroupRef.current;
    const sphere = mapData?.geometry?.boundingSphere;
    if (!group || !waypointGroup || !sphere) return;
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }
    while (waypointGroup.children.length) {
      const child = waypointGroup.children.pop();
      disposeObject(child);
    }
    selectedWaypointPulseRef.current = null;

    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    const edgeKeys = new Set(edges.map((edge) => `${edge.from}:${edge.to}`));
    const routeScale = Math.max(sphere.radius * 0.006, 0.12);
    const waypointRadius = routeScale * WAYPOINT_RADIUS_SCALE;
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.waypointCount = String(waypoints.length);
      canvas.dataset.waypointVolumeRatio = String(WAYPOINT_VOLUME_RATIO);
      canvas.dataset.waypointRadiusScale = WAYPOINT_RADIUS_SCALE.toFixed(6);
      canvas.dataset.waypointRadius = waypointRadius.toPrecision(8);
      canvas.dataset.waypointVisibilityMode = 'screen-clamped-lod';
      canvas.dataset.minimumWaypointScreenDiameter = String(MIN_WAYPOINT_SCREEN_DIAMETER);
    }

    edges.forEach((edge) => {
      const source = pointById.get(edge.from);
      const target = pointById.get(edge.to);
      if (!source || !target) return;
      const start = new THREE.Vector3(
        source.pose.x,
        source.pose.y,
        source.pose.z + routeScale * 0.25,
      );
      const end = new THREE.Vector3(
        target.pose.x,
        target.pose.y,
        target.pose.z + routeScale * 0.25,
      );
      if (edgeKeys.has(`${edge.to}:${edge.from}`)) {
        const laneNormal = new THREE.Vector3(
          -(end.y - start.y),
          end.x - start.x,
          0,
        );
        if (laneNormal.lengthSq() < 1e-12) laneNormal.set(1, 0, 0);
        laneNormal.normalize().multiplyScalar(routeScale * 0.7);
        start.add(laneNormal);
        end.add(laneNormal);
      }
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 0.001) return;
      direction.normalize();
      const selected = edge.id === selectedEdgeId;
      const edgeGroup = new THREE.Group();
      const arrow = new THREE.ArrowHelper(
        direction,
        start,
        length,
        statusColor(edge.status, selected),
        Math.min(routeScale * 2.1, length * 0.24),
        routeScale * 0.72,
      );
      const hitGeometry = new THREE.CylinderGeometry(
        Math.max(routeScale * 0.55, waypointRadius * 0.9),
        Math.max(routeScale * 0.55, waypointRadius * 0.9),
        length,
        8,
        1,
        true,
      );
      const hitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
        side: THREE.DoubleSide,
      });
      const hitTarget = new THREE.Mesh(hitGeometry, hitMaterial);
      hitTarget.position.copy(start).addScaledVector(direction, length / 2);
      hitTarget.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      edgeGroup.add(arrow, hitTarget);
      tagSelectionTarget(edgeGroup, 'edge', edge.id);
      group.add(edgeGroup);
    });

    waypoints.forEach((point) => {
      const selected = point.id === selectedWaypointId;
      const markerGroup = new THREE.Group();
      markerGroup.userData.baseRadius = waypointRadius;
      const markerGeometry = new THREE.SphereGeometry(
        waypointRadius,
        16,
        12,
      );
      const markerMaterial = new THREE.MeshBasicMaterial({
        color: selected ? WAYPOINT_SELECTED_BODY_COLOR : WAYPOINT_DEFAULT_COLOR,
        depthTest: false,
      });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.renderOrder = 10;
      if (selected) {
        const haloGeometry = new THREE.SphereGeometry(waypointRadius * 1.48, 18, 12);
        const haloMaterial = new THREE.MeshBasicMaterial({
          color: WAYPOINT_SELECTED_HALO_COLOR,
          transparent: true,
          opacity: 0.36,
          wireframe: true,
          depthTest: false,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(haloGeometry, haloMaterial);
        halo.renderOrder = 9;
        markerGroup.add(halo);
        selectedWaypointPulseRef.current = halo;
      }
      const hitGeometry = new THREE.SphereGeometry(
        Math.max(waypointRadius * 2.2, routeScale * 0.9),
        10,
        8,
      );
      const hitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
      const hitTarget = new THREE.Mesh(hitGeometry, hitMaterial);
      markerGroup.position.set(point.pose.x, point.pose.y, point.pose.z);
      markerGroup.add(marker, hitTarget);
      tagSelectionTarget(markerGroup, 'waypoint', point.id);
      waypointGroup.add(markerGroup);
    });
    if (canvas) {
      canvas.dataset.routeEdgeCount = String(group.children.length);
      canvas.dataset.renderedWaypointCount = String(waypointGroup.children.length);
      canvas.dataset.selectedWaypointPulseState = selectedWaypointId ? 'active' : 'idle';
      canvas.dataset.selectedWaypointBodyColor = WAYPOINT_SELECTED_BODY_COLOR;
      canvas.dataset.selectedWaypointHaloColor = WAYPOINT_SELECTED_HALO_COLOR;
    }
  }, [edges, mapData?.geometry, selectedEdgeId, selectedWaypointId, waypoints]);

  useEffect(() => {
    const waypointGroup = waypointGroupRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!waypointGroup || !canvas) return;
    waypointGroup.visible = showWaypoints;
    canvas.dataset.waypointsVisible = showWaypoints ? 'true' : 'false';
    canvas.dataset.waypointVisualStatus = showWaypoints
      ? waypointGroup.children.length ? 'visible' : 'no-waypoints'
      : 'hidden-by-user';
  }, [mapData?.geometry, showWaypoints, waypoints.length]);

  const focusOrigin = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    precisionPanRef.current?.clear?.();
    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(0, 0, 0);
    camera.position.copy(offset);
    controls.update();
  };

  const resetView = () => viewActionsRef.current?.reset?.();
  const temporaryShiftPan = interactionMode === 'rotate' && shiftPanArmed;

  return (
    <div
      className={`point-cloud-view ${temporaryShiftPan ? 'is-shift-pan-armed' : ''}`}
      ref={mountRef}
    >
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
          <div className="viewer-top-tools">
            <div className="viewer-tool-switch" role="toolbar" aria-label="三维视图工具">
              <button
                type="button"
                className={interactionMode === 'rotate' && !temporaryShiftPan ? 'is-active' : ''}
                aria-pressed={interactionMode === 'rotate' && !temporaryShiftPan}
                onClick={() => setInteractionMode('rotate')}
                title="左键拖拽旋转"
              >
                <Rotate3D size={13} /> 旋转
              </button>
              <button
                type="button"
                className={`${interactionMode === 'pan' || temporaryShiftPan ? 'is-active' : ''} ${temporaryShiftPan ? 'is-temporary' : ''}`}
                aria-pressed={interactionMode === 'pan' || temporaryShiftPan}
                onClick={() => setInteractionMode('pan')}
                title={temporaryShiftPan ? 'Shift 临时平移已启用' : '左键拖拽平移'}
              >
                <Move3D size={13} /> {temporaryShiftPan ? 'Shift 平移' : '平移'}
              </button>
              <button
                type="button"
                className={showWaypoints ? 'is-active' : 'is-hidden-state'}
                aria-label={showWaypoints ? '隐藏3D路径点' : '显示3D路径点'}
                aria-pressed={showWaypoints}
                title={showWaypoints ? '隐藏3D导航点小球，保留路径连线' : '显示3D导航点小球'}
                onClick={() => onShowWaypointsChange?.(!showWaypoints)}
              >
                {showWaypoints ? <Eye size={13} /> : <EyeOff size={13} />}
                {showWaypoints ? '路径点' : '点已隐藏'}
              </button>
              <button type="button" onClick={focusOrigin} title="将三维视图中心定位到坐标原点">
                <Crosshair size={13} /> 原点
              </button>
              <button
                type="button"
                onClick={resetView}
                title="恢复点云初始相机位置、旋转与缩放"
                aria-label="重置3D视角"
              >
                <RotateCcw size={13} /> 重置视角
              </button>
            </div>
            <div
              className="viewer-resolution-control"
              role="group"
              aria-label="点云显示分辨率"
              title={
                resolutionSelection === 'auto'
                  ? `源点数超过 ${AUTO_POINT_BUDGET.toLocaleString('zh-CN')}，已自动选择当前档位；可用按钮手动覆盖`
                  : '仅调整 3D 显示采样，不改变 2D 截面和导航数据'
              }
            >
              <div
                className={`resolution-readout tone-${resolution.tone} ${resolutionSelection === 'auto' ? 'is-auto' : ''}`}
                role="status"
                aria-label={`${resolutionSelection === 'auto' ? '自动降采样，' : ''}3D 点云分辨率 ${Math.round(resolution.ratio * 100)}%，渲染 ${renderedPointCount.toLocaleString('zh-CN')} 个点`}
              >
                <Gauge size={14} />
                <span>
                  <small>{resolutionSelection === 'auto' ? `自动·${resolution.label}` : resolution.label}</small>
                  <strong>{Math.round(resolution.ratio * 100)}%</strong>
                </span>
                <em>{formatPointCount(renderedPointCount)} PTS</em>
              </div>
              <button
                type="button"
                aria-label="降低点云分辨率"
                title="降低分辨率，提高浏览性能"
                disabled={resolutionIndex === 0}
                onClick={() => chooseResolution(resolutionIndex - 1)}
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                aria-label="提高点云分辨率"
                title="提高分辨率，显示更多原始点"
                disabled={resolutionIndex === DEFAULT_RESOLUTION_INDEX}
                onClick={() => chooseResolution(resolutionIndex + 1)}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className="resolution-reset"
                aria-label="重置点云分辨率"
                title="重置为 100% 原始分辨率"
                disabled={resolutionIndex === DEFAULT_RESOLUTION_INDEX}
                onClick={() => chooseResolution(DEFAULT_RESOLUTION_INDEX)}
              >
                <RotateCcw size={12} />
                <span>重置</span>
              </button>
              <button
                type="button"
                className={`height-color-toggle is-active mode-${colorModeMeta.id}`}
                aria-label="切换点云颜色模式"
                data-color-mode={colorModeMeta.id}
                title={`当前为${colorModeMeta.label}，点击切换为${nextColorMode.label}`}
                onClick={() => onColorModeChange?.(nextColorMode.id)}
              >
                <Palette size={12} />
                <span>{colorModeMeta.label}</span>
              </button>
            </div>
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
              左键{interactionMode === 'pan' ? '平移' : '旋转'} · 点 / 路径可选
            </span>
            <span><Keyboard size={12} /> WASD 平移 · ↑↓ Z升降 · ←→ 翻滚 · IJKL 视角</span>
            <span><MousePointer2 size={12} /> Shift 加速 / 临时平移 · 右键平移</span>
            <span>
              <Gauge size={12} />
              {resolutionSelection === 'auto' ? '点数超限 · 已自动降采样' : '分辨率仅影响 3D 显示'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
