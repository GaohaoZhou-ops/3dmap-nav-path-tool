import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  Bot,
  Box,
  Camera,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Keyboard,
  Lock,
  MapPin,
  MousePointer2,
  Move3D,
  Palette,
  Rotate3D,
  RotateCcw,
  Ruler,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import EndEffectorControlPanel from './EndEffectorControlPanel.jsx';
import {
  createUniformMeshIndex,
  MESH_RENDER_QUALITY_OPTIONS,
  prepareMapGeometryTopology,
  resolveMeshRenderQuality,
} from '../lib/mapGeometry.js';
import {
  clusterNearbyParkingPoints,
  createCommonParkingCandidates,
  DEFAULT_PARKING_CLUSTER_DISTANCE,
  DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
  DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
} from '../lib/parkingPointMerge.js';
import {
  applyRobotJointValues,
  disposeRobotModel,
  getRobotEndEffector,
  loadRobotModel,
  normalizeRobotJointValues,
  normalizeRobotPose,
  readRobotJointValues,
  setRobotJointValue,
} from '../lib/robotLoader.js';
import { normalizeRobotJointLocks } from '../lib/robotJointLocks.js';
import {
  collectTeachingVisionCoverageFrames,
  createTeachingSurfaceProjectionOverlay,
  createTeachingVisionCoverageVolume,
  disposeTeachingSurfaceProjectionOverlay,
  markTeachingSurfaceCoverageRange,
  prepareTeachingVisionCoverageFrames,
  TEACHING_SURFACE_PROJECTION_MODE,
  VISION_COVERAGE_EMPTY_CELL_MODE,
  VISION_COVERAGE_MODE,
  VISION_COVERAGE_SURFACE_STOP,
} from '../lib/visionCoverage.js';
import {
  applyRobotCollisionHighlights,
  collectRobotCollisionProxies,
  createRobotCollisionStatus,
  disposeRobotCollisionProxies,
  ROBOT_COLLISION_CHECK_INTERVAL_MS,
  ROBOT_COLLISION_CONTACT_MARGIN,
  ROBOT_COLLISION_SAFETY_DISTANCE,
  selectRobotCollisionProbe,
  serializeRobotCollisionProxies,
} from '../lib/robotCollision.js';

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
const WAYPOINT_VOLUME_RATIO = 0.14;
const WAYPOINT_RADIUS_SCALE = Math.cbrt(WAYPOINT_VOLUME_RATIO);
// Keep the interaction target at its former size while making only the visible
// marker more compact, so dense waypoint layouts remain easy to select.
const WAYPOINT_HIT_RADIUS_SCALE = Math.cbrt(0.2) * 2.2;
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
const KEYBOARD_WORLD_SPEED_RATIO = 0.75;
const KEYBOARD_MIN_PROJECTED_AXIS = 1e-4;
const KEYBOARD_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const SPACEMOUSE_INPUT_STALE_MS = 180;
const SPACEMOUSE_WHEEL_GUARD_MS = 420;
const SPACEMOUSE_WHEEL_ARBITRATION_MS = 48;
const SPACEMOUSE_FILTER_ATTACK_SECONDS = 0.038;
const SPACEMOUSE_FILTER_RELEASE_SECONDS = 0.068;
const SPACEMOUSE_FILTER_EPSILON = 0.0025;
const SPACEMOUSE_FORWARD_SPEED_RATIO = 0.9;
const SPACEMOUSE_PAN_PIXELS_PER_SECOND = 640;
const SPACEMOUSE_ROTATION_SPEED = THREE.MathUtils.degToRad(125);
const SPACEMOUSE_AXIS_HUD_HOLD_MS = 1000;
const MAIN_VIEW_PREVIEW_CONTROL_EVENT = 'atlas-main-view-preview-control';
const SPACEMOUSE_VIEW_AXES = Object.freeze(['x', 'y', 'z', 'roll', 'pitch', 'yaw']);
const SPACEMOUSE_TRANSLATION_AXES = Object.freeze(['x', 'y', 'z']);
const SPACEMOUSE_ROTATION_AXES = Object.freeze(['roll', 'pitch', 'yaw']);
const SPACEMOUSE_AXIS_HUD_META = Object.freeze({
  x: { code: 'X', label: '前进 / 后退', group: 'XYZ' },
  y: { code: 'Y', label: '向左 / 向右', group: 'XYZ' },
  z: { code: 'Z', label: '向上 / 向下', group: 'XYZ' },
  roll: { code: 'ROLL', label: '左翻滚 / 右翻滚', group: 'RPY' },
  pitch: { code: 'PITCH', label: '前倾 / 后仰', group: 'RPY' },
  yaw: { code: 'YAW', label: '左偏航 / 右偏航', group: 'RPY' },
});
const ROBOT_LINEAR_SPEED = 0.9;
// Ground alignment is an occasional trim operation, so keep this deliberately
// slower than planar driving: a key tap changes height by roughly 8 mm.
const ROBOT_VERTICAL_SPEED = 0.12;
const ROBOT_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const ROBOT_PARKING_GHOST_COLOR = 0x63e6ee;
const ROBOT_PARKING_GHOST_OPACITY = 0.24;
const EMPTY_VISION_COVERAGE_STATS = Object.freeze({
  poseCount: 0,
  frameCount: 0,
  opticalPointCount: 0,
  coordinateFrameCount: 0,
  coordinateAxisCount: 0,
  cellCount: 0,
  hitCellCount: 0,
  renderCellCount: 0,
  omittedCellCount: 0,
  minimumDepth: null,
  maximumDepth: null,
});
const EMPTY_TEACHING_SURFACE_TINT_STATS = Object.freeze({
  status: 'hidden',
  coveredPointCount: 0,
  totalPointCount: 0,
});
const TEACHING_SURFACE_COVERAGE_ATTRIBUTE = 'atlasTeachingCoverage';
const TEACHING_SURFACE_TINT_CHUNK_SIZE = 50_000;
const TEACHING_SURFACE_TINT_OPACITY = 0.05;
const PROGRESSIVE_COVERAGE_PLAYBACK_STATUSES = new Set(['playing', 'paused', 'completed']);
const ROBOT_POSE_REPORT_INTERVAL = 70;
const ROBOT_JOINT_REPORT_INTERVAL = 70;
const ZIVID_CAMERA_POSE_REPORT_INTERVAL = 70;
const COLLISION_INDEX_CELL_SIZE = 0.12;
const END_EFFECTOR_SCREEN_DIAMETER = 58;
const IK_ORIENTATION_SCALE = 0.24;
const IK_DAMPING = 0.045;
const IK_MAX_ITERATIONS = 28;
const ROBOT_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const ROBOT_VERTICAL_CONTROL_CODES = new Set(['ArrowUp', 'ArrowDown']);
const KEYBOARD_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
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
  q: 'KeyQ',
  e: 'KeyE',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  shift: 'ShiftLeft',
};

const KEYBOARD_ROTATION_ACTIONS = {
  ArrowUp: 'pitch-up',
  ArrowDown: 'pitch-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

const KEYBOARD_VERTICAL_ACTIONS = {
  KeyQ: 'z-up',
  KeyE: 'z-down',
};

const ROBOT_CONTROL_ACTIONS = {
  KeyW: 'forward',
  KeyA: 'strafe-left',
  KeyS: 'backward',
  KeyD: 'strafe-right',
  ArrowUp: 'z-up',
  ArrowDown: 'z-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

const CAMERA_TEACH_ACTIONS = Object.freeze({
  near: { kind: 'translate', axis: [0, 0, 1], direction: 1 },
  far: { kind: 'translate', axis: [0, 0, 1], direction: -1 },
  up: { kind: 'translate', axis: [0, -1, 0], direction: 1 },
  down: { kind: 'translate', axis: [0, 1, 0], direction: 1 },
  left: { kind: 'translate', axis: [-1, 0, 0], direction: 1 },
  right: { kind: 'translate', axis: [1, 0, 0], direction: 1 },
  'yaw-left': { kind: 'rotate', axis: [0, 1, 0], direction: -1 },
  'yaw-right': { kind: 'rotate', axis: [0, 1, 0], direction: 1 },
  'pitch-up': { kind: 'rotate', axis: [1, 0, 0], direction: 1 },
  'pitch-down': { kind: 'rotate', axis: [1, 0, 0], direction: -1 },
  'roll-left': { kind: 'rotate', axis: [0, 0, 1], direction: -1 },
  'roll-right': { kind: 'rotate', axis: [0, 0, 1], direction: 1 },
});

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

const formatPointCount = (count) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  return String(count);
};

const formatHeight = (value) => (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2));

const packCollisionPositions = (attribute) => {
  const count = attribute?.count || 0;
  if (
    attribute?.array instanceof Float32Array
    && !attribute.isInterleavedBufferAttribute
    && attribute.itemSize === 3
  ) {
    return attribute.array.slice(0, count * 3);
  }
  const packed = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    packed[offset] = attribute.getX(index);
    packed[offset + 1] = attribute.getY(index);
    packed[offset + 2] = attribute.getZ(index);
  }
  return packed;
};

const packCollisionIndices = (attribute) => {
  const count = attribute?.count || 0;
  if (attribute?.array instanceof Uint32Array && !attribute.isInterleavedBufferAttribute) {
    return attribute.array.slice(0, count);
  }
  if (attribute?.array instanceof Uint16Array && !attribute.isInterleavedBufferAttribute) {
    return Uint32Array.from(attribute.array.subarray(0, count));
  }
  const packed = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) packed[index] = attribute.getX(index);
  return packed;
};

const collisionStatusSignature = (status) => JSON.stringify({
  enabled: status.enabled,
  state: status.state,
  minimumDistance: Number.isFinite(status.minimumDistance)
    ? Number(status.minimumDistance).toFixed(4)
    : null,
  collisionLinks: status.collisionLinks,
  nearLinks: status.nearLinks,
  excludedLinks: status.excludedLinks,
  monitoredLinkCount: status.monitoredLinkCount,
  monitoredProxyCount: status.monitoredProxyCount,
  sourcePointCount: status.sourcePointCount,
  indexedPointCount: status.indexedPointCount,
  meshSampleCount: status.meshSampleCount,
  message: status.message,
  detail: status.detail,
});

const normalizeDegrees = (value) => {
  const wrapped = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
};

const applyRobotPose = (layer, value) => {
  if (!layer) return normalizeRobotPose(value);
  const pose = normalizeRobotPose(value);
  layer.position.set(pose.position.x, pose.position.y, pose.position.z);
  layer.rotation.set(
    THREE.MathUtils.degToRad(pose.rpy.roll),
    THREE.MathUtils.degToRad(pose.rpy.pitch),
    THREE.MathUtils.degToRad(pose.rpy.yaw),
    'XYZ',
  );
  layer.updateMatrixWorld(true);
  return pose;
};

const writeRobotPoseDataset = (canvas, value) => {
  if (!canvas) return;
  const pose = normalizeRobotPose(value);
  canvas.dataset.robotX = pose.position.x.toFixed(6);
  canvas.dataset.robotY = pose.position.y.toFixed(6);
  canvas.dataset.robotZ = pose.position.z.toFixed(6);
  canvas.dataset.robotRoll = pose.rpy.roll.toFixed(6);
  canvas.dataset.robotPitch = pose.rpy.pitch.toFixed(6);
  canvas.dataset.robotYaw = pose.rpy.yaw.toFixed(6);
  canvas.dataset.robotOrigin = [
    pose.position.x,
    pose.position.y,
    pose.position.z,
  ].join(',');
};

const clearRobotJointDataset = (canvas) => {
  if (!canvas) return;
  delete canvas.dataset.robotJointValues;
  delete canvas.dataset.robotJointTransforms;
  delete canvas.dataset.robotJointApplySource;
  canvas.dataset.robotJointAppliedCount = '0';
};

const writeRobotJointLockDataset = (canvas, lockedJointNames) => {
  if (!canvas) return;
  const names = normalizeRobotJointLocks(lockedJointNames);
  canvas.dataset.robotJointLockCount = String(names.length);
  canvas.dataset.robotJointLockedNames = JSON.stringify(names);
};

const writeRobotJointDataset = (canvas, robot, source = 'scene') => {
  if (!robot) return {};
  robot.updateMatrixWorld(true);
  const values = readRobotJointValues(robot);
  const transforms = Object.fromEntries(
    Object.keys(values).flatMap((name) => {
      const joint = robot.getObjectByName(name);
      if (!joint) return [];
      return [[name, {
        position: joint.position.toArray(),
        quaternion: joint.quaternion.toArray(),
      }]];
    }),
  );
  if (!canvas) return values;
  canvas.dataset.robotJointValues = JSON.stringify(values);
  canvas.dataset.robotJointTransforms = JSON.stringify(transforms);
  canvas.dataset.robotJointApplySource = source;
  canvas.dataset.robotJointAppliedCount = String(Object.keys(transforms).length);
  canvas.dataset.robotJointApplyRevision = String(
    Number(canvas.dataset.robotJointApplyRevision || 0) + 1,
  );
  return values;
};

const createEndEffectorLocks = () => ({ left: null, right: null });

const endEffectorLockModes = (locks) => ({
  left: locks?.left?.type || null,
  right: locks?.right?.type || null,
});

const endEffectorLockFlags = (locks) => ({
  left: Boolean(locks?.left),
  right: Boolean(locks?.right),
});

const writeEndEffectorLockDataset = (canvas, locks, activeSide = null) => {
  if (!canvas) return;
  const flags = endEffectorLockFlags(locks);
  const modes = endEffectorLockModes(locks);
  canvas.dataset.endEffectorLeftLocked = flags.left ? 'true' : 'false';
  canvas.dataset.endEffectorRightLocked = flags.right ? 'true' : 'false';
  canvas.dataset.endEffectorLeftLockMode = modes.left || 'free';
  canvas.dataset.endEffectorRightLockMode = modes.right || 'free';
  canvas.dataset.endEffectorLockCount = String(Number(flags.left) + Number(flags.right));
  canvas.dataset.endEffectorGlobalLockCount = String(
    Number(modes.left === 'map') + Number(modes.right === 'map'),
  );
  canvas.dataset.endEffectorActiveLocked =
    activeSide && flags[activeSide] ? 'true' : 'false';
  canvas.dataset.endEffectorActiveLockMode =
    activeSide ? modes[activeSide] || 'free' : 'free';
  canvas.dataset.endEffectorLockedJointCount = String(
    Object.values(locks || {}).reduce(
      (count, lock) => count + (lock?.jointValues?.size || 0),
      0,
    ),
  );
  ['left', 'right'].forEach((side) => {
    const prefix = side === 'left' ? 'endEffectorLeft' : 'endEffectorRight';
    const pose = locks?.[side]?.type === 'map' ? locks[side].pose : null;
    if (!pose) {
      delete canvas.dataset[`${prefix}MapTargetX`];
      delete canvas.dataset[`${prefix}MapTargetY`];
      delete canvas.dataset[`${prefix}MapTargetZ`];
      delete canvas.dataset[`${prefix}MapTargetRoll`];
      delete canvas.dataset[`${prefix}MapTargetPitch`];
      delete canvas.dataset[`${prefix}MapTargetYaw`];
      delete canvas.dataset[`${prefix}MapActualX`];
      delete canvas.dataset[`${prefix}MapActualY`];
      delete canvas.dataset[`${prefix}MapActualZ`];
      delete canvas.dataset[`${prefix}MapPositionError`];
      delete canvas.dataset[`${prefix}MapRotationError`];
      delete canvas.dataset[`${prefix}MapIkStatus`];
      return;
    }
    canvas.dataset[`${prefix}MapTargetX`] = pose.position.x.toFixed(6);
    canvas.dataset[`${prefix}MapTargetY`] = pose.position.y.toFixed(6);
    canvas.dataset[`${prefix}MapTargetZ`] = pose.position.z.toFixed(6);
    canvas.dataset[`${prefix}MapTargetRoll`] = pose.rpy.roll.toFixed(6);
    canvas.dataset[`${prefix}MapTargetPitch`] = pose.rpy.pitch.toFixed(6);
    canvas.dataset[`${prefix}MapTargetYaw`] = pose.rpy.yaw.toFixed(6);
  });
};

const poseFromWorldObject = (object) => {
  const position = object.getWorldPosition(new THREE.Vector3());
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'ZYX');
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rpy: {
      roll: normalizeDegrees(THREE.MathUtils.radToDeg(euler.x)),
      pitch: normalizeDegrees(THREE.MathUtils.radToDeg(euler.y)),
      yaw: normalizeDegrees(THREE.MathUtils.radToDeg(euler.z)),
    },
  };
};

const zividOpticalPoseFromObject = (frame, side) => {
  if (!frame) return null;
  const position = frame.getWorldPosition(new THREE.Vector3());
  const quaternion = frame.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  return {
    side,
    frameName: frame.name,
    position: { x: position.x, y: position.y, z: position.z },
    quaternion: {
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    },
    forward: { x: forward.x, y: forward.y, z: forward.z },
  };
};

const parkingMergeTargetFromSnapshot = (value, side) => {
  if (!value?.position || !value?.quaternion) return null;
  const positionValues = ['x', 'y', 'z'].map((axis) => Number(value.position[axis]));
  const quaternionValues = ['x', 'y', 'z', 'w'].map((axis) => Number(value.quaternion[axis]));
  if (![...positionValues, ...quaternionValues].every(Number.isFinite)) return null;
  const quaternion = new THREE.Quaternion(...quaternionValues);
  if (quaternion.lengthSq() < 1e-12) return null;
  quaternion.normalize();
  return {
    side,
    frameName: String(value.frameName || `zivid_${side}_optical_frame`),
    source: 'camera-capture',
    position: new THREE.Vector3(...positionValues),
    quaternion,
  };
};

const parkingMergeTargetFromFrame = (frame, side) => {
  if (!frame) return null;
  return {
    side,
    frameName: frame.name,
    source: 'forward-kinematics',
    position: frame.getWorldPosition(new THREE.Vector3()),
    quaternion: frame.getWorldQuaternion(new THREE.Quaternion()).normalize(),
  };
};

const measureParkingMergeTarget = (frame, target) => {
  if (!frame || !target) {
    return { positionError: Number.POSITIVE_INFINITY, rotationError: Number.POSITIVE_INFINITY };
  }
  const position = frame.getWorldPosition(new THREE.Vector3());
  const quaternion = frame.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const quaternionDot = THREE.MathUtils.clamp(
    Math.abs(quaternion.dot(target.quaternion)),
    -1,
    1,
  );
  return {
    positionError: position.distanceTo(target.position),
    rotationError: THREE.MathUtils.radToDeg(2 * Math.acos(quaternionDot)),
  };
};

const applyPoseToWorldTarget = (target, value) => {
  const pose = normalizeRobotPose(value);
  target.position.set(pose.position.x, pose.position.y, pose.position.z);
  target.quaternion.setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(pose.rpy.roll),
      THREE.MathUtils.degToRad(pose.rpy.pitch),
      THREE.MathUtils.degToRad(pose.rpy.yaw),
      'ZYX',
    ),
  );
  target.updateMatrixWorld(true);
  return pose;
};

const rotationErrorVector = (targetQuaternion, currentQuaternion) => {
  const error = targetQuaternion
    .clone()
    .multiply(currentQuaternion.clone().invert())
    .normalize();
  if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
  const sinHalf = Math.hypot(error.x, error.y, error.z);
  if (sinHalf < 1e-10) return new THREE.Vector3();
  const angle = 2 * Math.atan2(sinHalf, THREE.MathUtils.clamp(error.w, -1, 1));
  return new THREE.Vector3(error.x, error.y, error.z).multiplyScalar(angle / sinHalf);
};

const solveDenseSystem = (matrix, vector) => {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= size; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      if (Math.abs(factor) < 1e-16) continue;
      for (let index = column; index <= size; index += 1) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }
  return rows.map((row) => row[size]);
};

const solveEndEffectorIk = (
  controller,
  targetPosition,
  targetQuaternion,
  excludedJoints = new Set(),
) => {
  if (!controller?.frame || !controller.joints?.length) return null;
  const { robot, frame } = controller;
  const joints = controller.joints.filter((joint) => !excludedJoints.has(joint));
  const currentPosition = new THREE.Vector3();
  const currentQuaternion = new THREE.Quaternion();
  const jointPosition = new THREE.Vector3();
  const jointQuaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const radiusVector = new THREE.Vector3();
  const positionDerivative = new THREE.Vector3();
  let positionError = Number.POSITIVE_INFINITY;
  let rotationError = Number.POSITIVE_INFINITY;

  if (!joints.length) {
    robot.updateMatrixWorld(true);
    frame.getWorldPosition(currentPosition);
    frame.getWorldQuaternion(currentQuaternion);
    positionError = currentPosition.distanceTo(targetPosition);
    rotationError = rotationErrorVector(targetQuaternion, currentQuaternion).length();
    return {
      actualPose: poseFromWorldObject(frame),
      positionError,
      rotationError: THREE.MathUtils.radToDeg(rotationError),
      status: 'limited',
      frozenJointCount: controller.joints.length,
    };
  }

  for (let iteration = 0; iteration < IK_MAX_ITERATIONS; iteration += 1) {
    robot.updateMatrixWorld(true);
    frame.getWorldPosition(currentPosition);
    frame.getWorldQuaternion(currentQuaternion);
    const positionDelta = targetPosition.clone().sub(currentPosition);
    const rotationDelta = rotationErrorVector(targetQuaternion, currentQuaternion);
    positionError = positionDelta.length();
    rotationError = rotationDelta.length();
    if (positionError < 0.00045 && rotationError < THREE.MathUtils.degToRad(0.18)) break;

    const jacobian = Array.from({ length: 6 }, () => Array(joints.length).fill(0));
    joints.forEach((joint, index) => {
      joint.getWorldPosition(jointPosition);
      joint.getWorldQuaternion(jointQuaternion);
      axis.fromArray(joint.userData.jointAxis || [0, 0, 1]);
      axis.applyQuaternion(jointQuaternion).normalize();
      if (joint.userData.jointType === 'prismatic') {
        positionDerivative.copy(axis);
        jacobian[3][index] = 0;
        jacobian[4][index] = 0;
        jacobian[5][index] = 0;
      } else {
        radiusVector.copy(currentPosition).sub(jointPosition);
        positionDerivative.crossVectors(axis, radiusVector);
        jacobian[3][index] = axis.x * IK_ORIENTATION_SCALE;
        jacobian[4][index] = axis.y * IK_ORIENTATION_SCALE;
        jacobian[5][index] = axis.z * IK_ORIENTATION_SCALE;
      }
      jacobian[0][index] = positionDerivative.x;
      jacobian[1][index] = positionDerivative.y;
      jacobian[2][index] = positionDerivative.z;
    });

    const errorVector = [
      positionDelta.x,
      positionDelta.y,
      positionDelta.z,
      rotationDelta.x * IK_ORIENTATION_SCALE,
      rotationDelta.y * IK_ORIENTATION_SCALE,
      rotationDelta.z * IK_ORIENTATION_SCALE,
    ];
    const normalMatrix = Array.from({ length: 6 }, (_, row) =>
      Array.from({ length: 6 }, (_, column) => {
        let value = row === column ? IK_DAMPING ** 2 : 0;
        for (let joint = 0; joint < joints.length; joint += 1) {
          value += jacobian[row][joint] * jacobian[column][joint];
        }
        return value;
      }),
    );
    const resolvedError = solveDenseSystem(normalMatrix, errorVector);
    if (!resolvedError) break;

    let largestStep = 0;
    joints.forEach((joint, index) => {
      let step = 0;
      for (let axisIndex = 0; axisIndex < 6; axisIndex += 1) {
        step += jacobian[axisIndex][index] * resolvedError[axisIndex];
      }
      step = THREE.MathUtils.clamp(step * 0.76, -0.13, 0.13);
      largestStep = Math.max(largestStep, Math.abs(step));
      setRobotJointValue(joint, (Number(joint.userData.jointValue) || 0) + step);
    });
    if (largestStep < 1e-7) break;
  }

  robot.updateMatrixWorld(true);
  frame.getWorldPosition(currentPosition);
  frame.getWorldQuaternion(currentQuaternion);
  positionError = currentPosition.distanceTo(targetPosition);
  rotationError = rotationErrorVector(targetQuaternion, currentQuaternion).length();
  return {
    actualPose: poseFromWorldObject(frame),
    positionError,
    rotationError: THREE.MathUtils.radToDeg(rotationError),
    status:
      positionError < 0.006 && rotationError < THREE.MathUtils.degToRad(2)
        ? 'tracking'
        : 'limited',
    frozenJointCount: controller.joints.length - joints.length,
  };
};

const createEndEffectorSpaceBall = () => {
  const group = new THREE.Group();
  group.name = 'end-effector-space-ball';
  // Keep the tool centre completely open so the gripper remains visible.
  // The RGB rings alone communicate 3D orientation without an occluding mesh.
  group.userData.baseRadius = 0.17;
  const rings = [
    { color: 0xf0443e, rotation: [0, Math.PI / 2, 0] },
    { color: 0x38c75a, rotation: [Math.PI / 2, 0, 0] },
    { color: 0x3c82f6, rotation: [0, 0, 0] },
  ].map(({ color, rotation }, index) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.155 + index * 0.006, 0.006, 8, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    ring.rotation.set(...rotation);
    return ring;
  });
  group.add(...rings);
  group.traverse((object) => { object.renderOrder = 35; });
  return group;
};

const endEffectorSideForObject = (object) => {
  let current = object;
  while (current) {
    if (['left', 'right'].includes(current.userData?.endEffectorSide)) {
      return current.userData.endEffectorSide;
    }
    current = current.parent;
  }
  return null;
};

const expandObjectBoundsInFrame = (bounds, object, frameInverse) => {
  object.traverse((child) => {
    const geometry = child.geometry;
    if (!geometry?.getAttribute?.('position')) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
    const relativeMatrix = new THREE.Matrix4().multiplyMatrices(
      frameInverse,
      child.matrixWorld,
    );
    const { min, max } = geometry.boundingBox;
    [min.x, max.x].forEach((x) => {
      [min.y, max.y].forEach((y) => {
        [min.z, max.z].forEach((z) => {
          bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(relativeMatrix));
        });
      });
    });
  });
};

const createRobotChassisDragHandle = (robot, metadata = {}) => {
  robot.updateMatrixWorld(true);
  const frame = robot.getObjectByName('base_link') || robot;
  frame.updateWorldMatrix(true, true);
  const frameInverse = frame.matrixWorld.clone().invert();
  const localBounds = new THREE.Box3();
  const baseVisuals = frame.children.filter(
    (child) => child.userData?.urdfType === 'visual',
  );
  baseVisuals.forEach((object) => {
    expandObjectBoundsInFrame(localBounds, object, frameInverse);
  });

  if (localBounds.isEmpty()) {
    const sourceMin = Array.isArray(metadata.bounds?.min)
      ? new THREE.Vector3().fromArray(metadata.bounds.min)
      : new THREE.Vector3(-0.25, -0.25, 0);
    const sourceMax = Array.isArray(metadata.bounds?.max)
      ? new THREE.Vector3().fromArray(metadata.bounds.max)
      : new THREE.Vector3(0.25, 0.25, 0.2);
    const height = Math.max((sourceMax.z - sourceMin.z) * 0.18, 0.12);
    localBounds.min.set(sourceMin.x, sourceMin.y, sourceMin.z);
    localBounds.max.set(sourceMax.x, sourceMax.y, sourceMin.z + height);
  }

  const size = localBounds.getSize(new THREE.Vector3());
  const center = localBounds.getCenter(new THREE.Vector3());
  const longestSide = Math.max(size.x, size.y, size.z, 0.25);
  const padding = THREE.MathUtils.clamp(longestSide * 0.045, 0.015, 0.05);
  size.x = Math.max(size.x + padding * 2, 0.22);
  size.y = Math.max(size.y + padding * 2, 0.22);
  size.z = Math.max(size.z + padding * 1.2, 0.12);

  const target = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  target.name = 'robot-chassis-planar-drag-target';
  target.position.copy(center);
  target.userData.robotChassisDragTarget = true;
  frame.add(target);

  const guideRadius = Math.max(size.x, size.y) * 0.68;
  const guide = new THREE.Group();
  guide.name = 'robot-chassis-planar-drag-guide';
  guide.visible = false;
  guide.position.set(0, 0, 0.012);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(guideRadius * 0.985, guideRadius, 64),
    new THREE.MeshBasicMaterial({
      color: 0xf4c95d,
      transparent: true,
      opacity: 0.86,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  const guideLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-guideRadius, 0, 0),
      new THREE.Vector3(guideRadius, 0, 0),
      new THREE.Vector3(0, -guideRadius, 0),
      new THREE.Vector3(0, guideRadius, 0),
    ]),
    new THREE.LineBasicMaterial({
      color: 0xf4c95d,
      transparent: true,
      opacity: 0.56,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  guide.add(ring, guideLines);
  guide.traverse((object) => { object.renderOrder = 34; });
  frame.add(guide);

  return { frame, target, guide, localBounds, size };
};

const colorModeValue = (mode) => (mode === 'height' ? 1 : mode === 'white' ? 2 : 0);
const POINT_COLOR_MODES = [
  { id: 'height', label: '高程色' },
  { id: 'source', label: '原始色' },
  { id: 'white', label: '纯白色' },
];

// Keep the source buffer untouched and perform all three color modes in the GPU.
// The five height stops match the on-screen scale from low (blue) to high (coral).
const installMapColorShader = (material, bounds, colorMode, { surface = false } = {}) => {
  material.userData.mapColorMode = colorMode;
  material.userData.teachingTintVisibility = 1;
  material.userData.teachingTintOpacity = TEACHING_SURFACE_TINT_OPACITY;
  if (surface) {
    material.extensions = { ...(material.extensions || {}), derivatives: true };
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasPointColorMode = {
      value: colorModeValue(material.userData.mapColorMode),
    };
    shader.uniforms.atlasHeightMin = { value: bounds.min.z };
    shader.uniforms.atlasHeightMax = { value: bounds.max.z };
    shader.uniforms.atlasTeachingTintVisibility = {
      value: material.userData.teachingTintVisibility,
    };
    shader.uniforms.atlasTeachingTintOpacity = {
      value: material.userData.teachingTintOpacity,
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAtlasTeachingCoverage = ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
#ifdef USE_INSTANCING
  vAtlasHeight = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;
#else
  vAtlasHeight = (modelMatrix * vec4(transformed, 1.0)).z;
#endif`,
      );
    if (surface) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vAtlasViewPosition = -mvPosition.xyz;`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}
uniform float atlasPointColorMode;
uniform float atlasHeightMin;
uniform float atlasHeightMax;
uniform float atlasTeachingTintVisibility;
uniform float atlasTeachingTintOpacity;

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
}
${surface ? `vec3 atlasDx = dFdx(vAtlasViewPosition);
vec3 atlasDy = dFdy(vAtlasViewPosition);
vec3 atlasFaceNormal = normalize(cross(atlasDx, atlasDy));
vec3 atlasLightDirection = normalize(vec3(0.32, 0.46, 0.83));
float atlasSurfaceLight = 0.68 + 0.32 * abs(dot(atlasFaceNormal, atlasLightDirection));
diffuseColor.rgb *= atlasSurfaceLight;` : ''}
${surface ? '' : `float atlasTeachingSurface = smoothstep(
  0.18,
  0.82,
  clamp(vAtlasTeachingCoverage, 0.0, 1.0)
);
vec3 atlasTeachingTint = vec3(0.1765, 0.9412, 0.5961);
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  atlasTeachingTint,
  atlasTeachingSurface
    * atlasTeachingTintOpacity
    * atlasTeachingTintVisibility
);`}`,
      );
    material.userData.mapColorShader = shader;
  };
  material.customProgramCacheKey = () => (
    surface ? 'atlas-map-color-v12-fragment-projection' : 'atlas-map-color-v12-points-tint-opacity'
  );
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

const clearRobotParkingGhostLayer = (layer) => {
  if (!layer) return;
  const resources = layer.userData?.ownedResources;
  if (resources instanceof Set) {
    resources.forEach((resource) => resource?.dispose?.());
  }
  layer.clear();
  layer.userData.ownedResources = new Set();
};

const writeRobotParkingGhostHiddenDataset = (canvas) => {
  if (!canvas) return;
  canvas.dataset.parkingGhostState = 'hidden';
  canvas.dataset.parkingGhostTargetId = '';
  canvas.dataset.parkingGhostMeshCount = '0';
  canvas.dataset.parkingGhostJointCount = '0';
  canvas.dataset.parkingGhostJointValues = '';
  canvas.dataset.parkingGhostPlanarDistance = '';
  canvas.dataset.parkingGhostStraightDistance = '';
  canvas.dataset.parkingGhostDeltaZ = '';
};

const measureRobotParkingGhost = (sourcePose, targetPose) => {
  const source = normalizeRobotPose(sourcePose);
  const target = normalizeRobotPose(targetPose);
  const deltaX = target.position.x - source.position.x;
  const deltaY = target.position.y - source.position.y;
  const deltaZ = target.position.z - source.position.z;
  return {
    deltaX,
    deltaY,
    deltaZ,
    planarDistance: Math.hypot(deltaX, deltaY),
    straightDistance: Math.hypot(deltaX, deltaY, deltaZ),
  };
};

const copyRobotJointMetadata = (source, clone) => {
  if (!source || !clone) return;
  if (source.userData?.jointType) {
    clone.userData.jointType = source.userData.jointType;
    clone.userData.jointAxis = [...(source.userData.jointAxis || [0, 0, 1])];
    clone.userData.jointLimit = { ...(source.userData.jointLimit || {}) };
    clone.userData.restPosition = [...(source.userData.restPosition || source.position.toArray())];
    clone.userData.restQuaternion = [
      ...(source.userData.restQuaternion || source.quaternion.toArray()),
    ];
    clone.userData.jointValue = Number(source.userData.jointValue) || 0;
  }
  source.children.forEach((child, index) => {
    copyRobotJointMetadata(child, clone.children[index]);
  });
};

const createRobotParkingGhostVisual = (liveRobot, ghost) => {
  const resources = new Set();
  const ghostRobot = cloneSkeleton(liveRobot);
  copyRobotJointMetadata(liveRobot, ghostRobot);
  applyRobotJointValues(ghostRobot, ghost.jointValues);
  ghostRobot.name = `parking-ghost:${ghost.parkingPointName || ghost.parkingPointId}`;
  ghostRobot.userData.isRobotParkingGhost = true;
  let meshCount = 0;

  ghostRobot.traverse((object) => {
    const sourceMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const isInteractionHelper = (
      object.userData?.robotChassisDragTarget
      || /^end-effector-.*-double-click-target$/.test(object.name || '')
      || object.name === 'robot-chassis-planar-drag-guide'
      || sourceMaterials.some((material) => material?.colorWrite === false)
    );
    if (isInteractionHelper) {
      object.visible = false;
      return;
    }

    let material = null;
    if (object.isMesh) {
      material = new THREE.MeshBasicMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      meshCount += 1;
    } else if (object.isLine || object.isLineSegments) {
      material = new THREE.LineBasicMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY * 1.7,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
    } else if (object.isPoints) {
      material = new THREE.PointsMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY,
        depthTest: true,
        depthWrite: false,
        size: 0.012,
        sizeAttenuation: true,
        toneMapped: false,
      });
    } else if (object.isSprite) {
      object.visible = false;
    }
    if (!material) return;
    object.material = material;
    object.castShadow = false;
    object.receiveShadow = false;
    object.renderOrder = 23;
    object.userData.isRobotParkingGhost = true;
    resources.add(material);
  });

  const targetPose = normalizeRobotPose(ghost.targetPose);
  const metadata = liveRobot.userData?.robot || {};
  const modelSize = Math.max(
    0.5,
    ...(Array.isArray(metadata.bounds?.size)
      ? metadata.bounds.size.map((value) => Math.abs(Number(value) || 0))
      : [1]),
  );
  const ringRadius = THREE.MathUtils.clamp(modelSize * 0.2, 0.18, 0.85);
  const guideLift = THREE.MathUtils.clamp(ringRadius * 0.08, 0.018, 0.065);

  const poseRoot = new THREE.Group();
  poseRoot.name = 'robot-parking-ghost-pose';
  poseRoot.add(ghostRobot);
  applyRobotPose(poseRoot, targetPose);

  const targetMarker = new THREE.Group();
  targetMarker.name = 'robot-parking-ghost-target-marker';
  targetMarker.position.set(
    targetPose.position.x,
    targetPose.position.y,
    targetPose.position.z + guideLift,
  );
  const ringGeometry = new THREE.RingGeometry(ringRadius * 0.86, ringRadius, 72);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: ROBOT_PARKING_GHOST_COLOR,
    transparent: true,
    opacity: 0.86,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.renderOrder = 29;
  const pulseGeometry = new THREE.RingGeometry(ringRadius * 1.02, ringRadius * 1.075, 72);
  const pulseMaterial = new THREE.MeshBasicMaterial({
    color: ROBOT_PARKING_GHOST_COLOR,
    transparent: true,
    opacity: 0.28,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const pulseRing = new THREE.Mesh(pulseGeometry, pulseMaterial);
  pulseRing.renderOrder = 28;
  targetMarker.add(ring, pulseRing);
  resources.add(ringGeometry);
  resources.add(ringMaterial);
  resources.add(pulseGeometry);
  resources.add(pulseMaterial);

  const forward = new THREE.Vector3(
    Math.cos(THREE.MathUtils.degToRad(targetPose.rpy.yaw)),
    Math.sin(THREE.MathUtils.degToRad(targetPose.rpy.yaw)),
    0,
  );
  const orientationArrow = new THREE.ArrowHelper(
    forward,
    targetMarker.position,
    ringRadius * 0.78,
    ROBOT_PARKING_GHOST_COLOR,
    ringRadius * 0.22,
    ringRadius * 0.1,
  );
  [orientationArrow.line, orientationArrow.cone].forEach((object) => {
    object.material.transparent = true;
    object.material.opacity = 0.92;
    object.material.depthTest = false;
    object.material.depthWrite = false;
    object.renderOrder = 30;
    resources.add(object.material);
  });

  const distanceArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    1,
    ROBOT_PARKING_GHOST_COLOR,
    Math.max(ringRadius * 0.24, 0.05),
    Math.max(ringRadius * 0.1, 0.025),
  );
  distanceArrow.name = 'robot-parking-ghost-distance-guide';
  [distanceArrow.line, distanceArrow.cone].forEach((object) => {
    object.material.transparent = true;
    object.material.opacity = object === distanceArrow.line ? 0.64 : 0.9;
    object.material.depthTest = false;
    object.material.depthWrite = false;
    object.renderOrder = 28;
    resources.add(object.material);
  });

  return {
    objects: [poseRoot, targetMarker, orientationArrow, distanceArrow],
    resources,
    poseRoot,
    ghostRobot,
    targetMarker,
    pulseRing,
    distanceArrow,
    targetPose,
    targetPosition: new THREE.Vector3(
      targetPose.position.x,
      targetPose.position.y,
      targetPose.position.z + guideLift,
    ),
    ringRadius,
    guideLift,
    meshCount,
    jointCount: Object.keys(normalizeRobotJointValues(ghost.jointValues)).length,
  };
};

const updateRobotParkingGhostGuide = (visual, sourcePose, canvas) => {
  if (!visual) return measureRobotParkingGhost(sourcePose, null);
  const source = normalizeRobotPose(sourcePose);
  const metrics = measureRobotParkingGhost(source, visual.targetPose);
  const start = new THREE.Vector3(
    source.position.x,
    source.position.y,
    source.position.z + visual.guideLift,
  );
  const delta = visual.targetPosition.clone().sub(start);
  const length = delta.length();
  visual.distanceArrow.position.copy(start);
  visual.distanceArrow.visible = length > 1e-4;
  if (visual.distanceArrow.visible) {
    visual.distanceArrow.setDirection(delta.normalize());
    const headLength = Math.min(
      Math.max(visual.ringRadius * 0.24, 0.05),
      length * 0.34,
    );
    visual.distanceArrow.setLength(
      length,
      headLength,
      Math.max(headLength * 0.42, 0.025),
    );
  }
  if (canvas) {
    canvas.dataset.parkingGhostPlanarDistance = metrics.planarDistance.toFixed(6);
    canvas.dataset.parkingGhostStraightDistance = metrics.straightDistance.toFixed(6);
    canvas.dataset.parkingGhostDeltaZ = metrics.deltaZ.toFixed(6);
  }
  return metrics;
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
  meshRenderQuality = 'auto',
  onMeshRenderQualityChange,
  showWaypoints = true,
  onShowWaypointsChange,
  onSelectWaypoint,
  onSelectEdge,
  onClearSelection,
  focusRequest,
  initialView,
  onViewChange,
  resetRequest,
  robotDescriptor,
  robotLoadState,
  robotPose,
  robotJointValues,
  lockedRobotJointNames = [],
  robotControlEnabled = false,
  robotHeightLocked = false,
  robotTrajectoryActive = false,
  teachingPlayback = null,
  robotParkingGhost = null,
  teachingSpaceMode = 'map',
  teachingTasks = [],
  spaceMouseInputRef,
  viewportCanvasRef,
  cameraTeachingCommand,
  collisionProtectionEnabled = false,
  onRobotLoadState,
  onRobotPoseChange,
  onRobotJointValuesChange,
  onResetRobotJointPose,
  onRobotControlChange,
  onRobotHeightLockChange,
  onZividCameraPoseChange,
  onCameraTeachingResult,
  onParkingMergePlannerChange,
  onCollisionProtectionChange,
  onClearRobotParkingGhost,
  onCollisionProtectionStatus,
  isActive = true,
}) {
  const mountRef = useRef(null);
  const spaceMouseAxisHudRef = useRef(null);
  const sceneRef = useRef(null);
  const sliceGroupRef = useRef(null);
  const routeGroupRef = useRef(null);
  const waypointGroupRef = useRef(null);
  const visionCoverageGroupRef = useRef(null);
  const surfaceCoverageProjectionRef = useRef(null);
  const visionCoverageRenderingEnabledRef = useRef(true);
  const teachingSurfaceTintOpacityRef = useRef(TEACHING_SURFACE_TINT_OPACITY);
  const robotLayerRef = useRef(null);
  const loadedRobotRef = useRef(null);
  const robotParkingGhostLayerRef = useRef(null);
  const robotParkingGhostVisualRef = useRef(null);
  const robotChassisHandleRef = useRef(null);
  const chassisDragInteractionRef = useRef(null);
  const chassisDragModeRef = useRef(false);
  const endEffectorControllersRef = useRef({ left: null, right: null });
  const transformControlsRef = useRef(null);
  const endEffectorTargetRef = useRef(null);
  const endEffectorSpaceBallRef = useRef(null);
  const endEffectorControlRef = useRef(null);
  const lockedEndEffectorsRef = useRef(createEndEffectorLocks());
  const globalEndEffectorUpdateRef = useRef(null);
  const endEffectorInteractionRef = useRef(null);
  const endEffectorObjectChangeRef = useRef(null);
  const selectedWaypointPulseRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const displayGeometryRef = useRef(null);
  const surfaceGeometryRef = useRef(null);
  const cloudMaterialRef = useRef(null);
  const meshMaterialRef = useRef(null);
  const colorModeRef = useRef(colorMode);
  const renderActiveRef = useRef(Boolean(isActive));
  const onSelectWaypointRef = useRef(onSelectWaypoint);
  const onSelectEdgeRef = useRef(onSelectEdge);
  const onClearSelectionRef = useRef(onClearSelection);
  const pressedKeysRef = useRef(new Set());
  const keyboardImpulseRef = useRef(new Set());
  const interactionModeRef = useRef('rotate');
  const precisionPanRef = useRef(null);
  const focusAnimationRef = useRef(null);
  const pointerInteractionRef = useRef(null);
  const viewActionsRef = useRef(null);
  const initialViewRef = useRef(initialView);
  const onViewChangeRef = useRef(onViewChange);
  const onRobotLoadStateRef = useRef(onRobotLoadState);
  const onRobotPoseChangeRef = useRef(onRobotPoseChange);
  const onRobotJointValuesChangeRef = useRef(onRobotJointValuesChange);
  const onRobotControlChangeRef = useRef(onRobotControlChange);
  const onZividCameraPoseChangeRef = useRef(onZividCameraPoseChange);
  const onCameraTeachingResultRef = useRef(onCameraTeachingResult);
  const parkingMergePlannerRef = useRef(null);
  const onCollisionProtectionStatusRef = useRef(onCollisionProtectionStatus);
  const collisionMonitorGenerationRef = useRef(0);
  const collisionHighlightCleanupRef = useRef(null);
  const collisionCheckRequestRef = useRef(null);
  const zividCameraFramesRef = useRef({ left: null, right: null });
  const lastZividCameraPoseReportRef = useRef(0);
  const lastZividCameraPoseSignatureRef = useRef('');
  const robotPoseRef = useRef(normalizeRobotPose(robotPose));
  const robotJointValuesRef = useRef(normalizeRobotJointValues(robotJointValues));
  const lockedRobotJointNamesRef = useRef(normalizeRobotJointLocks(lockedRobotJointNames));
  const robotControlEnabledRef = useRef(Boolean(robotControlEnabled));
  const robotHeightLockedRef = useRef(Boolean(robotHeightLocked));
  const robotTrajectoryActiveRef = useRef(Boolean(robotTrajectoryActive));
  const robotLoadStateRef = useRef(robotLoadState);
  const robotPoseActionsRef = useRef(null);
  const lastRobotPoseReportRef = useRef(0);
  const lastRobotJointReportRef = useRef(0);
  const appliedInitialViewRef = useRef(null);
  const appliedResetRevisionRef = useRef(0);
  const appliedCameraTeachingRevisionRef = useRef(0);
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [shiftPanArmed, setShiftPanArmed] = useState(false);
  const [chassisDragMode, setChassisDragMode] = useState(false);
  const [chassisDragging, setChassisDragging] = useState(false);
  const [endEffectorControl, setEndEffectorControl] = useState(null);
  const [endEffectorLockModesState, setEndEffectorLockModesState] = useState({
    left: null,
    right: null,
  });
  const [robotCollisionStatus, setRobotCollisionStatus] = useState(
    () => createRobotCollisionStatus(),
  );
  const [visionCoverageStats, setVisionCoverageStats] = useState(
    EMPTY_VISION_COVERAGE_STATS,
  );
  const [teachingSurfaceTintStats, setTeachingSurfaceTintStats] = useState(
    EMPTY_TEACHING_SURFACE_TINT_STATS,
  );
  const [visionCoverageRenderingEnabled, setVisionCoverageRenderingEnabled] = useState(true);
  const [teachingSurfaceTintOpacity, setTeachingSurfaceTintOpacity] = useState(
    TEACHING_SURFACE_TINT_OPACITY,
  );
  visionCoverageRenderingEnabledRef.current = visionCoverageRenderingEnabled;
  teachingSurfaceTintOpacityRef.current = teachingSurfaceTintOpacity;
  interactionModeRef.current = interactionMode;
  colorModeRef.current = colorMode;
  renderActiveRef.current = Boolean(isActive);
  onSelectWaypointRef.current = onSelectWaypoint;
  onSelectEdgeRef.current = onSelectEdge;
  onClearSelectionRef.current = onClearSelection;
  initialViewRef.current = initialView;
  onViewChangeRef.current = onViewChange;
  onRobotLoadStateRef.current = onRobotLoadState;
  onRobotPoseChangeRef.current = onRobotPoseChange;
  onRobotJointValuesChangeRef.current = onRobotJointValuesChange;
  onRobotControlChangeRef.current = onRobotControlChange;
  onZividCameraPoseChangeRef.current = onZividCameraPoseChange;
  onCameraTeachingResultRef.current = onCameraTeachingResult;
  onCollisionProtectionStatusRef.current = onCollisionProtectionStatus;
  robotControlEnabledRef.current = Boolean(robotControlEnabled);
  robotHeightLockedRef.current = Boolean(robotHeightLocked);
  robotTrajectoryActiveRef.current = Boolean(robotTrajectoryActive);
  robotLoadStateRef.current = robotLoadState;
  lockedRobotJointNamesRef.current = normalizeRobotJointLocks(lockedRobotJointNames);
  const [manualResolution, setManualResolution] = useState({ mapKey: null, index: null });

  const visionCoveragePlaybackStatus = String(teachingPlayback?.status || 'idle');
  const visionCoveragePlaybackTaskId = String(teachingPlayback?.taskId || '');
  const visionCoveragePlaybackActive = Boolean(
    teachingSpaceMode === 'independent'
    && visionCoveragePlaybackTaskId
    && PROGRESSIVE_COVERAGE_PLAYBACK_STATUSES.has(visionCoveragePlaybackStatus),
  );
  const visionCoveragePlaybackReachedPoseIds = visionCoveragePlaybackActive
    && Array.isArray(teachingPlayback?.reachedPoseIds)
    ? teachingPlayback.reachedPoseIds.map(String)
    : [];
  const visionCoveragePlaybackReachedSignature = JSON.stringify(
    visionCoveragePlaybackReachedPoseIds,
  );
  const visionCoveragePlaybackPoseCount = Math.max(
    0,
    Number(teachingPlayback?.poseCount) || 0,
  );
  const visionCoveragePlaybackSelection = useMemo(() => {
    if (teachingSpaceMode !== 'independent') {
      return {
        progressive: false,
        mode: 'hidden',
        taskId: '',
        records: [],
        availableFrameCount: 0,
        availablePoseCount: 0,
        reachedPoseCount: 0,
        playbackPoseCount: 0,
      };
    }

    const allRecords = collectTeachingVisionCoverageFrames(teachingTasks);
    if (!visionCoveragePlaybackActive) {
      const poseIds = new Set(allRecords.map((record) => record.poseId).filter(Boolean));
      return {
        progressive: false,
        mode: 'static-all-records',
        taskId: '',
        records: allRecords,
        availableFrameCount: allRecords.length,
        availablePoseCount: poseIds.size,
        reachedPoseCount: poseIds.size,
        playbackPoseCount: poseIds.size,
      };
    }

    const taskRecords = allRecords.filter(
      (record) => String(record.taskId || '') === visionCoveragePlaybackTaskId,
    );
    const reachedPoseIds = new Set(visionCoveragePlaybackReachedPoseIds);
    const records = taskRecords.filter((record) => reachedPoseIds.has(String(record.poseId)));
    return {
      progressive: true,
      mode: 'pose-arrival-progressive',
      taskId: visionCoveragePlaybackTaskId,
      records,
      availableFrameCount: taskRecords.length,
      availablePoseCount: new Set(
        taskRecords.map((record) => record.poseId).filter(Boolean),
      ).size,
      reachedPoseCount: new Set(
        records.map((record) => record.poseId).filter(Boolean),
      ).size,
      playbackPoseCount: visionCoveragePlaybackPoseCount,
    };
  }, [
    teachingSpaceMode,
    teachingTasks,
    visionCoveragePlaybackActive,
    visionCoveragePlaybackPoseCount,
    visionCoveragePlaybackReachedSignature,
    visionCoveragePlaybackTaskId,
  ]);

  const sourcePointCount = mapData?.geometry?.getAttribute('position')?.count || 0;
  const meshInfo = mapData?.meshInfo || mapData?.geometry?.userData?.mapTopology || null;
  const hasEmbeddedMesh = Boolean(meshInfo?.hasMesh && meshInfo.faceCount > 0);
  const meshQualityPlan = resolveMeshRenderQuality(
    meshRenderQuality,
    meshInfo?.faceCount,
  );
  const renderablePointCount = hasEmbeddedMesh
    ? Number(meshInfo.unreferencedPointCount) || 0
    : sourcePointCount;
  const resolutionMapKey = mapData?.mapId || mapData?.geometry?.uuid || null;
  const suggestedResolutionIndex = adaptiveResolutionIndex(renderablePointCount);
  const suggestedResolution = RESOLUTION_LEVELS[suggestedResolutionIndex];
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
  const renderedPointCount = renderablePointCount
    ? Math.max(1, Math.round(renderablePointCount * resolution.ratio))
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
  const chooseResolutionMode = (value) => {
    if (value === 'auto') {
      setManualResolution({ mapKey: null, index: null });
      return;
    }
    chooseResolution(Number(value));
  };

  const applyRobotJointStateToScene = (values, source = 'external') => {
    const normalized = normalizeRobotJointValues(values);
    robotJointValuesRef.current = normalized;
    const robot = loadedRobotRef.current;
    if (!robot) return normalized;
    applyRobotJointValues(robot, normalized);
    robotLayerRef.current?.updateMatrixWorld(true);
    return writeRobotJointDataset(controlsRef.current?.domElement, robot, source);
  };

  const reportRobotJointValues = (force = false) => {
    const robot = loadedRobotRef.current;
    if (!robot) return;
    const values = writeRobotJointDataset(
      controlsRef.current?.domElement,
      robot,
      'scene-report',
    );
    robotJointValuesRef.current = values;
    const now = performance.now();
    if (!force && now - lastRobotJointReportRef.current < ROBOT_JOINT_REPORT_INTERVAL) return;
    lastRobotJointReportRef.current = now;
    onRobotJointValuesChangeRef.current?.(values);
  };

  const reportZividCameraPoses = (force = false) => {
    const frames = zividCameraFramesRef.current;
    if (!frames.left && !frames.right) return;
    const now = performance.now();
    if (
      !force
      && now - lastZividCameraPoseReportRef.current < ZIVID_CAMERA_POSE_REPORT_INTERVAL
    ) {
      return;
    }
    lastZividCameraPoseReportRef.current = now;
    robotLayerRef.current?.updateMatrixWorld(true);
    const poses = Object.fromEntries(
      Object.entries(frames).flatMap(([side, frame]) => {
        const pose = zividOpticalPoseFromObject(frame, side);
        return pose ? [[side, pose]] : [];
      }),
    );
    const signature = Object.values(poses)
      .flatMap((pose) => [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      ])
      .map((value) => value.toFixed(7))
      .join('|');
    if (!force && signature === lastZividCameraPoseSignatureRef.current) return;
    lastZividCameraPoseSignatureRef.current = signature;

    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      Object.entries(poses).forEach(([side, pose]) => {
        const prefix = side === 'left' ? 'zividLeftOptical' : 'zividRightOptical';
        canvas.dataset[`${prefix}Frame`] = pose.frameName;
        canvas.dataset[`${prefix}Position`] = [
          pose.position.x,
          pose.position.y,
          pose.position.z,
        ].map((value) => value.toFixed(6)).join(',');
        canvas.dataset[`${prefix}Quaternion`] = [
          pose.quaternion.x,
          pose.quaternion.y,
          pose.quaternion.z,
          pose.quaternion.w,
        ].map((value) => value.toFixed(8)).join(',');
      });
      canvas.dataset.zividCameraPoseRevision = String(
        Number(canvas.dataset.zividCameraPoseRevision || 0) + 1,
      );
    }
    onZividCameraPoseChangeRef.current?.(poses);
  };

  parkingMergePlannerRef.current = async (request = {}) => {
    const task = request?.task;
    if (!task?.id) throw new Error('没有可分析的示教任务');
    const distanceThreshold = THREE.MathUtils.clamp(
      Number(request.distanceThreshold) || DEFAULT_PARKING_CLUSTER_DISTANCE,
      0.02,
      5,
    );
    const positionTolerance = THREE.MathUtils.clamp(
      Number(request.positionTolerance) || DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
      0.001,
      0.5,
    );
    const rotationTolerance = THREE.MathUtils.clamp(
      Number(request.rotationTolerance) || DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
      0.1,
      45,
    );
    const spatialAnalysis = clusterNearbyParkingPoints(
      task.parkingPoints || [],
      distanceThreshold,
    );
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.parkingMergePlannerState = 'analyzing';
      canvas.dataset.parkingMergeClusterCount = String(spatialAnalysis.clusters.length);
      delete canvas.dataset.parkingMergePlannerError;
    }

    if (!spatialAnalysis.clusters.length) {
      if (canvas) canvas.dataset.parkingMergePlannerState = 'ready';
      return {
        version: 1,
        status: 'no-neighbors',
        taskId: task.id,
        analyzedAt: new Date().toISOString(),
        distanceThreshold,
        positionTolerance,
        rotationTolerance,
        clusters: [],
        nearbyPairs: spatialAnalysis.nearbyPairs,
        isolatedParkingPointIds: spatialAnalysis.isolatedParkingPointIds,
        feasibleClusterCount: 0,
      };
    }

    const liveRobot = loadedRobotRef.current;
    if (!liveRobot) throw new Error('机器人运动学模型尚未加载，无法搜索公共停车点');
    const liveFrames = zividCameraFramesRef.current;
    const availableSides = ['left', 'right'].filter((side) => (
      liveFrames[side] && endEffectorControllersRef.current[side]
    ));
    if (!availableSides.length) {
      throw new Error('机器人末端相机运动链尚未就绪，无法校验拍照姿态');
    }

    const planningRobot = liveRobot.clone(true);
    const planningLayer = new THREE.Group();
    planningLayer.name = 'parking-point-merge-planning-layer';
    planningLayer.add(planningRobot);
    const baselineJoints = readRobotJointValues(liveRobot);
    const planningControllers = Object.fromEntries(availableSides.flatMap((side) => {
      const controller = getRobotEndEffector(planningRobot, side);
      const opticalFrame = planningRobot.getObjectByName(liveFrames[side].name)
        || planningRobot.getObjectByName(`zivid_${side}_optical_frame`);
      return controller && opticalFrame
        ? [[side, { ...controller, frame: opticalFrame }]]
        : [];
    }));
    const planningSides = availableSides.filter((side) => planningControllers[side]);
    if (!planningSides.length) {
      planningLayer.clear();
      throw new Error('克隆的机器人模型缺少 Zivid 光学坐标系');
    }

    const applyPlanningSeed = (mapPose, jointValues) => {
      applyRobotPose(planningLayer, mapPose);
      applyRobotJointValues(planningRobot, baselineJoints);
      applyRobotJointValues(planningRobot, jointValues || {});
      planningLayer.updateMatrixWorld(true);
    };
    const clusterPlans = [];

    try {
      for (const cluster of spatialAnalysis.clusters) {
        const sourcePoseRecords = cluster.members.flatMap((parkingPoint) => (
          (parkingPoint.poses || []).map((pose) => ({ parkingPoint, pose }))
        ));
        if (!sourcePoseRecords.length) {
          clusterPlans.push({
            id: cluster.id,
            memberIds: cluster.memberIds,
            memberNames: cluster.memberNames,
            poseCount: 0,
            targetCount: 0,
            maximumPairDistance: cluster.maximumPairDistance,
            nearbyPairCount: cluster.nearbyPairCount,
            feasible: false,
            reason: '该近邻簇没有机械臂示教姿态',
            candidateCount: 0,
            plannedPoses: [],
          });
          continue;
        }

        const targetRecords = sourcePoseRecords.map(({ parkingPoint, pose }) => {
          const sourceMapPose = pose.mapPose || parkingPoint.mapPose;
          const sourceJoints = pose.fullBodyJoints?.values || {};
          applyPlanningSeed(sourceMapPose, sourceJoints);
          const targets = planningSides.flatMap((side) => {
            const capturedPose = pose.cameraCapture?.frames?.[side]?.opticalPose;
            const target = parkingMergeTargetFromSnapshot(capturedPose, side)
              || parkingMergeTargetFromFrame(planningControllers[side].frame, side);
            return target ? [target] : [];
          });
          return {
            poseId: pose.id,
            poseName: pose.name,
            sourceParkingPointId: parkingPoint.id,
            sourceParkingPointName: parkingPoint.name,
            sourceMapPose,
            sourceJoints,
            targets,
          };
        });
        const candidates = createCommonParkingCandidates(cluster.members);
        let bestCandidate = null;

        for (const candidate of candidates) {
          const plannedPoses = [];
          for (const record of targetRecords) {
            applyPlanningSeed(candidate.mapPose, record.sourceJoints);
            let sideErrors = {};

            for (let pass = 0; pass < 4; pass += 1) {
              record.targets.forEach((target) => {
                const controller = planningControllers[target.side];
                solveEndEffectorIk(
                  controller,
                  target.position,
                  target.quaternion,
                  new Set(),
                );
              });
              planningLayer.updateMatrixWorld(true);
              sideErrors = Object.fromEntries(record.targets.map((target) => [
                target.side,
                {
                  ...measureParkingMergeTarget(
                    planningControllers[target.side]?.frame,
                    target,
                  ),
                  targetSource: target.source,
                  frameName: target.frameName,
                },
              ]));
              const errors = Object.values(sideErrors);
              if (
                errors.length
                && errors.every((error) => (
                  error.positionError <= Math.min(positionTolerance, 0.004)
                  && error.rotationError <= Math.min(rotationTolerance, 1)
                ))
              ) break;
            }

            const errors = Object.values(sideErrors);
            const positionError = errors.length
              ? Math.max(...errors.map((error) => error.positionError))
              : Number.POSITIVE_INFINITY;
            const rotationError = errors.length
              ? Math.max(...errors.map((error) => error.rotationError))
              : Number.POSITIVE_INFINITY;
            const feasible = errors.length === record.targets.length
              && errors.length > 0
              && positionError <= positionTolerance
              && rotationError <= rotationTolerance;
            plannedPoses.push({
              poseId: record.poseId,
              poseName: record.poseName,
              sourceParkingPointId: record.sourceParkingPointId,
              sourceParkingPointName: record.sourceParkingPointName,
              feasible,
              positionError,
              rotationError,
              sideErrors,
              jointValues: readRobotJointValues(planningRobot),
            });
          }

          const feasiblePoseCount = plannedPoses.filter((pose) => pose.feasible).length;
          const failedPoseCount = plannedPoses.length - feasiblePoseCount;
          const maximumPositionError = Math.max(
            ...plannedPoses.map((pose) => pose.positionError),
          );
          const maximumRotationError = Math.max(
            ...plannedPoses.map((pose) => pose.rotationError),
          );
          const score = failedPoseCount * 1_000_000
            + (maximumPositionError / positionTolerance) * 1_000
            + (maximumRotationError / rotationTolerance) * 100
            + candidate.travel.maximum;
          const candidateResult = {
            id: candidate.id,
            source: candidate.source,
            sourceLabel: candidate.sourceLabel,
            anchorParkingPointId: candidate.anchorParkingPointId,
            anchorParkingPointName: candidate.anchorParkingPointName,
            mapPose: candidate.mapPose,
            travel: candidate.travel,
            plannedPoses,
            feasiblePoseCount,
            failedPoseCount,
            maximumPositionError,
            maximumRotationError,
            score,
          };
          if (!bestCandidate || candidateResult.score < bestCandidate.score) {
            bestCandidate = candidateResult;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }

        const feasible = Boolean(
          bestCandidate
          && bestCandidate.failedPoseCount === 0
          && bestCandidate.plannedPoses.length === sourcePoseRecords.length,
        );
        clusterPlans.push({
          id: cluster.id,
          memberIds: cluster.memberIds,
          memberNames: cluster.memberNames,
          poseCount: sourcePoseRecords.length,
          targetCount: targetRecords.reduce(
            (total, record) => total + record.targets.length,
            0,
          ),
          maximumPairDistance: cluster.maximumPairDistance,
          nearbyPairCount: cluster.nearbyPairCount,
          candidateCount: candidates.length,
          feasible,
          reason: feasible ? '' : '没有候选底盘位姿能让全部相机姿态落入当前容差',
          candidate: bestCandidate
            ? {
                id: bestCandidate.id,
                source: bestCandidate.source,
                sourceLabel: bestCandidate.sourceLabel,
                anchorParkingPointId: bestCandidate.anchorParkingPointId,
                anchorParkingPointName: bestCandidate.anchorParkingPointName,
                mapPose: bestCandidate.mapPose,
                travel: bestCandidate.travel,
                maximumPositionError: bestCandidate.maximumPositionError,
                maximumRotationError: bestCandidate.maximumRotationError,
                feasiblePoseCount: bestCandidate.feasiblePoseCount,
                failedPoseCount: bestCandidate.failedPoseCount,
              }
            : null,
          plannedPoses: bestCandidate?.plannedPoses || [],
        });
      }
    } finally {
      planningLayer.remove(planningRobot);
      planningLayer.clear();
    }

    const result = {
      version: 1,
      status: 'ready',
      taskId: task.id,
      analyzedAt: new Date().toISOString(),
      method: 'xy-single-link+common-base-dual-optical-dls',
      distanceThreshold,
      positionTolerance,
      rotationTolerance,
      clusters: clusterPlans,
      nearbyPairs: spatialAnalysis.nearbyPairs,
      isolatedParkingPointIds: spatialAnalysis.isolatedParkingPointIds,
      feasibleClusterCount: clusterPlans.filter((cluster) => cluster.feasible).length,
    };
    if (canvas) {
      canvas.dataset.parkingMergePlannerState = 'ready';
      canvas.dataset.parkingMergeFeasibleClusterCount = String(result.feasibleClusterCount);
      canvas.dataset.parkingMergeAnalysisRevision = String(
        Number(canvas.dataset.parkingMergeAnalysisRevision || 0) + 1,
      );
    }
    return result;
  };

  useEffect(() => {
    if (!onParkingMergePlannerChange) return undefined;
    const provider = async (request) => {
      try {
        return await parkingMergePlannerRef.current?.(request);
      } catch (error) {
        const canvas = controlsRef.current?.domElement;
        if (canvas) {
          canvas.dataset.parkingMergePlannerState = 'error';
          canvas.dataset.parkingMergePlannerError = error?.message || 'planning-failed';
        }
        throw error;
      }
    };
    onParkingMergePlannerChange(provider);
    return () => onParkingMergePlannerChange(null);
  }, [onParkingMergePlannerChange]);

  const currentEndEffectorLockModes = () =>
    endEffectorLockModes(lockedEndEffectorsRef.current);

  const syncEndEffectorLockState = (activeSide = endEffectorControlRef.current?.side) => {
    const modes = currentEndEffectorLockModes();
    setEndEffectorLockModesState(modes);
    writeEndEffectorLockDataset(
      controlsRef.current?.domElement,
      lockedEndEffectorsRef.current,
      activeSide,
    );
    return modes;
  };

  const restoreLockedEndEffectorJoints = (activeSide) => {
    const frozenJoints = new Set();
    const robot = loadedRobotRef.current;
    lockedRobotJointNamesRef.current.forEach((name) => {
      const joint = robot?.getObjectByName(name);
      if (joint?.userData?.jointType) frozenJoints.add(joint);
    });
    Object.entries(lockedEndEffectorsRef.current).forEach(([side, lock]) => {
      if (!lock || side === activeSide) return;
      const controller = endEffectorControllersRef.current[side];
      if (lock.type === 'body') {
        lock.jointValues.forEach((value, joint) => {
          if (!frozenJoints.has(joint)) setRobotJointValue(joint, value);
        });
      }
      controller?.joints?.forEach((joint) => frozenJoints.add(joint));
    });
    endEffectorControllersRef.current[activeSide]?.robot?.updateMatrixWorld(true);
    return frozenJoints;
  };

  const endEffectorPanelState = (active, overrides = {}) => {
    const lockModes = currentEndEffectorLockModes();
    return {
      side: active.side,
      mode: active.mode,
      pose: active.pose,
      status: active.status,
      positionError: active.positionError,
      rotationError: active.rotationError,
      dragging: Boolean(transformControlsRef.current?.dragging),
      ...overrides,
      locked: Boolean(lockModes[active.side]),
      lockMode: lockModes[active.side],
      lockModes,
    };
  };

  const writeActiveEndEffectorDataset = (canvas, active, result, pose) => {
    if (!canvas) return;
    canvas.dataset.endEffectorControlState = 'active';
    canvas.dataset.endEffectorSide = active.side;
    canvas.dataset.endEffectorMode = active.mode;
    canvas.dataset.endEffectorIkStatus = result.status;
    canvas.dataset.endEffectorPositionError = result.positionError.toExponential(5);
    canvas.dataset.endEffectorRotationError = result.rotationError.toFixed(4);
    canvas.dataset.endEffectorFrozenJointCount = String(result.frozenJointCount || 0);
    canvas.dataset.endEffectorTargetX = pose.position.x.toFixed(6);
    canvas.dataset.endEffectorTargetY = pose.position.y.toFixed(6);
    canvas.dataset.endEffectorTargetZ = pose.position.z.toFixed(6);
    canvas.dataset.endEffectorTargetRoll = pose.rpy.roll.toFixed(6);
    canvas.dataset.endEffectorTargetPitch = pose.rpy.pitch.toFixed(6);
    canvas.dataset.endEffectorTargetYaw = pose.rpy.yaw.toFixed(6);
    canvas.dataset.endEffectorActualX = result.actualPose.position.x.toFixed(6);
    canvas.dataset.endEffectorActualY = result.actualPose.position.y.toFixed(6);
    canvas.dataset.endEffectorActualZ = result.actualPose.position.z.toFixed(6);
    canvas.dataset.endEffectorSolveCount = String(
      Number(canvas.dataset.endEffectorSolveCount || 0) + 1,
    );
    writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current, active.side);
  };

  const solveGlobalEndEffectorLocks = (forceReport = false, requestedSides = null) => {
    const canvas = controlsRef.current?.domElement;
    const sides = requestedSides || ['left', 'right'];
    const results = {};
    sides.forEach((side) => {
      const lock = lockedEndEffectorsRef.current[side];
      const controller = endEffectorControllersRef.current[side];
      if (lock?.type !== 'map' || !controller) return;
      const frozenJoints = restoreLockedEndEffectorJoints(side);
      const result = solveEndEffectorIk(
        controller,
        lock.targetPosition,
        lock.targetQuaternion,
        frozenJoints,
      );
      if (!result) return;
      lock.lastResult = result;
      results[side] = result;

      if (canvas) {
        const prefix = side === 'left' ? 'endEffectorLeft' : 'endEffectorRight';
        canvas.dataset[`${prefix}MapIkStatus`] = result.status;
        canvas.dataset[`${prefix}MapPositionError`] = result.positionError.toExponential(5);
        canvas.dataset[`${prefix}MapRotationError`] = result.rotationError.toFixed(4);
        canvas.dataset[`${prefix}MapActualX`] = result.actualPose.position.x.toFixed(6);
        canvas.dataset[`${prefix}MapActualY`] = result.actualPose.position.y.toFixed(6);
        canvas.dataset[`${prefix}MapActualZ`] = result.actualPose.position.z.toFixed(6);
        canvas.dataset.endEffectorGlobalSolveCount = String(
          Number(canvas.dataset.endEffectorGlobalSolveCount || 0) + 1,
        );
      }

      const active = endEffectorControlRef.current;
      if (active?.side === side) {
        active.pose = lock.pose;
        active.status = result.status;
        active.positionError = result.positionError;
        active.rotationError = result.rotationError;
        setEndEffectorControl(endEffectorPanelState(active));
        writeActiveEndEffectorDataset(canvas, active, result, lock.pose);
      }
    });
    if (Object.keys(results).length) {
      reportRobotJointValues(forceReport);
      reportZividCameraPoses(forceReport);
    }
    return results;
  };

  globalEndEffectorUpdateRef.current = solveGlobalEndEffectorLocks;

  const updateEndEffectorTarget = (forceReport = false) => {
    const active = endEffectorControlRef.current;
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!active || !target) return null;

    const activeLock = lockedEndEffectorsRef.current[active.side];
    if (activeLock?.type === 'body') {
      activeLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
      active.controller.robot.updateMatrixWorld(true);
      const pose = poseFromWorldObject(active.controller.frame);
      applyPoseToWorldTarget(target, pose);
      const result = {
        actualPose: pose,
        positionError: 0,
        rotationError: 0,
        status: 'locked',
        frozenJointCount: active.controller.joints.length,
      };
      active.pose = pose;
      active.status = 'locked';
      active.positionError = 0;
      active.rotationError = 0;
      setEndEffectorControl(endEffectorPanelState(active));
      writeActiveEndEffectorDataset(canvas, active, result, pose);
      reportRobotJointValues(forceReport);
      return result;
    }

    if (activeLock?.type === 'map') {
      applyPoseToWorldTarget(target, activeLock.pose);
      const results = solveGlobalEndEffectorLocks(forceReport, [active.side]);
      return results[active.side] || null;
    }

    const frozenJoints = restoreLockedEndEffectorJoints(active.side);
    target.updateMatrixWorld(true);
    const targetPosition = target.getWorldPosition(new THREE.Vector3());
    const targetQuaternion = target.getWorldQuaternion(new THREE.Quaternion());
    const result = solveEndEffectorIk(
      active.controller,
      targetPosition,
      targetQuaternion,
      frozenJoints,
    );
    if (!result) return null;
    const pose = poseFromWorldObject(target);
    active.pose = pose;
    active.status = result.status;
    active.positionError = result.positionError;
    active.rotationError = result.rotationError;
    setEndEffectorControl(endEffectorPanelState(active));
    writeActiveEndEffectorDataset(canvas, active, result, pose);
    reportRobotJointValues(forceReport);
    return result;
  };

  const enterEndEffectorControl = (side) => {
    if (robotTrajectoryActiveRef.current) return false;
    const controller = endEffectorControllersRef.current[side];
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!controller || !transform || !target) return false;
    restoreLockedEndEffectorJoints(side);
    const activeLock = lockedEndEffectorsRef.current[side];
    if (activeLock?.type === 'body') {
      activeLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
    } else if (activeLock?.type === 'map') {
      solveGlobalEndEffectorLocks(true, [side]);
    }
    controller.robot.updateMatrixWorld(true);
    const pose = activeLock?.type === 'map'
      ? activeLock.pose
      : poseFromWorldObject(controller.frame);
    applyPoseToWorldTarget(target, pose);
    const locked = Boolean(activeLock);
    const lastResult = activeLock?.lastResult;
    const status = activeLock?.type === 'body'
      ? 'locked'
      : lastResult?.status || 'tracking';
    transform.detach();
    target.visible = !locked;
    transform.enabled = !locked;
    transform.setSpace('world');
    transform.setMode('translate');
    if (!locked) transform.attach(target);
    endEffectorControlRef.current = {
      side,
      mode: 'translate',
      controller,
      pose,
      status,
      positionError: activeLock?.type === 'map' ? lastResult?.positionError || 0 : 0,
      rotationError: activeLock?.type === 'map' ? lastResult?.rotationError || 0 : 0,
    };
    setEndEffectorControl(endEffectorPanelState(endEffectorControlRef.current));
    if (robotControlEnabledRef.current) {
      robotControlEnabledRef.current = false;
      onRobotControlChangeRef.current?.(false);
    }
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();
    interactionModeRef.current = 'rotate';
    setInteractionMode('rotate');
    setShiftPanArmed(false);
    if (canvas) {
      canvas.dataset.endEffectorControlState = 'active';
      canvas.dataset.endEffectorSide = side;
      canvas.dataset.endEffectorMode = 'translate';
      canvas.dataset.endEffectorIkStatus = status;
      canvas.dataset.endEffectorSpaceBallVisible = locked ? 'false' : 'true';
      canvas.dataset.endEffectorTransformAttached = locked ? 'false' : 'true';
      canvas.dataset.endEffectorDoubleClickCount = String(
        Number(canvas.dataset.endEffectorDoubleClickCount || 0) + 1,
      );
      writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current, side);
      canvas.focus({ preventScroll: true });
    }
    updateEndEffectorTarget(true);
    return true;
  };

  const exitEndEffectorControl = () => {
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    transform?.detach();
    if (target) target.visible = false;
    if (controlsRef.current) controlsRef.current.enabled = true;
    endEffectorControlRef.current = null;
    setEndEffectorControl(null);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.endEffectorControlState = 'idle';
      canvas.dataset.endEffectorSide = '';
      canvas.dataset.endEffectorMode = '';
      canvas.dataset.endEffectorDragging = 'false';
      canvas.dataset.endEffectorSpaceBallVisible = 'false';
      canvas.dataset.endEffectorTransformAttached = 'false';
      canvas.dataset.endEffectorFrozenJointCount = '0';
      writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current);
    }
    reportRobotJointValues(true);
  };

  const setEndEffectorMode = (mode) => {
    const nextMode = mode === 'rotate' ? 'rotate' : 'translate';
    const active = endEffectorControlRef.current;
    if (!active || lockedEndEffectorsRef.current[active.side]) return;
    active.mode = nextMode;
    transformControlsRef.current?.setMode(nextMode);
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.endEffectorMode = nextMode;
    setEndEffectorControl((current) => current ? { ...current, mode: nextMode } : current);
  };

  const setEndEffectorPose = (pose) => {
    const target = endEffectorTargetRef.current;
    const active = endEffectorControlRef.current;
    if (!target || !active || lockedEndEffectorsRef.current[active.side]) return;
    applyPoseToWorldTarget(target, pose);
    updateEndEffectorTarget(true);
  };

  const resetEndEffectorJoints = () => {
    const active = endEffectorControlRef.current;
    if (!active || lockedEndEffectorsRef.current[active.side]) return;
    const frozenJoints = restoreLockedEndEffectorJoints(active.side);
    const values = readRobotJointValues(active.controller.robot);
    active.controller.joints.forEach((joint) => {
      if (!frozenJoints.has(joint)) values[joint.name] = 0;
    });
    applyRobotJointValues(active.controller.robot, values);
    robotJointValuesRef.current = readRobotJointValues(active.controller.robot);
    const pose = poseFromWorldObject(active.controller.frame);
    applyPoseToWorldTarget(endEffectorTargetRef.current, pose);
    active.pose = pose;
    active.status = 'tracking';
    active.positionError = 0;
    active.rotationError = 0;
    updateEndEffectorTarget(true);
  };

  const setEndEffectorLockMode = (requestedMode) => {
    const active = endEffectorControlRef.current;
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (
      !active
      || !transform
      || !target
      || transform.dragging
      || !['body', 'map'].includes(requestedMode)
    ) return;

    const existingLock = lockedEndEffectorsRef.current[active.side];
    if (existingLock?.type === requestedMode) {
      lockedEndEffectorsRef.current = {
        ...lockedEndEffectorsRef.current,
        [active.side]: null,
      };
      const frozenJoints = restoreLockedEndEffectorJoints(active.side);
      active.controller.robot.updateMatrixWorld(true);
      const pose = poseFromWorldObject(active.controller.frame);
      applyPoseToWorldTarget(target, pose);
      target.visible = true;
      transform.enabled = true;
      transform.setSpace('world');
      transform.setMode(active.mode);
      transform.attach(target);
      active.pose = pose;
      active.status = 'tracking';
      active.positionError = 0;
      active.rotationError = 0;
      setEndEffectorControl(endEffectorPanelState(active));
      syncEndEffectorLockState(active.side);
      if (canvas) {
        canvas.dataset.endEffectorIkStatus = 'tracking';
        canvas.dataset.endEffectorSpaceBallVisible = 'true';
        canvas.dataset.endEffectorTransformAttached = 'true';
        canvas.dataset.endEffectorFrozenJointCount = String(
          active.controller.joints.filter((joint) => frozenJoints.has(joint)).length,
        );
      }
      reportRobotJointValues(true);
      canvas?.focus({ preventScroll: true });
      return;
    }

    if (existingLock?.type === 'body') {
      existingLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
    } else if (existingLock?.type === 'map') {
      solveGlobalEndEffectorLocks(true, [active.side]);
    } else {
      updateEndEffectorTarget(true);
    }
    active.controller.robot.updateMatrixWorld(true);
    const pose = poseFromWorldObject(active.controller.frame);
    const worldPosition = active.controller.frame.getWorldPosition(new THREE.Vector3());
    const worldQuaternion = active.controller.frame
      .getWorldQuaternion(new THREE.Quaternion())
      .normalize();
    const lock = requestedMode === 'body'
      ? {
        type: 'body',
        side: active.side,
        jointValues: new Map(
          active.controller.joints.map((joint) => [
            joint,
            Number(joint.userData.jointValue) || 0,
          ]),
        ),
      }
      : {
        type: 'map',
        side: active.side,
        pose,
        targetPosition: worldPosition.clone(),
        targetQuaternion: worldQuaternion.clone(),
        lastResult: {
          actualPose: pose,
          positionError: 0,
          rotationError: 0,
          status: 'tracking',
          frozenJointCount: 0,
        },
      };
    lockedEndEffectorsRef.current = {
      ...lockedEndEffectorsRef.current,
      [active.side]: lock,
    };
    applyPoseToWorldTarget(target, pose);
    transform.detach();
    transform.enabled = false;
    target.visible = false;
    if (controlsRef.current) controlsRef.current.enabled = true;
    active.pose = pose;
    active.status = requestedMode === 'body' ? 'locked' : 'tracking';
    active.positionError = 0;
    active.rotationError = 0;
    setEndEffectorControl(endEffectorPanelState(active));
    syncEndEffectorLockState(active.side);
    if (canvas) {
      canvas.dataset.endEffectorIkStatus = active.status;
      canvas.dataset.endEffectorPositionError = '0.00000e+0';
      canvas.dataset.endEffectorRotationError = '0.0000';
      canvas.dataset.endEffectorSpaceBallVisible = 'false';
      canvas.dataset.endEffectorTransformAttached = 'false';
      canvas.dataset.endEffectorFrozenJointCount = requestedMode === 'body'
        ? String(lock.jointValues.size)
        : '0';
    }
    if (requestedMode === 'map') solveGlobalEndEffectorLocks(true, [active.side]);
    reportRobotJointValues(true);
  };

  const toggleBodyEndEffectorLock = () => setEndEffectorLockMode('body');
  const toggleMapEndEffectorLock = () => setEndEffectorLockMode('map');

  const clearEndEffectorLocks = () => {
    lockedEndEffectorsRef.current = createEndEffectorLocks();
    setEndEffectorLockModesState({ left: null, right: null });
    writeEndEffectorLockDataset(controlsRef.current?.domElement, lockedEndEffectorsRef.current);
  };

  endEffectorInteractionRef.current = {
    enter: enterEndEffectorControl,
    exit: exitEndEffectorControl,
  };
  endEffectorObjectChangeRef.current = () => updateEndEffectorTarget(false);

  useEffect(() => {
    const nextPose = normalizeRobotPose(robotPose);
    robotPoseRef.current = nextPose;
    applyRobotPose(robotLayerRef.current, nextPose);
    const canvas = controlsRef.current?.domElement;
    writeRobotPoseDataset(canvas, nextPose);
    updateRobotParkingGhostGuide(robotParkingGhostVisualRef.current, nextPose, canvas);
  }, [mapData?.geometry, robotPose]);

  useLayoutEffect(() => {
    const appliedValues = applyRobotJointStateToScene(robotJointValues, 'external-control');
    if (loadedRobotRef.current) {
      robotJointValuesRef.current = appliedValues;
      reportZividCameraPoses(true);
    }
  }, [mapData?.geometry, robotJointValues]);

  useEffect(() => {
    writeRobotJointLockDataset(
      controlsRef.current?.domElement,
      lockedRobotJointNamesRef.current,
    );
  }, [lockedRobotJointNames, mapData?.geometry]);

  useEffect(() => {
    const revision = Number(cameraTeachingCommand?.revision) || 0;
    if (!revision || revision === appliedCameraTeachingRevisionRef.current) return;
    appliedCameraTeachingRevisionRef.current = revision;

    const side = cameraTeachingCommand?.side === 'right' ? 'right' : 'left';
    const actionId = String(cameraTeachingCommand?.action || '');
    const commandSource = cameraTeachingCommand?.source === 'spacemouse'
      ? 'spacemouse'
      : 'button';
    const action = CAMERA_TEACH_ACTIONS[actionId];
    const canvas = controlsRef.current?.domElement;
    const publishFailure = (message) => {
      if (canvas) {
        canvas.dataset.cameraTeachingState = 'error';
        canvas.dataset.cameraTeachingRevision = String(revision);
        canvas.dataset.cameraTeachingSide = side;
        canvas.dataset.cameraTeachingAction = actionId;
        canvas.dataset.cameraTeachingSource = commandSource;
        canvas.dataset.cameraTeachingIkStatus = 'error';
        canvas.dataset.cameraTeachingError = message;
      }
      onCameraTeachingResultRef.current?.({
        revision,
        side,
        action: actionId,
        status: 'error',
        message,
      });
    };

    const robot = loadedRobotRef.current;
    const armController = endEffectorControllersRef.current[side];
    const opticalFrame = zividCameraFramesRef.current[side];
    if (!action) {
      publishFailure('未知的相机示教动作');
      return;
    }
    if (!robot || !armController || !opticalFrame) {
      publishFailure(`${side === 'left' ? '左' : '右'}臂相机运动链尚未就绪`);
      return;
    }

    if (endEffectorControlRef.current) endEffectorInteractionRef.current?.exit?.();
    if (lockedEndEffectorsRef.current[side]) {
      lockedEndEffectorsRef.current = {
        ...lockedEndEffectorsRef.current,
        [side]: null,
      };
      syncEndEffectorLockState(side);
    }
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();

    robot.updateMatrixWorld(true);
    const targetPosition = opticalFrame.getWorldPosition(new THREE.Vector3());
    const targetQuaternion = opticalFrame
      .getWorldQuaternion(new THREE.Quaternion())
      .normalize();
    const localAxis = new THREE.Vector3(...action.axis).normalize();
    if (action.kind === 'translate') {
      const linearStep = THREE.MathUtils.clamp(
        Math.abs(Number(cameraTeachingCommand?.linearStep) || 0.025),
        0.001,
        0.1,
      );
      targetPosition.addScaledVector(
        localAxis.applyQuaternion(targetQuaternion),
        linearStep * action.direction,
      );
    } else {
      const angularStep = THREE.MathUtils.clamp(
        Math.abs(Number(cameraTeachingCommand?.angularStep) || 3),
        0.2,
        15,
      );
      targetQuaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(
          localAxis,
          THREE.MathUtils.degToRad(angularStep * action.direction),
        ),
      ).normalize();
    }

    if (canvas) {
      canvas.dataset.cameraTeachingState = 'solving';
      canvas.dataset.cameraTeachingRevision = String(revision);
      canvas.dataset.cameraTeachingSide = side;
      canvas.dataset.cameraTeachingAction = actionId;
      canvas.dataset.cameraTeachingSource = commandSource;
      canvas.dataset.cameraTeachingTargetPosition = targetPosition
        .toArray()
        .map((value) => value.toFixed(7))
        .join(',');
      canvas.dataset.cameraTeachingTargetQuaternion = targetQuaternion
        .toArray()
        .map((value) => value.toFixed(9))
        .join(',');
      delete canvas.dataset.cameraTeachingError;
    }

    const frozenJoints = restoreLockedEndEffectorJoints(side);
    const result = solveEndEffectorIk(
      { ...armController, frame: opticalFrame },
      targetPosition,
      targetQuaternion,
      frozenJoints,
    );
    if (!result) {
      publishFailure('相机位姿逆解失败');
      return;
    }

    robot.updateMatrixWorld(true);
    const actualPose = zividOpticalPoseFromObject(opticalFrame, side);
    reportRobotJointValues(true);
    reportZividCameraPoses(true);
    const output = {
      revision,
      side,
      action: actionId,
      source: commandSource,
      status: result.status,
      positionError: result.positionError,
      rotationError: result.rotationError,
      frozenJointCount: result.frozenJointCount,
      chainJointCount: armController.joints.length,
      pose: actualPose,
    };
    if (canvas) {
      canvas.dataset.cameraTeachingState = 'settled';
      canvas.dataset.cameraTeachingIkStatus = result.status;
      canvas.dataset.cameraTeachingPositionError = result.positionError.toExponential(5);
      canvas.dataset.cameraTeachingRotationError = result.rotationError.toFixed(5);
      canvas.dataset.cameraTeachingChainJointCount = String(armController.joints.length);
      canvas.dataset.cameraTeachingActualPosition = [
        actualPose?.position.x || 0,
        actualPose?.position.y || 0,
        actualPose?.position.z || 0,
      ].map((value) => value.toFixed(7)).join(',');
    }
    onCameraTeachingResultRef.current?.(output);
  }, [cameraTeachingCommand, mapData?.geometry]);

  useEffect(() => {
    const mount = mountRef.current;
    const geometry = mapData?.geometry;
    if (!mount || !geometry) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071014);
    scene.fog = new THREE.FogExp2(0x071014, 0.0032);
    const hemisphereLight = new THREE.HemisphereLight(0xd8f4f3, 0x172229, 2.15);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.65);
    keyLight.position.set(-4, -6, 9);
    const fillLight = new THREE.DirectionalLight(0x76dce7, 1.15);
    fillLight.position.set(5, 3, 2);
    scene.add(hemisphereLight, keyLight, fillLight);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'three-canvas';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '三维点云交互画布');
    renderer.domElement.setAttribute(
      'aria-keyshortcuts',
      'W A S D Q E ArrowUp ArrowDown ArrowLeft ArrowRight Escape Shift+W Shift+A Shift+S Shift+D Shift+Q Shift+E Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight',
    );
    if (viewportCanvasRef) viewportCanvasRef.current = renderer.domElement;
    writeRobotJointLockDataset(renderer.domElement, lockedRobotJointNamesRef.current);
    renderer.domElement.dataset.geometrySource =
      mapData.geometrySource || geometry.userData.geometrySource || 'ply-parse';
    renderer.domElement.dataset.teachingSpaceMode = mapData.teachingSpaceMode || 'map';
    renderer.domElement.dataset.coordinateFrame = mapData.coordinateFrame || 'map';
    renderer.domElement.dataset.spaceOrigin = '0,0,0';
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
    // WASD, Q/E and the arrow keys are owned by the application. Disable
    // TrackballControls' legacy A/S/D modes so it cannot process them twice.
    controls.keys = [];
    controls.minDistance = detailDollyFloor;
    controls.maxDistance = radius * 6;
    renderer.domElement.dataset.controlMode = 'free-trackball';
    renderer.domElement.dataset.zoomMode = 'hybrid-continuous-detail';
    renderer.domElement.dataset.keyboardPlane = 'xy-target-locked';
    renderer.domElement.dataset.keyboardVerticalAxis = 'q:+z,e:-z';
    renderer.domElement.dataset.keyboardLookMode = 'arrow-orbit-target';
    renderer.domElement.dataset.keyboardLookKeys =
      'arrowup:pitch-up,arrowdown:pitch-down,arrowleft:yaw-left,arrowright:yaw-right';
    renderer.domElement.dataset.keyboardYawOwnership = 'camera-unless-mecanum-control';
    renderer.domElement.dataset.keyboardPanMode = 'world-with-precision-offset';
    renderer.domElement.dataset.keyboardPanImplementation = 'world';
    renderer.domElement.dataset.keyboardVerticalPanMode = 'world-with-precision-offset';
    renderer.domElement.dataset.keyboardFocusPolicy = 'wheel-or-pointer-claims-canvas';
    renderer.domElement.dataset.keyboardDetailSpeed = 'constant-screen-space';
    renderer.domElement.dataset.shiftPanScope = 'camera-and-robot';
    renderer.domElement.dataset.shiftPanPriority = 'viewport-first';
    renderer.domElement.dataset.spacemouseConnected = spaceMouseInputRef?.current?.connected
      ? 'true'
      : 'false';
    renderer.domElement.dataset.spacemouseControlEnabled =
      spaceMouseInputRef?.current?.controlEnabled === false ? 'false' : 'true';
    renderer.domElement.dataset.spacemouseButtonGesture =
      'left-cycle-xyz,right-cycle-rpy,same-button-double-pause';
    renderer.domElement.dataset.spacemouseControlTarget = 'viewport';
    renderer.domElement.dataset.spacemouseCoexistence = 'parallel-input';
    renderer.domElement.dataset.spacemouseZoomPolicy = 'mouse-only';
    renderer.domElement.dataset.spacemouseXPolicy = 'camera-heading-translation-no-zoom';
    renderer.domElement.dataset.spacemouseYPolarity = '+y:left,-y:right';
    renderer.domElement.dataset.spacemouseZPolarity = '+z:up,-z:down';
    renderer.domElement.dataset.spacemouseWheelGuardMs = String(SPACEMOUSE_WHEEL_GUARD_MS);
    renderer.domElement.dataset.spacemouseWheelArbitrationMs = String(
      SPACEMOUSE_WHEEL_ARBITRATION_MS,
    );
    renderer.domElement.dataset.spacemouseWheelArbitration = 'idle';
    renderer.domElement.dataset.spacemouseWheelSuppressedCount = '0';
    renderer.domElement.dataset.spacemouseCalibrationIsolation = 'enabled';
    renderer.domElement.dataset.spacemouseMotionFilter = 'adaptive-frame-low-pass';
    renderer.domElement.dataset.spacemouseAxisPolicy = 'button-selected-only';
    renderer.domElement.dataset.spacemouseSelectedAxis =
      spaceMouseInputRef?.current?.selectedAxis || 'x';
    renderer.domElement.dataset.spacemouseAxisHudHoldMs = String(SPACEMOUSE_AXIS_HUD_HOLD_MS);
    renderer.domElement.dataset.spacemouseAxisHudState = 'hidden';
    renderer.domElement.dataset.spacemouseDominantAxis = '';
    renderer.domElement.dataset.spacemouseAppliedAxisCount = '0';
    renderer.domElement.dataset.spacemouseFilterAttackMs = String(
      SPACEMOUSE_FILTER_ATTACK_SECONDS * 1000,
    );
    renderer.domElement.dataset.spacemouseFilterReleaseMs = String(
      SPACEMOUSE_FILTER_RELEASE_SECONDS * 1000,
    );
    renderer.domElement.dataset.spacemouseMotionState = 'idle';
    renderer.domElement.dataset.spacemouseMode = spaceMouseInputRef?.current?.mode || 'xyz';
    renderer.domElement.dataset.spacemouseInputCount = '0';
    renderer.domElement.dataset.keyboardPrecisionMovementCount = '0';
    renderer.domElement.dataset.keyboardRotationSpeed = '72deg/s';
    renderer.domElement.dataset.minCameraDistance = detailDollyFloor.toPrecision(8);
    renderer.domElement.dataset.minEffectiveDistance = minimumEffectiveDistance.toExponential(6);
    renderer.domElement.dataset.maxOpticalZoom = MAX_OPTICAL_ZOOM.toExponential(0);
    renderer.domElement.dataset.cameraFov = String(camera.fov);
    renderer.domElement.dataset.cameraTeachingState = 'idle';
    renderer.domElement.dataset.cameraTeachingIkStatus = 'idle';
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

    const claimKeyboardFocus = (source) => {
      if (document.activeElement !== renderer.domElement) {
        renderer.domElement.focus({ preventScroll: true });
      }
      renderer.domElement.dataset.keyboardFocusSource = source;
      renderer.domElement.dataset.keyboardFocusClaimCount = String(
        Number(renderer.domElement.dataset.keyboardFocusClaimCount || 0) + 1,
      );
    };

    const topology = prepareMapGeometryTopology(geometry);
    const pointRenderOrder = geometry.userData.pointRenderOrder;
    const displayGeometry = new THREE.BufferGeometry();
    Object.entries(geometry.attributes).forEach(([name, attribute]) => {
      displayGeometry.setAttribute(name, attribute);
    });
    const teachingSurfaceCoverageAttribute = new THREE.Float32BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count),
      1,
    );
    displayGeometry.setAttribute(
      TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
      teachingSurfaceCoverageAttribute,
    );
    displayGeometry.setIndex(
      new THREE.BufferAttribute(pointRenderOrder, 1),
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
    installMapColorShader(material, bounds, colorModeRef.current);
    cloudMaterialRef.current = material;
    renderer.domElement.dataset.colorMode = colorModeRef.current;
    const cloud = new THREE.Points(displayGeometry, material);
    cloud.name = 'scene-map-point-cloud';
    cloud.renderOrder = 2;

    const mapLayer = new THREE.Group();
    mapLayer.name = 'scene-map-render-layer';
    let surfaceGeometry = null;
    let meshMaterial = null;
    if (topology.hasMesh) {
      surfaceGeometry = new THREE.BufferGeometry();
      Object.entries(geometry.attributes).forEach(([name, attribute]) => {
        surfaceGeometry.setAttribute(name, attribute);
      });
      surfaceGeometry.setAttribute(
        TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
        teachingSurfaceCoverageAttribute,
      );
      const sourceMeshIndex = geometry.getIndex();
      const sampledFaceCapacity = Math.max(
        0,
        ...MESH_RENDER_QUALITY_OPTIONS.flatMap((option) => (
          Number.isFinite(option.triangleBudget)
            && option.triangleBudget < topology.faceCount
            ? [option.triangleBudget]
            : []
        )),
      );
      const sampledMeshIndices = sampledFaceCapacity
        ? createUniformMeshIndex(sourceMeshIndex, sampledFaceCapacity)
        : sourceMeshIndex.array;
      const sampledMeshIndex = sampledMeshIndices === sourceMeshIndex.array
        ? sourceMeshIndex
        : new THREE.BufferAttribute(sampledMeshIndices, 1);
      surfaceGeometry.setIndex(meshQualityPlan.isFull ? sourceMeshIndex : sampledMeshIndex);
      surfaceGeometry.setDrawRange(0, meshQualityPlan.renderedFaceCount * 3);
      surfaceGeometry.boundingBox = geometry.boundingBox?.clone() || null;
      surfaceGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;
      surfaceGeometryRef.current = {
        geometry: surfaceGeometry,
        sourceIndex: sourceMeshIndex,
        sampledIndex: sampledMeshIndex,
      };
      meshMaterial = new THREE.MeshBasicMaterial({
        vertexColors: Boolean(geometry.getAttribute('color')),
        color: geometry.getAttribute('color') ? 0xffffff : 0x9fc7ca,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        fog: true,
        toneMapped: false,
      });
      installMapColorShader(meshMaterial, bounds, colorModeRef.current, { surface: true });
      meshMaterialRef.current = meshMaterial;
      const mesh = new THREE.Mesh(surfaceGeometry, meshMaterial);
      mesh.name = 'scene-map-embedded-mesh';
      mesh.renderOrder = 1;
      mapLayer.add(mesh);
    }
    mapLayer.add(cloud);
    cloud.visible = topology.unreferencedPointCount > 0;
    renderer.domElement.dataset.mapRenderMode = topology.hasMesh ? 'hybrid-mesh-points' : 'points';
    renderer.domElement.dataset.mapPointCloudVisible = cloud.visible ? 'true' : 'false';
    renderer.domElement.dataset.plyMeshVisible = topology.hasMesh ? 'true' : 'false';
    renderer.domElement.dataset.plyMeshFaceCount = String(topology.faceCount);
    renderer.domElement.dataset.plyMeshReferencedPointCount = String(
      topology.referencedPointCount,
    );
    renderer.domElement.dataset.plyUnmeshedPointCount = String(
      topology.unreferencedPointCount,
    );
    renderer.domElement.dataset.plyMeshRenderStrategy = topology.renderStrategy;
    renderer.domElement.dataset.meshRenderQuality = meshQualityPlan.requestedId;
    renderer.domElement.dataset.meshRenderQualityEffective = meshQualityPlan.effectiveId;
    renderer.domElement.dataset.renderMeshFaceCount = String(
      meshQualityPlan.renderedFaceCount,
    );
    renderer.domElement.dataset.mapRenderIsolation = 'scene-map-only';
    scene.add(mapLayer);

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

    const applyMouseWheelZoomFactor = (factor) => {
      if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-12) {
        return false;
      }
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      if (!distance) return false;
      const effectiveDistance = distance / Math.max(camera.zoom, 1);
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
      renderer.domElement.dataset.lastZoomSource = 'wheel';
      return true;
    };

    const readLastSpaceMousePhysicalMotionAt = () => Math.max(
      Number(spaceMouseInputRef?.current?.lastPhysicalMotionTimestamp || 0),
      Number(spaceMouseInputRef?.current?.lastMotionTimestamp || 0),
    );
    const suppressSpaceMouseWheel = (reason, eventCount = 1) => {
      renderer.domElement.dataset.spacemouseWheelSuppressedCount = String(
        Number(renderer.domElement.dataset.spacemouseWheelSuppressedCount || 0)
          + eventCount,
      );
      renderer.domElement.dataset.lastZoomDecision = reason;
      renderer.domElement.dataset.spacemouseWheelArbitration = 'blocked';
    };
    const applyProgressiveWheelDelta = (delta) => {
      claimKeyboardFocus('wheel');
      const effectiveDistance =
        camera.position.distanceTo(controls.target) / Math.max(camera.zoom, 1);
      const normalizedDelta = Math.sign(delta) * Math.min(Math.abs(delta), 160);
      applyMouseWheelZoomFactor(
        Math.exp(normalizedDelta * 0.0017 * zoomBoostForDistance(effectiveDistance)),
      );
      renderer.domElement.dataset.lastZoomDecision = 'accepted-mouse-wheel';
      renderer.domElement.dataset.spacemouseWheelArbitration = 'accepted';
    };
    let pendingWheelArbitration = null;
    let pendingWheelArbitrationTimer = null;
    const flushPendingWheelArbitration = () => {
      pendingWheelArbitrationTimer = null;
      const pending = pendingWheelArbitration;
      pendingWheelArbitration = null;
      if (!pending) return;

      const now = performance.now();
      const lastPhysicalMotionAt = readLastSpaceMousePhysicalMotionAt();
      const hidReportFollowedWheel = (
        lastPhysicalMotionAt >= pending.startedAt - 1
        && lastPhysicalMotionAt <= now
      );
      if (spaceMouseInputRef?.current?.connected && hidReportFollowedWheel) {
        // Some 3DxWare builds dispatch the mapped wheel event before the WebHID
        // report. Waiting one short frame window lets us classify that ordering
        // without making a real mouse wheel unavailable in RPY mode.
        suppressSpaceMouseWheel(
          'blocked-spacemouse-driver-wheel-race',
          pending.eventCount,
        );
        return;
      }
      applyProgressiveWheelDelta(pending.delta);
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
      const now = performance.now();
      const spaceMouseInput = spaceMouseInputRef?.current;
      const lastPhysicalMotionAt = readLastSpaceMousePhysicalMotionAt();
      const spaceMouseMotionAge = now - lastPhysicalMotionAt;
      if (
        spaceMouseInput?.connected
        && lastPhysicalMotionAt > 0
        && spaceMouseMotionAge >= 0
        && spaceMouseMotionAge <= SPACEMOUSE_WHEEL_GUARD_MS
      ) {
        suppressSpaceMouseWheel('blocked-spacemouse-driver-wheel');
        return;
      }

      if (spaceMouseInput?.connected && spaceMouseInput.mode === 'rpy') {
        if (pendingWheelArbitration) {
          pendingWheelArbitration.delta += delta;
          pendingWheelArbitration.eventCount += 1;
        } else {
          pendingWheelArbitration = {
            delta,
            eventCount: 1,
            startedAt: now,
          };
          pendingWheelArbitrationTimer = window.setTimeout(
            flushPendingWheelArbitration,
            SPACEMOUSE_WHEEL_ARBITRATION_MS,
          );
        }
        renderer.domElement.dataset.lastZoomDecision = 'pending-rpy-wheel-arbitration';
        renderer.domElement.dataset.spacemouseWheelArbitration = 'pending';
        return;
      }
      applyProgressiveWheelDelta(delta);
    };
    renderer.domElement.addEventListener('wheel', progressiveWheelZoom, {
      passive: false,
      capture: true,
    });

    const size = new THREE.Vector3();
    bounds.getSize(size);
    const independentTeachingSpace = mapData.teachingSpaceMode === 'independent';
    const gridExtentFromOrigin = Math.max(
      Math.abs(bounds.min.x),
      Math.abs(bounds.max.x),
      Math.abs(bounds.min.y),
      Math.abs(bounds.max.y),
      5,
    );
    const gridSize = independentTeachingSpace
      ? gridExtentFromOrigin * 2
      : Math.max(size.x, size.y, 10);
    const grid = new THREE.GridHelper(gridSize, 40, 0x3f7478, 0x173035);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(
      independentTeachingSpace ? 0 : center.x,
      independentTeachingSpace ? 0 : center.y,
      independentTeachingSpace ? 0 : bounds.min.z - Math.max(size.z * 0.03, 0.03),
    );
    grid.name = independentTeachingSpace
      ? 'virtual-origin-reference-plane'
      : 'map-reference-plane';
    renderer.domElement.dataset.referencePlane = grid.name;
    renderer.domElement.dataset.referencePlanePosition = [
      grid.position.x,
      grid.position.y,
      grid.position.z,
    ].join(',');
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
    const visionCoverageGroup = new THREE.Group();
    const robotLayer = new THREE.Group();
    const robotParkingGhostLayer = new THREE.Group();
    routeGroup.name = 'directed-route-edges';
    waypointGroup.name = 'navigation-waypoint-markers';
    visionCoverageGroup.name = 'independent-teaching-vision-coverage';
    visionCoverageGroup.visible = visionCoverageRenderingEnabledRef.current;
    robotLayer.name = 'loaded-robot-model';
    robotParkingGhostLayer.name = 'robot-parking-ghost-layer';
    robotParkingGhostLayer.userData.ownedResources = new Set();
    robotLayer.visible = true;
    scene.add(
      sliceGroup,
      visionCoverageGroup,
      robotLayer,
      robotParkingGhostLayer,
      routeGroup,
      waypointGroup,
    );
    sliceGroupRef.current = sliceGroup;
    routeGroupRef.current = routeGroup;
    waypointGroupRef.current = waypointGroup;
    visionCoverageGroupRef.current = visionCoverageGroup;
    robotLayerRef.current = robotLayer;
    robotParkingGhostLayerRef.current = robotParkingGhostLayer;
    robotPoseRef.current = applyRobotPose(robotLayer, robotPoseRef.current);
    writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
    renderer.domElement.dataset.robotLayerVisible = 'true';
    renderer.domElement.dataset.robotLayerRenderIsolation = 'independent';
    renderer.domElement.dataset.robotControlEnabled = robotControlEnabledRef.current
      ? 'true'
      : 'false';
    renderer.domElement.dataset.robotHeightLocked = robotHeightLockedRef.current
      ? 'true'
      : 'false';
    renderer.domElement.dataset.robotHeightLockBlockedCount = '0';
    renderer.domElement.dataset.keyboardControlOwner = robotControlEnabledRef.current
      ? 'robot'
      : 'camera';
    renderer.domElement.dataset.robotDriveModel = 'mecanum-local-frame';
    renderer.domElement.dataset.robotForwardAxis = '+x';
    renderer.domElement.dataset.robotLeftAxis = '+y';
    renderer.domElement.dataset.robotLinearSpeed = `${ROBOT_LINEAR_SPEED}m/s`;
    renderer.domElement.dataset.robotVerticalSpeed = `${ROBOT_VERTICAL_SPEED}m/s`;
    renderer.domElement.dataset.robotRotationSpeed = '72deg/s';
    renderer.domElement.dataset.chassisDragMode = 'idle';
    renderer.domElement.dataset.chassisDragging = 'false';
    renderer.domElement.dataset.chassisDragPlane = 'map-xy';
    renderer.domElement.dataset.chassisDragPreserves = 'z,roll,pitch,yaw';
    renderer.domElement.dataset.chassisDragHandleReady = 'false';
    renderer.domElement.dataset.robotChassisScreenVisible = 'false';
    sceneRef.current = scene;

    const publishRobotPose = (force = false) => {
      globalEndEffectorUpdateRef.current?.(force);
      const now = performance.now();
      if (
        !force
        && now - lastRobotPoseReportRef.current < ROBOT_POSE_REPORT_INTERVAL
      ) {
        return;
      }
      lastRobotPoseReportRef.current = now;
      onRobotPoseChangeRef.current?.(normalizeRobotPose(robotPoseRef.current));
    };
    const robotPoseActions = { publish: publishRobotPose };
    robotPoseActionsRef.current = robotPoseActions;

    const endEffectorTarget = new THREE.Object3D();
    endEffectorTarget.name = 'end-effector-space-ball-target';
    endEffectorTarget.visible = false;
    const endEffectorSpaceBall = createEndEffectorSpaceBall();
    endEffectorTarget.add(endEffectorSpaceBall);
    scene.add(endEffectorTarget);

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setSize(0.74);
    transformControls.detach();
    const transformHelper = transformControls.getHelper();
    transformHelper.name = 'end-effector-six-dof-transform-controls';
    transformHelper.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((transformMaterial) => {
        transformMaterial.depthTest = false;
        transformMaterial.depthWrite = false;
      });
      object.renderOrder = 36;
    });
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;
    endEffectorTargetRef.current = endEffectorTarget;
    endEffectorSpaceBallRef.current = endEffectorSpaceBall;
    renderer.domElement.dataset.endEffectorInteraction = 'double-click-space-ball';
    renderer.domElement.dataset.endEffectorControlState = 'idle';
    renderer.domElement.dataset.endEffectorSpaceBallVisible = 'false';
    renderer.domElement.dataset.endEffectorTransformAttached = 'false';
    renderer.domElement.dataset.endEffectorCoordinateFrame = 'map';
    renderer.domElement.dataset.endEffectorIkMethod = 'damped-least-squares';
    renderer.domElement.dataset.endEffectorCenterMesh = 'none';
    renderer.domElement.dataset.endEffectorGuideStyle = 'rgb-rings-only';
    writeEndEffectorLockDataset(renderer.domElement, lockedEndEffectorsRef.current);

    const onTransformDraggingChanged = (event) => {
      controls.enabled = !event.value;
      renderer.domElement.dataset.endEffectorDragging = event.value ? 'true' : 'false';
      setEndEffectorControl((current) =>
        current ? { ...current, dragging: Boolean(event.value) } : current,
      );
      if (!event.value) {
        endEffectorObjectChangeRef.current?.();
        robotPoseActionsRef.current?.publish?.(true);
        reportRobotJointValues(true);
      }
    };
    const onTransformObjectChange = () => {
      endEffectorObjectChangeRef.current?.();
    };
    transformControls.addEventListener('dragging-changed', onTransformDraggingChanged);
    transformControls.addEventListener('objectChange', onTransformObjectChange);

    const raycaster = new THREE.Raycaster();
    const normalizedPointer = new THREE.Vector2();
    let pointerStart = null;
    let chassisPointerDrag = null;

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
      // Three.js performs camera matrix arithmetic in JS doubles, but uploads
      // the result as float32 uniforms. Use a conservative GPU-space floor so
      // keyboard motion switches before several sub-pixel frames accumulate
      // into a visible jump.
      const representableFloor = Math.max(
        Number.EPSILON * largestCoordinate * 64,
        largestCoordinate * (2 ** -21),
      );
      renderer.domElement.dataset.keyboardGpuPrecisionFloor =
        representableFloor.toExponential(6);
      return { effectiveDistance, height, representableFloor, unitsPerPixel };
    };

    const needsPrecisionPanForDistance = (intendedWorldDistance, metrics) =>
      camera.zoom > 1.000001
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

    const previewOrbitOffset = new THREE.Vector3();
    const previewOrbitAxis = new THREE.Vector3();
    const previewOrbitQuaternion = new THREE.Quaternion();
    const rotateFromPreview = (deltaX, deltaY, sourceWidth, sourceHeight) => {
      const width = Math.max(Number(sourceWidth) || renderer.domElement.clientWidth, 1);
      const height = Math.max(Number(sourceHeight) || renderer.domElement.clientHeight, 1);
      const yaw = -(Number(deltaX) || 0) * Math.PI * controls.rotateSpeed / width;
      const pitch = -(Number(deltaY) || 0) * Math.PI * controls.rotateSpeed / height;
      if (Math.abs(yaw) < 1e-9 && Math.abs(pitch) < 1e-9) return false;

      previewOrbitOffset.copy(camera.position).sub(controls.target);
      if (previewOrbitOffset.lengthSq() < 1e-18) return false;
      if (Math.abs(yaw) >= 1e-9) {
        previewOrbitAxis.copy(camera.up).normalize();
        previewOrbitQuaternion.setFromAxisAngle(previewOrbitAxis, yaw);
        previewOrbitOffset.applyQuaternion(previewOrbitQuaternion);
        camera.position.copy(controls.target).add(previewOrbitOffset);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
      }
      if (Math.abs(pitch) >= 1e-9) {
        previewOrbitAxis.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        previewOrbitQuaternion.setFromAxisAngle(previewOrbitAxis, pitch);
        previewOrbitOffset.copy(camera.position).sub(controls.target)
          .applyQuaternion(previewOrbitQuaternion);
        camera.up.applyQuaternion(previewOrbitQuaternion).normalize();
        camera.position.copy(controls.target).add(previewOrbitOffset);
        camera.lookAt(controls.target);
      }
      camera.updateMatrixWorld(true);
      controls.update();
      syncDetailView();
      reportCameraView();
      return true;
    };

    const onMainViewPreviewControl = (event) => {
      const detail = event.detail || {};
      const kind = detail.kind === 'pan' ? 'pan' : 'rotate';
      const deltaX = Number(detail.deltaX) || 0;
      const deltaY = Number(detail.deltaY) || 0;
      if (!deltaX && !deltaY) return;
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
        renderer.domElement.dataset.synchronizedFocusState = 'interrupted-by-preview';
      }
      let changed = false;
      if (kind === 'pan') {
        const sourceWidth = Math.max(Number(detail.sourceWidth) || 1, 1);
        const sourceHeight = Math.max(Number(detail.sourceHeight) || 1, 1);
        changed = Boolean(panByPixels(
          deltaX * renderer.domElement.clientWidth / sourceWidth,
          deltaY * renderer.domElement.clientHeight / sourceHeight,
        ));
      } else {
        changed = rotateFromPreview(
          deltaX,
          deltaY,
          detail.sourceWidth,
          detail.sourceHeight,
        );
      }
      if (!changed) return;
      renderer.domElement.dataset.previewControlMode = kind;
      renderer.domElement.dataset.previewControlCount = String(
        Number(renderer.domElement.dataset.previewControlCount || 0) + 1,
      );
      const countKey = kind === 'pan'
        ? 'previewPanControlCount'
        : 'previewRotateControlCount';
      renderer.domElement.dataset[countKey] = String(
        Number(renderer.domElement.dataset[countKey] || 0) + 1,
      );
    };
    renderer.domElement.addEventListener(
      MAIN_VIEW_PREVIEW_CONTROL_EVENT,
      onMainViewPreviewControl,
    );

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

    const setRayFromPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);
      return true;
    };

    const chassisAtPointer = (event) => {
      const handle = robotChassisHandleRef.current;
      if (!handle?.target || !setRayFromPointer(event)) return null;
      return raycaster.intersectObject(handle.target, false).length ? handle : null;
    };

    const updatePickHover = (event) => {
      if (transformControls.dragging || transformControls.axis) {
        renderer.domElement.classList.remove(
          'is-pick-hover',
          'is-end-effector-hover',
          'is-chassis-drag-hover',
        );
        return;
      }
      if (chassisDragModeRef.current) {
        const hoveredChassis = Boolean(chassisAtPointer(event));
        renderer.domElement.classList.toggle('is-chassis-drag-hover', hoveredChassis);
        renderer.domElement.classList.remove('is-pick-hover', 'is-end-effector-hover');
        renderer.domElement.dataset.hoverRobotPart = hoveredChassis ? 'chassis' : 'none';
        return;
      }
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      const hoveredEndEffector = endEffectorAtPointer(event);
      renderer.domElement.classList.toggle(
        'is-end-effector-hover',
        Boolean(hoveredEndEffector),
      );
      renderer.domElement.dataset.hoverEndEffector = hoveredEndEffector || 'none';
      if (hoveredEndEffector) {
        renderer.domElement.classList.remove('is-pick-hover');
        return;
      }
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

    const finishChassisPointerDrag = (
      event,
      reason = 'ended',
      forcePublish = true,
      updateUi = true,
    ) => {
      if (!chassisPointerDrag) return false;
      const pointerId = event?.pointerId ?? chassisPointerDrag.pointerId;
      chassisPointerDrag = null;
      controls.enabled = true;
      if (Number.isFinite(pointerId) && renderer.domElement.hasPointerCapture?.(pointerId)) {
        try {
          renderer.domElement.releasePointerCapture(pointerId);
        } catch {
          // Pointer capture can already be gone after leaving the canvas.
        }
      }
      renderer.domElement.classList.remove('is-chassis-dragging');
      renderer.domElement.dataset.chassisDragging = 'false';
      renderer.domElement.dataset.chassisDragGestureState = reason;
      if (updateUi) setChassisDragging(false);
      if (forcePublish) robotPoseActionsRef.current?.publish?.(true);
      return true;
    };

    const updateChassisDragMode = (enabled, reason = 'user', updateUi = true) => {
      if (enabled && robotTrajectoryActiveRef.current) return false;
      const nextEnabled = Boolean(enabled && robotChassisHandleRef.current?.target);
      if (!nextEnabled) {
        finishChassisPointerDrag(null, reason, true, updateUi);
      }
      if (nextEnabled && endEffectorControlRef.current) {
        endEffectorInteractionRef.current?.exit?.();
      }
      if (nextEnabled && robotControlEnabledRef.current) {
        robotControlEnabledRef.current = false;
        onRobotControlChangeRef.current?.(false);
      }
      if (nextEnabled) {
        pressedKeysRef.current.clear();
        keyboardImpulseRef.current.clear();
        interactionModeRef.current = 'rotate';
        setInteractionMode('rotate');
        setShiftPanArmed(false);
        cancelPointerGesture(null, 'chassis-drag-mode');
      }
      chassisDragModeRef.current = nextEnabled;
      const handle = robotChassisHandleRef.current;
      if (handle?.guide) handle.guide.visible = nextEnabled;
      renderer.domElement.classList.toggle('is-chassis-drag-mode', nextEnabled);
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      renderer.domElement.dataset.chassisDragMode = nextEnabled ? 'armed' : 'idle';
      renderer.domElement.dataset.chassisDragExitReason = nextEnabled ? '' : reason;
      renderer.domElement.dataset.keyboardControlOwner = nextEnabled
        ? 'camera'
        : robotControlEnabledRef.current ? 'robot' : 'camera';
      if (updateUi) {
        setChassisDragMode(nextEnabled);
        if (!nextEnabled) setChassisDragging(false);
      }
      if (nextEnabled) renderer.domElement.focus({ preventScroll: true });
      return nextEnabled;
    };

    const startChassisPointerDrag = (event) => {
      if (
        robotTrajectoryActiveRef.current
        ||
        !chassisDragModeRef.current
        || event.button !== 0
        || event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight')
        || transformControls.dragging
        || transformControls.axis
        || !chassisAtPointer(event)
      ) {
        return false;
      }
      const currentPose = normalizeRobotPose(robotPoseRef.current);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -currentPose.position.z);
      const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (!point) return false;

      cancelPointerGesture(event, 'chassis-drag-start');
      chassisPointerDrag = {
        pointerId: event.pointerId,
        plane,
        offsetX: currentPose.position.x - point.x,
        offsetY: currentPose.position.y - point.y,
        startX: currentPose.position.x,
        startY: currentPose.position.y,
      };
      controls.enabled = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      renderer.domElement.setPointerCapture?.(event.pointerId);
      renderer.domElement.classList.add('is-chassis-dragging');
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      renderer.domElement.dataset.chassisDragging = 'true';
      renderer.domElement.dataset.chassisDragGestureState = 'active';
      renderer.domElement.dataset.chassisDragPlaneZ = currentPose.position.z.toFixed(6);
      renderer.domElement.dataset.chassisDragStartX = currentPose.position.x.toFixed(6);
      renderer.domElement.dataset.chassisDragStartY = currentPose.position.y.toFixed(6);
      setChassisDragging(true);
      return true;
    };

    const moveChassisPointerDrag = (event) => {
      if (!chassisPointerDrag || chassisPointerDrag.pointerId !== event.pointerId) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      const outside =
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom;
      if (outside) {
        finishChassisPointerDrag(event, 'cancelled-on-leave');
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      if (!setRayFromPointer(event)) return false;
      const point = raycaster.ray.intersectPlane(
        chassisPointerDrag.plane,
        new THREE.Vector3(),
      );
      if (!point) return false;

      const nextPose = normalizeRobotPose(robotPoseRef.current);
      nextPose.position.x = point.x + chassisPointerDrag.offsetX;
      nextPose.position.y = point.y + chassisPointerDrag.offsetY;
      robotPoseRef.current = applyRobotPose(robotLayer, nextPose);
      writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
      renderer.domElement.dataset.chassisDragDeltaX = (
        nextPose.position.x - chassisPointerDrag.startX
      ).toFixed(6);
      renderer.domElement.dataset.chassisDragDeltaY = (
        nextPose.position.y - chassisPointerDrag.startY
      ).toFixed(6);
      renderer.domElement.dataset.chassisDragCount = String(
        Number(renderer.domElement.dataset.chassisDragCount || 0) + 1,
      );
      robotPoseActionsRef.current?.publish?.(false);
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };

    const chassisDragActions = {
      enter: () => updateChassisDragMode(true, 'double-click'),
      exit: (reason = 'user') => updateChassisDragMode(false, reason),
      cancel: (reason = 'cancelled') => finishChassisPointerDrag(null, reason),
    };
    chassisDragInteractionRef.current = chassisDragActions;

    const promotePointerToShiftPan = () => {
      if (
        !pointerStart
        || pointerStart.button !== 0
        || pointerStart.panGesture
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
      claimKeyboardFocus('pointer');
      const shiftPressed =
        event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight');
      const shiftPanOverride = event.button === 0 && shiftPressed;
      const persistentPanOverride = event.button === 0
        && interactionModeRef.current === 'pan';
      const viewportPanOverride = shiftPanOverride || persistentPanOverride;

      // Both persistent pan mode and Shift + left drag belong to the viewport.
      // Check them before chassis/TransformControls so the interaction contract
      // remains identical whether the user holds Shift or clicks the toolbar.
      if (!viewportPanOverride && startChassisPointerDrag(event)) return;
      if (
        !viewportPanOverride
        && transformControls.object
        && (transformControls.axis || transformControls.dragging)
      ) {
        controls.enabled = false;
        pointerStart = null;
        renderer.domElement.dataset.pointerGestureState = 'space-ball';
        return;
      }
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
        renderer.domElement.dataset.synchronizedFocusState = 'interrupted';
      }
      const panGesture =
        event.button === 2
        || viewportPanOverride;
      if (shiftPanOverride) {
        setShiftPanArmed(true);
      }
      if (viewportPanOverride) {
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
        persistentPanOverride,
        moved: false,
      };
      if (panGesture) {
        event.preventDefault();
        renderer.domElement.setPointerCapture?.(event.pointerId);
      }
      renderer.domElement.dataset.lastPointerGesture = shiftPanOverride
        ? 'shift-pan'
        : persistentPanOverride ? 'mode-pan' : panGesture ? 'pan' : 'rotate-or-pick';
      renderer.domElement.dataset.pointerGestureState = 'active';
      renderer.domElement.classList.remove('is-pick-hover', 'is-end-effector-hover');
    };
    const onPickPointerMove = (event) => {
      if (moveChassisPointerDrag(event)) return;
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
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishChassisPointerDrag(event, 'ended');
        return;
      }
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
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        finishChassisPointerDrag(event, 'cancelled-by-browser');
      }
      cancelPointerGesture(event, 'cancelled-by-browser');
    };
    const onPickPointerLeave = (event) => {
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        finishChassisPointerDrag(event, 'cancelled-on-leave');
        return;
      }
      if (pointerStart?.id === event.pointerId) {
        cancelPointerGesture(event, 'cancelled-on-leave');
        return;
      }
      renderer.domElement.classList.remove(
        'is-pick-hover',
        'is-end-effector-hover',
        'is-chassis-drag-hover',
      );
    };

    const endEffectorAtPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height || !robotLayer.children.length) return null;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);
      const hits = raycaster.intersectObjects(robotLayer.children, true);
      for (const hit of hits) {
        const side = endEffectorSideForObject(hit.object);
        if (side) return side;
      }
      return null;
    };
    const onRobotDoubleClick = (event) => {
      if (robotTrajectoryActiveRef.current) return;
      if (transformControls.dragging || transformControls.axis) return;
      const side = endEffectorAtPointer(event);
      renderer.domElement.dataset.lastEndEffectorDoubleClick = side || 'none';
      const chassis = side ? null : chassisAtPointer(event);
      renderer.domElement.dataset.lastChassisDoubleClick = chassis ? 'chassis' : 'none';
      if (!side && !chassis) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPointerGesture(
        event,
        side ? 'end-effector-double-click' : 'chassis-double-click',
      );
      if (side) {
        chassisDragInteractionRef.current?.exit?.('end-effector-control');
        endEffectorInteractionRef.current?.enter?.(side);
      } else {
        updateChassisDragMode(!chassisDragModeRef.current, 'double-click');
        renderer.domElement.dataset.chassisDoubleClickCount = String(
          Number(renderer.domElement.dataset.chassisDoubleClickCount || 0) + 1,
        );
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPickPointerDown, true);
    renderer.domElement.addEventListener('pointermove', onPickPointerMove, true);
    renderer.domElement.addEventListener('pointerup', onPickPointerUp, true);
    renderer.domElement.addEventListener('pointercancel', resetPickPointer);
    renderer.domElement.addEventListener('pointerleave', onPickPointerLeave);
    renderer.domElement.addEventListener('dblclick', onRobotDoubleClick, true);

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
    const keyboardRotation = new THREE.Quaternion();
    const waypointCameraPosition = new THREE.Vector3();
    const originCameraPosition = new THREE.Vector3();
    const endEffectorWorldPosition = new THREE.Vector3();
    const endEffectorCameraPosition = new THREE.Vector3();
    const endEffectorProjectedPosition = new THREE.Vector3();
    const chassisWorldPosition = new THREE.Vector3();
    const chassisProjectedPosition = new THREE.Vector3();
    const filteredSpaceMouseAxes = Object.fromEntries(
      SPACEMOUSE_VIEW_AXES.map((axis) => [axis, 0]),
    );
    const targetSpaceMouseAxes = Object.fromEntries(
      SPACEMOUSE_VIEW_AXES.map((axis) => [axis, 0]),
    );
    let previousSpaceMouseMode = spaceMouseInputRef?.current?.mode || 'xyz';
    let previousSpaceMouseSelectedAxis = spaceMouseInputRef?.current?.selectedAxis || 'x';
    let spaceMouseHudMotionActive = false;
    let spaceMouseHudHideAt = -Infinity;
    let lastSpaceMouseTelemetryAt = -Infinity;
    const clearFilteredSpaceMouseAxes = () => {
      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        filteredSpaceMouseAxes[axis] = 0;
        targetSpaceMouseAxes[axis] = 0;
      });
    };
    const updateFilteredSpaceMouseAxis = (axis, target, duration) => {
      const current = filteredSpaceMouseAxes[axis];
      const boundedTarget = THREE.MathUtils.clamp(Number(target) || 0, -1, 1);
      targetSpaceMouseAxes[axis] = boundedTarget;
      const startsOrReverses = boundedTarget !== 0 && (
        current === 0
        || Math.sign(boundedTarget) !== Math.sign(current)
        || Math.abs(boundedTarget) > Math.abs(current)
      );
      const responseSeconds = startsOrReverses
        ? SPACEMOUSE_FILTER_ATTACK_SECONDS
        : SPACEMOUSE_FILTER_RELEASE_SECONDS;
      const blend = 1 - Math.exp(-duration / Math.max(responseSeconds, 1e-4));
      const next = current + (boundedTarget - current) * blend;
      filteredSpaceMouseAxes[axis] = (
        boundedTarget === 0 && Math.abs(next) < SPACEMOUSE_FILTER_EPSILON
      ) ? 0 : next;
    };
    const updateSpaceMouseAxisHud = (selectedAxis, motionActive, ready) => {
      const hud = spaceMouseAxisHudRef.current;
      if (!hud) return;
      const now = performance.now();
      const meta = SPACEMOUSE_AXIS_HUD_META[selectedAxis] || SPACEMOUSE_AXIS_HUD_META.x;
      hud.dataset.axis = selectedAxis;
      hud.querySelector('[data-axis-code]').textContent = meta.code;
      hud.querySelector('[data-axis-label]').textContent = meta.label;
      hud.querySelector('[data-axis-group]').textContent = `${meta.group} / SINGLE AXIS`;

      if (!ready) {
        spaceMouseHudMotionActive = false;
        spaceMouseHudHideAt = -Infinity;
        hud.classList.remove('is-visible', 'is-active');
        hud.dataset.state = 'hidden';
        hud.setAttribute('aria-hidden', 'true');
      } else if (motionActive) {
        spaceMouseHudMotionActive = true;
        spaceMouseHudHideAt = Infinity;
        hud.classList.add('is-visible', 'is-active');
        hud.dataset.state = 'active';
        hud.setAttribute('aria-hidden', 'false');
      } else if (spaceMouseHudMotionActive) {
        spaceMouseHudMotionActive = false;
        spaceMouseHudHideAt = now + SPACEMOUSE_AXIS_HUD_HOLD_MS;
        hud.classList.add('is-visible');
        hud.classList.remove('is-active');
        hud.dataset.state = 'holding';
      } else if (now >= spaceMouseHudHideAt && hud.classList.contains('is-visible')) {
        hud.classList.remove('is-visible', 'is-active');
        hud.dataset.state = 'fading';
        hud.setAttribute('aria-hidden', 'true');
        spaceMouseHudHideAt = Infinity;
      }
      renderer.domElement.dataset.spacemouseAxisHudState = hud.dataset.state;
      renderer.domElement.dataset.spacemouseAxisHudAxis = selectedAxis;
    };
    const writeSpaceMouseFilterTelemetry = (force = false) => {
      const now = performance.now();
      if (!force && now - lastSpaceMouseTelemetryAt < 50) return;
      lastSpaceMouseTelemetryAt = now;
      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        const suffix = `${axis[0].toUpperCase()}${axis.slice(1)}`;
        renderer.domElement.dataset[`spacemouseTarget${suffix}`] =
          targetSpaceMouseAxes[axis].toFixed(4);
        renderer.domElement.dataset[`spacemouseFiltered${suffix}`] =
          filteredSpaceMouseAxes[axis].toFixed(4);
      });
    };
    writeSpaceMouseFilterTelemetry(true);
    const keyboardPixelsForWorldDirection = (
      worldDirection,
      fallbackX,
      fallbackY,
      duration,
      speedMultiplier,
      metrics,
    ) => {
      camera.updateMatrixWorld(true);
      screenRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      let projectedX = -worldDirection.dot(screenRight);
      let projectedY = worldDirection.dot(screenUp);
      const projectedLength = Math.hypot(projectedX, projectedY);
      if (projectedLength > KEYBOARD_MIN_PROJECTED_AXIS) {
        projectedX /= projectedLength;
        projectedY /= projectedLength;
      } else {
        const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
        projectedX = fallbackX / fallbackLength;
        projectedY = fallbackY / fallbackLength;
      }
      const pixelStep =
        (KEYBOARD_WORLD_SPEED_RATIO * speedMultiplier * duration * metrics.height)
        / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      return {
        deltaX: projectedX * pixelStep,
        deltaY: projectedY * pixelStep,
        pixelStep,
      };
    };
    renderer.setAnimationLoop(() => {
      const deltaSeconds = Math.min(frameClock.getDelta(), 0.05);
      if (!renderActiveRef.current) return;
      const pressedKeys = pressedKeysRef.current;
      const keyboardImpulses = keyboardImpulseRef.current;
      const robotControlActive =
        robotControlEnabledRef.current && robotLayer.children.length > 0;
      let keyboardMoved = false;
      let spaceMouseMoved = false;
      if (pressedKeys.size || keyboardImpulses.size) {
        const keyActive = (code) => pressedKeys.has(code) || keyboardImpulses.has(code);
        camera.getWorldDirection(forward);
        forward.z = 0;
        if (forward.lengthSq() < 1e-12) forward.set(0, 1, 0);
        else forward.normalize();
        right.crossVectors(forward, worldUp).normalize();
        const forwardInput = robotControlActive
          ? 0
          : Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
        const strafeInput = robotControlActive
          ? 0
          : Number(keyActive('KeyD')) - Number(keyActive('KeyA'));
        const verticalInput = Number(keyActive('KeyQ')) - Number(keyActive('KeyE'));
        movement.copy(forward).multiplyScalar(forwardInput);
        movement.addScaledVector(right, strafeInput);

        if (movement.lengthSq() > 0) {
          const metrics = getPanMetrics();
          const baseSpeed = THREE.MathUtils.clamp(
            metrics.effectiveDistance * KEYBOARD_WORLD_SPEED_RATIO,
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
            const { deltaX, deltaY } = keyboardPixelsForWorldDirection(
              movement,
              -Math.sign(strafeInput),
              -Math.sign(forwardInput),
              movementDuration,
              speedMultiplier,
              metrics,
            );

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
          const metrics = getPanMetrics();
          const baseSpeed = THREE.MathUtils.clamp(
            metrics.effectiveDistance * KEYBOARD_WORLD_SPEED_RATIO,
            radius * 1e-8,
            radius * 0.4,
          );
          const speedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 3 : 1;
          const hasTapImpulse =
            keyboardImpulses.has('KeyQ') || keyboardImpulses.has('KeyE');
          const movementDuration = hasTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const worldStep = baseSpeed * speedMultiplier * movementDuration;
          verticalMovement.copy(worldUp).multiplyScalar(verticalInput);
          if (needsPrecisionPanForDistance(worldStep, metrics)) {
            const { deltaX, deltaY } = keyboardPixelsForWorldDirection(
              verticalMovement,
              0,
              -Math.sign(verticalInput),
              movementDuration,
              speedMultiplier,
              metrics,
            );
            const implementation = panByPixels(deltaX, deltaY);
            renderer.domElement.dataset.keyboardVerticalImplementation = implementation;
            renderer.domElement.dataset.keyboardPrecisionPixels = Math.hypot(
              deltaX,
              deltaY,
            ).toFixed(3);
            renderer.domElement.dataset.keyboardPrecisionMovementCount = String(
              Number(renderer.domElement.dataset.keyboardPrecisionMovementCount || 0) + 1,
            );
          } else {
            verticalMovement.multiplyScalar(worldStep);
            camera.position.add(verticalMovement);
            controls.target.add(verticalMovement);
            renderer.domElement.dataset.keyboardVerticalImplementation = 'world';
          }
          keyboardMoved = true;
        }

        const yawInput = robotControlActive
          ? 0
          : Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
        const pitchInput = robotControlActive
          ? 0
          : Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
        if (yawInput || pitchInput) {
          const hasRotationTapImpulse =
            keyboardImpulses.has('ArrowUp')
            || keyboardImpulses.has('ArrowDown')
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
          camera.up.normalize();
          camera.position.copy(controls.target).add(cameraOffset);
          keyboardMoved = true;
        }

        if (robotControlActive) {
          const heightLocked = robotHeightLockedRef.current;
          const robotForwardInput =
            Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
          const robotStrafeLeftInput =
            Number(keyActive('KeyA')) - Number(keyActive('KeyD'));
          const robotYawInput =
            Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
          const robotVerticalInput = heightLocked
            ? 0
            : Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
          if (
            robotForwardInput
            || robotStrafeLeftInput
            || robotVerticalInput
            || robotYawInput
          ) {
            const robotTapImpulse = [...ROBOT_CONTROL_CODES].some((code) => (
              keyboardImpulses.has(code)
              && (!heightLocked || !ROBOT_VERTICAL_CONTROL_CODES.has(code))
            ));
            const movementDuration = robotTapImpulse
              ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
              : deltaSeconds;
            const speedMultiplier =
              keyActive('ShiftLeft') || keyActive('ShiftRight') ? 2.5 : 1;
            const currentPose = normalizeRobotPose(robotPoseRef.current);
            const nextPose = normalizeRobotPose(currentPose);
            const yawRadians = THREE.MathUtils.degToRad(currentPose.rpy.yaw);
            const inputMagnitude = Math.hypot(robotForwardInput, robotStrafeLeftInput);

            if (inputMagnitude > 0) {
              const inputScale = 1 / Math.max(1, inputMagnitude);
              const distance =
                ROBOT_LINEAR_SPEED * speedMultiplier * movementDuration * inputScale;
              // ROS base-frame convention: +X forward, +Y left. Rotate that
              // local mecanum command into the map's world XY plane.
              nextPose.position.x += (
                Math.cos(yawRadians) * robotForwardInput
                - Math.sin(yawRadians) * robotStrafeLeftInput
              ) * distance;
              nextPose.position.y += (
                Math.sin(yawRadians) * robotForwardInput
                + Math.cos(yawRadians) * robotStrafeLeftInput
              ) * distance;
            }
            if (robotYawInput) {
              nextPose.rpy.yaw = normalizeDegrees(
                currentPose.rpy.yaw
                + THREE.MathUtils.radToDeg(
                  robotYawInput
                    * ROBOT_ROTATION_SPEED
                    * speedMultiplier
                    * movementDuration,
                ),
              );
            }
            if (robotVerticalInput) {
              nextPose.position.z += (
                ROBOT_VERTICAL_SPEED
                * speedMultiplier
                * movementDuration
                * robotVerticalInput
              );
            }

            robotPoseRef.current = applyRobotPose(robotLayer, nextPose);
            writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
            renderer.domElement.dataset.lastRobotAction = [...ROBOT_CONTROL_CODES]
              .filter((code) => (
                keyActive(code)
                && (!heightLocked || !ROBOT_VERTICAL_CONTROL_CODES.has(code))
              ))
              .map((code) => ROBOT_CONTROL_ACTIONS[code])
              .join('+');
            renderer.domElement.dataset.robotSpeedMode = speedMultiplier > 1
              ? 'boost'
              : 'normal';
            renderer.domElement.dataset.robotInputCount = String(
              Number(renderer.domElement.dataset.robotInputCount || 0) + 1,
            );
            publishRobotPose(robotTapImpulse);
          }
        }
      }

      const spaceMouseInput = spaceMouseInputRef?.current;
      const spaceMouseMode = spaceMouseInput?.mode === 'rpy' ? 'rpy' : 'xyz';
      const spaceMouseControlTarget = spaceMouseInput?.controlTarget === 'zivid-camera'
        ? 'zivid-camera'
        : 'viewport';
      const spaceMouseReady = Boolean(
        spaceMouseInput?.connected
        && spaceMouseInput?.calibrated
        && !spaceMouseInput?.calibrating
        && spaceMouseInput?.controlEnabled !== false
        && spaceMouseControlTarget === 'viewport'
      );
      const spaceMouseReportFresh = Boolean(
        spaceMouseReady
        && performance.now() - Number(spaceMouseInput.timestamp || 0)
          <= SPACEMOUSE_INPUT_STALE_MS,
      );
      renderer.domElement.dataset.spacemouseConnected = spaceMouseInput?.connected
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseCalibrated = spaceMouseInput?.calibrated
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseCalibrating = spaceMouseInput?.calibrating
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseControlEnabled =
        spaceMouseInput?.controlEnabled === false ? 'false' : 'true';
      renderer.domElement.dataset.spacemouseControlTarget = spaceMouseControlTarget;
      renderer.domElement.dataset.spacemouseMode = spaceMouseMode;

      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        targetSpaceMouseAxes[axis] = 0;
      });
      const candidateAxes = spaceMouseMode === 'rpy'
        ? SPACEMOUSE_ROTATION_AXES
        : SPACEMOUSE_TRANSLATION_AXES;
      const requestedAxis = String(spaceMouseInput?.selectedAxis || '');
      const selectedSpaceMouseAxis = candidateAxes.includes(requestedAxis)
        ? requestedAxis
        : spaceMouseMode === 'rpy' ? 'yaw' : 'x';
      const modeChanged = spaceMouseMode !== previousSpaceMouseMode;
      const selectedAxisChanged = selectedSpaceMouseAxis !== previousSpaceMouseSelectedAxis;
      renderer.domElement.dataset.spacemouseSelectedAxis = selectedSpaceMouseAxis;
      if (!spaceMouseReady) {
        clearFilteredSpaceMouseAxes();
      } else {
        if (modeChanged || selectedAxisChanged) {
          clearFilteredSpaceMouseAxes();
        }
        const axes = spaceMouseReportFresh ? (spaceMouseInput.axes || {}) : {};
        SPACEMOUSE_VIEW_AXES.forEach((axis) => {
          if (axis === selectedSpaceMouseAxis) {
            updateFilteredSpaceMouseAxis(
              axis,
              Number(axes[axis]) || 0,
              deltaSeconds,
            );
          } else {
            // Button selection is an explicit output gate. Sensor coupling can
            // still be decoded for quality, but it never reaches another view axis.
            targetSpaceMouseAxes[axis] = 0;
            filteredSpaceMouseAxes[axis] = 0;
          }
        });
      }
      previousSpaceMouseMode = spaceMouseMode;
      previousSpaceMouseSelectedAxis = selectedSpaceMouseAxis;
      updateSpaceMouseAxisHud(
        selectedSpaceMouseAxis,
        Boolean(
          spaceMouseReady
          && spaceMouseReportFresh
          && spaceMouseInput?.motionActive
        ),
        spaceMouseReady,
      );

      const targetSpaceMouseMagnitude = Math.max(
        ...SPACEMOUSE_VIEW_AXES.map((axis) => Math.abs(targetSpaceMouseAxes[axis])),
      );
      const filteredSpaceMouseMagnitude = Math.max(
        ...SPACEMOUSE_VIEW_AXES.map((axis) => Math.abs(filteredSpaceMouseAxes[axis])),
      );
      const appliedSpaceMouseAxis = (
        selectedSpaceMouseAxis
        && Math.abs(filteredSpaceMouseAxes[selectedSpaceMouseAxis])
          >= SPACEMOUSE_FILTER_EPSILON
      ) ? selectedSpaceMouseAxis : '';
      renderer.domElement.dataset.spacemouseDominantAxis = appliedSpaceMouseAxis;
      renderer.domElement.dataset.spacemouseAppliedAxisCount = appliedSpaceMouseAxis ? '1' : '0';
      renderer.domElement.dataset.spacemouseMotionState = spaceMouseInput?.calibrating
        ? 'calibrating'
        : targetSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON
          ? 'active'
          : filteredSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON
            ? 'settling'
            : 'idle';
      writeSpaceMouseFilterTelemetry();

      if (filteredSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON) {
        if (spaceMouseMode === 'rpy') {
          const rollInput = filteredSpaceMouseAxes.roll;
          const pitchInput = filteredSpaceMouseAxes.pitch;
          const yawInput = filteredSpaceMouseAxes.yaw;
          if (rollInput || pitchInput || yawInput) {
            cameraOffset.copy(camera.position).sub(controls.target);
            const lockedOrbitDistance = cameraOffset.length();
            if (yawInput) {
              keyboardRotation.setFromAxisAngle(
                worldUp,
                yawInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
              );
              cameraOffset.applyQuaternion(keyboardRotation);
              camera.up.applyQuaternion(keyboardRotation);
            }
            if (pitchInput) {
              lookForward.copy(cameraOffset).multiplyScalar(-1).normalize();
              lookRight.crossVectors(lookForward, camera.up).normalize();
              if (lookRight.lengthSq() > 1e-12) {
                keyboardRotation.setFromAxisAngle(
                  lookRight,
                  -pitchInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
                );
                cameraOffset.applyQuaternion(keyboardRotation);
                camera.up.applyQuaternion(keyboardRotation);
              }
            }
            if (lockedOrbitDistance > 0) cameraOffset.setLength(lockedOrbitDistance);
            camera.position.copy(controls.target).add(cameraOffset);
            if (rollInput) {
              camera.getWorldDirection(lookForward).normalize();
              keyboardRotation.setFromAxisAngle(
                lookForward,
                rollInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
              );
              camera.up.applyQuaternion(keyboardRotation);
            }
            camera.up.normalize();
            renderer.domElement.dataset.spacemouseLastMotion = [
              rollInput ? 'roll' : '',
              pitchInput ? 'pitch' : '',
              yawInput ? 'yaw' : '',
            ].filter(Boolean).join('+');
            renderer.domElement.dataset.spacemouseRotationDistancePolicy = 'locked';
            spaceMouseMoved = true;
          }
        } else {
          // XYZ is translation-only: X moves the camera and target together
          // along the current XY heading, while Y/Z pan laterally/vertically.
          // Camera-target distance and optical zoom therefore remain untouched.
          const xInput = filteredSpaceMouseAxes.x;
          const yInput = filteredSpaceMouseAxes.y;
          const zInput = filteredSpaceMouseAxes.z;
          if (xInput) {
            camera.getWorldDirection(forward);
            forward.z = 0;
            if (forward.lengthSq() < 1e-12) forward.set(0, 1, 0);
            else forward.normalize();
            const metrics = getPanMetrics();
            const forwardSpeed = THREE.MathUtils.clamp(
              metrics.effectiveDistance * SPACEMOUSE_FORWARD_SPEED_RATIO,
              radius * 1e-5,
              radius * 0.45,
            );
            movement.copy(forward).multiplyScalar(
              xInput * forwardSpeed * deltaSeconds,
            );
            camera.position.add(movement);
            controls.target.add(movement);
            renderer.domElement.dataset.spacemouseForwardImplementation = 'world-xy';
            spaceMouseMoved = true;
          }
          if (yInput || zInput) {
            panByPixels(
              yInput * SPACEMOUSE_PAN_PIXELS_PER_SECOND * deltaSeconds,
              zInput * SPACEMOUSE_PAN_PIXELS_PER_SECOND * deltaSeconds,
            );
            spaceMouseMoved = true;
          }
          if (spaceMouseMoved) {
            renderer.domElement.dataset.spacemouseLastMotion = [
              xInput ? 'x' : '',
              yInput ? 'y' : '',
              zInput ? 'z' : '',
            ].filter(Boolean).join('+');
          }
        }
      }
      if (spaceMouseMoved) {
        renderer.domElement.dataset.spacemouseInputCount = String(
          Number(renderer.domElement.dataset.spacemouseInputCount || 0) + 1,
        );
        renderer.domElement.dataset.spacemouseLastInputAt = String(
          Number(spaceMouseInput.timestamp || 0).toFixed(2),
        );
      }
      keyboardImpulses.clear();
      controls.update();
      reportZividCameraPoses();
      if (keyboardMoved || spaceMouseMoved) {
        syncDetailView();
        // Application-owned keyboard and SpaceMouse transforms need an explicit
        // persisted view update because TrackballControls did not originate them.
        reportCameraView();
      }

      camera.updateMatrixWorld(true);
      const focalPixels =
        (Math.max(renderer.domElement.clientHeight, 1) / 2)
        / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

      const chassisHandle = robotChassisHandleRef.current;
      if (chassisHandle?.target) {
        chassisHandle.target.getWorldPosition(chassisWorldPosition);
        chassisProjectedPosition.copy(chassisWorldPosition).project(camera);
        renderer.domElement.dataset.robotChassisWorldX = chassisWorldPosition.x.toFixed(6);
        renderer.domElement.dataset.robotChassisWorldY = chassisWorldPosition.y.toFixed(6);
        renderer.domElement.dataset.robotChassisWorldZ = chassisWorldPosition.z.toFixed(6);
        renderer.domElement.dataset.robotChassisScreenX = (
          (chassisProjectedPosition.x + 1) * 0.5 * renderer.domElement.clientWidth
        ).toFixed(2);
        renderer.domElement.dataset.robotChassisScreenY = (
          (1 - chassisProjectedPosition.y) * 0.5 * renderer.domElement.clientHeight
        ).toFixed(2);
        renderer.domElement.dataset.robotChassisScreenVisible =
          Math.abs(chassisProjectedPosition.x) <= 1
          && Math.abs(chassisProjectedPosition.y) <= 1
          && chassisProjectedPosition.z >= -1
          && chassisProjectedPosition.z <= 1
            ? 'true'
            : 'false';
      } else {
        renderer.domElement.dataset.robotChassisScreenVisible = 'false';
      }

      Object.entries(endEffectorControllersRef.current).forEach(([side, controller]) => {
        if (!controller?.frame) return;
        controller.frame.getWorldPosition(endEffectorWorldPosition);
        endEffectorProjectedPosition.copy(endEffectorWorldPosition).project(camera);
        const prefix = side === 'left' ? 'robotLeftTool' : 'robotRightTool';
        renderer.domElement.dataset[`${prefix}WorldX`] = endEffectorWorldPosition.x.toFixed(6);
        renderer.domElement.dataset[`${prefix}WorldY`] = endEffectorWorldPosition.y.toFixed(6);
        renderer.domElement.dataset[`${prefix}WorldZ`] = endEffectorWorldPosition.z.toFixed(6);
        renderer.domElement.dataset[`${prefix}ScreenX`] = (
          (endEffectorProjectedPosition.x + 1) * 0.5 * renderer.domElement.clientWidth
        ).toFixed(2);
        renderer.domElement.dataset[`${prefix}ScreenY`] = (
          (1 - endEffectorProjectedPosition.y) * 0.5 * renderer.domElement.clientHeight
        ).toFixed(2);
        renderer.domElement.dataset[`${prefix}ScreenVisible`] =
          Math.abs(endEffectorProjectedPosition.x) <= 1
          && Math.abs(endEffectorProjectedPosition.y) <= 1
          && endEffectorProjectedPosition.z >= -1
          && endEffectorProjectedPosition.z <= 1
            ? 'true'
            : 'false';
      });

      if (endEffectorTarget.visible && endEffectorSpaceBall.visible) {
        endEffectorTarget.getWorldPosition(endEffectorWorldPosition);
        endEffectorCameraPosition
          .copy(endEffectorWorldPosition)
          .applyMatrix4(camera.matrixWorldInverse);
        const targetDepth = -endEffectorCameraPosition.z;
        if (targetDepth > 1e-9) {
          const baseRadius = endEffectorSpaceBall.userData.baseRadius || 0.12;
          const naturalDiameter =
            (2 * baseRadius * camera.zoom * focalPixels) / targetDepth;
          const lodScale = THREE.MathUtils.clamp(
            END_EFFECTOR_SCREEN_DIAMETER / Math.max(naturalDiameter, 1e-30),
            1e-30,
            1e30,
          );
          endEffectorSpaceBall.scale.setScalar(lodScale);
          renderer.domElement.dataset.endEffectorSpaceBallScreenDiameter = (
            naturalDiameter * lodScale
          ).toFixed(2);
          renderer.domElement.dataset.endEffectorSpaceBallScale = lodScale.toExponential(5);
        }
      }
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
      const parkingGhostVisual = robotParkingGhostVisualRef.current;
      if (parkingGhostVisual) {
        updateRobotParkingGhostGuide(parkingGhostVisual, robotPoseRef.current, null);
        const ghostPulse = 1.04 + Math.sin(performance.now() * 0.0034) * 0.08;
        parkingGhostVisual.pulseRing.scale.setScalar(ghostPulse);
        parkingGhostVisual.pulseRing.material.opacity = 0.18
          + ((ghostPulse - 0.96) / 0.16) * 0.22;
        renderer.domElement.dataset.parkingGhostPulse = ghostPulse.toFixed(3);
      }
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      if (pendingWheelArbitrationTimer) {
        window.clearTimeout(pendingWheelArbitrationTimer);
        pendingWheelArbitrationTimer = null;
      }
      pendingWheelArbitration = null;
      updateChassisDragMode(false, 'scene-dispose');
      observer.disconnect();
      renderer.domElement.removeEventListener('wheel', progressiveWheelZoom, true);
      renderer.domElement.removeEventListener('pointerdown', onPickPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', onPickPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', onPickPointerUp, true);
      renderer.domElement.removeEventListener('pointercancel', resetPickPointer);
      renderer.domElement.removeEventListener('pointerleave', onPickPointerLeave);
      renderer.domElement.removeEventListener('dblclick', onRobotDoubleClick, true);
      renderer.domElement.removeEventListener(
        MAIN_VIEW_PREVIEW_CONTROL_EVENT,
        onMainViewPreviewControl,
      );
      transformControls.removeEventListener('dragging-changed', onTransformDraggingChanged);
      transformControls.removeEventListener('objectChange', onTransformObjectChange);
      transformControls.detach();
      transformControls.dispose();
      scene.remove(transformHelper, endEffectorTarget);
      disposeObject(endEffectorTarget);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      displayGeometry.dispose();
      material.dispose();
      disposeTeachingSurfaceProjectionOverlay(surfaceCoverageProjectionRef.current);
      surfaceCoverageProjectionRef.current = null;
      surfaceGeometry?.dispose();
      meshMaterial?.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      disposeObject(originGroup);
      disposeObject(sliceGroup);
      disposeObject(routeGroup);
      disposeObject(waypointGroup);
      disposeObject(visionCoverageGroup);
      clearRobotParkingGhostLayer(robotParkingGhostLayer);
      renderer.dispose();
      if (viewportCanvasRef?.current === renderer.domElement) {
        viewportCanvasRef.current = null;
      }
      renderer.domElement.remove();
      sceneRef.current = null;
      sliceGroupRef.current = null;
      routeGroupRef.current = null;
      waypointGroupRef.current = null;
      visionCoverageGroupRef.current = null;
      robotLayerRef.current = null;
      loadedRobotRef.current = null;
      robotParkingGhostLayerRef.current = null;
      robotParkingGhostVisualRef.current = null;
      robotChassisHandleRef.current = null;
      endEffectorControllersRef.current = { left: null, right: null };
      endEffectorControlRef.current = null;
      lockedEndEffectorsRef.current = createEndEffectorLocks();
      if (transformControlsRef.current === transformControls) transformControlsRef.current = null;
      if (endEffectorTargetRef.current === endEffectorTarget) endEffectorTargetRef.current = null;
      if (endEffectorSpaceBallRef.current === endEffectorSpaceBall) {
        endEffectorSpaceBallRef.current = null;
      }
      if (robotPoseActionsRef.current === robotPoseActions) {
        robotPoseActionsRef.current = null;
      }
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
      if (chassisDragInteractionRef.current === chassisDragActions) {
        chassisDragInteractionRef.current = null;
      }
      chassisDragModeRef.current = false;
      controlsRef.current = null;
      cameraRef.current = null;
      displayGeometryRef.current = null;
      if (surfaceGeometryRef.current?.geometry === surfaceGeometry) {
        surfaceGeometryRef.current = null;
      }
      if (cloudMaterialRef.current === material) cloudMaterialRef.current = null;
      if (meshMaterialRef.current === meshMaterial) meshMaterialRef.current = null;
    };
  }, [mapData?.geometry, mapData?.teachingSpaceMode, viewportCanvasRef]);

  useEffect(() => {
    const layer = robotLayerRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!layer || !canvas) return undefined;

    collisionHighlightCleanupRef.current?.();
    collisionHighlightCleanupRef.current = null;
    chassisDragInteractionRef.current?.exit?.('robot-change');
    robotChassisHandleRef.current = null;
    loadedRobotRef.current = null;
    canvas.dataset.chassisDragHandleReady = 'false';
    canvas.dataset.robotChassisScreenVisible = 'false';
    endEffectorInteractionRef.current?.exit?.();
    clearEndEffectorLocks();
    endEffectorControllersRef.current = { left: null, right: null };
    zividCameraFramesRef.current = { left: null, right: null };
    lastZividCameraPoseSignatureRef.current = '';
    onZividCameraPoseChangeRef.current?.({});
    [...layer.children].forEach((child) => disposeRobotModel(child));
    clearRobotJointDataset(canvas);
    robotPoseRef.current = applyRobotPose(layer, robotPoseRef.current);
    writeRobotPoseDataset(canvas, robotPoseRef.current);
    if (!robotDescriptor) {
      canvas.dataset.robotModelState = 'idle';
      canvas.dataset.robotModelName = '';
      canvas.dataset.robotOrigin = '';
      return undefined;
    }

    const controller = new AbortController();
    let loadedRobot = null;
    canvas.dataset.robotModelState = 'loading';
    canvas.dataset.robotModelName = robotDescriptor.name;
    canvas.dataset.robotModelFormat = robotDescriptor.format;
    writeRobotPoseDataset(canvas, robotPoseRef.current);
    onRobotLoadStateRef.current?.({
      status: 'loading',
      robotId: robotDescriptor.id,
      name: robotDescriptor.name,
      loaded: 0,
      total: 0,
      phase: '读取机器人描述',
    });

    loadRobotModel(robotDescriptor, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (controller.signal.aborted) return;
        onRobotLoadStateRef.current?.({
          status: 'loading',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          ...progress,
        });
      },
    })
      .then((robot) => {
        if (controller.signal.aborted || robotLayerRef.current !== layer) {
          disposeRobotModel(robot);
          return;
        }
        loadedRobot = robot;
        layer.add(robot);
        loadedRobotRef.current = robot;
        applyRobotPose(layer, robotPoseRef.current);
        robotJointValuesRef.current = applyRobotJointStateToScene(
          robotJointValuesRef.current,
          'robot-load',
        );
        layer.updateMatrixWorld(true);
        const metadata = robot.userData.robot || {};
        const chassisHandle = createRobotChassisDragHandle(robot, metadata);
        robotChassisHandleRef.current = chassisHandle;
        const bounds = metadata.bounds || {};
        const modelSize = Array.isArray(bounds.size)
          ? Math.max(...bounds.size.map((value) => Math.abs(Number(value) || 0)))
          : 1;
        const pickRadius = THREE.MathUtils.clamp(modelSize * 0.045, 0.055, 0.14);
        const endEffectors = {
          left: getRobotEndEffector(robot, 'left'),
          right: getRobotEndEffector(robot, 'right'),
        };
        Object.entries(endEffectors).forEach(([side, endEffector]) => {
          if (!endEffector) return;
          const pickTarget = new THREE.Mesh(
            new THREE.SphereGeometry(pickRadius, 12, 8),
            new THREE.MeshBasicMaterial({
              transparent: true,
              opacity: 0,
              depthWrite: false,
              colorWrite: false,
            }),
          );
          pickTarget.name = `end-effector-${side}-double-click-target`;
          pickTarget.userData.endEffectorSide = side;
          endEffector.frame.add(pickTarget);
        });
        endEffectorControllersRef.current = endEffectors;
        zividCameraFramesRef.current = {
          left: robot.getObjectByName('zivid_left_optical_frame') || null,
          right: robot.getObjectByName('zivid_right_optical_frame') || null,
        };
        robot.updateMatrixWorld(true);
        const leftPosition = endEffectors.left?.frame
          .getWorldPosition(new THREE.Vector3()).toArray() || [];
        const rightPosition = endEffectors.right?.frame
          .getWorldPosition(new THREE.Vector3()).toArray() || [];
        canvas.dataset.robotModelState = 'loaded';
        canvas.dataset.robotModelName = robotDescriptor.name;
        canvas.dataset.robotModelFormat = metadata.format || robotDescriptor.format;
        writeRobotPoseDataset(canvas, robotPoseRef.current);
        canvas.dataset.robotLinkCount = String(metadata.linkCount || 0);
        canvas.dataset.robotJointCount = String(metadata.jointCount || 0);
        canvas.dataset.robotVisualCount = String(metadata.visualCount || 0);
        canvas.dataset.robotZividCount = String(metadata.zividCount || 0);
        canvas.dataset.robotOpticalFrameCount = String(metadata.opticalFrameCount || 0);
        canvas.dataset.robotWebOverrideCount = String(metadata.webOverrideCount || 0);
        canvas.dataset.robotEndEffectorCount = String(
          Object.values(endEffectors).filter(Boolean).length,
        );
        canvas.dataset.chassisDragHandleReady = 'true';
        canvas.dataset.chassisDragTargetFrame = chassisHandle.frame.name || 'robot-root';
        canvas.dataset.chassisDragTargetSize = chassisHandle.size
          .toArray()
          .map((value) => value.toFixed(6))
          .join(',');
        canvas.dataset.robotBoundsMin = (bounds.min || []).join(',');
        canvas.dataset.robotBoundsMax = (bounds.max || []).join(',');
        canvas.dataset.robotLeftToolPosition = leftPosition.join(',');
        canvas.dataset.robotRightToolPosition = rightPosition.join(',');
        canvas.dataset.robotWaistPosition = (metadata.framePositions?.waist_yaw_L || []).join(',');
        onRobotLoadStateRef.current?.({
          status: 'loaded',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          loaded: metadata.visualCount || 1,
          total: metadata.visualCount || 1,
          ...metadata,
        });
        reportRobotJointValues(true);
        reportZividCameraPoses(true);
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        canvas.dataset.robotModelState = 'error';
        canvas.dataset.robotModelError = error.message || '未知错误';
        onRobotLoadStateRef.current?.({
          status: 'error',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          message: error.message || '未知错误',
        });
      });

    return () => {
      controller.abort();
      collisionHighlightCleanupRef.current?.();
      collisionHighlightCleanupRef.current = null;
      chassisDragInteractionRef.current?.exit?.('robot-change');
      robotChassisHandleRef.current = null;
      canvas.dataset.chassisDragHandleReady = 'false';
      canvas.dataset.robotChassisScreenVisible = 'false';
      endEffectorInteractionRef.current?.exit?.();
      endEffectorControllersRef.current = { left: null, right: null };
      zividCameraFramesRef.current = { left: null, right: null };
      lastZividCameraPoseSignatureRef.current = '';
      onZividCameraPoseChangeRef.current?.({});
      if (loadedRobotRef.current === loadedRobot) loadedRobotRef.current = null;
      clearRobotJointDataset(canvas);
      if (loadedRobot) disposeRobotModel(loadedRobot);
    };
  }, [mapData?.geometry, robotDescriptor]);

  useEffect(() => {
    const layer = robotParkingGhostLayerRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!layer || !canvas) return undefined;

    clearRobotParkingGhostLayer(layer);
    robotParkingGhostVisualRef.current = null;
    writeRobotParkingGhostHiddenDataset(canvas);
    if (
      !robotParkingGhost
      || !loadedRobotRef.current
      || robotLoadState?.status !== 'loaded'
    ) return undefined;

    let visual = null;
    try {
      visual = createRobotParkingGhostVisual(
        loadedRobotRef.current,
        robotParkingGhost,
      );
      visual.objects.forEach((object) => layer.add(object));
      layer.userData.ownedResources = visual.resources;
      layer.userData.parkingPointId = robotParkingGhost.parkingPointId;
      robotParkingGhostVisualRef.current = visual;
      updateRobotParkingGhostGuide(visual, robotPoseRef.current, canvas);
      canvas.dataset.parkingGhostState = 'visible';
      canvas.dataset.parkingGhostTargetId = robotParkingGhost.parkingPointId;
      canvas.dataset.parkingGhostMeshCount = String(visual.meshCount);
      canvas.dataset.parkingGhostJointCount = String(visual.jointCount);
      canvas.dataset.parkingGhostJointValues = JSON.stringify(
        normalizeRobotJointValues(robotParkingGhost.jointValues),
      );
      canvas.dataset.parkingGhostOpacity = String(ROBOT_PARKING_GHOST_OPACITY);
      canvas.dataset.parkingGhostTargetPose = [
        visual.targetPose.position.x,
        visual.targetPose.position.y,
        visual.targetPose.position.z,
        visual.targetPose.rpy.roll,
        visual.targetPose.rpy.pitch,
        visual.targetPose.rpy.yaw,
      ].join(',');
    } catch (error) {
      clearRobotParkingGhostLayer(layer);
      robotParkingGhostVisualRef.current = null;
      canvas.dataset.parkingGhostState = 'error';
      canvas.dataset.parkingGhostError = error?.message || '机器人虚影创建失败';
      console.error('Failed to create robot parking ghost', error);
      return undefined;
    }

    return () => {
      if (robotParkingGhostVisualRef.current === visual) {
        robotParkingGhostVisualRef.current = null;
        clearRobotParkingGhostLayer(layer);
        writeRobotParkingGhostHiddenDataset(canvas);
      }
    };
  }, [mapData?.geometry, robotDescriptor, robotLoadState?.status, robotParkingGhost]);

  useEffect(() => {
    const canvas = controlsRef.current?.domElement;
    const geometry = mapData?.geometry;
    const generation = collisionMonitorGenerationRef.current + 1;
    collisionMonitorGenerationRef.current = generation;
    let disposed = false;
    let worker = null;
    let workerReady = false;
    let workerBusy = false;
    let collisionCheckPending = false;
    let checkTimer = null;
    let deferredCheckTimer = null;
    let lastCheckSubmittedAt = Number.NEGATIVE_INFINITY;
    let observedRobot = null;
    let proxyCollection = null;
    let lastPoseSignature = '';
    let lastPublishedSignature = '';
    let checkRevision = 0;
    let checkCount = 0;
    let indexMetrics = {
      sourcePointCount: geometry?.getAttribute?.('position')?.count || 0,
      indexedPointCount: 0,
      meshSampleCount: 0,
    };
    let currentStatus = createRobotCollisionStatus({
      enabled: Boolean(collisionProtectionEnabled),
    });

    const writeStatusDataset = (status) => {
      if (!canvas) return;
      canvas.dataset.collisionProtectionEnabled = status.enabled ? 'true' : 'false';
      canvas.dataset.collisionState = status.state;
      canvas.dataset.collisionSafetyDistance = String(ROBOT_COLLISION_SAFETY_DISTANCE);
      canvas.dataset.collisionContactMargin = String(ROBOT_COLLISION_CONTACT_MARGIN);
      canvas.dataset.collisionMinimumDistance = Number.isFinite(status.minimumDistance)
        ? Number(status.minimumDistance).toFixed(6)
        : '';
      canvas.dataset.collisionLinks = (status.collisionLinks || []).join(',');
      canvas.dataset.collisionNearLinks = (status.nearLinks || []).join(',');
      canvas.dataset.collisionExcludedLinks = (status.excludedLinks || []).join(',');
      canvas.dataset.collisionMonitoredLinkCount = String(status.monitoredLinkCount || 0);
      canvas.dataset.collisionMonitoredProxyCount = String(status.monitoredProxyCount || 0);
      canvas.dataset.collisionSourcePoints = String(status.sourcePointCount || 0);
      canvas.dataset.collisionIndexedPoints = String(status.indexedPointCount || 0);
      canvas.dataset.collisionMeshSamples = String(status.meshSampleCount || 0);
      canvas.dataset.collisionCheckCount = String(status.checkCount || 0);
      canvas.dataset.collisionHighlightedLinks = [
        ...(status.collisionLinks || []),
        ...(status.nearLinks || []),
      ].join(',');
      canvas.dataset.collisionHighlightColor = status.state === 'collision'
        ? '#ff4545'
        : status.state === 'near'
          ? '#ffc84a'
          : 'none';
    };

    const publishStatus = (patch) => {
      currentStatus = createRobotCollisionStatus({
        ...currentStatus,
        ...patch,
        enabled: Boolean(collisionProtectionEnabled),
        threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
      });
      writeStatusDataset(currentStatus);
      const signature = collisionStatusSignature(currentStatus);
      if (signature === lastPublishedSignature) return;
      lastPublishedSignature = signature;
      setRobotCollisionStatus(currentStatus);
      onCollisionProtectionStatusRef.current?.(currentStatus);
    };

    const clearProxyCollection = () => {
      if (proxyCollection) disposeRobotCollisionProxies(proxyCollection);
      proxyCollection = null;
      observedRobot = null;
      if (canvas) {
        canvas.dataset.collisionProbePoint = '';
        canvas.dataset.collisionProbeLink = '';
      }
    };
    if (!collisionProtectionEnabled) {
      if (canvas) canvas.dataset.collisionWorker = 'inactive';
      publishStatus({
        state: 'disabled',
        message: '碰撞保护未开启',
        detail: '专用空间索引与距离检测尚未占用硬件资源',
      });
      return undefined;
    }

    const positionAttribute = geometry?.getAttribute?.('position');
    if (!canvas || !positionAttribute?.count) {
      publishStatus({
        state: 'error',
        message: '干涉检测不可用',
        detail: '请先加载有效的地图点云',
      });
      return undefined;
    }
    collisionHighlightCleanupRef.current = clearProxyCollection;

    publishStatus({
      state: 'building',
      message: '正在建立环境空间索引',
      detail: `${positionAttribute.count.toLocaleString('zh-CN')} 个地图顶点正在专用 Worker 中处理`,
      ...indexMetrics,
    });

    const ensureRobotProxies = () => {
      const robot = loadedRobotRef.current;
      if (!robot) return false;
      if (observedRobot === robot && proxyCollection) return proxyCollection.proxies.length > 0;
      clearProxyCollection();
      observedRobot = robot;
      proxyCollection = collectRobotCollisionProxies(robot);
      lastPoseSignature = '';
      const serialized = serializeRobotCollisionProxies(proxyCollection);
      const probe = selectRobotCollisionProbe(serialized.records);
      if (probe && canvas) {
        canvas.dataset.collisionProbePoint = probe.center
          .map((value) => Number(value).toFixed(6))
          .join(',');
        canvas.dataset.collisionProbeLink = probe.linkName;
      }
      return proxyCollection.proxies.length > 0;
    };

    const requestCollisionCheck = () => {
      if (disposed) return;
      canvas.dataset.collisionRequestCount = String(
        Number(canvas.dataset.collisionRequestCount || 0) + 1,
      );
      if (!workerReady || !worker) {
        collisionCheckPending = true;
        return;
      }
      if (workerBusy) {
        collisionCheckPending = true;
        return;
      }
      const timeUntilNextCheck = ROBOT_COLLISION_CHECK_INTERVAL_MS
        - (performance.now() - lastCheckSubmittedAt);
      if (timeUntilNextCheck > 1) {
        collisionCheckPending = true;
        if (!deferredCheckTimer) {
          deferredCheckTimer = window.setTimeout(() => {
            deferredCheckTimer = null;
            requestCollisionCheck();
          }, timeUntilNextCheck);
        }
        return;
      }
      collisionCheckPending = false;
      if (!ensureRobotProxies()) {
        publishStatus({
          state: robotLoadStateRef.current?.status === 'error' ? 'error' : 'waiting',
          message: robotLoadStateRef.current?.status === 'error'
            ? '机器人检测体不可用'
            : '等待机器人检测体',
          detail: robotLoadStateRef.current?.status === 'error'
            ? '机器人模型加载失败，请重新选择模型'
            : '模型装配完成后将自动开始检测',
          ...indexMetrics,
        });
        return;
      }
      robotLayerRef.current?.updateMatrixWorld(true);
      const serialized = serializeRobotCollisionProxies(proxyCollection);
      const probe = selectRobotCollisionProbe(serialized.records);
      if (probe) {
        canvas.dataset.collisionProbePoint = probe.center
          .map((value) => Number(value).toFixed(6))
          .join(',');
        canvas.dataset.collisionProbeLink = probe.linkName;
      }
      if (serialized.signature === lastPoseSignature) {
        canvas.dataset.collisionSkippedPoseCount = String(
          Number(canvas.dataset.collisionSkippedPoseCount || 0) + 1,
        );
        return;
      }
      lastPoseSignature = serialized.signature;
      workerBusy = true;
      lastCheckSubmittedAt = performance.now();
      checkRevision += 1;
      canvas.dataset.collisionSubmittedRevision = String(checkRevision);
      worker.postMessage({
        type: 'check',
        revision: checkRevision,
        proxies: serialized.records,
        threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
        contactMargin: ROBOT_COLLISION_CONTACT_MARGIN,
      });
    };
    const requestCollisionCheckFromScene = () => {
      collisionCheckPending = true;
      requestCollisionCheck();
    };
    collisionCheckRequestRef.current = requestCollisionCheckFromScene;

    try {
      worker = new Worker(new URL('../workers/robotCollision.worker.js', import.meta.url), {
        type: 'module',
      });
      canvas.dataset.collisionWorker = 'building';
      worker.onmessage = (event) => {
        if (disposed || collisionMonitorGenerationRef.current !== generation) return;
        const message = event.data || {};
        if (message.type === 'ready') {
          workerReady = true;
          indexMetrics = {
            sourcePointCount: Number(message.sourcePointCount) || 0,
            indexedPointCount: Number(message.indexedPointCount) || 0,
            meshSampleCount: Number(message.meshSampleCount) || 0,
          };
          canvas.dataset.collisionWorker = 'dedicated';
          canvas.dataset.collisionIndexBuildMs = Number(message.buildMs || 0).toFixed(2);
          canvas.dataset.collisionIndexCellSize = String(message.cellSize || COLLISION_INDEX_CELL_SIZE);
          canvas.dataset.collisionIndexBuckets = String(message.bucketCount || 0);
          publishStatus({
            state: 'waiting',
            message: '环境索引已就绪',
            detail: `已索引 ${(indexMetrics.indexedPointCount).toLocaleString('zh-CN')} 个环境样本，正在同步机器人`,
            ...indexMetrics,
          });
          requestCollisionCheck();
          return;
        }
        if (message.type === 'result') {
          workerBusy = false;
          if (Number(message.revision) !== checkRevision || !proxyCollection) return;
          checkCount += 1;
          const collisionLinks = Array.isArray(message.collisionLinks)
            ? message.collisionLinks
            : [];
          const nearLinks = Array.isArray(message.nearLinks) ? message.nearLinks : [];
          const minimumDistance = Number.isFinite(message.minimumDistance)
            ? Number(message.minimumDistance)
            : null;
          const state = collisionLinks.length ? 'collision' : nearLinks.length ? 'near' : 'safe';
          applyRobotCollisionHighlights(proxyCollection, { collisionLinks, nearLinks });
          canvas.dataset.collisionLastCheckMs = Number(message.checkMs || 0).toFixed(2);
          publishStatus({
            state,
            minimumDistance,
            collisionLinks,
            nearLinks,
            excludedLinks: proxyCollection.excludedLinks,
            monitoredLinkCount: proxyCollection.monitoredLinks.length,
            monitoredProxyCount: proxyCollection.proxies.length,
            checkCount,
            message: state === 'collision'
              ? '检测到环境干涉'
              : state === 'near'
                ? '进入 100 mm 安全边界'
                : '非底盘结构安全',
            detail: state === 'collision'
              ? `红色部件：${collisionLinks.slice(0, 4).join(' / ')}${collisionLinks.length > 4 ? ` +${collisionLinks.length - 4}` : ''}`
              : state === 'near'
                ? `最近直线距离 ${Math.max(0, minimumDistance * 1000).toFixed(0)} mm · ${nearLinks.slice(0, 3).join(' / ')}`
                : '最近环境样本距离不小于 100 mm',
            ...indexMetrics,
          });
          if (collisionCheckPending) {
            window.setTimeout(requestCollisionCheck, 0);
          }
          return;
        }
        if (message.type === 'error') {
          workerBusy = false;
          applyRobotCollisionHighlights(proxyCollection, {});
          publishStatus({
            state: 'error',
            message: '干涉检测中断',
            detail: message.message || '专用 Worker 返回了未知错误',
            ...indexMetrics,
          });
        }
      };
      worker.onerror = (event) => {
        if (disposed || collisionMonitorGenerationRef.current !== generation) return;
        workerBusy = false;
        applyRobotCollisionHighlights(proxyCollection, {});
        publishStatus({
          state: 'error',
          message: '干涉检测中断',
          detail: event.message || '专用 Worker 无法建立环境索引',
        });
      };

      const positions = packCollisionPositions(positionAttribute);
      const indices = packCollisionIndices(geometry.getIndex?.());
      worker.postMessage({
        type: 'init',
        positions,
        indices,
        requestedCellSize: COLLISION_INDEX_CELL_SIZE,
      }, [positions.buffer, indices.buffer]);
      checkTimer = window.setInterval(
        requestCollisionCheck,
        ROBOT_COLLISION_CHECK_INTERVAL_MS,
      );
    } catch (error) {
      publishStatus({
        state: 'error',
        message: '干涉检测无法启动',
        detail: error.message || '当前浏览器不支持专用 Worker',
      });
    }

    return () => {
      disposed = true;
      if (collisionMonitorGenerationRef.current === generation) {
        collisionMonitorGenerationRef.current += 1;
      }
      if (checkTimer) window.clearInterval(checkTimer);
      if (deferredCheckTimer) window.clearTimeout(deferredCheckTimer);
      worker?.terminate();
      applyRobotCollisionHighlights(proxyCollection, {});
      clearProxyCollection();
      if (collisionCheckRequestRef.current === requestCollisionCheckFromScene) {
        collisionCheckRequestRef.current = null;
      }
      if (collisionHighlightCleanupRef.current === clearProxyCollection) {
        collisionHighlightCleanupRef.current = null;
      }
      canvas.dataset.collisionWorker = 'terminated';
      canvas.dataset.collisionHighlightedLinks = '';
      canvas.dataset.collisionHighlightColor = 'none';
    };
  }, [collisionProtectionEnabled, mapData?.geometry, robotDescriptor]);

  useEffect(() => {
    collisionCheckRequestRef.current?.();
  }, [robotJointValues, robotPose]);

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
    } else if (focusRequest.type === 'robot') {
      const robot = robotLayerRef.current;
      if (robot?.children.length) {
        const robotSphere = new THREE.Box3()
          .setFromObject(robot)
          .getBoundingSphere(new THREE.Sphere());
        if (Number.isFinite(robotSphere.radius) && robotSphere.radius > 0) {
          target = robotSphere.center.clone();
          subjectSpan = robotSphere.radius * 2;
          camera.updateMatrixWorld(true);
          const screenUp = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 1)
            .normalize();
          target.addScaledVector(screenUp, -robotSphere.radius * 0.28);
        }
      }
    } else if (focusRequest.type === 'robot-ghost') {
      const robot = robotLayerRef.current;
      const ghostPoseRoot = robotParkingGhostVisualRef.current?.poseRoot;
      if (robot?.children.length && ghostPoseRoot) {
        const comparisonBounds = new THREE.Box3().setFromObject(robot);
        comparisonBounds.expandByObject(ghostPoseRoot);
        const comparisonSphere = comparisonBounds.getBoundingSphere(new THREE.Sphere());
        if (Number.isFinite(comparisonSphere.radius) && comparisonSphere.radius > 0) {
          target = comparisonSphere.center.clone();
          subjectSpan = comparisonSphere.radius * 2;
        }
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
        : focusRequest.type === 'robot'
          ? Math.max(subjectSpan * 1.72, 0.9)
          : focusRequest.type === 'robot-ghost'
            ? Math.max(subjectSpan * 1.48, 1.05)
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
    const materials = [cloudMaterialRef.current, meshMaterialRef.current].filter(Boolean);
    const canvas = controlsRef.current?.domElement;
    if (!materials.length || !canvas) return;

    materials.forEach((material) => {
      material.userData.mapColorMode = colorMode;
      const shader = material.userData.mapColorShader;
      if (shader) shader.uniforms.atlasPointColorMode.value = colorModeValue(colorMode);
    });
    canvas.dataset.colorMode = colorMode;
    canvas.dataset.plyMeshColorMode = colorMode;
  }, [colorMode, mapData?.geometry]);

  useEffect(() => {
    const surfaceState = surfaceGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!surfaceState || !canvas || !hasEmbeddedMesh) return;
    const plan = resolveMeshRenderQuality(meshRenderQuality, meshInfo.faceCount);
    surfaceState.geometry.setIndex(
      plan.isFull ? surfaceState.sourceIndex : surfaceState.sampledIndex,
    );
    surfaceState.geometry.setDrawRange(0, plan.renderedFaceCount * 3);
    canvas.dataset.meshRenderQuality = plan.requestedId;
    canvas.dataset.meshRenderQualityEffective = plan.effectiveId;
    canvas.dataset.renderMeshFaceCount = String(plan.renderedFaceCount);
    canvas.dataset.meshFaceBudget = Number.isFinite(plan.triangleBudget)
      ? String(plan.triangleBudget)
      : 'full';
  }, [hasEmbeddedMesh, mapData?.geometry, meshInfo?.faceCount, meshRenderQuality]);

  useEffect(() => {
    const displayGeometry = displayGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!displayGeometry || !canvas || !sourcePointCount) return;

    displayGeometry.setDrawRange(0, renderedPointCount);
    canvas.dataset.resolutionPercent = String(Math.round(resolution.ratio * 100));
    canvas.dataset.renderPointCount = String(renderedPointCount);
    canvas.dataset.sourcePointCount = String(sourcePointCount);
    canvas.dataset.renderablePointCount = String(renderablePointCount);
    canvas.dataset.resolutionSelection = resolutionSelection;
    canvas.dataset.autoPointBudget = String(AUTO_POINT_BUDGET);
  }, [
    renderablePointCount,
    renderedPointCount,
    resolution.ratio,
    resolutionSelection,
    sourcePointCount,
  ]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const temporaryShiftPan = shiftPanArmed;
    controls.mouseButtons.LEFT = interactionMode === 'pan'
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.domElement.dataset.interactionMode = interactionMode;
    controls.domElement.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
    controls.domElement.dataset.effectiveInteractionMode = temporaryShiftPan
      ? 'shift-pan'
      : interactionMode;
    controls.domElement.dataset.interactionModeSource = interactionMode === 'pan'
      ? 'toolbar-toggle'
      : 'default';
    controls.domElement.dataset.keyboardEnabled = 'true';
    controls.domElement.dataset.keyboardMode = 'always-on';
  }, [interactionMode, mapData?.geometry, shiftPanArmed]);

  useEffect(() => {
    const canvas = controlsRef.current?.domElement;
    const enabled = Boolean(
      robotControlEnabled
      && robotDescriptor
      && robotLoadState?.status === 'loaded',
    );
    if (enabled && chassisDragModeRef.current) {
      chassisDragInteractionRef.current?.exit?.('robot-keyboard-control');
    }
    robotControlEnabledRef.current = enabled;
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();
    setShiftPanArmed(false);
    if (!canvas) return;
    canvas.dataset.robotControlEnabled = enabled ? 'true' : 'false';
    canvas.dataset.robotControlAvailable =
      robotDescriptor && robotLoadState?.status === 'loaded' ? 'true' : 'false';
    canvas.dataset.keyboardControlOwner = enabled ? 'robot' : 'camera';
    canvas.dataset.shiftPanArmed = 'false';
    canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
  }, [mapData?.geometry, robotControlEnabled, robotDescriptor, robotLoadState?.status]);

  useEffect(() => {
    const locked = Boolean(robotHeightLocked && robotDescriptor);
    robotHeightLockedRef.current = locked;
    if (locked) {
      ROBOT_VERTICAL_CONTROL_CODES.forEach((code) => {
        pressedKeysRef.current.delete(code);
        keyboardImpulseRef.current.delete(code);
      });
    }
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.robotHeightLocked = locked ? 'true' : 'false';
  }, [mapData?.geometry, robotDescriptor, robotHeightLocked]);

  useEffect(() => {
    const canvas = controlsRef.current?.domElement;
    const active = Boolean(robotTrajectoryActive);
    if (active) {
      chassisDragInteractionRef.current?.exit?.('teaching-trajectory-playback');
      endEffectorInteractionRef.current?.exit?.();
      robotControlEnabledRef.current = false;
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      setShiftPanArmed(false);
    }
    if (canvas) {
      canvas.dataset.robotTrajectoryActive = active ? 'true' : 'false';
      if (active) canvas.dataset.keyboardControlOwner = 'camera';
    }
  }, [mapData?.geometry, robotTrajectoryActive]);

  useEffect(() => {
    if (!mapData?.geometry) return undefined;
    const resetKeys = (updateUi = true) => {
      const hadRobotInput = [...ROBOT_CONTROL_CODES].some(
        (code) => pressedKeysRef.current.has(code),
      );
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      if (hadRobotInput && robotControlEnabledRef.current) {
        robotPoseActionsRef.current?.publish?.(true);
      }
      if (updateUi) setShiftPanArmed(false);
      const canvas = controlsRef.current?.domElement;
      if (canvas) {
        canvas.dataset.shiftPanArmed = 'false';
        canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
      }
    };
    const onKeyDown = (event) => {
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
      if (event.code === 'Escape' && chassisDragModeRef.current) {
        event.preventDefault();
        chassisDragInteractionRef.current?.exit?.('escape');
        return;
      }
      const code = movementCodeForEvent(event);
      if (!code) return;
      const isActionKey = code !== 'ShiftLeft' && code !== 'ShiftRight';
      if (isActionKey) event.preventDefault();
      pressedKeysRef.current.add(code);
      if (!event.repeat && isActionKey) keyboardImpulseRef.current.add(code);
      const canvas = controlsRef.current?.domElement;
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        setShiftPanArmed(true);
        if (canvas) {
          canvas.dataset.shiftPanArmed = 'true';
          canvas.dataset.effectiveInteractionMode = 'shift-pan';
        }
        pointerInteractionRef.current?.activateShiftPan?.();
      }
      if (canvas && isActionKey) {
        const robotOwnsKey =
          robotControlEnabledRef.current
          && ROBOT_CONTROL_CODES.has(code)
          && robotLayerRef.current?.children.length > 0;
        canvas.dataset.lastKeyboardKey = code.startsWith('Key') ? code.slice(3) : code;
        canvas.dataset.keyboardControlOwner = robotOwnsKey ? 'robot' : 'camera';
        if (robotOwnsKey) {
          const heightChangeBlocked =
            robotHeightLockedRef.current
            && ROBOT_VERTICAL_CONTROL_CODES.has(code);
          if (heightChangeBlocked) {
            pressedKeysRef.current.delete(code);
            keyboardImpulseRef.current.delete(code);
            canvas.dataset.lastRobotAction = 'z-locked';
            canvas.dataset.lastRobotBlockedAction = ROBOT_CONTROL_ACTIONS[code];
            if (!event.repeat) {
              canvas.dataset.robotHeightLockBlockedCount = String(
                Number(canvas.dataset.robotHeightLockBlockedCount || 0) + 1,
              );
            }
          } else {
            canvas.dataset.lastRobotAction = ROBOT_CONTROL_ACTIONS[code];
          }
        } else if (KEYBOARD_ROTATION_ACTIONS[code]) {
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
      if (robotControlEnabledRef.current && ROBOT_CONTROL_CODES.has(code)) {
        robotPoseActionsRef.current?.publish?.(true);
      }
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        const shiftStillPressed =
          pressedKeysRef.current.has('ShiftLeft')
          || pressedKeysRef.current.has('ShiftRight');
        const temporaryShiftPan = shiftStillPressed;
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
    const group = visionCoverageGroupRef.current;
    const displayGeometry = displayGeometryRef.current;
    const sourcePosition = mapData?.geometry?.getAttribute('position');
    if (!group || !displayGeometry || !sourcePosition) return undefined;
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      disposeObject(child);
    }

    const canvas = controlsRef.current?.domElement;
    const independent = teachingSpaceMode === 'independent';
    const records = independent
      ? visionCoveragePlaybackSelection.records
      : [];
    const preparedFrames = prepareTeachingVisionCoverageFrames(records);
    disposeTeachingSurfaceProjectionOverlay(surfaceCoverageProjectionRef.current);
    surfaceCoverageProjectionRef.current = null;
    const surfaceProjection = independent
      ? createTeachingSurfaceProjectionOverlay(
          surfaceGeometryRef.current?.geometry,
          preparedFrames,
          {
            color: 0x2df098,
            opacity: teachingSurfaceTintOpacityRef.current,
          },
        )
      : null;
    if (surfaceProjection && sceneRef.current) {
      surfaceProjection.mesh.visible = visionCoverageRenderingEnabledRef.current;
      sceneRef.current.add(surfaceProjection.mesh);
      surfaceCoverageProjectionRef.current = surfaceProjection;
    }
    const clearSurfaceProjection = () => {
      if (surfaceCoverageProjectionRef.current === surfaceProjection) {
        surfaceCoverageProjectionRef.current = null;
      }
      disposeTeachingSurfaceProjectionOverlay(surfaceProjection);
    };
    const poseIds = new Set();
    let frameCount = 0;
    let opticalPointCount = 0;
    let coordinateFrameCount = 0;
    let coordinateAxisCount = 0;
    let cellCount = 0;
    let hitCellCount = 0;
    let renderCellCount = 0;
    let omittedCellCount = 0;
    let minimumDepth = Number.POSITIVE_INFINITY;
    let maximumDepth = Number.NEGATIVE_INFINITY;

    preparedFrames.forEach((preparedFrame) => {
      const { record, grid } = preparedFrame;
      const volume = createTeachingVisionCoverageVolume(record, { grid });
      if (!volume) return;
      const coverage = volume.userData.coverage || {};
      group.add(volume);
      frameCount += 1;
      opticalPointCount += Number(coverage.opticalPointCount) || 0;
      coordinateFrameCount += Number(coverage.coordinateFrameCount) || 0;
      coordinateAxisCount += Number(coverage.coordinateAxisCount) || 0;
      cellCount += Number(coverage.sampleCellCount)
        || (Number(coverage.columns) || 0) * (Number(coverage.rows) || 0);
      hitCellCount += Number(coverage.surfaceCellCount) || 0;
      renderCellCount += Number(coverage.renderCellCount) || 0;
      omittedCellCount += Number(coverage.rangeLimitedCellCount) || 0;
      if (record.poseId) poseIds.add(record.poseId);
      if (Number.isFinite(coverage.minimumDepth)) {
        minimumDepth = Math.min(minimumDepth, coverage.minimumDepth);
      }
      if (Number.isFinite(coverage.maximumDepth)) {
        maximumDepth = Math.max(maximumDepth, coverage.maximumDepth);
      }
    });

    const nextStats = {
      poseCount: poseIds.size,
      frameCount,
      opticalPointCount,
      coordinateFrameCount,
      coordinateAxisCount,
      cellCount,
      hitCellCount,
      renderCellCount,
      omittedCellCount,
      minimumDepth: Number.isFinite(minimumDepth) ? minimumDepth : null,
      maximumDepth: Number.isFinite(maximumDepth) ? maximumDepth : null,
    };
    setVisionCoverageStats((current) => (
      current.poseCount === nextStats.poseCount
      && current.frameCount === nextStats.frameCount
      && current.opticalPointCount === nextStats.opticalPointCount
      && current.coordinateFrameCount === nextStats.coordinateFrameCount
      && current.coordinateAxisCount === nextStats.coordinateAxisCount
      && current.cellCount === nextStats.cellCount
      && current.hitCellCount === nextStats.hitCellCount
      && current.renderCellCount === nextStats.renderCellCount
      && current.omittedCellCount === nextStats.omittedCellCount
      && current.minimumDepth === nextStats.minimumDepth
      && current.maximumDepth === nextStats.maximumDepth
        ? current
        : nextStats
    ));

    const opticalPoseSignature = preparedFrames.map(({ record }) => {
      const opticalPose = record?.frame?.opticalPose;
      const components = [
        opticalPose?.position?.x,
        opticalPose?.position?.y,
        opticalPose?.position?.z,
        opticalPose?.quaternion?.x,
        opticalPose?.quaternion?.y,
        opticalPose?.quaternion?.z,
        opticalPose?.quaternion?.w,
      ].map((value, index) => {
        const numericValue = Number(value);
        const fallback = index === 6 ? 1 : 0;
        return (Number.isFinite(numericValue) ? numericValue : fallback).toFixed(8);
      });
      return `${record?.key || record?.side || 'camera'}:${components.join(',')}`;
    }).join('|');

    if (canvas) {
      const waitingForPlaybackPose = Boolean(
        visionCoveragePlaybackSelection.progressive
        && visionCoveragePlaybackSelection.availableFrameCount > 0
        && !frameCount,
      );
      canvas.dataset.visionCoverageState = frameCount
        ? 'visible'
        : independent
          ? waitingForPlaybackPose ? 'waiting' : 'empty'
          : 'hidden';
      canvas.dataset.visionCoverageMode = VISION_COVERAGE_MODE;
      canvas.dataset.visionCoverageSurfaceStop = VISION_COVERAGE_SURFACE_STOP;
      canvas.dataset.visionCoverageEmptyCellMode = VISION_COVERAGE_EMPTY_CELL_MODE;
      canvas.dataset.visionCoverageVisualMode = 'continuous-volume';
      canvas.dataset.visionCoverageOutlineMode = 'outer-silhouette';
      canvas.dataset.visionCoverageInternalRays = 'false';
      canvas.dataset.visionCoverageIndependentOnly = 'true';
      canvas.dataset.visionCoverageInfinite = 'false';
      canvas.dataset.visionCoveragePoseCount = String(nextStats.poseCount);
      canvas.dataset.visionCoverageFrameCount = String(frameCount);
      canvas.dataset.visionCoverageOpticalPointCount = String(opticalPointCount);
      canvas.dataset.visionCoverageCoordinateFrameCount = String(coordinateFrameCount);
      canvas.dataset.visionCoverageCoordinateAxisCount = String(coordinateAxisCount);
      canvas.dataset.visionCoverageRetentionMode = 'captured-pose-static';
      canvas.dataset.visionCoverageOpticalPoseSignature = opticalPoseSignature;
      canvas.dataset.visionCoverageCellCount = String(cellCount);
      canvas.dataset.visionCoverageHitCellCount = String(hitCellCount);
      canvas.dataset.visionCoverageRenderCellCount = String(renderCellCount);
      canvas.dataset.visionCoverageOmittedCellCount = String(omittedCellCount);
      canvas.dataset.visionCoverageMinimumDepth = nextStats.minimumDepth?.toFixed(6) || '';
      canvas.dataset.visionCoverageMaximumDepth = nextStats.maximumDepth?.toFixed(6) || '';
      canvas.dataset.visionCoverageGenerationMode = visionCoveragePlaybackSelection.mode;
      canvas.dataset.visionCoveragePlaybackTask = visionCoveragePlaybackSelection.taskId;
      canvas.dataset.visionCoverageAvailablePoseCount = String(
        visionCoveragePlaybackSelection.availablePoseCount,
      );
      canvas.dataset.visionCoverageAvailableFrameCount = String(
        visionCoveragePlaybackSelection.availableFrameCount,
      );
      canvas.dataset.visionCoverageReachedPoseCount = String(
        visionCoveragePlaybackSelection.reachedPoseCount,
      );
      canvas.dataset.visionCoveragePlaybackPoseCount = String(
        visionCoveragePlaybackSelection.playbackPoseCount,
      );
    }

    const coverageAttributes = [...new Set([
      displayGeometry.getAttribute(TEACHING_SURFACE_COVERAGE_ATTRIBUTE),
      surfaceGeometryRef.current?.geometry?.getAttribute(
        TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
      ),
    ].filter(Boolean))];
    const commitSurfaceMask = (mask) => {
      coverageAttributes.forEach((attribute) => {
        if (attribute.array.length !== mask.length) return;
        attribute.array.set(mask);
        attribute.needsUpdate = true;
      });
    };
    const updateSurfaceTintStats = (nextTintStats) => {
      setTeachingSurfaceTintStats((current) => (
        current.status === nextTintStats.status
        && current.coveredPointCount === nextTintStats.coveredPointCount
        && current.totalPointCount === nextTintStats.totalPointCount
          ? current
          : nextTintStats
      ));
      if (!canvas) return;
      canvas.dataset.teachingSurfaceTintState = nextTintStats.status;
      canvas.dataset.teachingSurfaceTintCoveredPointCount = String(
        nextTintStats.coveredPointCount,
      );
      canvas.dataset.teachingSurfaceTintTotalPointCount = String(
        nextTintStats.totalPointCount,
      );
      canvas.dataset.teachingSurfaceTintOverlapMode = 'binary-union';
      canvas.dataset.teachingSurfaceTintMaximumWeight = '1';
      canvas.dataset.teachingSurfaceTintCameraIsolation = 'main-view-only';
      canvas.dataset.teachingSurfaceTintProjectionMode = TEACHING_SURFACE_PROJECTION_MODE;
      canvas.dataset.teachingSurfaceTintRasterization = surfaceProjection
        ? 'per-fragment-depth-atlas+vertex-points'
        : 'vertex-points';
      canvas.dataset.teachingSurfaceTintMeshProjection = surfaceProjection
        ? 'active'
        : 'unavailable';
      canvas.dataset.teachingSurfaceTintColor = '#2df098';
      canvas.dataset.teachingSurfaceTintOpacity = String(
        teachingSurfaceTintOpacityRef.current,
      );
    };

    const totalPointCount = sourcePosition.count;
    if (!independent || !preparedFrames.length || !coverageAttributes.length) {
      commitSurfaceMask(new Float32Array(totalPointCount));
      updateSurfaceTintStats({
        status: independent ? 'empty' : 'hidden',
        coveredPointCount: 0,
        totalPointCount,
      });
      if (canvas) canvas.dataset.teachingSurfaceTintProgress = '1';
      return clearSurfaceProjection;
    }

    let cancelled = false;
    let scheduledWork = null;
    let cursor = 0;
    let coveredPointCount = 0;
    const mask = new Float32Array(totalPointCount);
    const surfaceTintChunkSize = Math.max(
      2_000,
      Math.floor(
        TEACHING_SURFACE_TINT_CHUNK_SIZE
        / Math.max(1, preparedFrames.length / 2),
      ),
    );
    updateSurfaceTintStats({
      status: 'computing',
      coveredPointCount: 0,
      totalPointCount,
    });
    if (canvas) canvas.dataset.teachingSurfaceTintProgress = '0';

    const cancelScheduledWork = () => {
      if (!scheduledWork) return;
      if (scheduledWork.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scheduledWork.id);
      } else {
        window.cancelAnimationFrame(scheduledWork.id);
      }
      scheduledWork = null;
    };
    const scheduleWork = (callback) => {
      if (typeof window.requestIdleCallback === 'function') {
        scheduledWork = {
          type: 'idle',
          id: window.requestIdleCallback(callback, { timeout: 80 }),
        };
      } else {
        scheduledWork = {
          type: 'frame',
          id: window.requestAnimationFrame(() => callback({
            didTimeout: true,
            timeRemaining: () => 0,
          })),
        };
      }
    };
    const processSurfaceTintChunk = (deadline) => {
      scheduledWork = null;
      if (cancelled) return;
      const startedAt = performance.now();
      do {
        const nextCursor = Math.min(
          totalPointCount,
          cursor + surfaceTintChunkSize,
        );
        coveredPointCount += markTeachingSurfaceCoverageRange(
          sourcePosition,
          preparedFrames,
          mask,
          cursor,
          nextCursor,
        );
        cursor = nextCursor;
      } while (
        cursor < totalPointCount
        && deadline?.timeRemaining?.() > 3
        && performance.now() - startedAt < 12
      );

      if (canvas) {
        canvas.dataset.teachingSurfaceTintProgress = String(
          totalPointCount ? cursor / totalPointCount : 1,
        );
      }
      if (cursor < totalPointCount) {
        scheduleWork(processSurfaceTintChunk);
        return;
      }

      commitSurfaceMask(mask);
      updateSurfaceTintStats({
        status: coveredPointCount || surfaceProjection ? 'visible' : 'empty',
        coveredPointCount,
        totalPointCount,
      });
      if (canvas) canvas.dataset.teachingSurfaceTintProgress = '1';
    };
    scheduleWork(processSurfaceTintChunk);

    return () => {
      cancelled = true;
      cancelScheduledWork();
      clearSurfaceProjection();
    };
  }, [mapData?.geometry, teachingSpaceMode, visionCoveragePlaybackSelection]);

  useEffect(() => {
    const enabled = visionCoverageRenderingEnabled;
    const group = visionCoverageGroupRef.current;
    const surfaceProjection = surfaceCoverageProjectionRef.current;
    const canvas = controlsRef.current?.domElement;
    const tintOpacity = THREE.MathUtils.clamp(teachingSurfaceTintOpacity, 0, 1);

    if (group) group.visible = enabled;
    if (surfaceProjection?.mesh) surfaceProjection.mesh.visible = enabled;
    const projectionOpacityUniform = surfaceProjection?.material
      ?.uniforms?.atlasCoverageOpacity;
    if (projectionOpacityUniform) projectionOpacityUniform.value = tintOpacity;

    [cloudMaterialRef.current, meshMaterialRef.current]
      .filter(Boolean)
      .forEach((material) => {
        material.userData.teachingTintVisibility = enabled ? 1 : 0;
        material.userData.teachingTintOpacity = tintOpacity;
        const visibilityUniform = material.userData.mapColorShader
          ?.uniforms?.atlasTeachingTintVisibility;
        const opacityUniform = material.userData.mapColorShader
          ?.uniforms?.atlasTeachingTintOpacity;
        if (visibilityUniform) visibilityUniform.value = enabled ? 1 : 0;
        if (opacityUniform) opacityUniform.value = tintOpacity;
      });

    if (canvas) {
      const hasFrames = visionCoverageStats.frameCount > 0;
      const waitingForPlaybackPose = Boolean(
        visionCoveragePlaybackSelection.progressive
        && visionCoveragePlaybackSelection.availableFrameCount > 0
        && !hasFrames,
      );
      canvas.dataset.visionCoverageRenderEnabled = enabled ? 'true' : 'false';
      canvas.dataset.visionCoverageRenderState = enabled ? 'enabled' : 'disabled';
      canvas.dataset.teachingSurfaceTintRenderEnabled = enabled ? 'true' : 'false';
      canvas.dataset.teachingSurfaceTintOpacity = String(tintOpacity);
      canvas.dataset.teachingSurfaceTintOpacityPercent = String(
        Math.round(tintOpacity * 100),
      );
      canvas.dataset.visionCoveragePlaybackStatus = visionCoveragePlaybackSelection.progressive
        ? visionCoveragePlaybackStatus
        : 'idle';
      canvas.dataset.visionCoverageState = teachingSpaceMode === 'independent'
        ? hasFrames
          ? enabled ? 'visible' : 'disabled'
          : waitingForPlaybackPose
            ? enabled ? 'waiting' : 'disabled'
            : 'empty'
        : 'hidden';
    }
  }, [
    mapData?.geometry,
    teachingSpaceMode,
    visionCoveragePlaybackSelection,
    visionCoveragePlaybackStatus,
    visionCoverageRenderingEnabled,
    visionCoverageStats.frameCount,
    teachingSurfaceTintOpacity,
  ]);

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
      canvas.dataset.waypointHitRadiusScale = WAYPOINT_HIT_RADIUS_SCALE.toFixed(6);
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
        Math.max(routeScale * WAYPOINT_HIT_RADIUS_SCALE, routeScale * 0.9),
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

  const focusRobot = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const robot = robotLayerRef.current;
    if (!controls || !camera || !robot?.children.length) return;
    const sphere = new THREE.Box3().setFromObject(robot).getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
    precisionPanRef.current?.clear?.();
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(-0.55, -0.8, 0.42);
    direction.normalize();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2.85);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.update();
  };

  const toggleRobotControl = () => {
    if (robotTrajectoryActiveRef.current) return;
    if (robotLoadState?.status !== 'loaded' || !robotDescriptor) return;
    const enabled = !robotControlEnabledRef.current;
    if (enabled && chassisDragModeRef.current) {
      chassisDragInteractionRef.current?.exit?.('robot-keyboard-control');
    }
    if (enabled && endEffectorControlRef.current) {
      endEffectorInteractionRef.current?.exit?.();
    }
    robotControlEnabledRef.current = enabled;
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();
    setShiftPanArmed(false);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.robotControlEnabled = enabled ? 'true' : 'false';
      canvas.dataset.keyboardControlOwner = enabled ? 'robot' : 'camera';
      canvas.dataset.shiftPanArmed = 'false';
      canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
      canvas.focus({ preventScroll: true });
    }
    onRobotControlChangeRef.current?.(enabled);
  };

  const toggleInteractionMode = () => {
    const nextMode = interactionModeRef.current === 'pan' ? 'rotate' : 'pan';
    if (nextMode === 'pan' && chassisDragModeRef.current) {
      chassisDragInteractionRef.current?.exit?.('viewport-pan-mode');
    }
    interactionModeRef.current = nextMode;
    setInteractionMode(nextMode);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.interactionMode = nextMode;
      canvas.dataset.interactionModeSource = nextMode === 'pan'
        ? 'toolbar-toggle'
        : 'default';
      canvas.dataset.effectiveInteractionMode = shiftPanArmed ? 'shift-pan' : nextMode;
      canvas.dataset.lastInteractionModeAction = `toolbar:${nextMode}`;
      canvas.focus({ preventScroll: true });
    }
  };

  const resetView = () => viewActionsRef.current?.reset?.();
  const robotControlActive = Boolean(
    robotControlEnabled
    && robotDescriptor
    && robotLoadState?.status === 'loaded',
  );
  const robotHeightLockActive = Boolean(
    robotHeightLocked
    && robotDescriptor
    && robotLoadState?.status === 'loaded'
  );
  const displayedRobotPose = normalizeRobotPose(robotPose);
  const robotParkingGhostVisible = Boolean(
    robotParkingGhost
    && robotDescriptor
    && robotLoadState?.status === 'loaded',
  );
  const robotParkingGhostMetrics = robotParkingGhostVisible
    ? measureRobotParkingGhost(displayedRobotPose, robotParkingGhost.targetPose)
    : null;
  const endEffectorControlActive = Boolean(endEffectorControl);
  const mapLockedSides = ['left', 'right'].filter(
    (side) => endEffectorLockModesState[side] === 'map',
  );
  const mapLockSideLabel = mapLockedSides
    .map((side) => side === 'left' ? 'L' : 'R')
    .join('+');
  const persistentPanMode = interactionMode === 'pan';
  const temporaryShiftPan = shiftPanArmed && !persistentPanMode;
  const effectiveViewportPan = persistentPanMode || shiftPanArmed;
  const collisionStatusState = robotCollisionStatus?.state || 'disabled';
  const collisionDistanceMillimeters = Number.isFinite(robotCollisionStatus?.minimumDistance)
    ? Math.max(0, robotCollisionStatus.minimumDistance * 1000)
    : null;
  const collisionControlReady = Boolean(
    robotDescriptor && robotLoadState?.status === 'loaded',
  );
  const collisionButtonState = collisionProtectionEnabled
    ? collisionStatusState
    : 'disabled';
  const collisionButtonLabel = collisionProtectionEnabled
    ? {
        building: '建立索引',
        waiting: '等待检测',
        safe: '保护开启',
        near: '距离过近',
        collision: '环境干涉',
        error: '检测异常',
      }[collisionStatusState] || '保护开启'
    : '碰撞保护';
  const progressiveCoveragePlayback = visionCoveragePlaybackSelection.progressive;
  const progressiveReachedPoseCount = Math.min(
    visionCoveragePlaybackSelection.playbackPoseCount,
    visionCoveragePlaybackReachedPoseIds.length,
  );
  const showVisionCoverageReadout = teachingSpaceMode === 'independent' && (
    visionCoverageStats.frameCount > 0
    || (
      progressiveCoveragePlayback
      && visionCoveragePlaybackSelection.availableFrameCount > 0
    )
  );

  return (
    <div
      className={`point-cloud-view ${shiftPanArmed ? 'is-shift-pan-armed' : ''} ${effectiveViewportPan ? 'is-viewport-pan-mode' : ''} ${persistentPanMode ? 'is-persistent-pan-mode' : ''} ${robotControlActive ? 'is-robot-driving' : ''} ${endEffectorControlActive ? 'is-end-effector-control' : ''} ${chassisDragMode ? 'is-chassis-drag-mode' : ''} ${chassisDragging ? 'is-chassis-dragging' : ''} ${robotTrajectoryActive ? 'is-teaching-trajectory-active' : ''} ${robotParkingGhostVisible ? 'is-parking-ghost-visible' : ''} ${visionCoverageRenderingEnabled && visionCoverageStats.frameCount ? 'is-vision-coverage-active' : ''} ${visionCoverageRenderingEnabled && teachingSurfaceTintStats.status === 'visible' ? 'is-teaching-surface-tinted' : ''}`}
      ref={mountRef}
      data-robot-trajectory-active={robotTrajectoryActive ? 'true' : 'false'}
      data-parking-ghost-state={robotParkingGhostVisible ? 'visible' : 'hidden'}
      data-parking-ghost-target={robotParkingGhost?.parkingPointId || ''}
      data-parking-ghost-planar-distance={robotParkingGhostMetrics?.planarDistance.toFixed(6) || ''}
      data-parking-ghost-straight-distance={robotParkingGhostMetrics?.straightDistance.toFixed(6) || ''}
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
          <div
            ref={spaceMouseAxisHudRef}
            className="spacemouse-axis-hud"
            data-axis="x"
            data-state="hidden"
            aria-label="SpaceMouse 当前控制轴"
            aria-hidden="true"
          >
            <small data-axis-group>XYZ / SINGLE AXIS</small>
            <strong data-axis-code>X</strong>
            <span data-axis-label>前进 / 后退</span>
          </div>
          {collisionProtectionEnabled && (
            <div
              className={`robot-collision-alert is-${collisionStatusState}`}
              role={['collision', 'near', 'error'].includes(collisionStatusState) ? 'alert' : 'status'}
              aria-live="polite"
              data-collision-state={collisionStatusState}
              data-collision-distance={collisionDistanceMillimeters ?? ''}
            >
              <span className="robot-collision-alert__icon">
                {collisionStatusState === 'safe'
                  ? <ShieldCheck size={16} />
                  : <ShieldAlert size={16} />}
              </span>
              <div>
                <small>NON-CHASSIS / ENV CLEARANCE</small>
                <strong>{robotCollisionStatus.message}</strong>
                <em>{robotCollisionStatus.detail}</em>
              </div>
              <b>
                {collisionDistanceMillimeters !== null
                  ? `${collisionDistanceMillimeters.toFixed(0)} mm`
                  : collisionStatusState === 'safe' ? '≥100 mm' : '100 mm'}
              </b>
            </div>
          )}
          {robotParkingGhostVisible && robotParkingGhostMetrics && (
            <aside
              className={`robot-parking-ghost-readout ${collisionProtectionEnabled ? 'has-collision-readout' : ''}`}
              role="status"
              aria-live="polite"
              aria-label="停车点机器人虚影"
              data-parking-point-id={robotParkingGhost.parkingPointId}
              data-frozen-joint-count={Object.keys(robotParkingGhost.jointValues || {}).length}
            >
              <span className="robot-parking-ghost-readout__mark" aria-hidden="true">
                <Bot size={16} />
                <MapPin size={10} />
              </span>
              <div className="robot-parking-ghost-readout__body">
                <small>ROBOT GHOST · MAP COMPARISON</small>
                <strong>
                  <span>{robotParkingGhost.sourceName || '当前机器人'}</span>
                  <i>→</i>
                  <span>{robotParkingGhost.parkingPointName || '目标停车点'}</span>
                </strong>
                <div className="robot-parking-ghost-readout__metrics">
                  <span><Ruler size={10} /><small>XY 平面</small><b>{robotParkingGhostMetrics.planarDistance.toFixed(2)} m</b></span>
                  <span><small>3D 直线</small><b>{robotParkingGhostMetrics.straightDistance.toFixed(2)} m</b></span>
                  <span><small>ΔZ</small><b>{robotParkingGhostMetrics.deltaZ >= 0 ? '+' : ''}{robotParkingGhostMetrics.deltaZ.toFixed(2)} m</b></span>
                </div>
                <em>{Object.keys(robotParkingGhost.jointValues || {}).length} JOINTS FROZEN · 虚影不改变当前机器人</em>
              </div>
              <button
                type="button"
                aria-label="清除停车点机器人虚影"
                title="移除停车点机器人虚影与距离连线"
                onClick={() => onClearRobotParkingGhost?.()}
              >
                <X size={12} />
              </button>
            </aside>
          )}
          <div className="viewer-top-tools">
            <div className="viewer-tool-switch" role="toolbar" aria-label="三维视图工具">
              <button
                type="button"
                className={`viewer-interaction-mode is-active ${temporaryShiftPan ? 'is-temporary' : ''} ${persistentPanMode ? 'is-pan-mode' : ''}`}
                aria-label={temporaryShiftPan ? 'Shift 临时平移' : persistentPanMode ? '平移' : '旋转'}
                aria-pressed="true"
                aria-keyshortcuts="Shift"
                data-base-mode={interactionMode}
                data-mode={shiftPanArmed ? 'shift-pan' : interactionMode}
                data-switchable="true"
                onClick={toggleInteractionMode}
                title={temporaryShiftPan
                  ? 'Shift 已按下：左键拖拽临时平移，松开后恢复旋转'
                  : persistentPanMode
                    ? '平移模式：左键拖拽平移；点击切换为旋转'
                    : '旋转模式：左键拖拽旋转；点击切换为平移；按住 Shift 临时平移'}
              >
                {effectiveViewportPan ? <Move3D size={13} /> : <Rotate3D size={13} />}
                {temporaryShiftPan ? 'Shift 平移' : persistentPanMode ? '平移' : '旋转'}
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
              {robotLoadState?.status === 'loaded' && (
                <>
                  <button
                    type="button"
                    className={`robot-control-toggle ${robotControlActive ? 'is-active' : ''}`}
                    disabled={robotTrajectoryActive}
                    onClick={() => {
                      focusRobot();
                      toggleRobotControl();
                    }}
                    aria-label="定位机器人模型"
                    aria-pressed={robotControlActive}
                    title={
                      robotTrajectoryActive
                        ? '示教轨迹播放期间由规划器接管机器人，暂停或停止后可恢复手动控制'
                        : endEffectorControlActive
                        ? '退出机械臂末端控制，定位机器人并启用麦轮底盘控制'
                        : robotControlActive
                          ? '底盘控制已启用；再次点击将键盘交还相机'
                          : '定位机器人并启用麦轮底盘控制：W/S 前后、A/D 横移、←/→ 旋转、↑/↓ 微调底盘高度'
                    }
                  >
                    <Bot size={13} /> 机器人
                  </button>
                  <button
                    type="button"
                    className={`robot-height-lock-toggle ${robotHeightLockActive ? 'is-active' : ''}`}
                    aria-label={robotHeightLockActive ? '解锁机器人高度' : '锁定机器人高度'}
                    aria-pressed={robotHeightLockActive}
                    data-height-lock-state={robotHeightLockActive ? 'locked' : 'unlocked'}
                    title={robotHeightLockActive
                      ? `机器人 Z=${displayedRobotPose.position.z.toFixed(3)} m 已锁定；点击后允许 ↑/↓ 调整`
                      : '锁定当前机器人 Z 高度，避免之后误触 ↑/↓ 改变底盘高度'}
                    onClick={() => onRobotHeightLockChange?.(!robotHeightLockActive)}
                  >
                    {robotHeightLockActive ? <Lock size={12} /> : <Unlock size={12} />}
                    {robotHeightLockActive ? '高度已锁' : '锁定高度'}
                  </button>
                  <button
                    type="button"
                    className="robot-pose-reset"
                    aria-label="复位机器人关节姿态"
                    data-resettable-joint-count={robotLoadState?.movableJoints?.length || 0}
                    disabled={
                      robotTrajectoryActive
                      || !robotLoadState?.movableJoints?.length
                    }
                    title={robotTrajectoryActive
                      ? '示教轨迹播放期间由规划器接管机器人，停止后可复位姿态'
                      : robotLoadState?.movableJoints?.length
                        ? '将全部可动关节恢复为初始角度，不改变机器人底盘位置与朝向'
                        : '当前机器人模型没有可复位的关节'}
                    onClick={() => onResetRobotJointPose?.()}
                  >
                    <RotateCcw size={12} /> 姿态复位
                  </button>
                </>
              )}
              <button
                type="button"
                className={`collision-protection-toggle is-${collisionButtonState} ${collisionProtectionEnabled ? 'is-active' : ''}`}
                aria-label={collisionProtectionEnabled ? '关闭碰撞保护' : '开启碰撞保护'}
                aria-pressed={collisionProtectionEnabled}
                data-collision-control-state={collisionButtonState}
                disabled={!collisionProtectionEnabled && !collisionControlReady}
                onClick={() => onCollisionProtectionChange?.(!collisionProtectionEnabled)}
                title={!collisionControlReady && !collisionProtectionEnabled
                  ? '请先加载机器人；模型装配完成后即可开启碰撞保护'
                  : collisionProtectionEnabled
                    ? '关闭碰撞保护并释放环境空间索引'
                    : '开启非底盘结构的环境干涉与 10 cm 安全距离检测'}
              >
                {collisionProtectionEnabled && collisionStatusState === 'safe'
                  ? <ShieldCheck size={13} />
                  : <ShieldAlert size={13} />}
                {collisionButtonLabel}
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
                !hasManualResolution
                  ? `自动档会在源点数超过 ${AUTO_POINT_BUDGET.toLocaleString('zh-CN')} 时选择合适密度；可用下拉框手动覆盖`
                  : '仅调整 3D 显示采样，不改变 2D 截面和导航数据'
              }
            >
              <label
                className={`mesh-quality-control point-density-control tone-${resolution.tone} ${!hasManualResolution ? 'is-auto' : ''}`}
                title={`${hasManualResolution ? '手动' : '自动'}档：当前渲染 ${renderedPointCount.toLocaleString('zh-CN')} / ${renderablePointCount.toLocaleString('zh-CN')} 个点`}
              >
                <Gauge size={13} />
                <span>
                  <small>POINT DENSITY</small>
                  <select
                    aria-label="点云显示密度"
                    value={hasManualResolution ? String(resolutionIndex) : 'auto'}
                    onChange={(event) => chooseResolutionMode(event.target.value)}
                  >
                    <option value="auto">
                      自动 · {suggestedResolution.label} {Math.round(suggestedResolution.ratio * 100)}%（推荐）
                    </option>
                    {RESOLUTION_LEVELS.map((option, index) => (
                      <option key={option.ratio} value={index}>
                        {option.label} · {Math.round(option.ratio * 100)}%
                      </option>
                    ))}
                  </select>
                </span>
                <em>{Math.round(resolution.ratio * 100)}% · {formatPointCount(renderedPointCount)} PTS</em>
              </label>
              {hasEmbeddedMesh && (
                <div
                  className="mesh-topology-readout"
                  role="status"
                  aria-label={`PLY 内嵌网格 ${meshInfo.faceCount.toLocaleString('zh-CN')} 个三角面，另有 ${renderablePointCount.toLocaleString('zh-CN')} 个未成面点`}
                  title="PLY 自带 face 索引：成面区域以实体网格显示，未被引用的顶点继续显示为点云"
                >
                  <Box size={13} />
                  <span><small>PLY MESH</small><strong>{formatPointCount(meshInfo.faceCount)} TRI</strong></span>
                </div>
              )}
              {hasEmbeddedMesh && (
                <label
                  className={`mesh-quality-control tone-${meshQualityPlan.effectiveId}`}
                  title={`${meshQualityPlan.requestedLabel}：当前渲染 ${meshQualityPlan.renderedFaceCount.toLocaleString('zh-CN')} / ${meshQualityPlan.faceCount.toLocaleString('zh-CN')} 个三角面`}
                >
                  <Gauge size={13} />
                  <span>
                    <small>MESH QUALITY</small>
                    <select
                      aria-label="网格渲染质量"
                      value={meshQualityPlan.requestedId}
                      onChange={(event) => onMeshRenderQualityChange?.(event.target.value)}
                    >
                      {MESH_RENDER_QUALITY_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}{option.id === 'auto' ? '（推荐）' : ''}
                        </option>
                      ))}
                    </select>
                  </span>
                  <em>{formatPointCount(meshQualityPlan.renderedFaceCount)} TRI</em>
                </label>
              )}
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
          {showVisionCoverageReadout && (
            <aside
              className={`vision-coverage-readout ${visionCoverageRenderingEnabled ? 'is-rendering' : 'is-paused'} ${progressiveCoveragePlayback ? 'is-progressive' : ''}`}
              role="group"
              aria-label="独立示教相机视觉覆盖范围"
              data-projection-rendering={visionCoverageRenderingEnabled ? 'enabled' : 'disabled'}
              data-generation-mode={visionCoveragePlaybackSelection.mode}
              data-playback-status={progressiveCoveragePlayback
                ? visionCoveragePlaybackStatus
                : 'idle'}
              data-playback-reached-pose-count={progressiveReachedPoseCount}
              data-playback-pose-count={visionCoveragePlaybackSelection.playbackPoseCount}
              data-available-frame-count={visionCoveragePlaybackSelection.availableFrameCount}
              data-coverage-pose-count={visionCoverageStats.poseCount}
              data-coverage-frame-count={visionCoverageStats.frameCount}
              data-coverage-optical-point-count={visionCoverageStats.opticalPointCount}
              data-coverage-coordinate-frame-count={visionCoverageStats.coordinateFrameCount}
              data-coverage-coordinate-axis-count={visionCoverageStats.coordinateAxisCount}
              data-coverage-cell-count={visionCoverageStats.cellCount}
              data-surface-tint-state={teachingSurfaceTintStats.status}
              data-surface-tint-point-count={teachingSurfaceTintStats.coveredPointCount}
              data-surface-tint-opacity={teachingSurfaceTintOpacity.toFixed(2)}
            >
              <span className="vision-coverage-readout__icon"><Camera size={14} /></span>
              <div className="vision-coverage-readout__copy">
                <small>
                  {progressiveCoveragePlayback
                    ? 'OPTICAL COVERAGE · ARRIVAL REVEAL'
                    : 'OPTICAL COVERAGE · SURFACE UNION'}
                </small>
                <strong>
                  {progressiveCoveragePlayback ? (
                    <>
                      已到达 {progressiveReachedPoseCount}
                      /{visionCoveragePlaybackSelection.playbackPoseCount} 姿态
                      {' · '}{visionCoverageStats.frameCount}
                      /{visionCoveragePlaybackSelection.availableFrameCount} 个视域
                    </>
                  ) : (
                    <>
                      {visionCoverageStats.poseCount} 组姿态 · {visionCoverageStats.frameCount} 个视域
                      {' · '}覆盖采样 {teachingSurfaceTintStats.coveredPointCount}
                    </>
                  )}
                </strong>
                <label className="vision-coverage-readout__opacity">
                  <span>表面透明度</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(teachingSurfaceTintOpacity * 100)}
                    aria-label="表面贴图渲染透明度"
                    aria-valuetext={`${Math.round(teachingSurfaceTintOpacity * 100)}%`}
                    title="调整物体表面绿色覆盖贴图的透明度"
                    style={{
                      '--vision-coverage-opacity': `${Math.round(
                        teachingSurfaceTintOpacity * 100,
                      )}%`,
                    }}
                    onChange={(event) => {
                      const percentage = Math.max(
                        0,
                        Math.min(100, Number(event.target.value) || 0),
                      );
                      setTeachingSurfaceTintOpacity(percentage / 100);
                    }}
                  />
                  <output>{Math.round(teachingSurfaceTintOpacity * 100)}%</output>
                </label>
              </div>
              <div className="vision-coverage-readout__controls">
                <button
                  type="button"
                  className={`vision-coverage-readout__toggle ${visionCoverageRenderingEnabled ? 'is-on' : 'is-off'}`}
                  aria-label={visionCoverageRenderingEnabled ? '关闭投影渲染' : '开启投影渲染'}
                  aria-pressed={visionCoverageRenderingEnabled}
                  title={visionCoverageRenderingEnabled
                    ? '隐藏视域体、光学坐标轴和表面染色'
                    : '显示视域体、光学坐标轴和表面染色'}
                  onClick={() => setVisionCoverageRenderingEnabled((current) => !current)}
                >
                  {visionCoverageRenderingEnabled ? <Eye size={11} /> : <EyeOff size={11} />}
                  <span>投影 {visionCoverageRenderingEnabled ? 'ON' : 'OFF'}</span>
                </button>
                <span className="vision-coverage-readout__sides" aria-hidden="true">
                  <i className="is-left" />
                  <i className="is-right" />
                  <i className="is-surface" />
                </span>
              </div>
            </aside>
          )}
          <EndEffectorControlPanel
            control={endEffectorControl}
            lockModes={endEffectorLockModesState}
            onModeChange={setEndEffectorMode}
            onPoseChange={setEndEffectorPose}
            onReset={resetEndEffectorJoints}
            onToggleBodyLock={toggleBodyEndEffectorLock}
            onToggleMapLock={toggleMapEndEffectorLock}
            onClose={exitEndEffectorControl}
          />
          {robotDescriptor && (
            <div
              className={`robot-model-indicator is-${robotLoadState?.status || 'pending'} ${robotControlActive ? 'is-driving' : ''} ${robotHeightLockActive ? 'is-height-locked' : ''} ${chassisDragMode ? 'is-planar-drag' : ''}`}
              role="status"
              aria-label="机器人模型状态"
            >
              <span><Bot size={14} /></span>
              <div>
                <small>
                  {endEffectorControlActive
                    ? endEffectorControl.locked
                      ? endEffectorControl.lockMode === 'map'
                        ? `${endEffectorControl.side.toUpperCase()} ARM · MAP POSE HOLD`
                        : `${endEffectorControl.side.toUpperCase()} ARM · BODY POSE HOLD`
                      : `${endEffectorControl.side.toUpperCase()} ARM · 6D CONTROL`
                    : chassisDragMode
                      ? chassisDragging
                        ? 'CHASSIS · MOVING ON XY'
                        : 'CHASSIS · XY PLANE DRAG'
                    : robotControlActive
                      ? mapLockedSides.length
                        ? `MECANUM DRIVE · MAP HOLD ${mapLockSideLabel}${robotHeightLockActive ? ' · Z HOLD' : ''}`
                        : `MECANUM DRIVE · ${robotHeightLockActive ? 'Z HOLD' : 'ACTIVE'}`
                      : mapLockedSides.length
                        ? `ROBOT POSE · MAP HOLD ${mapLockSideLabel}${robotHeightLockActive ? ' · Z HOLD' : ''}`
                        : `ROBOT POSE · ${robotHeightLockActive ? 'Z HOLD' : 'MAP FRAME'}`}
                </small>
                <strong>{robotDescriptor.name}</strong>
              </div>
              <em>
                {robotLoadState?.status === 'loaded'
                  ? chassisDragMode
                    ? `按住底盘拖拽 · Z ${displayedRobotPose.position.z.toFixed(2)} 固定`
                    : `${robotLoadState.zividCount || 0}× Zivid · X ${displayedRobotPose.position.x.toFixed(2)} · Y ${displayedRobotPose.position.y.toFixed(2)} · Z ${displayedRobotPose.position.z.toFixed(2)} · YAW ${displayedRobotPose.rpy.yaw.toFixed(1)}°`
                  : robotLoadState?.status === 'error'
                    ? '加载失败'
                    : robotLoadState?.phase || '正在装配…'}
              </em>
            </div>
          )}
          <div className="viewer-help">
            <span>
              {effectiveViewportPan || chassisDragMode
                ? <Move3D size={12} />
                : <Rotate3D size={12} />}
              {temporaryShiftPan
                ? 'Shift + 左键平移 · 松开恢复旋转'
                : persistentPanMode
                  ? '左键平移 · 点击“平移”切回旋转'
                  : chassisDragMode
                    ? '按住底盘拖拽 · 保持 Z / RPY'
                    : '左键旋转 · 点 / 路径可选'}
            </span>
            <span>
              <Keyboard size={12} />
              {robotControlActive
                ? robotHeightLockActive
                  ? 'W/S 前后 · A/D 麦轮横移 · ←→ 旋转 · Z 高度已锁'
                  : 'W/S 前后 · A/D 麦轮横移 · ←→ 旋转 · ↑↓ 高度'
                : 'WASD 平移 · Q/E 升降 · ←→ Yaw · ↑↓ Pitch'}
            </span>
            <span>
              <MousePointer2 size={12} />
              {endEffectorControlActive
                ? endEffectorControl.locked
                  ? endEffectorControl.lockMode === 'map'
                    ? '地图绝对姿态锁定 · 底盘移动时全链 IK 补偿'
                    : '本体关节姿态锁定 · 双击另一末端继续调整'
                  : '空间球拖拽 XYZ / RPY · 面板支持精确输入'
                : chassisDragMode
                  ? '黄色平面标记已启用 · 双击底盘 / Esc 退出'
                : robotControlActive
                ? mapLockedSides.length
                  ? `全局锁定 ${mapLockSideLabel} · 移动底盘观察全链关节补偿`
                  : 'Shift + 左键视角平移 · Q/E 视角升降'
                : 'Shift + 左键临时平移 · 右键平移'}
            </span>
            {robotLoadState?.status === 'loaded' && !endEffectorControlActive && !chassisDragMode && (
              <span><Bot size={12} /> 双击底盘平移 · 双击左 / 右末端进入 6D 控制</span>
            )}
            <span>
              <Gauge size={12} />
              {hasEmbeddedMesh
                ? `内嵌网格 ${formatPointCount(meshInfo.faceCount)} 面 · 档位仅调整未成面点`
                : resolutionSelection === 'auto'
                  ? '点数超限 · 已自动降采样'
                  : '分辨率仅影响 3D 显示'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
