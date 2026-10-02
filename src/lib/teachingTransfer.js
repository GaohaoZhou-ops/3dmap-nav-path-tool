import { Euler, Matrix4, Quaternion, Vector3, MathUtils } from 'three';
import { buildExport, createId, normalizeProject, teachingCoordinateFrame } from './io.js';
import { sha256Bytes } from './hash.js';

const axes = ['x', 'y', 'z'];
const rotationAxes = ['roll', 'pitch', 'yaw'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
const hashObject = (value) => sha256Bytes(new TextEncoder().encode(
  JSON.stringify(value, (key, item) => key === 'sequence' ? undefined : item),
));

export const identityTransferPose = () => ({
  position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 },
});

export function transferMatrix(pose) {
  requireValue(axes.every((axis) => Number.isFinite(pose?.position?.[axis]))
    && rotationAxes.every((axis) => Number.isFinite(pose?.rpy?.[axis])), '位置和角度必须是有效数值');
  return new Matrix4().compose(
    new Vector3(...axes.map((axis) => pose.position[axis])),
    new Quaternion().setFromEuler(new Euler(
      ...rotationAxes.map((axis) => MathUtils.degToRad(pose.rpy[axis])), 'ZYX',
    )),
    new Vector3(1, 1, 1),
  );
}

export function transformTeachingPose(pose, matrix, frameId) {
  const composed = matrix.clone().multiply(transferMatrix(pose));
  const position = new Vector3().setFromMatrixPosition(composed);
  const angles = new Euler().setFromRotationMatrix(composed, 'ZYX');
  return {
    ...(frameId ? { frameId } : {}),
    position: { x: position.x, y: position.y, z: position.z },
    rpy: { roll: MathUtils.radToDeg(angles.x), pitch: MathUtils.radToDeg(angles.y), yaw: MathUtils.radToDeg(angles.z) },
  };
}

export function placementTransform(destinationPose, sourceAnchor = identityTransferPose()) {
  return transformTeachingPose(identityTransferPose(), transferMatrix(destinationPose)
    .multiply(transferMatrix(sourceAnchor).invert()));
}

export function insideTransferBounds(position, bounds) {
  return axes.every((axis) => position[axis] >= bounds.min[axis] && position[axis] <= bounds.max[axis]);
}

export function validateTransferBounds(bounds) {
  requireValue(axes.every((axis) => Number.isFinite(bounds?.min?.[axis])
    && Number.isFinite(bounds?.max?.[axis]) && bounds.min[axis] <= bounds.max[axis]), '裁剪范围无效：最小值不能大于最大值');
  requireValue(bounds.max.x > bounds.min.x && bounds.max.y > bounds.min.y, '请框选一个有面积的区域');
}

const transformOpticalPose = (pose, matrix) => {
  const position = new Vector3(pose.position.x, pose.position.y, pose.position.z).applyMatrix4(matrix);
  const quaternion = new Quaternion().setFromRotationMatrix(matrix).multiply(
    new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w),
  ).normalize();
  return { ...pose, position: { x: position.x, y: position.y, z: position.z },
    quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w } };
};

export function transformTeachingTasks(tasks, matrix, mode, map) {
  const frame = teachingCoordinateFrame(mode);
  const pose = (value) => transformTeachingPose(value, matrix, frame);
  return tasks.map((task) => ({
    ...task, coordinateFrame: frame,
    map: { id: map.mapId, fileName: map.name, sourceHash: map.sourceHash, teachingSpaceMode: mode, coordinateFrame: frame },
    parkingPoints: task.parkingPoints.map((parking) => ({
      ...parking, mapPose: pose(parking.mapPose),
      mergeHistory: parking.mergeHistory.map((entry) => ({ ...entry,
        sourceParkingPoints: entry.sourceParkingPoints.map((source) => ({ ...source, mapPose: pose(source.mapPose) })),
      })),
      poses: parking.poses.map((point) => ({
        ...point, mapPose: pose(point.mapPose),
        opticalTargets: Object.fromEntries(Object.entries(point.opticalTargets || {})
          .map(([side, target]) => [side, transformOpticalPose(target, matrix)])),
        cameraCapture: point.cameraCapture ? { ...point.cameraCapture,
          // RGB and camera-local XYZ stay unchanged; only the camera's world pose moves.
          frames: Object.fromEntries(Object.entries(point.cameraCapture.frames).map(([side, camera]) => [side, {
            ...camera, opticalPose: transformOpticalPose(camera.opticalPose, matrix),
          }])),
        } : null,
        replanningHistory: point.replanningHistory.map((entry) => ({ ...entry,
          sourceMapPose: pose(entry.sourceMapPose), commonMapPose: pose(entry.commonMapPose),
        })),
      })),
    })),
  }));
}

const transformWaypoints = (points, matrix) => points.map((point) => {
  const pose = transformTeachingPose({ position: point.pose,
    rpy: { roll: point.pose.roll, pitch: point.pose.pitch, yaw: point.pose.yaw } }, matrix);
  return { ...point, pose: { ...pose.position, ...pose.rpy } };
});

const positionsOf = (map) => {
  requireValue(map?.positionBuffer instanceof ArrayBuffer, '请先打开包含完整点云的工程');
  const positions = new Float32Array(map.positionBuffer);
  requireValue(positions.length > 0 && positions.length % 3 === 0, '工程点云数据不完整');
  return positions;
};
const indicesOf = (map) => map.indexBuffer instanceof ArrayBuffer
  ? map.indexComponentType === 'uint16' ? new Uint16Array(map.indexBuffer) : new Uint32Array(map.indexBuffer)
  : new Uint32Array();
const colorsOf = (map) => map.colorBuffer instanceof ArrayBuffer ? new Uint8Array(map.colorBuffer) : null;

async function geometryRecord(name, positions, colors, indices, mode, robotPackage) {
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis];
      requireValue(Number.isFinite(value), '转换后的点云含无效坐标，请检查位置数值');
      bounds.min[axes[axis]] = Math.min(bounds.min[axes[axis]], value);
      bounds.max[axes[axis]] = Math.max(bounds.max[axes[axis]], value);
    }
    if (offset && offset % 750000 === 0) await yieldToUI();
  }
  const hashes = await Promise.all([positions, colors || new Uint8Array(), indices].map(sha256Bytes));
  return {
    name, mapId: createId('map-transfer'), geometryCacheVersion: 1,
    positionBuffer: positions.buffer, colorBuffer: colors?.buffer || null,
    indexBuffer: indices.length ? indices.buffer : null, indexComponentType: 'uint32',
    pointCount: positions.length / 3, faceCount: indices.length / 3, bounds,
    byteLength: positions.byteLength + (colors?.byteLength || 0) + indices.byteLength,
    sourceHash: await hashObject(hashes), sourceHashKind: 'geometry',
    sourceKind: 'teaching-transfer', sourceBlob: null, loadedAt: new Date().toISOString(),
    teachingSpaceMode: mode, coordinateFrame: teachingCoordinateFrame(mode),
    portableRobotPackage: robotPackage || null,
  };
}

export async function cropTeachingGeometry(map, bounds, localToMap, name = `${map.name.replace(/\.ply$/i, '')}-local.ply`) {
  validateTransferBounds(bounds);
  const source = positionsOf(map);
  const sourceColors = colorsOf(map);
  const sourceIndices = indicesOf(map);
  const remap = new Int32Array(source.length / 3).fill(-1);
  let count = 0;
  for (let index = 0; index < remap.length; index += 1) {
    if (insideTransferBounds({ x: source[index * 3], y: source[index * 3 + 1], z: source[index * 3 + 2] }, bounds)) remap[index] = count++;
    if (index && index % 250000 === 0) await yieldToUI();
  }
  requireValue(count > 0, '选定范围内没有点云，请扩大裁剪范围');
  const positions = new Float32Array(count * 3);
  const colors = sourceColors ? new Uint8Array(count * 3) : null;
  const inverse = transferMatrix(localToMap).invert();
  const point = new Vector3();
  for (let index = 0; index < remap.length; index += 1) {
    if (remap[index] < 0) continue;
    const offset = remap[index] * 3;
    point.fromArray(source, index * 3).applyMatrix4(inverse).toArray(positions, offset);
    if (colors) colors.set(sourceColors.subarray(index * 3, index * 3 + 3), offset);
    if (index && index % 250000 === 0) await yieldToUI();
  }
  const faces = [];
  for (let index = 0; index < sourceIndices.length; index += 3) {
    const a = remap[sourceIndices[index]], b = remap[sourceIndices[index + 1]], c = remap[sourceIndices[index + 2]];
    if (a >= 0 && b >= 0 && c >= 0) faces.push(a, b, c);
  }
  return geometryRecord(name, positions, colors, Uint32Array.from(faces), 'independent', map.portableRobotPackage);
}

export async function placeTeachingGeometry(source, target, localToMap) {
  const background = positionsOf(target), local = positionsOf(source);
  const positions = new Float32Array(background.length + local.length);
  positions.set(background);
  const matrix = transferMatrix(localToMap), point = new Vector3();
  for (let offset = 0; offset < local.length; offset += 3) {
    point.fromArray(local, offset).applyMatrix4(matrix).toArray(positions, background.length + offset);
    if (offset && offset % 750000 === 0) await yieldToUI();
  }
  const sourceColors = colorsOf(source), targetColors = colorsOf(target);
  const colors = sourceColors || targetColors ? new Uint8Array(positions.length).fill(255) : null;
  if (targetColors) colors.set(targetColors);
  if (sourceColors) colors.set(sourceColors, background.length);
  const backgroundIndices = indicesOf(target), localIndices = indicesOf(source);
  const indices = new Uint32Array(backgroundIndices.length + localIndices.length);
  indices.set(backgroundIndices);
  for (let index = 0; index < localIndices.length; index += 1) indices[backgroundIndices.length + index] = localIndices[index] + background.length / 3;
  return geometryRecord(target.name, positions, colors, indices, 'map', source.portableRobotPackage || target.portableRobotPackage);
}

const snapshotProject = (snapshot) => {
  requireValue(snapshot?.config?.config?.project, '工程配置尚未保存，请稍后再试');
  return normalizeProject(snapshot.config.config.project);
};

const mapIdentity = async (map) => ({
  name: map.name, mapId: map.mapId,
  sourceHash: map.sourceHash || await sha256Bytes(positionsOf(map)),
});

function snapshotResult(project, map, mode, transfer, suspended = true) {
  const payload = buildExport({
    ...project, mapData: map,
    heightRange: project.slice || [map.bounds.min.z, map.bounds.max.z],
    robotPose: project.robot?.origin, robotJointValues: project.robot?.joints,
    lockedRobotJointNames: project.robot?.lockedJoints, robotHeightLocked: project.robot?.heightLocked,
    ...project.workspace, teachingSpaceMode: mode,
    meshRenderQuality: project.rendering?.meshQuality || 'auto',
    transfer, directoryAutosaveSuspended: suspended,
  });
  const ui = {
    ...payload.workspace, mode: 'select', selectedWaypointId: null, selectedEdgeId: null, connectionSourceId: null,
    meshRenderQuality: payload.rendering.meshQuality, validation: { status: 'idle', unreachableCount: 0, checkedAt: null },
    robotHeightLocked: payload.robot?.heightLocked === true, selectedRobot: payload.robot,
  };
  return { map, config: { schemaVersion: 1, project: payload, ui }, mode };
}

async function createBaseline(project) {
  return {
    tasks: await Promise.all(project.teachingTasks.map(async (task) => ({
      id: task.id, name: task.name,
      parkingPoints: await Promise.all(task.parkingPoints.map(async (point) => ({ id: point.id, hash: await hashObject(point) }))),
    }))),
    waypoints: await Promise.all(project.waypoints.map(async (point) => ({ id: point.id, hash: await hashObject(point) }))),
    edges: await Promise.all(project.edges.map(async (edge) => ({ id: edge.id, hash: await hashObject(edge) }))),
    jointPoses: await Promise.all((project.jointPoses || []).map(async (pose) => ({ id: pose.id, hash: await hashObject(pose) }))),
  };
}

export async function extractTeachingWorkspace(source, { bounds, localToMap, name }) {
  const project = snapshotProject(source);
  requireValue(project.workspace.teachingSpaceMode === 'map', '只能从地图示教提取局部工程');
  const map = await cropTeachingGeometry(source.map, bounds, localToMap, name);
  const selected = {
    ...project,
    teachingTasks: project.teachingTasks.map((task) => ({ ...task,
      parkingPoints: task.parkingPoints.filter((point) => insideTransferBounds(point.mapPose.position, bounds)),
    })).filter((task) => task.parkingPoints.length),
    waypoints: project.waypoints.filter((point) => insideTransferBounds(point.pose, bounds)),
  };
  const ids = new Set(selected.waypoints.map((point) => point.id));
  selected.edges = project.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const transfer = { version: 1, kind: 'extraction', id: createId('transfer'),
    sourceMap: await mapIdentity(source.map), localToMap, bounds,
    createdAt: new Date().toISOString(), baseline: await createBaseline(selected),
    robotPath: project.robot?.relativePath || null,
  };
  const inverse = transferMatrix(localToMap).invert();
  return snapshotResult({ ...selected,
    robot: project.robot ? { ...project.robot, origin: transformTeachingPose(project.robot.origin, inverse) } : null,
    teachingTasks: transformTeachingTasks(selected.teachingTasks, inverse, 'independent', map),
    waypoints: transformWaypoints(selected.waypoints, inverse),
    edges: selected.edges.map((edge) => ({ ...edge, status: 'unchecked' })),
    slice: [map.bounds.min.z, map.bounds.max.z], view2d: null, view3d: null,
  }, map, 'independent', transfer);
}

function assertRobotCompatibility(source, target) {
  if (!source.robot || !target.robot || !target.teachingTasks.length) return;
  requireValue(source.robot.relativePath === target.robot.relativePath,
    '两个工程使用不同机器人；请先在地图工程中选择相同机器人，再转换示教内容');
}

export async function placeTeachingWorkspace(source, target, { localToMap }) {
  const local = snapshotProject(source), background = snapshotProject(target);
  requireValue(local.workspace.teachingSpaceMode === 'independent' && background.workspace.teachingSpaceMode === 'map', '请选择独立工程和目标地图工程');
  assertRobotCompatibility(local, background);
  const map = await placeTeachingGeometry(source.map, target.map, localToMap);
  const matrix = transferMatrix(localToMap);
  const remap = new Map();
  const newId = (id) => { if (!remap.has(id)) remap.set(id, createId('transferred')); return remap.get(id); };
  const importedTasks = transformTeachingTasks(local.teachingTasks, matrix, 'map', map).map((task) => ({ ...task,
    id: newId(task.id), parkingPoints: task.parkingPoints.map((point) => ({ ...point,
      id: newId(point.id), poses: point.poses.map((pose) => ({ ...pose, id: newId(pose.id) })),
    })),
  }));
  const points = transformWaypoints(local.waypoints, matrix).map((point) => ({ ...point, id: newId(point.id) }));
  const sourceRobot = local.robot || background.robot;
  map.portableRobotPackage = [source.map.portableRobotPackage, target.map.portableRobotPackage]
    .find((candidate) => candidate?.relativePath === sourceRobot?.relativePath) || null;
  const result = snapshotResult({ ...background,
    robot: local.robot ? { ...local.robot, origin: transformTeachingPose(local.robot.origin, matrix) } : sourceRobot,
    teachingTasks: [...transformTeachingTasks(background.teachingTasks, new Matrix4(), 'map', map), ...importedTasks],
    waypoints: [...background.waypoints, ...points],
    edges: [...background.edges, ...local.edges.map((edge) => ({ ...edge, id: newId(edge.id), from: newId(edge.from), to: newId(edge.to), status: 'unchecked' }))],
    jointPoses: [...background.jointPoses, ...local.jointPoses.map((pose) => ({ ...pose, id: newId(pose.id) }))],
    workspace: { ...background.workspace,
      activeTeachingTaskId: importedTasks[0]?.id || background.workspace.activeTeachingTaskId,
      activeTeachingParkingPointId: importedTasks[0]?.parkingPoints[0]?.id || null,
    },
  }, map, 'map', { version: 1, kind: 'placement', id: createId('transfer'),
    sourceMap: await mapIdentity(source.map), localToMap, createdAt: new Date().toISOString(),
  });
  return result;
}

async function verifyBaseline(baseline, project) {
  const verifyItems = async (saved, current) => {
    const byId = new Map(current.map((item) => [item.id, item]));
    for (const item of saved) {
      requireValue(byId.has(item.id) && await hashObject(byId.get(item.id)) === item.hash,
        '原地图中的对应内容已修改，无法直接回写；请重新提取局部以避免覆盖修改');
    }
  };
  for (const saved of baseline.tasks) {
    const task = project.teachingTasks.find((item) => item.id === saved.id);
    requireValue(task, '原地图中的来源任务已删除，请重新提取局部');
    await verifyItems(saved.parkingPoints, task.parkingPoints);
  }
  await verifyItems(baseline.waypoints, project.waypoints);
  await verifyItems(baseline.edges, project.edges);
  await verifyItems(baseline.jointPoses || [], project.jointPoses);
}

export async function writeBackTeachingWorkspace(source, target) {
  const local = snapshotProject(source), background = snapshotProject(target);
  const transfer = local.workspace.transfer;
  requireValue(transfer?.version === 1 && transfer.kind === 'extraction', '当前工程没有可回写的地图来源');
  requireValue((await mapIdentity(target.map)).sourceHash === transfer.sourceMap.sourceHash,
    '当前地图不是提取时的原地图，请先打开对应地图工程');
  requireValue((local.robot?.relativePath || null) === transfer.robotPath, '局部工程已更换机器人，请使用提取时的机器人进行回写');
  assertRobotCompatibility(local, background);
  await verifyBaseline(transfer.baseline, background);
  const matrix = transferMatrix(transfer.localToMap);
  const tasks = transformTeachingTasks(local.teachingTasks, matrix, 'map', target.map);
  const selectedTaskIds = new Set(transfer.baseline.tasks.map((task) => task.id));
  const targetTaskIds = new Set(background.teachingTasks.map((task) => task.id));
  for (const task of tasks) requireValue(selectedTaskIds.has(task.id) || !targetTaskIds.has(task.id), '新增任务与原地图 ID 冲突，请重新创建该任务');
  const mergedTasks = background.teachingTasks.map((task) => {
    const saved = transfer.baseline.tasks.find((item) => item.id === task.id);
    if (!saved) return task;
    const edited = tasks.find((item) => item.id === task.id);
    const selected = new Set(saved.parkingPoints.map((item) => item.id));
    const untouched = task.parkingPoints.filter((point) => !selected.has(point.id));
    const untouchedIds = new Set(untouched.map((point) => point.id));
    requireValue(!edited?.parkingPoints.some((point) => untouchedIds.has(point.id)), '局部停车点与原地图其他停车点 ID 冲突');
    requireValue(!edited || edited.name === saved.name || task.name === saved.name || task.name === edited.name,
      '任务名称在两种模式下都已修改，请统一名称后回写');
    const edits = new Map((edited?.parkingPoints || []).map((point) => [point.id, point]));
    const parkingPoints = task.parkingPoints.flatMap((point) => selected.has(point.id)
      ? edits.has(point.id) ? [edits.get(point.id)] : [] : [point]);
    parkingPoints.push(...(edited?.parkingPoints || []).filter((point) => !selected.has(point.id)));
    return { ...task, name: edited && edited.name !== saved.name ? edited.name : task.name,
      parkingPoints, updatedAt: new Date().toISOString() };
  }).filter((task) => !selectedTaskIds.has(task.id) || task.parkingPoints.length || tasks.some((edited) => edited.id === task.id));
  mergedTasks.push(...tasks.filter((task) => !selectedTaskIds.has(task.id)));
  const mergeGraph = (original, edited, saved) => {
    const selected = new Set(saved.map((item) => item.id));
    const untouched = original.filter((item) => !selected.has(item.id));
    const used = new Set(untouched.map((item) => item.id));
    requireValue(!edited.some((item) => used.has(item.id)), '局部数据与原地图 ID 冲突');
    return [...untouched, ...edited];
  };
  const points = transformWaypoints(local.waypoints, matrix);
  const waypoints = mergeGraph(background.waypoints, points, transfer.baseline.waypoints);
  const pointIds = new Set(waypoints.map((point) => point.id));
  const touchedPoints = new Set([...points, ...transfer.baseline.waypoints].map((point) => point.id));
  const edges = mergeGraph(background.edges, local.edges, transfer.baseline.edges)
    .filter((edge) => pointIds.has(edge.from) && pointIds.has(edge.to))
    .map((edge) => ({ ...edge, status: touchedPoints.has(edge.from) || touchedPoints.has(edge.to) ? 'unchecked' : edge.status }));
  const nextProject = { ...background, teachingTasks: mergedTasks, waypoints, edges,
    robot: local.robot ? { ...local.robot, origin: transformTeachingPose(local.robot.origin, matrix) } : background.robot,
    jointPoses: mergeGraph(background.jointPoses, local.jointPoses, transfer.baseline.jointPoses || []),
  };
  const result = snapshotResult(nextProject, { ...target.map,
    portableRobotPackage: source.map.portableRobotPackage || target.map.portableRobotPackage,
  }, 'map', background.workspace.transfer, background.workspace.directoryAutosaveSuspended);
  const savedProject = normalizeProject(result.config.project);
  const updatedBaseline = await createBaseline({
    teachingTasks: savedProject.teachingTasks.flatMap((task) => {
      const localTask = tasks.find((item) => item.id === task.id);
      if (!localTask) return [];
      const parkingIds = new Set(localTask.parkingPoints.map((point) => point.id));
      return [{ ...task, parkingPoints: task.parkingPoints.filter((point) => parkingIds.has(point.id)) }];
    }),
    waypoints: savedProject.waypoints.filter((point) => points.some((localPoint) => localPoint.id === point.id)),
    edges: savedProject.edges.filter((edge) => local.edges.some((localEdge) => localEdge.id === edge.id)),
    jointPoses: savedProject.jointPoses.filter((pose) => local.jointPoses.some((localPose) => localPose.id === pose.id)),
  });
  result.sourceConfig = { ...source.config.config,
    project: { ...source.config.config.project,
      virtualTeaching: { ...source.config.config.project.virtualTeaching,
        tasks: source.config.config.project.virtualTeaching.tasks.map((task) => ({ ...task,
          name: savedProject.teachingTasks.find((item) => item.id === task.id)?.name || task.name,
        })),
      },
      workspace: { ...source.config.config.project.workspace,
        transfer: { ...transfer, baseline: updatedBaseline, lastWrittenAt: new Date().toISOString() },
      },
    },
  };
  return result;
}
