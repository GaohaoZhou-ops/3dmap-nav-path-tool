import { calculatePathDistances } from './pathMetrics.js';
import { normalizeRobotJointLocks } from './robotJointLocks.js';
import { getSliceControlBounds } from './sliceRange.js';

const numberOr = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const booleanOr = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
};

export const createId = (prefix) =>
  `${prefix}-${
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  }`;

export function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

export async function fetchBufferWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`示例地图请求失败（${response.status}）`);
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body || !total) {
    const buffer = await response.arrayBuffer();
    onProgress(1);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged.buffer;
}

const normalizeTeachingPose = (value) => {
  const pose = value && typeof value === 'object' ? value : {};
  const position = pose.position && typeof pose.position === 'object'
    ? pose.position
    : pose;
  const rpy = pose.rpy && typeof pose.rpy === 'object' ? pose.rpy : pose;
  return {
    frameId: String(pose.frameId || pose.frame || 'map'),
    position: {
      x: numberOr(position.x),
      y: numberOr(position.y),
      z: numberOr(position.z),
    },
    rpy: {
      roll: numberOr(rpy.roll),
      pitch: numberOr(rpy.pitch),
      yaw: numberOr(rpy.yaw),
    },
  };
};

const normalizeTeachingJoints = (value) => {
  const hasExplicitValues = value?.values && typeof value.values === 'object';
  const source = hasExplicitValues
    ? value.values
    : value && typeof value === 'object' ? value : {};
  const metadataKeys = new Set(['angularUnit', 'linearUnit', 'source', 'count', 'values']);
  const values = Object.fromEntries(
    Object.entries(source).flatMap(([name, rawValue]) => {
      if (!hasExplicitValues && metadataKeys.has(name)) return [];
      const parsed = Number(
        rawValue && typeof rawValue === 'object' ? rawValue.value : rawValue,
      );
      return name && Number.isFinite(parsed) ? [[String(name), parsed]] : [];
    }),
  );
  return {
    angularUnit: String(value?.angularUnit || 'degree'),
    linearUnit: String(value?.linearUnit || 'meter'),
    source: String(value?.source || 'urdf-movable-joints'),
    count: Object.keys(values).length,
    values,
  };
};

const normalizeCaptureImage = (value) => {
  if (!value || typeof value !== 'object') return null;
  const dataUrl = String(value.dataUrl || value.data || '');
  if (!dataUrl.startsWith('data:image/')) return null;
  return {
    encoding: 'data-url',
    mimeType: String(value.mimeType || dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'),
    width: Math.max(1, Math.floor(numberOr(value.width, 1))),
    height: Math.max(1, Math.floor(numberOr(value.height, 1))),
    byteLength: Math.max(0, Math.floor(numberOr(value.byteLength))),
    dataUrl,
  };
};

const normalizeOpticalPose = (value, side) => {
  const pose = value && typeof value === 'object' ? value : {};
  const position = pose.position && typeof pose.position === 'object' ? pose.position : {};
  const quaternion = pose.quaternion && typeof pose.quaternion === 'object'
    ? pose.quaternion
    : {};
  return {
    frameName: String(
      pose.frameName || `zivid_${side === 'right' ? 'right' : 'left'}_optical_frame`,
    ),
    position: {
      x: numberOr(position.x),
      y: numberOr(position.y),
      z: numberOr(position.z),
    },
    quaternion: {
      x: numberOr(quaternion.x),
      y: numberOr(quaternion.y),
      z: numberOr(quaternion.z),
      w: numberOr(quaternion.w, 1),
    },
  };
};

const normalizeVector3Array = (value) => (
  Array.isArray(value)
    ? [0, 1, 2].map((index) => numberOr(value[index]))
    : [0, 0, 0]
);

const normalizeTeachingPointCloud = (value, frameName) => {
  if (!value || typeof value !== 'object') return null;
  const pointCount = Math.max(0, Math.floor(numberOr(value.pointCount)));
  return {
    coordinateFrame: String(value.coordinateFrame || frameName || 'camera-optical-frame'),
    convention: String(value.convention || 'x-right/y-down/z-forward'),
    pointCount,
    visiblePointCount: Math.max(pointCount, Math.floor(numberOr(value.visiblePointCount, pointCount))),
    sourcePointCount: Math.max(pointCount, Math.floor(numberOr(value.sourcePointCount, pointCount))),
    sampleMethod: String(value.sampleMethod || 'all-visible'),
    positionEncoding: String(value.positionEncoding || 'uint16-le/base64'),
    positionComponents: Array.isArray(value.positionComponents)
      ? value.positionComponents.slice(0, 3).map(String)
      : ['x', 'y', 'z'],
    positionOffset: normalizeVector3Array(value.positionOffset),
    positionScale: normalizeVector3Array(value.positionScale),
    positionData: String(value.positionData || ''),
    colorEncoding: String(value.colorEncoding || 'rgb8/base64'),
    colorData: String(value.colorData || ''),
    hasSourceRgb: Boolean(value.hasSourceRgb),
    byteLength: Math.max(0, Math.floor(numberOr(value.byteLength))),
    preview: normalizeCaptureImage(value.preview),
  };
};

const normalizeTeachingCameraFrame = (value, side) => {
  if (!value || typeof value !== 'object') return null;
  const opticalPose = normalizeOpticalPose(value.opticalPose || value.pose, side);
  const rgb = normalizeCaptureImage(value.rgb || value.image);
  const pointCloud = normalizeTeachingPointCloud(
    value.pointCloud || value.cloud,
    opticalPose.frameName,
  );
  if (!rgb && !pointCloud) return null;
  const rendering = value.rendering && typeof value.rendering === 'object'
    ? value.rendering
    : {};
  return {
    side,
    capturedAt: String(value.capturedAt || ''),
    opticalPose,
    rgb,
    pointCloud,
    rendering: {
      quality: String(rendering.quality || 'balanced'),
      rgbSurfaceMode: String(rendering.rgbSurfaceMode || 'local-surface'),
      renderedMeshFaceCount: Math.max(0, Math.floor(numberOr(rendering.renderedMeshFaceCount))),
      reconstructedTriangleCount: Math.max(
        0,
        Math.floor(numberOr(rendering.reconstructedTriangleCount)),
      ),
    },
    byteLength: Math.max(0, Math.floor(numberOr(value.byteLength))),
  };
};

const normalizeTeachingCameraCapture = (value) => {
  if (!value || typeof value !== 'object') return null;
  const rawFrames = value.frames && typeof value.frames === 'object' ? value.frames : value;
  const frames = Object.fromEntries(
    ['left', 'right'].flatMap((side) => {
      const frame = normalizeTeachingCameraFrame(rawFrames[side], side);
      return frame ? [[side, frame]] : [];
    }),
  );
  if (!Object.keys(frames).length) return null;
  const imageResolution = Array.isArray(value.imageResolution)
    ? value.imageResolution.slice(0, 2).map((item) => Math.max(1, Math.floor(numberOr(item, 1))))
    : [640, 395];
  return {
    version: Math.max(1, Math.floor(numberOr(value.version, 1))),
    status: String(value.status || 'complete'),
    cameraModel: String(value.cameraModel || 'Zivid 2 M70'),
    capturedAt: String(value.capturedAt || ''),
    imageResolution,
    calibration: {
      projection: String(value.calibration?.projection || 'perspective'),
      nativeResolution: Array.isArray(value.calibration?.nativeResolution)
        ? value.calibration.nativeResolution
          .slice(0, 2)
          .map((item) => Math.max(1, Math.floor(numberOr(item, 1))))
        : [1944, 1200],
      horizontalFov: numberOr(value.calibration?.horizontalFov, 56.6),
      verticalFov: numberOr(value.calibration?.verticalFov, 35.6),
      workingNear: numberOr(value.calibration?.workingNear, 0.3),
      workingFar: numberOr(value.calibration?.workingFar, 1.3),
    },
    pointBudgetPerCamera: Math.max(0, Math.floor(numberOr(value.pointBudgetPerCamera))),
    map: {
      fileName: String(value.map?.fileName || ''),
      sourceHash: value.map?.sourceHash ? String(value.map.sourceHash) : null,
    },
    quality: {
      requested: String(value.quality?.requested || 'auto'),
      effective: String(value.quality?.effective || 'balanced'),
    },
    frames,
    storageByteLength: Math.max(0, Math.floor(numberOr(value.storageByteLength))),
  };
};

const normalizeTeachingPoint = (point, pointIndex) => {
  const joints = normalizeTeachingJoints(
    point?.fullBodyJoints || point?.joints || point?.jointValues,
  );
  return {
    id: String(point?.id || createId('teach-pose')),
    name: String(
      point?.name
      || point?.label
      || `A${String(pointIndex + 1).padStart(2, '0')}`,
    ),
    sequence: pointIndex + 1,
    capturedAt: String(point?.capturedAt || point?.createdAt || ''),
    mapPose: normalizeTeachingPose(
      point?.mapPose || point?.robotPose || point?.pose,
    ),
    fullBodyJoints: joints,
    cameraCapture: normalizeTeachingCameraCapture(
      point?.cameraCapture || point?.visionCapture || point?.cameraFrames,
    ),
  };
};

const normalizeTeachingParkingPoint = (parkingPoint, parkingIndex) => {
  const rawPoses = Array.isArray(parkingPoint?.poses)
    ? parkingPoint.poses
    : Array.isArray(parkingPoint?.points)
      ? parkingPoint.points
      : Array.isArray(parkingPoint?.teachingPoses)
        ? parkingPoint.teachingPoses
        : [];
  const poses = rawPoses.map(normalizeTeachingPoint);
  return {
    id: String(parkingPoint?.id || createId('parking-point')),
    name: String(
      parkingPoint?.name
      || parkingPoint?.label
      || `停车点 P${String(parkingIndex + 1).padStart(2, '0')}`,
    ),
    sequence: parkingIndex + 1,
    createdAt: String(parkingPoint?.createdAt || ''),
    updatedAt: String(parkingPoint?.updatedAt || parkingPoint?.createdAt || ''),
    mapPose: normalizeTeachingPose(
      parkingPoint?.mapPose
      || parkingPoint?.robotPose
      || parkingPoint?.pose
      || parkingPoint?.location
      || poses[0]?.mapPose,
    ),
    poses,
  };
};

export function normalizeTeachingTasks(payload) {
  const rawTasks = Array.isArray(payload)
    ? payload
    : payload?.virtualTeaching?.tasks
      || payload?.teachingTasks
      || payload?.teaching?.tasks
      || [];
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.map((task, taskIndex) => {
    const nestedParkingPoints = Array.isArray(task?.parkingPoints)
      ? task.parkingPoints
      : Array.isArray(task?.parking_points)
        ? task.parking_points
        : Array.isArray(task?.stops) ? task.stops : [];
    const legacyPoints = Array.isArray(task?.points)
      ? task.points
      : Array.isArray(task?.teachingPoints) ? task.teachingPoints : [];
    const parkingPoints = nestedParkingPoints.length
      ? nestedParkingPoints.map(normalizeTeachingParkingPoint)
      : legacyPoints.length
        ? [normalizeTeachingParkingPoint({
            id: task?.legacyParkingPointId,
            name: '停车点 P01',
            createdAt: task?.createdAt,
            updatedAt: task?.updatedAt,
            mapPose: legacyPoints[0]?.mapPose || legacyPoints[0]?.robotPose || legacyPoints[0]?.pose,
            poses: legacyPoints,
          }, 0)]
        : [];
    const robot = task?.robot && typeof task.robot === 'object' ? task.robot : {};
    const map = task?.map && typeof task.map === 'object' ? task.map : {};
    return {
      id: String(task?.id || createId('teach-task')),
      name: String(task?.name || `示教任务 ${String(taskIndex + 1).padStart(2, '0')}`),
      createdAt: String(task?.createdAt || ''),
      updatedAt: String(task?.updatedAt || task?.createdAt || ''),
      coordinateFrame: String(task?.coordinateFrame || 'map'),
      robot: {
        id: String(robot.id || robot.relativePath || ''),
        name: String(robot.name || ''),
        relativePath: String(robot.relativePath || robot.path || ''),
      },
      map: {
        id: String(map.id || map.mapId || ''),
        fileName: String(map.fileName || map.name || ''),
        sourceHash: map.sourceHash ? String(map.sourceHash) : null,
      },
      parkingPoints,
    };
  });
}

export function normalizeJointPoses(payload) {
  const rawPoses = Array.isArray(payload)
    ? payload
    : payload?.virtualTeaching?.jointPoses
      || payload?.jointPoses
      || payload?.robot?.jointPoses
      || [];
  if (!Array.isArray(rawPoses)) return [];
  return rawPoses.map((pose, poseIndex) => {
    const joints = normalizeTeachingJoints(
      pose?.joints || pose?.fullBodyJoints || pose?.jointValues || pose?.values,
    );
    const robot = pose?.robot && typeof pose.robot === 'object' ? pose.robot : {};
    return {
      id: String(pose?.id || createId('joint-pose')),
      name: String(
        pose?.name
        || pose?.label
        || `关节姿态 ${String(poseIndex + 1).padStart(2, '0')}`,
      ),
      sequence: poseIndex + 1,
      createdAt: String(pose?.createdAt || pose?.capturedAt || ''),
      updatedAt: String(pose?.updatedAt || pose?.createdAt || pose?.capturedAt || ''),
      robot: {
        id: String(robot.id || robot.relativePath || ''),
        name: String(robot.name || ''),
        relativePath: String(robot.relativePath || robot.path || ''),
      },
      joints,
    };
  });
}

export function normalizeProject(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('JSON 根节点必须是对象');
  }

  const rawPoints =
    payload.waypoints || payload.navigationPoints || payload.points || [];
  const waypoints = rawPoints.map((point, index) => {
    const pose = point.pose || point.position || point;
    const xzy = Array.isArray(point.xzy) ? point.xzy : [];
    const rpy = Array.isArray(point.rpy) ? point.rpy : [];
    return {
      id: String(point.id || createId('wp')),
      name: String(point.name || point.label || `P${String(index + 1).padStart(2, '0')}`),
      pose: {
        x: numberOr(pose.x, numberOr(xzy[0])),
        y: numberOr(pose.y, numberOr(xzy[2])),
        z: numberOr(pose.z, numberOr(xzy[1])),
        roll: numberOr(pose.roll, numberOr(rpy[0])),
        pitch: numberOr(pose.pitch, numberOr(rpy[1])),
        yaw: numberOr(pose.yaw, numberOr(rpy[2])),
      },
      source: point.source || 'imported',
    };
  });

  const rawEdges = payload.paths || payload.edges || payload.routes || [];
  const edges = rawEdges
    .map((edge) => {
      const limits = edge.limits || edge.constraints || edge;
      const motion = edge.motion || edge.behavior || {};
      const rawDirection = String(
        motion.direction ?? edge.motionDirection ?? edge.travelDirection ?? 'forward',
      ).toLowerCase();
      return {
        id: String(edge.id || createId('edge')),
        from: String(edge.from ?? edge.source ?? edge.start ?? ''),
        to: String(edge.to ?? edge.target ?? edge.end ?? ''),
        directed: edge.directed !== false,
        limits: {
          minSpeed: numberOr(limits.minSpeed ?? limits.min_speed, 0.2),
          maxSpeed: numberOr(limits.maxSpeed ?? limits.max_speed, 1),
          minAcceleration: numberOr(
            limits.minAcceleration ?? limits.min_acceleration,
            -0.8,
          ),
          maxAcceleration: numberOr(
            limits.maxAcceleration ?? limits.max_acceleration,
            0.8,
          ),
        },
        motion: {
          direction: ['reverse', 'backward', 'back', '倒车'].includes(rawDirection)
            ? 'reverse'
            : 'forward',
          enable3DObstacleAvoidance: booleanOr(
            motion.enable3DObstacleAvoidance
              ?? motion.enable_3d_obstacle_avoidance
              ?? edge.enable3DObstacleAvoidance
              ?? edge.enable_3d_obstacle_avoidance,
            true,
          ),
        },
        status: ['connected', 'unreachable'].includes(edge.connectivity)
          ? edge.connectivity
          : 'unchecked',
      };
    })
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to);

  const projection = payload.projection || payload.slice || payload.map?.slice || {};
  const minHeight = numberOr(
    projection.minHeight ?? projection.minZ ?? projection.lower,
    NaN,
  );
  const maxHeight = numberOr(
    projection.maxHeight ?? projection.maxZ ?? projection.upper,
    NaN,
  );

  const rawRobot = payload.robot || payload.robotModel || null;
  const robot = rawRobot && typeof rawRobot === 'object'
    ? {
        id: String(rawRobot.id || rawRobot.relativePath || rawRobot.path || ''),
        name: String(rawRobot.name || rawRobot.fileName || 'robot'),
        fileName: String(rawRobot.fileName || ''),
        relativePath: String(rawRobot.relativePath || rawRobot.path || rawRobot.id || ''),
        format: String(rawRobot.format || '').toLowerCase(),
        packageName: rawRobot.packageName ? String(rawRobot.packageName) : null,
        packagePath: rawRobot.packagePath ? String(rawRobot.packagePath) : null,
        manifestUrl: rawRobot.manifestUrl ? String(rawRobot.manifestUrl) : null,
        joints: rawRobot.joints && typeof rawRobot.joints === 'object'
          ? Object.fromEntries(
              Object.entries(rawRobot.joints).flatMap(([name, value]) => {
                const parsed = Number(
                  value && typeof value === 'object' ? value.value : value,
                );
                return name && Number.isFinite(parsed) ? [[String(name), parsed]] : [];
              }),
            )
          : {},
        lockedJoints: normalizeRobotJointLocks(
          rawRobot.lockedJoints ?? rawRobot.jointLocks ?? rawRobot.lockedJointNames,
        ),
        origin: {
          position: {
            x: numberOr(rawRobot.origin?.position?.x ?? rawRobot.origin?.x),
            y: numberOr(rawRobot.origin?.position?.y ?? rawRobot.origin?.y),
            z: numberOr(rawRobot.origin?.position?.z ?? rawRobot.origin?.z),
          },
          rpy: {
            roll: numberOr(rawRobot.origin?.rpy?.roll ?? rawRobot.origin?.roll),
            pitch: numberOr(rawRobot.origin?.rpy?.pitch ?? rawRobot.origin?.pitch),
            yaw: numberOr(rawRobot.origin?.rpy?.yaw ?? rawRobot.origin?.yaw),
          },
        },
      }
    : null;
  const teachingTasks = normalizeTeachingTasks(payload);
  const jointPoses = normalizeJointPoses(payload);

  return {
    waypoints,
    edges,
    slice:
      Number.isFinite(minHeight) && Number.isFinite(maxHeight)
        ? [Math.min(minHeight, maxHeight), Math.max(minHeight, maxHeight)]
        : null,
    map: payload.map || null,
    view2d: payload.view2d || null,
    view3d: payload.view3d || null,
    rendering: payload.rendering || null,
    robot: robot?.relativePath ? robot : null,
    teachingTasks,
    jointPoses,
  };
}

export function buildExport({
  mapData,
  heightRange,
  waypoints,
  edges,
  view2d,
  view3d,
  robot,
  robotPose,
  robotJointValues,
  lockedRobotJointNames = [],
  teachingTasks = [],
  jointPoses = [],
  meshRenderQuality = 'auto',
}) {
  const pointById = new Map(waypoints.map((point) => [point.id, point]));
  const exportedRobotPose = robotPose || robot?.origin || {};
  return {
    schemaVersion: '1.2',
    exportedAt: new Date().toISOString(),
    coordinateSystem: {
      horizontalPlane: 'XY',
      verticalAxis: 'Z',
      angleUnit: 'degree',
      distanceUnit: 'meter',
    },
    rendering: {
      meshQuality: meshRenderQuality,
    },
    map: {
      fileName: mapData?.name || null,
      format: 'ply',
      pointCount: mapData?.pointCount || 0,
      faceCount: mapData?.faceCount || 0,
      bounds: mapData?.bounds || null,
      sourceHash: mapData?.sourceHash || null,
      sourceHashKind: mapData?.sourceHashKind || null,
    },
    projection: {
      plane: 'XY',
      mode: 'height-range',
      verticalAxis: 'Z',
      minHeight: heightRange[0],
      maxHeight: heightRange[1],
      centerHeight: (heightRange[0] + heightRange[1]) / 2,
      heightSpan: Math.max(0, heightRange[1] - heightRange[0]),
    },
    view2d: view2d || null,
    view3d: view3d || null,
    robot: robot
      ? {
          id: robot.id,
          name: robot.name,
          fileName: robot.fileName,
          relativePath: robot.relativePath,
          format: robot.format,
          packageName: robot.packageName || null,
          packagePath: robot.packagePath || null,
          manifestUrl: robot.manifestUrl || null,
          joints: Object.fromEntries(
            Object.entries(robotJointValues || robot.joints || {}).flatMap(([name, value]) => {
              const parsed = Number(value);
              return name && Number.isFinite(parsed) ? [[name, parsed]] : [];
            }),
          ),
          lockedJoints: normalizeRobotJointLocks(lockedRobotJointNames),
          origin: {
            position: {
              x: numberOr(exportedRobotPose.position?.x ?? exportedRobotPose.x),
              y: numberOr(exportedRobotPose.position?.y ?? exportedRobotPose.y),
              z: numberOr(exportedRobotPose.position?.z ?? exportedRobotPose.z),
            },
            rpy: {
              roll: numberOr(exportedRobotPose.rpy?.roll ?? exportedRobotPose.roll),
              pitch: numberOr(exportedRobotPose.rpy?.pitch ?? exportedRobotPose.pitch),
              yaw: numberOr(exportedRobotPose.rpy?.yaw ?? exportedRobotPose.yaw),
            },
          },
        }
      : null,
    virtualTeaching: {
      coordinateFrame: 'map',
      angularUnit: 'degree',
      distanceUnit: 'meter',
      jointPoses: normalizeJointPoses(jointPoses).map((pose, index) => ({
        ...pose,
        sequence: index + 1,
        joints: {
          ...pose.joints,
          count: Object.keys(pose.joints.values).length,
          values: { ...pose.joints.values },
        },
      })),
      tasks: normalizeTeachingTasks(teachingTasks).map((task) => ({
        ...task,
        parkingPoints: task.parkingPoints.map((parkingPoint, parkingIndex) => ({
          ...parkingPoint,
          sequence: parkingIndex + 1,
          mapPose: {
            frameId: 'map',
            position: { ...parkingPoint.mapPose.position },
            rpy: { ...parkingPoint.mapPose.rpy },
          },
          poses: parkingPoint.poses.map((point, pointIndex) => ({
            ...point,
            sequence: pointIndex + 1,
            mapPose: {
              frameId: 'map',
              position: { ...point.mapPose.position },
              rpy: { ...point.mapPose.rpy },
            },
            fullBodyJoints: {
              ...point.fullBodyJoints,
              count: Object.keys(point.fullBodyJoints.values).length,
              values: { ...point.fullBodyJoints.values },
            },
          })),
        })),
      })),
    },
    waypoints: waypoints.map((point) => ({
      id: point.id,
      name: point.name,
      pose: { ...point.pose },
      xzy: [point.pose.x, point.pose.z, point.pose.y],
      rpy: [point.pose.roll, point.pose.pitch, point.pose.yaw],
      source: point.source || 'point-cloud-slice',
    })),
    paths: edges.map((edge) => {
      const distance = calculatePathDistances(
        pointById.get(edge.from)?.pose,
        pointById.get(edge.to)?.pose,
      );
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        directed: true,
        limits: { ...edge.limits },
        motion: {
          direction: edge.motion?.direction === 'reverse' ? 'reverse' : 'forward',
          enable3DObstacleAvoidance: edge.motion?.enable3DObstacleAvoidance !== false,
        },
        distance: distance
          ? {
              straight3D: distance.straight3D,
              planarXY: distance.planarXY,
              verticalDelta: distance.verticalDelta,
            }
          : null,
        connectivity: edge.status || 'unchecked',
      };
    }),
  };
}

export function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function clampSlice(slice, bounds) {
  if (!slice || !bounds) return slice;
  const controlBounds = getSliceControlBounds(bounds);
  const low = Math.max(controlBounds.min, Math.min(controlBounds.max, slice[0]));
  const high = Math.max(controlBounds.min, Math.min(controlBounds.max, slice[1]));
  if (low === high) {
    const padding = Math.max((controlBounds.max - controlBounds.min) * 0.05, 0.01);
    return [
      Math.max(controlBounds.min, low - padding),
      Math.min(controlBounds.max, high + padding),
    ];
  }
  return [Math.min(low, high), Math.max(low, high)];
}
