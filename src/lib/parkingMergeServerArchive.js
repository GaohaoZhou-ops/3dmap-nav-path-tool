import { strFromU8, strToU8, unzip, zip } from 'fflate';
import computeScript from '../cluster/compute_parking_merge.py?raw';
import runScript from '../cluster/run_cluster.sh?raw';
import requirementsText from '../cluster/requirements.txt?raw';
import clusterReadme from '../cluster/README.md?raw';
import {
  DEFAULT_PARKING_CLUSTER_DISTANCE,
  DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
  DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
} from './parkingPointMerge.js';
import { sha256Bytes } from './hash.js';
import { resolveRobotResourceUrl } from './robotLoader.js';

export const PARKING_MERGE_SERVER_JOB_FORMAT = 'atlas-parking-merge-server-job';
export const PARKING_MERGE_SERVER_RESULT_FORMAT = 'atlas-parking-merge-server-result';
export const PARKING_MERGE_SERVER_ARCHIVE_VERSION = 1;
export const PARKING_MERGE_SERVER_ALGORITHM = 'atlas-common-parking-dls-environment';
export const PARKING_MERGE_SERVER_ALGORITHM_VERSION = '1.0.0';

const MANIFEST_PATH = 'manifest.json';
const TASK_PATH = 'input/task.json';
const CONFIG_PATH = 'input/config.json';
const ENVIRONMENT_META_PATH = 'environment/environment.json';
const ENVIRONMENT_POSITION_PATH = 'environment/positions.f32le';
const ENVIRONMENT_INDEX_PATH = 'environment/triangles.u32le';
const RESULT_MAX_BYTES = 64 * 1024 * 1024;
const ROBOT_RESOURCE_CONCURRENCY = 3;
const CHASSIS_LINK_PATTERN = /(?:^base(?:[_-]|$)|(?:^|[_-])(?:chassis|wheel|caster|mecanum)(?:[_-]|$)|(?:mobile|robot)[_-]base)/i;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const textBytes = (value) => strToU8(String(value));
const jsonBytes = (value) => textBytes(JSON.stringify(value, null, 2));

const zipEntries = (entries) => new Promise((resolve, reject) => {
  zip(entries, { level: 6 }, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

const unzipEntries = (bytes) => new Promise((resolve, reject) => {
  unzip(bytes, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const sha256Json = (value) => sha256Bytes(encoder.encode(stableStringify(value)));

const viewBytes = (array) => new Uint8Array(
  array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength),
);

const finite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const cleanPose = (value) => ({
  frameId: 'map',
  position: {
    x: finite(value?.position?.x),
    y: finite(value?.position?.y),
    z: finite(value?.position?.z),
  },
  rpy: {
    roll: finite(value?.rpy?.roll),
    pitch: finite(value?.rpy?.pitch),
    yaw: finite(value?.rpy?.yaw),
  },
});

const cleanOpticalPose = (value, side) => {
  if (!value?.position || !value?.quaternion) return null;
  const position = Object.fromEntries(
    ['x', 'y', 'z'].map((axis) => [axis, finite(value.position[axis], Number.NaN)]),
  );
  const quaternion = Object.fromEntries(
    ['x', 'y', 'z', 'w'].map((axis) => [axis, finite(value.quaternion[axis], Number.NaN)]),
  );
  if (![...Object.values(position), ...Object.values(quaternion)].every(Number.isFinite)) return null;
  return {
    side,
    frameName: String(value.frameName || `zivid_${side}_optical_frame`),
    position,
    quaternion,
  };
};

export const createParkingMergeComputationTask = (task) => ({
  id: String(task?.id || ''),
  name: String(task?.name || '未命名示教任务'),
  coordinateFrame: 'map',
  map: {
    fileName: String(task?.map?.fileName || ''),
    sourceHash: String(task?.map?.sourceHash || ''),
  },
  robot: {
    id: String(task?.robot?.id || task?.robot?.relativePath || ''),
    relativePath: String(task?.robot?.relativePath || task?.robot?.id || ''),
    name: String(task?.robot?.name || ''),
  },
  parkingPoints: (task?.parkingPoints || []).map((parkingPoint) => ({
    id: String(parkingPoint.id),
    name: String(parkingPoint.name || parkingPoint.id),
    sequence: finite(parkingPoint.sequence),
    mapPose: cleanPose(parkingPoint.mapPose),
    poses: (parkingPoint.poses || []).map((pose) => ({
      id: String(pose.id),
      name: String(pose.name || pose.id),
      sequence: finite(pose.sequence),
      mapPose: cleanPose(pose.mapPose || parkingPoint.mapPose),
      jointValues: Object.fromEntries(
        Object.entries(pose.fullBodyJoints?.values || {})
          .map(([name, value]) => [String(name), finite(value)])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      opticalTargets: Object.fromEntries(
        ['left', 'right'].flatMap((side) => {
          const target = cleanOpticalPose(
            pose.cameraCapture?.frames?.[side]?.opticalPose
              || pose.opticalTargets?.[side],
            side,
          );
          return target ? [[side, target]] : [];
        }),
      ),
    })),
  })),
});

const normalizeRelativePath = (value) => {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error(`机器人资源路径无效：${value || '(empty)'}`);
  }
  return parts.join('/');
};

const parentLinkName = (node) => {
  let current = node?.parentElement;
  while (current) {
    if (String(current.tagName || '').toLowerCase() === 'link') {
      return String(current.getAttribute('name') || '');
    }
    current = current.parentElement;
  }
  return '';
};

const robotResourceReference = (filename, descriptor) => {
  const source = String(filename || '').trim();
  const packageMatch = /^package:\/\/([^/]+)\/(.+)$/i.exec(source);
  if (packageMatch) {
    const relativePath = normalizeRelativePath(`${packageMatch[1]}/${packageMatch[2]}`);
    return {
      source,
      relativePath,
      archivePath: `robot/${relativePath}`,
      url: resolveRobotResourceUrl(descriptor, source),
    };
  }
  const descriptorPath = normalizeRelativePath(descriptor.relativePath || descriptor.id);
  const baseParts = descriptorPath.split('/').slice(0, -1);
  const resourceParts = [...baseParts, ...source.replaceAll('\\', '/').split('/')];
  const normalizedParts = [];
  resourceParts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') normalizedParts.pop();
    else normalizedParts.push(part);
  });
  const relativePath = normalizeRelativePath(normalizedParts.join('/'));
  return {
    source,
    relativePath,
    archivePath: `robot/${relativePath}`,
    url: resolveRobotResourceUrl(descriptor, source),
  };
};

const mapLimit = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const fetchBytes = async (url, label) => {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${label}读取失败（${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
};

const fetchOptionalBytes = async (url) => {
  const response = await fetch(url, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`机器人附属清单读取失败（${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
};

const parseRobotResourceReferences = (urdfSource, descriptor) => {
  const documentNode = new DOMParser().parseFromString(urdfSource, 'application/xml');
  const parserError = documentNode.querySelector('parsererror');
  if (parserError) throw new Error(`URDF 解析失败：${parserError.textContent.trim()}`);
  const collisionMeshes = [...documentNode.querySelectorAll('collision mesh')]
    .filter((mesh) => !CHASSIS_LINK_PATTERN.test(parentLinkName(mesh)))
    .map((mesh) => mesh.getAttribute('filename'))
    .filter(Boolean);
  return [...new Map(collisionMeshes.map((filename) => {
    const reference = robotResourceReference(filename, descriptor);
    return [reference.archivePath, reference];
  })).values()];
};

const robotSupportReferences = (descriptor) => {
  const packagePath = String(descriptor.packagePath || '').replace(/^\/+|\/+$/g, '');
  if (!packagePath) return [];
  return ['package.xml', 'RESOURCE_MANIFEST.sha256'].flatMap((name) => {
    const relativePath = normalizeRelativePath(`${packagePath}/${name}`);
    const url = resolveRobotResourceUrl(descriptor, name, {
      packageRelative: true,
      optional: true,
    });
    return url ? [{
      role: name === 'package.xml' ? 'robot-package' : 'robot-upstream-manifest',
      relativePath,
      archivePath: `robot/${relativePath}`,
      url,
      optional: true,
    }] : [];
  });
};

export async function collectParkingMergeRobotResources(robot, onProgress) {
  if (!robot || String(robot.format).toLowerCase() !== 'urdf') {
    throw new Error('Server 合并目前需要带运动学关节的 URDF 机器人');
  }
  const descriptorPath = normalizeRelativePath(robot.relativePath || robot.id);
  onProgress?.({ phase: '读取机器人运动学', detail: descriptorPath });
  const primaryBytes = await fetchBytes(robot.url, 'URDF');
  const primarySha256 = await sha256Bytes(primaryBytes);
  const urdfSource = decoder.decode(primaryBytes);
  const references = parseRobotResourceReferences(urdfSource, robot);
  const supportReferences = robotSupportReferences(robot);
  const total = references.length + supportReferences.length;
  let loaded = 0;
  const fetched = await mapLimit(
    [...references.map((reference) => ({ ...reference, role: 'robot-collision-mesh' })), ...supportReferences],
    ROBOT_RESOURCE_CONCURRENCY,
    async (reference) => {
      const bytes = reference.optional
        ? await fetchOptionalBytes(reference.url)
        : await fetchBytes(reference.url, reference.relativePath);
      loaded += 1;
      onProgress?.({
        phase: '收集机器人计算资源',
        detail: `${loaded} / ${total} · ${reference.relativePath}`,
      });
      if (!bytes) return null;
      return {
        ...reference,
        bytes,
        byteLength: bytes.byteLength,
        sha256: await sha256Bytes(bytes),
      };
    },
  );
  const primary = {
    role: 'robot-urdf',
    relativePath: descriptorPath,
    archivePath: `robot/${descriptorPath}`,
    bytes: primaryBytes,
    byteLength: primaryBytes.byteLength,
    sha256: primarySha256,
  };
  const resources = [primary, ...fetched.filter(Boolean)]
    .sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  const resourceDigest = await sha256Json(
    resources.map(({ archivePath, sha256, byteLength, role }) => ({
      archivePath,
      sha256,
      byteLength,
      role,
    })),
  );
  return { primary, resources, resourceDigest };
}

const mapGeometryFiles = async (mapData, onProgress) => {
  const geometry = mapData?.geometry;
  const positionAttribute = geometry?.getAttribute?.('position');
  if (!positionAttribute?.count || positionAttribute.itemSize < 3) {
    throw new Error('当前地图没有可导出的环境几何数据');
  }
  if (!mapData.sourceHash) {
    throw new Error('当前地图缺少 SHA-256 来源指纹，请重新加载原始地图');
  }
  onProgress?.({ phase: '冻结环境几何', detail: `${positionAttribute.count.toLocaleString('zh-CN')} 个顶点` });
  const positions = positionAttribute.array instanceof Float32Array
    && positionAttribute.itemSize === 3
    ? new Float32Array(
        positionAttribute.array.buffer.slice(
          positionAttribute.array.byteOffset,
          positionAttribute.array.byteOffset + positionAttribute.count * 3 * 4,
        ),
      )
    : Float32Array.from(
        { length: positionAttribute.count * 3 },
        (_, index) => finite(positionAttribute.array[index]),
      );
  const sourceIndex = geometry.getIndex?.()?.array;
  const indices = sourceIndex ? Uint32Array.from(sourceIndex) : new Uint32Array(0);
  const positionBytes = viewBytes(positions);
  const indexBytes = viewBytes(indices);
  const [positionSha256, indexSha256] = await Promise.all([
    sha256Bytes(positionBytes),
    sha256Bytes(indexBytes),
  ]);
  const geometryDigest = await sha256Json({ positionSha256, indexSha256 });
  const metadata = {
    schemaVersion: 1,
    coordinateFrame: 'map',
    lengthUnit: 'meter',
    source: {
      fileName: mapData.name,
      sourceHash: mapData.sourceHash,
      sourceHashKind: mapData.sourceHashKind || 'file',
      byteLength: finite(mapData.byteLength),
    },
    geometry: {
      positionFile: ENVIRONMENT_POSITION_PATH,
      positionEncoding: 'float32-le/xyz',
      pointCount: positions.length / 3,
      triangleFile: indices.length ? ENVIRONMENT_INDEX_PATH : null,
      triangleEncoding: indices.length ? 'uint32-le/triangle-index' : null,
      triangleCount: indices.length / 3,
      geometryDigest,
    },
    bounds: mapData.bounds,
  };
  return {
    metadata,
    geometryDigest,
    files: [
      { path: ENVIRONMENT_POSITION_PATH, bytes: positionBytes, role: 'environment-points', sha256: positionSha256 },
      ...(indices.length
        ? [{ path: ENVIRONMENT_INDEX_PATH, bytes: indexBytes, role: 'environment-triangles', sha256: indexSha256 }]
        : []),
    ],
  };
};

const addEntry = (entries, records, path, bytes, role, sha256, compressionLevel = 6) => {
  entries[path] = [bytes, { level: compressionLevel }];
  records.push({
    path,
    role,
    byteLength: bytes.byteLength,
    sha256,
  });
};

const addGeneratedText = async (entries, records, path, content, role) => {
  const bytes = textBytes(content);
  addEntry(entries, records, path, bytes, role, await sha256Bytes(bytes));
};

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const defaultServerConfig = (overrides = {}) => ({
  distanceThreshold: finite(overrides.distanceThreshold, DEFAULT_PARKING_CLUSTER_DISTANCE),
  positionTolerance: finite(overrides.positionTolerance, DEFAULT_PARKING_MERGE_XYZ_TOLERANCE),
  rotationTolerance: finite(overrides.rotationTolerance, DEFAULT_PARKING_MERGE_RPY_TOLERANCE),
  ik: {
    maximumIterations: 28,
    coordinationPasses: 4,
    damping: 0.045,
    orientationScale: 0.24,
  },
  environmentCollision: {
    enabled: overrides.environmentCollisionEnabled !== false,
    mode: 'final-pose-obb',
    safetyDistance: 0.1,
    contactMargin: 0.008,
    excludeChassis: true,
  },
});

export async function buildParkingMergeServerArchive({
  task,
  mapData,
  robot,
  parameters,
  onProgress,
}) {
  if (!task?.id || (task.parkingPoints?.length || 0) < 2) {
    throw new Error('至少需要两个停车点才能导出 Server 合并任务');
  }
  const computationTask = createParkingMergeComputationTask(task);
  const taskDigest = await sha256Json(computationTask);
  const config = defaultServerConfig(parameters);
  const [environment, robotBundle] = await Promise.all([
    mapGeometryFiles(mapData, onProgress),
    collectParkingMergeRobotResources(robot, onProgress),
  ]);
  const entries = {};
  const fileRecords = [];
  const taskFile = jsonBytes(computationTask);
  const configFile = jsonBytes(config);
  const environmentMetaFile = jsonBytes(environment.metadata);
  addEntry(entries, fileRecords, TASK_PATH, taskFile, 'computation-task', await sha256Bytes(taskFile));
  addEntry(entries, fileRecords, CONFIG_PATH, configFile, 'algorithm-config', await sha256Bytes(configFile));
  addEntry(
    entries,
    fileRecords,
    ENVIRONMENT_META_PATH,
    environmentMetaFile,
    'environment-metadata',
    await sha256Bytes(environmentMetaFile),
  );
  environment.files.forEach((file) => {
    addEntry(entries, fileRecords, file.path, file.bytes, file.role, file.sha256);
  });
  robotBundle.resources.forEach((resource) => {
    addEntry(
      entries,
      fileRecords,
      resource.archivePath,
      resource.bytes,
      resource.role,
      resource.sha256,
      /\.(?:glb|png|jpe?g)$/i.test(resource.archivePath) ? 0 : 6,
    );
  });
  await addGeneratedText(entries, fileRecords, 'scripts/compute_parking_merge.py', computeScript, 'algorithm');
  await addGeneratedText(entries, fileRecords, 'run_cluster.sh', runScript, 'entrypoint');
  await addGeneratedText(entries, fileRecords, 'requirements.txt', requirementsText, 'dependencies');
  await addGeneratedText(entries, fileRecords, 'README.md', clusterReadme, 'instructions');

  const binding = {
    task: {
      id: computationTask.id,
      digest: taskDigest,
      parkingPointCount: computationTask.parkingPoints.length,
      poseCount: computationTask.parkingPoints.reduce(
        (total, parkingPoint) => total + parkingPoint.poses.length,
        0,
      ),
    },
    map: {
      fileName: String(mapData.name || ''),
      sourceHash: String(mapData.sourceHash),
      sourceHashKind: String(mapData.sourceHashKind || 'file'),
      geometryDigest: environment.geometryDigest,
      pointCount: environment.metadata.geometry.pointCount,
      triangleCount: environment.metadata.geometry.triangleCount,
    },
    robot: {
      id: String(robot.id || robot.relativePath),
      relativePath: String(robot.relativePath || robot.id),
      primaryFile: robotBundle.primary.archivePath,
      primarySha256: robotBundle.primary.sha256,
      resourceDigest: robotBundle.resourceDigest,
      resourceCount: robotBundle.resources.length,
    },
  };
  const sortedFiles = fileRecords.sort((left, right) => left.path.localeCompare(right.path));
  const inputDigest = await sha256Json({
    format: PARKING_MERGE_SERVER_JOB_FORMAT,
    archiveVersion: PARKING_MERGE_SERVER_ARCHIVE_VERSION,
    algorithmVersion: PARKING_MERGE_SERVER_ALGORITHM_VERSION,
    binding,
    config,
    files: sortedFiles,
  });
  const jobId = `parking-merge-${inputDigest.slice(0, 16)}`;
  const manifest = {
    format: PARKING_MERGE_SERVER_JOB_FORMAT,
    archiveVersion: PARKING_MERGE_SERVER_ARCHIVE_VERSION,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    jobId,
    inputDigest,
    algorithm: {
      id: PARKING_MERGE_SERVER_ALGORITHM,
      version: PARKING_MERGE_SERVER_ALGORITHM_VERSION,
      runtime: 'python3',
      entrypoint: 'run_cluster.sh',
      implementation: 'scripts/compute_parking_merge.py',
    },
    binding,
    configFile: CONFIG_PATH,
    taskFile: TASK_PATH,
    environmentFile: ENVIRONMENT_META_PATH,
    files: sortedFiles,
    output: {
      format: PARKING_MERGE_SERVER_RESULT_FORMAT,
      archiveVersion: PARKING_MERGE_SERVER_ARCHIVE_VERSION,
      defaultFile: `output/${jobId}-result.zip`,
      acceptedByWeb: ['zip', 'json'],
    },
  };
  entries[MANIFEST_PATH] = [jsonBytes(manifest), { level: 6 }];
  onProgress?.({ phase: '压缩 Server 计算包', detail: `${sortedFiles.length + 1} 个文件` });
  const bytes = await zipEntries(entries);
  return {
    bytes,
    blob: new Blob([bytes], { type: 'application/zip' }),
    byteLength: bytes.byteLength,
    manifest,
  };
}

export async function downloadParkingMergeServerArchive(payload, filename) {
  const archive = await buildParkingMergeServerArchive(payload);
  triggerDownload(archive.blob, filename);
  return archive;
}

const readJson = (bytes, label) => {
  try {
    return JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label}解析失败：${error.message}`);
  }
};

const hasZipSignature = (bytes) => (
  bytes.length >= 4
  && bytes[0] === 0x50
  && bytes[1] === 0x4b
  && [0x03, 0x05, 0x07].includes(bytes[2])
  && [0x04, 0x06, 0x08].includes(bytes[3])
);

const parseResultPayload = async (bytes) => {
  if (!hasZipSignature(bytes)) {
    const payload = readJson(bytes, 'Server 结果 JSON');
    return {
      manifest: payload.manifest || payload,
      analysis: payload.analysis || payload.result,
      // The standalone envelope may have been pretty-printed differently from
      // the ZIP member whose byte hash is recorded in the result manifest.
      resultBytes: null,
    };
  }
  const files = await unzipEntries(bytes);
  const manifestBytes = files[MANIFEST_PATH];
  if (!manifestBytes) throw new Error('结果 ZIP 缺少 manifest.json');
  const manifest = readJson(manifestBytes, '结果 manifest');
  const resultPath = String(manifest.resultFile || 'result/analysis.json');
  const resultBytes = files[resultPath];
  if (!resultBytes) throw new Error(`结果 ZIP 缺少 ${resultPath}`);
  if (resultBytes.byteLength > RESULT_MAX_BYTES) throw new Error('结果分析文件超过 64 MB 安全上限');
  return { manifest, analysis: readJson(resultBytes, '停车点合并结果'), resultBytes };
};

const validateAnalysis = (analysis, task) => {
  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.clusters)) {
    throw new Error('Server 结果不包含有效的停车点合并分析');
  }
  if (String(analysis.taskId || '') !== String(task.id)) {
    throw new Error('结果中的示教任务 ID 与当前任务不匹配');
  }
  const parkingById = new Map((task.parkingPoints || []).map((item) => [String(item.id), item]));
  const knownPoseIds = new Set(
    (task.parkingPoints || []).flatMap((parkingPoint) => (
      (parkingPoint.poses || []).map((pose) => String(pose.id))
    )),
  );
  if (analysis.clusters.length > parkingById.size) throw new Error('Server 结果包含异常数量的近邻簇');
  analysis.clusters.forEach((cluster) => {
    if (!Array.isArray(cluster.memberIds) || cluster.memberIds.length < 2) {
      throw new Error('Server 结果包含无效的停车点簇');
    }
    if (cluster.memberIds.some((id) => !parkingById.has(String(id)))) {
      throw new Error('Server 结果引用了当前任务中不存在的停车点');
    }
    (cluster.plannedPoses || []).forEach((pose) => {
      if (!knownPoseIds.has(String(pose.poseId))) {
        throw new Error('Server 结果引用了当前任务中不存在的示教姿态');
      }
      if (pose.feasible && (!pose.jointValues || typeof pose.jointValues !== 'object')) {
        throw new Error('Server 可融合姿态缺少重规划关节值');
      }
    });
  });
};

export async function readParkingMergeServerResult(file, context, onProgress) {
  if (!file) throw new Error('未选择 Server 计算结果');
  if (file.size > RESULT_MAX_BYTES) throw new Error('Server 结果文件超过 64 MB 安全上限');
  onProgress?.({ phase: '读取 Server 结果', detail: file.name });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { manifest, analysis, resultBytes } = await parseResultPayload(bytes);
  if (manifest?.format !== PARKING_MERGE_SERVER_RESULT_FORMAT) {
    throw new Error('所选文件不是 Atlas 停车点 Server 计算结果');
  }
  if (Number(manifest.archiveVersion) !== PARKING_MERGE_SERVER_ARCHIVE_VERSION) {
    throw new Error(`结果协议版本不兼容：${manifest.archiveVersion || 'unknown'}`);
  }
  if (
    manifest.algorithm?.id !== PARKING_MERGE_SERVER_ALGORITHM
    || manifest.algorithm?.version !== PARKING_MERGE_SERVER_ALGORITHM_VERSION
  ) {
    throw new Error('结果算法版本与当前网页不兼容，请重新导出计算包');
  }
  if (resultBytes && manifest.resultSha256) {
    const resultSha256 = await sha256Bytes(resultBytes);
    if (resultSha256 !== manifest.resultSha256) throw new Error('结果文件摘要校验失败，文件可能已损坏');
  }
  const task = context?.task;
  const mapData = context?.mapData;
  const robot = context?.robot;
  const computationTask = createParkingMergeComputationTask(task);
  const taskDigest = await sha256Json(computationTask);
  if (!manifest.job?.id || !manifest.job?.inputDigest) throw new Error('结果缺少 Server 任务摘要');
  if (String(manifest.binding?.task?.id || '') !== String(task?.id || '')) {
    throw new Error('结果绑定了其他示教任务');
  }
  if (String(manifest.binding?.task?.digest || '') !== taskDigest) {
    throw new Error('当前示教任务在导出后已经变化，请重新提交 Server 计算');
  }
  if (
    !mapData?.sourceHash
    || String(manifest.binding?.map?.sourceHash || '') !== String(mapData.sourceHash)
  ) {
    throw new Error('结果绑定的地图 SHA-256 与当前地图不匹配');
  }
  if (String(manifest.binding?.robot?.id || '') !== String(robot?.id || robot?.relativePath || '')) {
    throw new Error('结果绑定的机器人模型与当前机器人不匹配');
  }
  onProgress?.({ phase: '校验机器人资源', detail: '正在核对 URDF 与碰撞网格摘要' });
  const robotBundle = await collectParkingMergeRobotResources(robot, onProgress);
  if (robotBundle.resourceDigest !== manifest.binding?.robot?.resourceDigest) {
    throw new Error('机器人 URDF 或碰撞模型已经变化，拒绝导入旧计算结果');
  }
  validateAnalysis(analysis, task);
  return { manifest, analysis };
}
