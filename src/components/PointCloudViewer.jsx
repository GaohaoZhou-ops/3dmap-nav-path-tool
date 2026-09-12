import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  Bot,
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
import EndEffectorControlPanel from './EndEffectorControlPanel.jsx';
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
const KEYBOARD_WORLD_SPEED_RATIO = 0.75;
const KEYBOARD_MIN_PROJECTED_AXIS = 1e-4;
const KEYBOARD_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const ROBOT_LINEAR_SPEED = 0.9;
const ROBOT_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const ROBOT_POSE_REPORT_INTERVAL = 70;
const ROBOT_JOINT_REPORT_INTERVAL = 70;
const ZIVID_CAMERA_POSE_REPORT_INTERVAL = 70;
const END_EFFECTOR_SCREEN_DIAMETER = 58;
const IK_ORIENTATION_SCALE = 0.24;
const IK_DAMPING = 0.045;
const IK_MAX_ITERATIONS = 28;
const ROBOT_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowLeft',
  'ArrowRight',
]);
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
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vAtlasHeight = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;
#else
  vAtlasHeight = (modelMatrix * vec4(transformed, 1.0)).z;
#endif`,
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
  material.customProgramCacheKey = () => 'atlas-point-color-v4-points';
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
  robotDescriptor,
  robotLoadState,
  robotPose,
  robotJointValues,
  robotControlEnabled = false,
  cameraTeachingCommand,
  onRobotLoadState,
  onRobotPoseChange,
  onRobotJointValuesChange,
  onRobotControlChange,
  onZividCameraPoseChange,
  onCameraTeachingResult,
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const sliceGroupRef = useRef(null);
  const routeGroupRef = useRef(null);
  const waypointGroupRef = useRef(null);
  const robotLayerRef = useRef(null);
  const loadedRobotRef = useRef(null);
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
  const onRobotLoadStateRef = useRef(onRobotLoadState);
  const onRobotPoseChangeRef = useRef(onRobotPoseChange);
  const onRobotJointValuesChangeRef = useRef(onRobotJointValuesChange);
  const onRobotControlChangeRef = useRef(onRobotControlChange);
  const onZividCameraPoseChangeRef = useRef(onZividCameraPoseChange);
  const onCameraTeachingResultRef = useRef(onCameraTeachingResult);
  const zividCameraFramesRef = useRef({ left: null, right: null });
  const lastZividCameraPoseReportRef = useRef(0);
  const lastZividCameraPoseSignatureRef = useRef('');
  const robotPoseRef = useRef(normalizeRobotPose(robotPose));
  const robotJointValuesRef = useRef(normalizeRobotJointValues(robotJointValues));
  const robotControlEnabledRef = useRef(Boolean(robotControlEnabled));
  const robotPoseActionsRef = useRef(null);
  const lastRobotPoseReportRef = useRef(0);
  const lastRobotJointReportRef = useRef(0);
  const appliedInitialViewRef = useRef(null);
  const appliedResetRevisionRef = useRef(0);
  const appliedCameraTeachingRevisionRef = useRef(0);
  const [shiftPanArmed, setShiftPanArmed] = useState(false);
  const [chassisDragMode, setChassisDragMode] = useState(false);
  const [chassisDragging, setChassisDragging] = useState(false);
  const [endEffectorControl, setEndEffectorControl] = useState(null);
  const [endEffectorLockModesState, setEndEffectorLockModesState] = useState({
    left: null,
    right: null,
  });
  colorModeRef.current = colorMode;
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
  robotControlEnabledRef.current = Boolean(robotControlEnabled);
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
    Object.entries(lockedEndEffectorsRef.current).forEach(([side, lock]) => {
      if (!lock || side === activeSide) return;
      const controller = endEffectorControllersRef.current[side];
      if (lock.type === 'body') {
        lock.jointValues.forEach((value, joint) => {
          setRobotJointValue(joint, value);
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
    writeRobotPoseDataset(controlsRef.current?.domElement, nextPose);
  }, [mapData?.geometry, robotPose]);

  useLayoutEffect(() => {
    const appliedValues = applyRobotJointStateToScene(robotJointValues, 'external-control');
    if (loadedRobotRef.current) {
      robotJointValuesRef.current = appliedValues;
      reportZividCameraPoses(true);
    }
  }, [mapData?.geometry, robotJointValues]);

  useEffect(() => {
    const revision = Number(cameraTeachingCommand?.revision) || 0;
    if (!revision || revision === appliedCameraTeachingRevisionRef.current) return;
    appliedCameraTeachingRevisionRef.current = revision;

    const side = cameraTeachingCommand?.side === 'right' ? 'right' : 'left';
    const actionId = String(cameraTeachingCommand?.action || '');
    const action = CAMERA_TEACH_ACTIONS[actionId];
    const canvas = controlsRef.current?.domElement;
    const publishFailure = (message) => {
      if (canvas) {
        canvas.dataset.cameraTeachingState = 'error';
        canvas.dataset.cameraTeachingRevision = String(revision);
        canvas.dataset.cameraTeachingSide = side;
        canvas.dataset.cameraTeachingAction = actionId;
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
    cloud.name = 'scene-map-point-cloud';

    const mapLayer = new THREE.Group();
    mapLayer.name = 'scene-map-render-layer';
    mapLayer.add(cloud);
    cloud.visible = true;
    renderer.domElement.dataset.mapRenderMode = 'points';
    renderer.domElement.dataset.mapPointCloudVisible = 'true';
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

    const progressiveWheelZoom = (event) => {
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= Math.max(renderer.domElement.clientHeight, 1);
      }
      if (!Number.isFinite(delta) || delta === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      claimKeyboardFocus('wheel');
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
    const robotLayer = new THREE.Group();
    routeGroup.name = 'directed-route-edges';
    waypointGroup.name = 'navigation-waypoint-markers';
    robotLayer.name = 'loaded-robot-model';
    robotLayer.visible = true;
    scene.add(sliceGroup, robotLayer, routeGroup, waypointGroup);
    sliceGroupRef.current = sliceGroup;
    routeGroupRef.current = routeGroup;
    waypointGroupRef.current = waypointGroup;
    robotLayerRef.current = robotLayer;
    robotPoseRef.current = applyRobotPose(robotLayer, robotPoseRef.current);
    writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
    renderer.domElement.dataset.robotLayerVisible = 'true';
    renderer.domElement.dataset.robotLayerRenderIsolation = 'independent';
    renderer.domElement.dataset.robotControlEnabled = robotControlEnabledRef.current
      ? 'true'
      : 'false';
    renderer.domElement.dataset.keyboardControlOwner = robotControlEnabledRef.current
      ? 'robot'
      : 'camera';
    renderer.domElement.dataset.robotDriveModel = 'mecanum-local-frame';
    renderer.domElement.dataset.robotForwardAxis = '+x';
    renderer.domElement.dataset.robotLeftAxis = '+y';
    renderer.domElement.dataset.robotLinearSpeed = `${ROBOT_LINEAR_SPEED}m/s`;
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
        !chassisDragModeRef.current
        || event.button !== 0
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
        || robotControlEnabledRef.current
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
      if (startChassisPointerDrag(event)) return;
      if (transformControls.object && (transformControls.axis || transformControls.dragging)) {
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
      const shiftPressed =
        event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight');
      const shiftPanOverride =
        event.button === 0
        && !robotControlEnabledRef.current
        && shiftPressed;
      const panGesture =
        event.button === 2
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
          && !robotControlEnabledRef.current
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
      const pressedKeys = pressedKeysRef.current;
      const keyboardImpulses = keyboardImpulseRef.current;
      const robotControlActive =
        robotControlEnabledRef.current && robotLayer.children.length > 0;
      let keyboardMoved = false;
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
        const pitchInput = Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
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
          const robotForwardInput =
            Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
          const robotStrafeLeftInput =
            Number(keyActive('KeyA')) - Number(keyActive('KeyD'));
          const robotYawInput =
            Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
          if (robotForwardInput || robotStrafeLeftInput || robotYawInput) {
            const robotTapImpulse = [...ROBOT_CONTROL_CODES].some(
              (code) => keyboardImpulses.has(code),
            );
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

            robotPoseRef.current = applyRobotPose(robotLayer, nextPose);
            writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
            renderer.domElement.dataset.lastRobotAction = [...ROBOT_CONTROL_CODES]
              .filter((code) => keyActive(code))
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
      keyboardImpulses.clear();
      controls.update();
      reportZividCameraPoses();
      if (keyboardMoved) {
        syncDetailView();
        // Application-owned keyboard rotations need an explicit persisted view update.
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
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      updateChassisDragMode(false, 'scene-dispose');
      observer.disconnect();
      renderer.domElement.removeEventListener('wheel', progressiveWheelZoom, true);
      renderer.domElement.removeEventListener('pointerdown', onPickPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', onPickPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', onPickPointerUp, true);
      renderer.domElement.removeEventListener('pointercancel', resetPickPointer);
      renderer.domElement.removeEventListener('pointerleave', onPickPointerLeave);
      renderer.domElement.removeEventListener('dblclick', onRobotDoubleClick, true);
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
      robotLayerRef.current = null;
      loadedRobotRef.current = null;
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
      if (cloudMaterialRef.current === material) cloudMaterialRef.current = null;
    };
  }, [mapData?.geometry]);

  useEffect(() => {
    const layer = robotLayerRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!layer || !canvas) return undefined;

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
    const temporaryShiftPan = shiftPanArmed;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.domElement.dataset.interactionMode = 'rotate';
    controls.domElement.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
    controls.domElement.dataset.effectiveInteractionMode = temporaryShiftPan
      ? 'shift-pan'
      : 'rotate';
    controls.domElement.dataset.keyboardEnabled = 'true';
    controls.domElement.dataset.keyboardMode = 'always-on';
  }, [mapData?.geometry, shiftPanArmed]);

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
    canvas.dataset.effectiveInteractionMode = 'rotate';
  }, [mapData?.geometry, robotControlEnabled, robotDescriptor, robotLoadState?.status]);

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
        canvas.dataset.effectiveInteractionMode = 'rotate';
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
        const temporaryShiftPan = !robotControlEnabledRef.current;
        setShiftPanArmed(temporaryShiftPan);
        if (canvas) {
          canvas.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
          canvas.dataset.effectiveInteractionMode = temporaryShiftPan
            ? 'shift-pan'
            : 'rotate';
        }
        if (temporaryShiftPan) pointerInteractionRef.current?.activateShiftPan?.();
      }
      if (canvas && isActionKey) {
        const robotOwnsKey =
          robotControlEnabledRef.current
          && ROBOT_CONTROL_CODES.has(code)
          && robotLayerRef.current?.children.length > 0;
        canvas.dataset.lastKeyboardKey = code.startsWith('Key') ? code.slice(3) : code;
        canvas.dataset.keyboardControlOwner = robotOwnsKey ? 'robot' : 'camera';
        if (robotOwnsKey) {
          canvas.dataset.lastRobotAction = ROBOT_CONTROL_ACTIONS[code];
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
        const temporaryShiftPan =
          shiftStillPressed
          && !robotControlEnabledRef.current;
        setShiftPanArmed(temporaryShiftPan);
        const canvas = controlsRef.current?.domElement;
        if (canvas) {
          canvas.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
          canvas.dataset.effectiveInteractionMode = temporaryShiftPan
            ? 'shift-pan'
            : 'rotate';
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
      canvas.dataset.effectiveInteractionMode = 'rotate';
      canvas.focus({ preventScroll: true });
    }
    onRobotControlChangeRef.current?.(enabled);
  };

  const resetView = () => viewActionsRef.current?.reset?.();
  const robotControlActive = Boolean(
    robotControlEnabled
    && robotDescriptor
    && robotLoadState?.status === 'loaded',
  );
  const displayedRobotPose = normalizeRobotPose(robotPose);
  const endEffectorControlActive = Boolean(endEffectorControl);
  const mapLockedSides = ['left', 'right'].filter(
    (side) => endEffectorLockModesState[side] === 'map',
  );
  const mapLockSideLabel = mapLockedSides
    .map((side) => side === 'left' ? 'L' : 'R')
    .join('+');
  const temporaryShiftPan = !robotControlActive && shiftPanArmed;

  return (
    <div
      className={`point-cloud-view ${temporaryShiftPan ? 'is-shift-pan-armed' : ''} ${robotControlActive ? 'is-robot-driving' : ''} ${endEffectorControlActive ? 'is-end-effector-control' : ''} ${chassisDragMode ? 'is-chassis-drag-mode' : ''} ${chassisDragging ? 'is-chassis-dragging' : ''}`}
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
                className={`viewer-interaction-mode is-active ${temporaryShiftPan ? 'is-temporary' : ''}`}
                aria-label={temporaryShiftPan ? 'Shift 临时平移' : '旋转'}
                aria-pressed="true"
                aria-keyshortcuts="Shift"
                data-mode={temporaryShiftPan ? 'shift-pan' : 'rotate'}
                onClick={() => controlsRef.current?.domElement?.focus({ preventScroll: true })}
                title={temporaryShiftPan ? 'Shift 已按下：左键拖拽平移' : '左键拖拽旋转；按住 Shift 临时平移'}
              >
                {temporaryShiftPan ? <Move3D size={13} /> : <Rotate3D size={13} />}
                {temporaryShiftPan ? 'Shift 平移' : '旋转'}
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
                <button
                  type="button"
                  className={`robot-control-toggle ${robotControlActive ? 'is-active' : ''}`}
                  onClick={() => {
                    focusRobot();
                    toggleRobotControl();
                  }}
                  aria-label="定位机器人模型"
                  aria-pressed={robotControlActive}
                  title={
                    endEffectorControlActive
                      ? '退出机械臂末端控制，定位机器人并启用麦轮底盘控制'
                      : robotControlActive
                        ? '底盘控制已启用；再次点击将键盘交还相机'
                        : '定位机器人并启用麦轮底盘控制：W/S 前后、A/D 横移、左右方向键旋转'
                  }
                >
                  <Bot size={13} /> 机器人
                </button>
              )}
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
              className={`robot-model-indicator is-${robotLoadState?.status || 'pending'} ${robotControlActive ? 'is-driving' : ''} ${chassisDragMode ? 'is-planar-drag' : ''}`}
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
                        ? `MECANUM DRIVE · MAP HOLD ${mapLockSideLabel}`
                        : 'MECANUM DRIVE · ACTIVE'
                      : mapLockedSides.length
                        ? `ROBOT POSE · MAP HOLD ${mapLockSideLabel}`
                        : 'ROBOT POSE · MAP FRAME'}
                </small>
                <strong>{robotDescriptor.name}</strong>
              </div>
              <em>
                {robotLoadState?.status === 'loaded'
                  ? chassisDragMode
                    ? `按住底盘拖拽 · Z ${displayedRobotPose.position.z.toFixed(2)} 固定`
                    : `${robotLoadState.zividCount || 0}× Zivid · X ${displayedRobotPose.position.x.toFixed(2)} · Y ${displayedRobotPose.position.y.toFixed(2)} · YAW ${displayedRobotPose.rpy.yaw.toFixed(1)}°`
                  : robotLoadState?.status === 'error'
                    ? '加载失败'
                    : robotLoadState?.phase || '正在装配…'}
              </em>
            </div>
          )}
          <div className="viewer-help">
            <span>
              {chassisDragMode || temporaryShiftPan
                ? <Move3D size={12} />
                : <Rotate3D size={12} />}
              {chassisDragMode
                ? '按住底盘拖拽 · 保持 Z / RPY'
                : temporaryShiftPan
                  ? 'Shift + 左键平移 · 松开恢复旋转'
                  : '左键旋转 · 点 / 路径可选'}
            </span>
            <span>
              <Keyboard size={12} />
              {robotControlActive
                ? 'W/S 前后 · A/D 麦轮横移 · ←→ 原地旋转'
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
                  : 'Shift 底盘加速 · Q/E 升降 · ↑↓ 相机 Pitch'
                : 'Shift 加速 / 临时平移 · 右键平移'}
            </span>
            {robotLoadState?.status === 'loaded' && !endEffectorControlActive && !chassisDragMode && (
              <span><Bot size={12} /> 双击底盘平移 · 双击左 / 右末端进入 6D 控制</span>
            )}
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
