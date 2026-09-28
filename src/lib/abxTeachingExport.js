import { sha256Bytes } from './hash.js';
import { pathExists } from './graph.js';

// v11 is the first ABX task format supporting poses without measured SLAM data.
const VERSION = 11;
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

const buildGraph = (payload, angleUnit) => {
  const waypoints = ordered(payload.waypoints || [], '导航点');
  const paths = ordered(payload.paths || [], '路径');
  requireExport(waypoints.length <= 512 && paths.length <= 4096, 'ABX 路网最多支持 512 个导航点、4096 条路径');
  const nodes = waypoints.map((point, id) => ({
    id, sourceId: point.id, name: point.name, ...targetPose(point.pose, angleUnit, `导航点 ${point.name || point.id}`),
  }));
  const bySourceId = new Map(nodes.map((node) => [node.sourceId, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const features = nodes.map((node) => ({
    type: 'Feature', properties: { id: node.id, frame: 'map' },
    geometry: { type: 'Point', coordinates: [node.x, node.y] },
  }));
  const edges = paths.map((path, index) => {
    const from = bySourceId.get(path.from);
    const to = bySourceId.get(path.to);
    requireExport(from && to && from !== to, `路径 ${path.id}引用了无效导航点`);
    requireExport(path.directed !== false, `路径 ${path.id}需要显式有向连线`);
    requireExport(!path.motion?.direction || path.motion.direction === 'forward',
      `路径 ${path.id}配置了倒车，当前 ABX 路网任务格式不能表达此运动设置`);
    requireExport(path.motion?.enable3DObstacleAvoidance !== false,
      `路径 ${path.id}关闭了 3D 避障，当前 ABX 路网任务格式不能表达此运动设置`);
    adjacency.get(from.id).push(to.id);
    const id = nodes.length + index;
    features.push({
      type: 'Feature',
      properties: { id, startid: from.id, endid: to.id, cost: 0, overridable: true },
      geometry: { type: 'MultiLineString', coordinates: [[[from.x, from.y], [to.x, to.y]]] },
    });
    return { id, sourceId: path.id, from: from.id, to: to.id, limits: path.limits, motion: path.motion };
  });
  const route = { type: 'FeatureCollection', features };
  const yaw = { features: nodes.map((node) => ({ id: node.id, pos: [node.x, node.y, node.yaw] })) };
  const routeBytes = jsonBytes(route);
  const yawBytes = jsonBytes(yaw);
  requireExport(routeBytes.length <= 512 * 1024 && yawBytes.length <= 512 * 1024, 'ABX 路网文件超过 512 KiB');
  return { nodes, edges, adjacency, routeBytes, yawBytes };
};

const matchNode = (graph, pose, angleUnit, label) => {
  const target = targetPose(pose, angleUnit, label);
  const matches = graph.nodes.filter((node) => Math.hypot(node.x - target.x, node.y - target.y) <= POSITION_TOLERANCE_M
    && yawDistance(node.yaw, target.yaw) <= YAW_TOLERANCE_RAD);
  requireExport(matches.length === 1, matches.length
    ? `${label}对应多个导航点，无法唯一匹配`
    : `${label}无法匹配已有导航点的 X/Y/yaw，请在现有导航图中核对坐标和朝向`);
  return matches[0];
};

const robotModel = (robotPackage) => {
  requireExport(robotPackage?.format === 'urdf', 'ABX 示教导出需要完整 URDF 机器人资源');
  const primary = robotPackage.files.find((file) => file.path === robotPackage.relativePath);
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
  'ABX 地图示教导出',
  '',
  '1. manifest.json 使用 abx-teaching-export v1；tasks/*.abxteach.ndjson 使用 abx-teaching-task v11。',
  '2. 在对应机器人/实例的 ABX Web「示教任务」中逐个导入 tasks/ 下的文件。不要将整个工程 ZIP 当作 NDJSON 导入。',
  '   大脑的存储服务会写入当前 abxpipeline 分支配置的任务库：',
  '   真机通常为 teaching/<robot_id>.sqlite3；Mock 为 simulation/<deployment_id>/teaching.sqlite3。',
  '   不覆盖现有 SQLite，也不向 workflows/ 写入不受支持的运动步骤。导入会分配新的任务 ID。',
  '3. graph_route.geojson / graph_yaw.geojson 仅转换工程中已有的导航图，不自动创建停车点连线。',
  '   使用前由部署方核对地图，并将两文件放到 ABXBrainSystem 同级目录及对应 RouteServer 中；本导出不会安装或上传路网。',
  '   X/Y 单位 m、yaw 单位 rad；匹配容差为 1e-6 m / 1e-6 rad，不将附近但不同的停车姿态吸附到路网。',
  '4. 每个有姿态的停车点先执行显式 route_navigation；同组姿态的底盘目标变化时也插入导航。',
  '   导航只控制 X/Y/yaw。原始 Z/roll/pitch、完整关节和视觉参考仍保存在原工程及 source-mapping.json 中。',
  '   速度、加速度由大脑/RouteServer 的实例配置决定；本地路径 limits 留作对照，不宣称这些字段会被大脑执行。',
  '5. 关节按 head、torso、left_arm、right_arm 的固定顺序转为 rad；轮子转角由导航控制，不作为全身姿态执行。',
  '   虚拟姿态没有实测定位：parking.location 为 null，姿态不伪造 SLAM/里程计。robot_received_ns=1 是格式占位，robot_sequence 是导出序号。',
  '   RGB/XYZ 是虚拟参考快照，继续位于工程 teaching-data/，不伪造真实采集记录，也不自动添加真机拍照动作。',
  '6. 本目录是点击「导出 ZIP」时的快照。工程目录自动保存不更新 ABX 文件；修改示教后须重新导出 ZIP。',
  '',
];

const compileExport = async (payload, robotPackage) => {
  const angleUnit = payload.coordinateSystem?.angleUnit || payload.virtualTeaching?.angularUnit || 'degree';
  requireExport(['meter', 'm'].includes(payload.coordinateSystem?.distanceUnit || 'meter'), 'ABX 导出需要米制地图坐标');
  requireExport((payload.coordinateSystem?.frameId || 'map') === 'map', 'ABX 导出需要 map 坐标系');
  const graph = buildGraph(payload, angleUnit);
  const files = {};
  if (graph.nodes.length) {
    files['abx/graph_route.geojson'] = graph.routeBytes;
    files['abx/graph_yaw.geojson'] = graph.yawBytes;
  }
  const exportedAt = payload.exportedAt || new Date().toISOString();
  const tasks = [];
  const taskMappings = [];
  let navigationCount = 0;
  for (const task of ordered(payload.virtualTeaching?.tasks || [], '任务')) {
    const name = text(task.name, '任务名称');
    requireExport((task.coordinateFrame || 'map') === 'map' && task.map?.teachingSpaceMode !== 'independent', `任务 ${name}不是地图示教`);
    requireExport(!task.map?.sourceHash || !payload.map?.sourceHash || task.map.sourceHash === payload.map.sourceHash,
      `任务 ${name}与当前地图摘要不一致`);
    requireExport(!task.map?.fileName || !payload.map?.fileName || task.map.fileName === payload.map.fileName,
      `任务 ${name}与当前地图文件不一致`);
    const id = await stableId('atlas-abx-task', task.id);
    const parkings = [];
    const points = [];
    const parkingMappings = [];
    let previousNode = null;
    let model = null;
    for (const parking of ordered(task.parkingPoints || [], `任务 ${name}的停车点`)) {
      const parkingName = text(parking.name, '停车点名称');
      const label = `${name} / ${parkingName}`;
      const node = matchNode(graph, parking.mapPose, angleUnit, label);
      const parkingId = await stableId('atlas-abx-parking', task.id, parking.id);
      const parkingPoints = [];
      const poseMappings = [];
      let parkingNode = null;
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
        const target = matchNode(graph, pose.mapPose, angleUnit, poseLabel);
        if (!model) {
          const sourceRobot = task.robot?.relativePath || task.robot?.id;
          requireExport(sourceRobot && sourceRobot === robotPackage?.relativePath, `任务 ${name}的机器人与当前 URDF 不一致`);
          model = robotModel(robotPackage);
        }
        const joints = bodyJoints(pose, poseLabel);
        if (parkingNode !== target.id) {
          requireExport(previousNode === null || pathExists(graph.adjacency, previousNode, target.id),
            `${poseLabel}在已有单向路网中无法从 N${previousNode}到达 N${target.id}`);
          append({ type: 'route_navigation', node_id: `N${target.id}` }, `导航至 N${target.id}`);
          previousNode = parkingNode = target.id;
          navigationCount += 1;
        }
        const point = append({
          captured_ns: timestamp(pose.capturedAt, exportedAt, poseLabel),
          robot_model: model,
          robot_sequence: String(points.length + 1),
          robot_received_ns: '1',
          joints_rad: joints,
        }, poseName);
        poseMappings.push({ sourceId: pose.id, seq: point.seq, nodeId: target.id, mapPose: pose.mapPose });
      }
      parkings.push({ type: 'parking', id: parkingId, seq: String(parkings.length + 1), name: parkingName,
        created_ns: timestamp(parking.createdAt, task.createdAt || exportedAt, label),
        point_count: String(parkingPoints.length), location: null });
      parkingMappings.push({ sourceId: parking.id, id: parkingId, nodeId: node.id, mapPose: parking.mapPose, poses: poseMappings });
    }
    requireExport(points.length <= 2000 && parkings.filter((parking) => parking.point_count !== '0').length <= 128,
      `任务 ${name}超过 ABX 单次执行的 2000 步骤或 128 个非空停车点上限`);
    const counts = { point_count: String(points.length), parking_count: String(parkings.length) };
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
  }
  files['abx/manifest.json'] = jsonBytes({ schema: 'abx-teaching-export', version: 1, exported_utc: exportedAt,
    include_images: false, tasks, images: [], pending_captures: 0 });
  files['abx/source-mapping.json'] = jsonBytes({ schema: 'atlas-abx-export-mapping', version: 1,
    exportedAt, sourceProject: 'config/project.json', map: payload.map,
    matching: { positionToleranceM: POSITION_TOLERANCE_M, yawToleranceRad: YAW_TOLERANCE_RAD },
    nodes: graph.nodes, paths: graph.edges, tasks: taskMappings });
  files['abx/README.txt'] = bytes(instructions.join('\n'));
  return { files, summary: { status: 'ready', taskCount: tasks.length, navigationCount, manifestFile: 'abx/manifest.json' } };
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
