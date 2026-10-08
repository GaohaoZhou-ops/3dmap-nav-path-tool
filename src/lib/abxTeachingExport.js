import { sha256Bytes } from './hash.js';
import { zipSync } from 'fflate';

// Match the current native importer, including automatic component selection.
const VERSION = 15;
const MAX_LINE_BYTES = 12000;
const POSITION_TOLERANCE_M = 1e-6;
const YAW_TOLERANCE_RAD = 1e-6;
const JOINT_ORDER = {
  head: ['yaw', 'pitch'],
  torso: ['ankle_pitch', 'knee_pitch', 'waist_pitch', 'waist_yaw'],
  left_arm: Array.from({ length: 7 }, (_, index) => `J${index + 1}`),
  right_arm: Array.from({ length: 7 }, (_, index) => `J${index + 1}`),
};
const JOINT_NAMES = {
  head: ['head_yaw_J', 'head_pitch_J'],
  torso: ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'],
  left_arm: JOINT_ORDER.left_arm.map((name) => `left_${name}`),
  right_arm: JOINT_ORDER.right_arm.map((name) => `right_${name}`),
};
const BODY_JOINTS = new Set(Object.values(JOINT_NAMES).flat());
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);
const jsonBytes = (value) => bytes(`${JSON.stringify(value, null, 2)}\n`);

class AbxExportError extends Error {}

const requireExport = (condition, message) => {
  if (!condition) throw new AbxExportError(message);
};

const finite = (value, label) => {
  requireExport(typeof value === 'number' && Number.isFinite(value), `${label}必须是有限数值`);
  return value;
};

const text = (value, label, limit = 120) => {
  requireExport(typeof value === 'string' && value.trim()
    && [...value].length <= limit && !/[\x00-\x1f\x7f]/.test(value),
  `${label}不能为空、超过 ${limit} 个字符或包含控制字符`);
  return value;
};

const radians = (value, unit, label) => {
  finite(value, label);
  if (['degree', 'degrees', 'deg'].includes(unit)) return value * (Math.PI / 180);
  requireExport(['radian', 'radians', 'rad'].includes(unit), `${label}的角度单位不受支持：${unit}`);
  return value;
};

const yawDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const wrapYaw = (value) => Math.atan2(Math.sin(value), Math.cos(value));

const timestamp = (value, fallback, label) => {
  const ms = Date.parse(value || fallback);
  requireExport(Number.isSafeInteger(ms) && ms > 0, `${label}时间无效`);
  const ns = BigInt(ms) * 1000000n;
  requireExport(ns <= 9223372036854775807n, `${label}时间超出 ABX 范围`);
  return String(ns);
};

const stableId = async (...parts) => (await sha256Bytes(bytes(JSON.stringify(parts)))).slice(0, 32);

const ordered = (items, label) => {
  requireExport(Array.isArray(items), `${label}列表无效`);
  const ids = new Set();
  return items.map((item, index) => {
    requireExport(item && typeof item.id === 'string' && item.id && !ids.has(item.id), `${label} ID 缺失或重复`);
    ids.add(item.id);
    const sequence = item.sequence ?? index + 1;
    requireExport(Number.isSafeInteger(sequence) && sequence > 0, `${label}顺序无效`);
    return { item, sequence, index };
  }).sort((a, b) => a.sequence - b.sequence || a.index - b.index).map(({ item }) => item);
};

const targetPose = (pose, unit, label) => {
  requireExport(pose && (pose.frameId || 'map') === 'map', `${label}必须使用 map 坐标系`);
  const position = pose.position || pose;
  const rpy = pose.rpy || pose;
  const x = finite(position.x, `${label} X`);
  const y = finite(position.y, `${label} Y`);
  requireExport(Math.abs(x) <= 3.4028234663852886e38 && Math.abs(y) <= 3.4028234663852886e38,
    `${label}坐标超出 ABX 范围`);
  return { x, y, yaw: wrapYaw(radians(rpy.yaw, unit, `${label} yaw`)) };
};

const freeTarget = (pose, unit, label) => {
  const { x, y, yaw } = targetPose(pose, unit, label);
  return { x_m: x, y_m: y, yaw_rad: yaw };
};

const sameTarget = (a, b) => a && b
  && Math.hypot(a.x_m - b.x_m, a.y_m - b.y_m) <= POSITION_TOLERANCE_M
  && yawDistance(a.yaw_rad, b.yaw_rad) <= YAW_TOLERANCE_RAD;

const navigationNotice = '当前大脑仅支持导入站点导航步骤；本包只导入 Pose，自由导航目标保存在 free-navigation.json，导入后不会自动执行导航。';

const robotModel = (robotPackage) => {
  requireExport(robotPackage?.format === 'urdf', 'ABX 示教导出需要完整 URDF 机器人资源');
  const primary = robotPackage.files?.find((file) => file.path === robotPackage.relativePath);
  requireExport(primary, 'ABX 示教导出缺少机器人 URDF');
  const source = new TextDecoder().decode(primary.bytes).replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<robot\b[^>]*>/.exec(source)?.[0];
  const name = tag && /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  return text(name?.[1] || name?.[2], 'URDF 机器人名称', 200);
};

const bodyJoints = (pose, label) => {
  const joints = pose.fullBodyJoints;
  requireExport(joints?.values && typeof joints.values === 'object', `${label}缺少全身关节`);
  const extra = Object.keys(joints.values).filter((name) => !BODY_JOINTS.has(name) && !/^wheel_(LF|LR|RF|RR)_J$/.test(name));
  requireExport(!extra.length, `${label}包含 ABX 20 关节格式无法表达的关节：${extra.join('、')}`);
  return Object.fromEntries(Object.entries(JOINT_NAMES).map(([group, names]) => [group,
    names.map((name) => radians(joints.values[name], joints.angularUnit || 'degree', `${label}关节 ${name}`)),
  ]));
};

const line = (value) => {
  const result = JSON.stringify(value);
  requireExport(bytes(result).length <= MAX_LINE_BYTES, 'ABX 示教记录超过单行 12000 字节上限');
  return `${result}\n`;
};

const instructions = [
  'ABX 机器人 Pose 与自由导航目标',
  '',
  '1. robot-teaching-*.zip 可直接在大脑 Web「示教任务 → 导入」选择；不用解压。',
  '   完整工程 ZIP 中的 abx/ 是同一份数据目录，也可逐个导入 tasks/*.abxteach.ndjson。',
  '   原生任务使用 abx-teaching-task v15，导出清单使用 abx-teaching-export v1。',
  '2. ' + navigationNotice,
  '   执行导入任务只执行上身 Pose，不会移动到底盘目标。导航接入前请按所需位置分别使用自由导航与对应 Pose。',
  '   free-navigation.json 的 waypoints 保存原导航点，tasks[].sequence 保存导航与 Pose 的对应顺序。',
  '   自由导航接口使用 mode=free、x_m、y_m、yaw_rad；run_id 和现场控制权限须由调用端当次取得。',
  '   本导出不调用导航接口、不创建站点路网、不写入大脑目录或数据库。',
  '3. 坐标使用机器人 map 坐标系，X/Y 单位 m，yaw 单位 rad，范围 [-π, π]，逆时针为正。',
  '   现场地图须与虚拟工程地图对齐；原始 Z/roll/pitch、路径及逐边速度约束保存在 source-mapping.json。',
  '   自由导航无需匹配站点或连线；路径及速度约束不是大脑已接受的执行配置。',
  '4. 20 个关节按实际 URDF 名称匹配，head、torso、left_arm、right_arm 转为 rad。',
  '   component=auto 由大脑根据实况判断执行部位；轮组不作为上身关节执行，缺失关节不会补零。',
  '   虚拟 Pose 没有实测定位，parking.location=null，不伪造 SLAM 或里程计。',
  '   robot_received_ns=1 为原生格式占位，robot_sequence 为导出序号，不代表硬件反馈。',
  '5. 基础姿态库不额外新增模板；任务、停车点与 Pose 的名称、顺序以及关节目标保留。',
  '   导入由大脑分配新任务 ID，source-mapping.json 记录源项目到包内任务和 Pose 的对应关系。',
  '   RGB/XYZ 视觉参考仍在完整工程中，不作为真机拍摄记录，也不自动触发相机。',
  '   移动设备 Pose（iPad / Vision Pro） 须先求解为机器人关节姿态，独立示教须先转换到地图坐标后再导出。',
  '6. 导出为当前快照；修改示教数据后请重新导出。原工程 ZIP 继续用于完整备份和恢复。',
  '',
];

const compileExport = async (payload, robotPackage) => {
  const angleUnit = payload.coordinateSystem?.angleUnit || payload.virtualTeaching?.angularUnit || 'degree';
  requireExport(['meter', 'm'].includes(payload.coordinateSystem?.distanceUnit || 'meter'), 'ABX 导出需要米制地图坐标');
  requireExport((payload.coordinateSystem?.frameId || 'map') === 'map', 'ABX 导出需要 map 坐标系');
  const waypoints = ordered(payload.waypoints || [], '导航点').map((point, index) => ({
    sourceId: point.id, name: point.name || point.id, sequence: index + 1,
    target: freeTarget(point.pose, angleUnit, `导航点 ${point.name || point.id}`),
    sourcePose: point.pose,
  }));
  const files = {};
  const exportedAt = payload.exportedAt || new Date().toISOString();
  const tasks = [];
  const taskMappings = [];
  let navigationCount = 0;
  let poseCount = 0;
  const navigationTasks = [];
  for (const task of ordered(payload.virtualTeaching?.tasks || [], '任务')) {
    const name = text(task.name, '任务名称');
    requireExport(!task.mobileCapture?.samples?.length, `任务 ${name}包含 ${task.mobileCapture?.device?.platform === 'visionOS' ? 'Vision Pro 头显 Pose' : 'iPad 相机 Pose'}，尚未转换成机器人关节姿态`);
    requireExport((task.coordinateFrame || 'map') === 'map' && task.map?.teachingSpaceMode !== 'independent', `任务 ${name}不是地图示教`);
    requireExport(!task.map?.sourceHash || !payload.map?.sourceHash || task.map.sourceHash === payload.map.sourceHash,
      `任务 ${name}与当前地图摘要不一致`);
    requireExport(!task.map?.fileName || !payload.map?.fileName || task.map.fileName === payload.map.fileName,
      `任务 ${name}与当前地图文件不一致`);
    const id = await stableId('atlas-abx-task', task.id);
    const parkings = [];
    const points = [];
    const parkingMappings = [];
    const navigationSequence = [];
    let model = null;
    for (const parking of ordered(task.parkingPoints || [], `任务 ${name}的停车点`)) {
      const parkingName = text(parking.name, '停车点名称');
      const label = `${name} / ${parkingName}`;
      const parkingTarget = freeTarget(parking.mapPose, angleUnit, label);
      const parkingId = await stableId('atlas-abx-parking', task.id, parking.id);
      const parkingPoints = [];
      const poseMappings = [];
      let previousTarget = null;
      const append = (record, pointLabel) => {
        const point = { type: 'point', seq: String(points.length + 1), label: pointLabel, record,
          parking_id: parkingId, parking_seq: String(parkingPoints.length + 1) };
        points.push(point);
        parkingPoints.push(point);
        return point;
      };
      for (const pose of ordered(parking.poses || [], `${label}的姿态`)) {
        const poseName = text(pose.name, '姿态名称');
        const poseLabel = `${label} / ${poseName}`;
        const target = freeTarget(pose.mapPose, angleUnit, poseLabel);
        if (!model) {
          const sourceRobot = task.robot?.relativePath || task.robot?.id;
          requireExport(sourceRobot && sourceRobot === robotPackage?.relativePath, `任务 ${name}的机器人与当前 URDF 不一致`);
          model = robotModel(robotPackage);
        }
        const joints = bodyJoints(pose, poseLabel);
        if (!sameTarget(previousTarget, target)) {
          navigationSequence.push({ type: 'free_navigation', mode: 'free', parkingId,
            beforePoseSeq: String(points.length + 1), target });
          previousTarget = target;
          navigationCount += 1;
        }
        const point = append({
          captured_ns: timestamp(pose.capturedAt, exportedAt, poseLabel),
          robot_model: model,
          robot_sequence: String(points.length + 1),
          robot_received_ns: '1',
          joints_rad: joints,
          component: 'auto',
        }, poseName);
        poseCount += 1;
        navigationSequence.push({ type: 'pose', parkingId, seq: point.seq, name: poseName, sourceId: pose.id });
        poseMappings.push({ sourceId: pose.id, name: poseName, seq: point.seq, target, mapPose: pose.mapPose });
      }
      parkings.push({ type: 'parking', id: parkingId, seq: String(parkings.length + 1), name: parkingName,
        created_ns: timestamp(parking.createdAt, task.createdAt || exportedAt, label),
        point_count: String(parkingPoints.length), location: null });
      parkingMappings.push({ sourceId: parking.id, id: parkingId, name: parkingName, target: parkingTarget, mapPose: parking.mapPose, poses: poseMappings });
    }
    requireExport(points.length <= 2000 && parkings.filter((parking) => parking.point_count !== '0').length <= 128,
      `任务 ${name}超过 ABX 单次执行的 2000 步骤或 128 个非空停车点上限`);
    const counts = { point_count: String(points.length), parking_count: String(parkings.length), basic_pose_count: '0' };
    const created = timestamp(task.createdAt, exportedAt, name);
    const body = [...parkings, ...points].map(line).join('');
    const header = { type: 'abx-teaching-task', version: VERSION, name, created_ns: created,
      ...counts, joint_order: JOINT_ORDER, units: { joints: 'rad', position: 'm' } };
    const footer = { type: 'end', ...counts, sha256: await sha256Bytes(bytes(body)) };
    const file = `tasks/${id}.abxteach.ndjson`;
    files[`abx/${file}`] = bytes(line(header) + body + line(footer));
    tasks.push({ id, name, created_ns: created, updated_ns: timestamp(task.updatedAt, task.createdAt || exportedAt, name),
      ...counts, file, image_count: 0 });
    taskMappings.push({ sourceId: task.id, id, file, robotModel: model, parkings: parkingMappings });
    navigationTasks.push({ sourceId: task.id, id, name, file, sequence: navigationSequence, parkings: parkingMappings });
  }
  files['abx/manifest.json'] = jsonBytes({ schema: 'abx-teaching-export', version: 1, exported_utc: exportedAt,
    include_images: false, tasks, images: [], pending_captures: 0 });
  files['abx/free-navigation.json'] = jsonBytes({ schema: 'atlas-abx-free-navigation-targets', version: 1,
    exportedAt, mode: 'free', coordinateFrame: 'map', units: { position: 'm', yaw: 'rad' },
    nativeTaskNavigationSupported: false, notice: navigationNotice,
    map: payload.map, waypoints, tasks: navigationTasks });
  files['abx/source-mapping.json'] = jsonBytes({ schema: 'atlas-abx-export-mapping', version: 2,
    exportedAt, sourceProject: 'config/project.json', map: payload.map,
    navigationMode: 'free', waypoints, paths: payload.paths || [], tasks: taskMappings });
  files['abx/README.txt'] = bytes(instructions.join('\n'));
  return { files, summary: { status: 'ready', navigationMode: 'free', navigationImportSupported: false,
    taskCount: tasks.length, poseCount, waypointCount: waypoints.length, navigationCount,
    notice: navigationNotice, manifestFile: 'abx/manifest.json', navigationFile: 'abx/free-navigation.json' } };
};

// Conversion is atomic: an incompatible task never leaves a partial native
// bundle, while the existing Atlas backup remains available to the operator.
export async function buildAbxTeachingExport(payload, { robotPackage = null } = {}) {
  const mode = payload.teachingSpace?.mode || payload.workspace?.teachingSpaceMode || payload.map?.teachingSpaceMode || 'map';
  if (mode !== 'map') return null;
  try {
    return await compileExport(payload, robotPackage);
  } catch (error) {
    if (!(error instanceof AbxExportError)) throw error;
    const summary = { status: 'blocked', message: error.message };
    return { summary, files: {
      'abx/export-status.json': jsonBytes(summary),
      'abx/README.txt': bytes(`ABX 任务文件未生成：${error.message}\n\n原始工程备份完整保留。修正数据后重新点击「导出 ZIP」。\n`),
    } };
  }
}

// The Brain ZIP reader expects its own manifest at the root. An Atlas project
// archive has a different manifest and must never be presented as this bundle.
export async function buildAbxTeachingArchive(payload, options = {}) {
  const result = await buildAbxTeachingExport(payload, options);
  requireExport(result, '请先将独立示教转换到地图示教，再导出机器人示教数据');
  requireExport(result.summary.status === 'ready', result.summary.message);
  requireExport(result.summary.taskCount >= 1 && result.summary.taskCount <= 100, '机器人示教导入包需要包含 1–100 个任务');
  const files = Object.fromEntries(Object.entries(result.files).map(([name, data]) => [name.slice('abx/'.length), data]));
  const archiveBytes = zipSync(files, { level: 0 });
  return { ...result, files, bytes: archiveBytes, byteLength: archiveBytes.length,
    blob: new Blob([archiveBytes], { type: 'application/zip' }) };
}

// Only the primary URDF is needed for the model identity; meshes are not part
// of a native teaching bundle and need not be fetched again.
export async function readAbxRobotPackage(robot, existingPackage, { signal } = {}) {
  if (!robot) return null;
  const relativePath = robot.relativePath || robot.id;
  requireExport(robot.format === 'urdf', '机器人示教导出需要 URDF 机器人描述');
  const primary = existingPackage?.relativePath === relativePath
    && existingPackage.files?.find((file) => file.path === relativePath);
  if (primary) return { relativePath, format: 'urdf', files: [primary] };
  requireExport(robot.url, '缺少机器人 URDF 地址，请重新加载机器人后导出');
  const response = await fetch(robot.url, { signal });
  requireExport(response.ok, `无法读取机器人 URDF（HTTP ${response.status}）`);
  return { relativePath, format: 'urdf', files: [{ path: relativePath, bytes: new Uint8Array(await response.arrayBuffer()) }] };
}
