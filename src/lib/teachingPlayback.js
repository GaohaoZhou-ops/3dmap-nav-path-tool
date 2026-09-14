const finite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));

const normalizePose = (value) => {
  const pose = value && typeof value === 'object' ? value : {};
  const position = pose.position && typeof pose.position === 'object'
    ? pose.position
    : pose;
  const rpy = pose.rpy && typeof pose.rpy === 'object' ? pose.rpy : pose;
  return {
    position: {
      x: finite(position.x),
      y: finite(position.y),
      z: finite(position.z),
    },
    rpy: {
      roll: finite(rpy.roll),
      pitch: finite(rpy.pitch),
      yaw: finite(rpy.yaw),
    },
  };
};

const normalizeJoints = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, rawValue]) => {
      const parsed = finite(
        rawValue && typeof rawValue === 'object' ? rawValue.value : rawValue,
        Number.NaN,
      );
      return name && Number.isFinite(parsed) ? [[String(name), parsed]] : [];
    }),
  );
};

const sequenceSort = (left, right) => {
  const leftSequence = finite(left?.sequence, Number.POSITIVE_INFINITY);
  const rightSequence = finite(right?.sequence, Number.POSITIVE_INFINITY);
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return finite(left?.__sourceIndex) - finite(right?.__sourceIndex);
};

const ordered = (items) => (Array.isArray(items) ? items : [])
  .map((item, index) => ({ ...item, __sourceIndex: index }))
  .sort(sequenceSort)
  .map(({ __sourceIndex, ...item }) => item);

const shortestAngleDelta = (from, to) => {
  const delta = finite(to) - finite(from);
  return ((delta + 180) % 360 + 360) % 360 - 180;
};

const poseDistance = (from, to) => Math.hypot(
  to.position.x - from.position.x,
  to.position.y - from.position.y,
  to.position.z - from.position.z,
);

const poseAngularDistance = (from, to) => Math.max(
  Math.abs(shortestAngleDelta(from.rpy.roll, to.rpy.roll)),
  Math.abs(shortestAngleDelta(from.rpy.pitch, to.rpy.pitch)),
  Math.abs(shortestAngleDelta(from.rpy.yaw, to.rpy.yaw)),
);

const S_CURVE_PEAK_VELOCITY_FACTOR = 1.875;
const S_CURVE_PEAK_ACCELERATION_FACTOR = 5.773503;

export const DEFAULT_TEACHING_PLAYBACK_SETTINGS = Object.freeze({
  chassisLinearSpeed: 0.4,
  chassisAngularSpeed: 42,
  chassisLinearAcceleration: 0.5,
  chassisAngularAcceleration: 90,
  revoluteJointSpeed: 36,
  prismaticJointSpeed: 0.1,
  revoluteJointAcceleration: 90,
  prismaticJointAcceleration: 0.25,
  minimumMotionDuration: 0.65,
  poseHoldDuration: 0.6,
  positionEpsilon: 0.0005,
  rotationEpsilon: 0.03,
  jointEpsilon: 0.0001,
});

export const quinticSmoothStep = (progress) => {
  const value = clamp01(progress);
  return value * value * value * (10 + value * (-15 + value * 6));
};

const interpolatePose = (from, to, progress) => {
  const eased = quinticSmoothStep(progress);
  return {
    position: {
      x: from.position.x + (to.position.x - from.position.x) * eased,
      y: from.position.y + (to.position.y - from.position.y) * eased,
      z: from.position.z + (to.position.z - from.position.z) * eased,
    },
    rpy: {
      roll: from.rpy.roll + shortestAngleDelta(from.rpy.roll, to.rpy.roll) * eased,
      pitch: from.rpy.pitch + shortestAngleDelta(from.rpy.pitch, to.rpy.pitch) * eased,
      yaw: from.rpy.yaw + shortestAngleDelta(from.rpy.yaw, to.rpy.yaw) * eased,
    },
  };
};

const interpolateJoints = (from, to, progress) => {
  const eased = quinticSmoothStep(progress);
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  return Object.fromEntries([...names].map((name) => {
    const fromValue = finite(from[name]);
    const toValue = finite(to[name], fromValue);
    return [name, fromValue + (toValue - fromValue) * eased];
  }));
};

const appendSegment = (segments, segment) => {
  const durationMs = Math.max(0, finite(segment.durationMs));
  const startOffsetMs = segments.at(-1)?.endOffsetMs || 0;
  segments.push({
    ...segment,
    id: `teaching-segment-${segments.length + 1}`,
    index: segments.length,
    durationMs,
    startOffsetMs,
    endOffsetMs: startOffsetMs + durationMs,
  });
};

const createTargetMeta = (task, parkingPoint, pose, parkingIndex, poseIndex, poseOrdinal) => ({
  taskId: task.id,
  taskName: task.name || '未命名示教任务',
  parkingPointId: parkingPoint.id,
  parkingPointName: parkingPoint.name || `停车点 ${parkingIndex + 1}`,
  parkingPointOrdinal: parkingIndex + 1,
  poseId: pose.id,
  poseName: pose.name || `姿态 ${poseIndex + 1}`,
  poseOrdinal,
});

export function buildTeachingTaskTrajectory({
  task,
  currentRobotPose,
  currentJointValues,
  jointDefinitions = [],
  settings = {},
} = {}) {
  const config = { ...DEFAULT_TEACHING_PLAYBACK_SETTINGS, ...settings };
  const segments = [];
  const definitionsByName = new Map(
    (Array.isArray(jointDefinitions) ? jointDefinitions : [])
      .filter((definition) => definition?.name)
      .map((definition) => [definition.name, definition]),
  );
  const parkingPoints = ordered(task?.parkingPoints);
  const poseCount = parkingPoints.reduce(
    (sum, parkingPoint) => sum + (parkingPoint.poses?.length || 0),
    0,
  );
  let currentPose = normalizePose(currentRobotPose);
  let currentJoints = normalizeJoints(currentJointValues);
  let poseOrdinal = 0;

  parkingPoints.forEach((parkingPoint, parkingIndex) => {
    ordered(parkingPoint.poses).forEach((pose, poseIndex) => {
      poseOrdinal += 1;
      const meta = createTargetMeta(
        task || {},
        parkingPoint,
        pose,
        parkingIndex,
        poseIndex,
        poseOrdinal,
      );
      const targetPose = normalizePose(pose.mapPose || parkingPoint.mapPose);
      const targetJointsRaw = normalizeJoints(pose.fullBodyJoints?.values);
      const targetJoints = { ...currentJoints };
      Object.entries(targetJointsRaw).forEach(([name, value]) => {
        const definition = definitionsByName.get(name);
        targetJoints[name] = definition?.type === 'continuous'
          ? finite(currentJoints[name]) + shortestAngleDelta(currentJoints[name], value)
          : value;
      });

      const linearDistance = poseDistance(currentPose, targetPose);
      const angularDistance = poseAngularDistance(currentPose, targetPose);
      if (
        linearDistance > config.positionEpsilon
        || angularDistance > config.rotationEpsilon
      ) {
        const nominalDuration = Math.max(
          S_CURVE_PEAK_VELOCITY_FACTOR
            * linearDistance / Math.max(0.001, config.chassisLinearSpeed),
          S_CURVE_PEAK_VELOCITY_FACTOR
            * angularDistance / Math.max(0.001, config.chassisAngularSpeed),
          Math.sqrt(
            S_CURVE_PEAK_ACCELERATION_FACTOR
              * linearDistance / Math.max(0.001, config.chassisLinearAcceleration),
          ),
          Math.sqrt(
            S_CURVE_PEAK_ACCELERATION_FACTOR
              * angularDistance / Math.max(0.001, config.chassisAngularAcceleration),
          ),
        );
        appendSegment(segments, {
          phase: 'chassis',
          durationMs: Math.max(config.minimumMotionDuration, nominalDuration) * 1000,
          fromPose: currentPose,
          toPose: targetPose,
          fromJointValues: currentJoints,
          toJointValues: currentJoints,
          target: meta,
          metrics: { linearDistance, angularDistance },
        });
        currentPose = targetPose;
      }

      const changedJointNames = Object.keys(targetJoints).filter((name) => (
        Math.abs(finite(targetJoints[name]) - finite(currentJoints[name])) > config.jointEpsilon
      ));
      if (changedJointNames.length) {
        const nominalDuration = changedJointNames.reduce((maximum, name) => {
          const definition = definitionsByName.get(name);
          const speed = definition?.type === 'prismatic'
            ? config.prismaticJointSpeed
            : config.revoluteJointSpeed;
          const acceleration = definition?.type === 'prismatic'
            ? config.prismaticJointAcceleration
            : config.revoluteJointAcceleration;
          const distance = Math.abs(targetJoints[name] - finite(currentJoints[name]));
          const jointDuration = Math.max(
            S_CURVE_PEAK_VELOCITY_FACTOR * distance / Math.max(0.001, speed),
            Math.sqrt(
              S_CURVE_PEAK_ACCELERATION_FACTOR
                * distance / Math.max(0.001, acceleration),
            ),
          );
          return Math.max(maximum, jointDuration);
        }, 0);
        appendSegment(segments, {
          phase: 'joints',
          durationMs: Math.max(config.minimumMotionDuration, nominalDuration) * 1000,
          fromPose: currentPose,
          toPose: currentPose,
          fromJointValues: currentJoints,
          toJointValues: targetJoints,
          changedJointNames,
          target: meta,
        });
        currentJoints = targetJoints;
      }

      appendSegment(segments, {
        phase: 'hold',
        durationMs: config.poseHoldDuration * 1000,
        fromPose: currentPose,
        toPose: currentPose,
        fromJointValues: currentJoints,
        toJointValues: currentJoints,
        target: meta,
      });
    });
  });

  const totalDurationMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  return {
    taskId: task?.id || '',
    taskName: task?.name || '未命名示教任务',
    parkingPointCount: parkingPoints.length,
    populatedParkingPointCount: parkingPoints.filter((point) => point.poses?.length).length,
    poseCount,
    segments,
    totalDurationMs,
    initialRobotPose: normalizePose(currentRobotPose),
    initialJointValues: normalizeJoints(currentJointValues),
    finalRobotPose: currentPose,
    finalJointValues: currentJoints,
  };
}

export function sampleTeachingTrajectorySegment(segment, progress) {
  if (!segment) {
    return { robotPose: normalizePose(null), robotJointValues: {}, easedProgress: 0 };
  }
  const normalizedProgress = clamp01(progress);
  return {
    robotPose: segment.phase === 'chassis'
      ? interpolatePose(segment.fromPose, segment.toPose, normalizedProgress)
      : normalizePose(segment.toPose),
    robotJointValues: segment.phase === 'joints'
      ? interpolateJoints(
          segment.fromJointValues,
          segment.toJointValues,
          normalizedProgress,
        )
      : normalizeJoints(segment.toJointValues),
    easedProgress: quinticSmoothStep(normalizedProgress),
  };
}

export function teachingPlaybackPhaseLabel(phase) {
  return {
    chassis: '底盘转场',
    joints: '全关节 S 曲线',
    hold: '姿态观察',
  }[phase] || '轨迹准备';
}
