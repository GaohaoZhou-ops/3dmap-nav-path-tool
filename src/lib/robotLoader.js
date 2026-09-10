import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const ROBOT_FILE_PREFIX = '/__atlas/robot-files/';
const SUPPORTED_FORMATS = new Set(['urdf', 'glb', 'gltf', 'stl']);
// The bundled BOTX package documents this GLB as the browser equivalent of the
// 99 MB official STL. Its geometry is already expressed in metres and centred
// on XY, so only the URDF's -90 degree yaw remains necessary.
const BUILTIN_MESH_OVERRIDES = {
  'package://botx_abx_zivid_m70/meshes/ZividTwo.stl': {
    file: 'meshes/zivid_2_m70_official.glb',
    applyUrdfScale: false,
    origin: { xyz: [0, 0, 0], rpy: [0, 0, -1.5707963268] },
  },
};

const encodePath = (value) =>
  value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const sanitizeRelativePath = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    return null;
  }
  return parts.join('/');
};

const extensionForPath = (value) => {
  const pathname = String(value || '').split(/[?#]/)[0];
  const dot = pathname.lastIndexOf('.');
  return dot >= 0 ? pathname.slice(dot + 1).toLowerCase() : '';
};

const finitePoseValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function normalizeRobotPose(value) {
  const pose = value && typeof value === 'object' ? value : {};
  const position = pose.position && typeof pose.position === 'object'
    ? pose.position
    : pose;
  const rpy = pose.rpy && typeof pose.rpy === 'object' ? pose.rpy : pose;
  return {
    position: {
      x: finitePoseValue(position.x),
      y: finitePoseValue(position.y),
      z: finitePoseValue(position.z),
    },
    rpy: {
      roll: finitePoseValue(rpy.roll),
      pitch: finitePoseValue(rpy.pitch),
      yaw: finitePoseValue(rpy.yaw),
    },
  };
}

export function normalizeRobotJointValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, rawValue]) => {
      const parsed = Number(
        rawValue && typeof rawValue === 'object' ? rawValue.value : rawValue,
      );
      return name && Number.isFinite(parsed) ? [[String(name), parsed]] : [];
    }),
  );
}

export function normalizeRobotDescriptor(value) {
  if (!value || typeof value !== 'object') return null;
  const relativePath = sanitizeRelativePath(
    value.relativePath || value.path || value.id || value.fileName,
  );
  if (!relativePath) return null;
  const format = String(value.format || extensionForPath(relativePath)).toLowerCase();
  if (!SUPPORTED_FORMATS.has(format)) return null;
  const packagePath = sanitizeRelativePath(value.packagePath)
    || (relativePath.includes('/') ? relativePath.split('/')[0] : null);
  const packageBaseUrl = packagePath
    ? `${ROBOT_FILE_PREFIX}${encodePath(packagePath)}/`
    : ROBOT_FILE_PREFIX;
  const fileName = relativePath.split('/').at(-1);
  const fallbackName = fileName.replace(/\.[^.]+$/, '');
  return {
    id: relativePath,
    name: String(value.name || fallbackName),
    fileName,
    relativePath,
    format,
    url: `${ROBOT_FILE_PREFIX}${encodePath(relativePath)}`,
    packageName: value.packageName ? String(value.packageName) : packagePath,
    packagePath,
    packageBaseUrl,
    manifestUrl: value.manifestUrl && packagePath
      ? `${packageBaseUrl}web-model.json`
      : null,
    origin: normalizeRobotPose(value.origin),
    joints: normalizeRobotJointValues(value.joints),
  };
}

export async function fetchRobotCatalog(signal) {
  const response = await fetch('/__atlas/robots', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`机器人目录请求失败（${response.status}）`);
  const payload = await response.json();
  if (!Array.isArray(payload?.robots)) throw new Error('机器人目录响应格式无效');
  return payload.robots.map(normalizeRobotDescriptor).filter(Boolean);
}

const childElements = (node, tagName) =>
  Array.from(node?.children || []).filter(
    (child) => child.tagName?.toLowerCase() === tagName.toLowerCase(),
  );

const childElement = (node, tagName) => childElements(node, tagName)[0] || null;

const parseNumbers = (value, count, fallback) => {
  const source = Array.isArray(value) ? value : String(value || '').trim().split(/\s+/);
  const parsed = Array.from({ length: count }, (_, index) => Number(source[index]));
  return parsed.every(Number.isFinite) ? parsed : [...fallback];
};

const readOrigin = (originElement) => ({
  xyz: parseNumbers(originElement?.getAttribute('xyz'), 3, [0, 0, 0]),
  rpy: parseNumbers(originElement?.getAttribute('rpy'), 3, [0, 0, 0]),
});

const applyOrigin = (object, origin) => {
  object.position.fromArray(origin.xyz);
  // URDF defines fixed-axis roll/pitch/yaw as Rz(yaw) · Ry(pitch) · Rx(roll).
  // Three.js' ZYX Euler order produces that matrix for the stored x/y/z angles;
  // using XYZ here makes multi-axis arm joints drift apart down the hierarchy.
  object.rotation.set(origin.rpy[0], origin.rpy[1], origin.rpy[2], 'ZYX');
};

const fetchText = async (url, signal, label) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${label}请求失败（${response.status}）`);
  return response.text();
};

const fetchBuffer = async (url, signal, label) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${label}请求失败（${response.status}）`);
  return response.arrayBuffer();
};

const materialFromRgba = (rgba = [0.68, 0.76, 0.77, 1]) => {
  const color = new THREE.Color(
    THREE.MathUtils.clamp(rgba[0], 0, 1),
    THREE.MathUtils.clamp(rgba[1], 0, 1),
    THREE.MathUtils.clamp(rgba[2], 0, 1),
  );
  const opacity = THREE.MathUtils.clamp(rgba[3], 0, 1);
  return new THREE.MeshStandardMaterial({
    color,
    opacity,
    transparent: opacity < 0.999,
    roughness: 0.58,
    metalness: 0.16,
    fog: false,
  });
};

const parseMaterialColor = (materialElement, namedMaterials) => {
  if (!materialElement) return [0.68, 0.76, 0.77, 1];
  const color = childElement(materialElement, 'color');
  if (color) return parseNumbers(color.getAttribute('rgba'), 4, [0.68, 0.76, 0.77, 1]);
  const materialName = materialElement.getAttribute('name');
  return namedMaterials.get(materialName) || [0.68, 0.76, 0.77, 1];
};

const resolvePackageUrl = (filename) => {
  const match = /^package:\/\/([^/]+)\/(.+)$/i.exec(filename);
  if (!match) return null;
  return `${ROBOT_FILE_PREFIX}${encodePath(`${match[1]}/${match[2]}`)}`;
};

const resolveAssetUrl = (filename, descriptor, override = false) => {
  if (override) return new URL(filename, new URL(descriptor.packageBaseUrl, window.location.href)).href;
  const packageUrl = resolvePackageUrl(filename);
  if (packageUrl) return new URL(packageUrl, window.location.href).href;
  return new URL(filename, new URL(descriptor.url, window.location.href)).href;
};

const loadAsset = async (url, signal) => {
  const format = extensionForPath(url);
  const buffer = await fetchBuffer(url, signal, `网格 ${decodeURIComponent(url.split('/').at(-1))}`);
  if (format === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { type: 'geometry', geometry };
  }
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const resourceBaseUrl = new URL('./', url).href;
    const gltf = await loader.parseAsync(buffer, resourceBaseUrl);
    return { type: 'scene', scene: gltf.scene };
  }
  throw new Error(`暂不支持网格格式 .${format || 'unknown'}`);
};

const instantiateAsset = (asset, material = null) => {
  if (asset.type === 'geometry') {
    const mesh = new THREE.Mesh(asset.geometry, material || materialFromRgba());
    mesh.renderOrder = 3;
    return mesh;
  }
  const clone = asset.scene.clone(true);
  clone.traverse((object) => {
    if (!object.isMesh) return;
    if (material) object.material = material;
    object.renderOrder = 3;
  });
  return clone;
};

const createPrimitive = (geometryElement, material) => {
  const box = childElement(geometryElement, 'box');
  if (box) {
    const size = parseNumbers(box.getAttribute('size'), 3, [1, 1, 1]);
    return new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  }
  const cylinder = childElement(geometryElement, 'cylinder');
  if (cylinder) {
    const radius = Number(cylinder.getAttribute('radius')) || 0.5;
    const length = Number(cylinder.getAttribute('length')) || 1;
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 24);
    geometry.rotateX(Math.PI / 2);
    return new THREE.Mesh(geometry, material);
  }
  const sphere = childElement(geometryElement, 'sphere');
  if (sphere) {
    const radius = Number(sphere.getAttribute('radius')) || 0.5;
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material);
  }
  return null;
};

async function loadManifest(descriptor, signal) {
  if (!descriptor.manifestUrl) return null;
  const response = await fetch(descriptor.manifestUrl, { signal, cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Web 模型清单请求失败（${response.status}）`);
  const manifest = await response.json();
  return manifest && typeof manifest.meshOverrides === 'object' ? manifest : null;
}

async function loadUrdfRobot(descriptor, signal, onProgress) {
  const [source, manifest] = await Promise.all([
    fetchText(descriptor.url, signal, 'URDF'),
    loadManifest(descriptor, signal),
  ]);
  const documentNode = new DOMParser().parseFromString(source, 'application/xml');
  const parserError = documentNode.querySelector('parsererror');
  if (parserError) throw new Error(`URDF 解析失败：${parserError.textContent.trim()}`);
  const robotElement = documentNode.documentElement;
  if (robotElement.tagName?.toLowerCase() !== 'robot') throw new Error('URDF 缺少 robot 根节点');

  const robot = new THREE.Group();
  robot.name = robotElement.getAttribute('name') || descriptor.name;
  const namedMaterials = new Map();
  childElements(robotElement, 'material').forEach((material) => {
    const name = material.getAttribute('name');
    const color = childElement(material, 'color');
    if (name && color) {
      namedMaterials.set(name, parseNumbers(color.getAttribute('rgba'), 4, [0.68, 0.76, 0.77, 1]));
    }
  });

  const linkElements = childElements(robotElement, 'link');
  const jointElements = childElements(robotElement, 'joint');
  const linkGroups = new Map();
  linkElements.forEach((linkElement) => {
    const name = linkElement.getAttribute('name');
    if (!name) return;
    const link = new THREE.Group();
    link.name = name;
    link.userData.urdfType = 'link';
    linkGroups.set(name, link);
  });

  const visualEntries = linkElements.flatMap((linkElement) =>
    childElements(linkElement, 'visual').map((visualElement, index) => ({
      linkElement,
      visualElement,
      index,
    })),
  );
  onProgress?.({ loaded: 0, total: visualEntries.length, phase: '解析 URDF 关节树' });
  const assetCache = new Map();
  const meshOverrides = {
    ...BUILTIN_MESH_OVERRIDES,
    ...(manifest?.meshOverrides || {}),
  };
  let loadedVisuals = 0;

  const visualTasks = visualEntries.map(async ({ linkElement, visualElement, index }) => {
    const linkName = linkElement.getAttribute('name');
    const link = linkGroups.get(linkName);
    const geometryElement = childElement(visualElement, 'geometry');
    if (!link || !geometryElement) return;
    const visual = new THREE.Group();
    visual.name = `${linkName}:visual:${index}`;
    visual.userData.urdfType = 'visual';
    const material = materialFromRgba(
      parseMaterialColor(childElement(visualElement, 'material'), namedMaterials),
    );
    const meshElement = childElement(geometryElement, 'mesh');
    let object;
    let origin = readOrigin(childElement(visualElement, 'origin'));

    if (meshElement) {
      const filename = meshElement.getAttribute('filename');
      if (!filename) throw new Error(`${linkName} 的 visual 缺少 mesh filename`);
      const override = meshOverrides[filename] || null;
      const selectedFile = override?.file || filename;
      const url = resolveAssetUrl(selectedFile, descriptor, Boolean(override?.file));
      if (!assetCache.has(url)) assetCache.set(url, loadAsset(url, signal));
      const asset = await assetCache.get(url);
      object = instantiateAsset(asset, material);
      const urdfScale = parseNumbers(meshElement.getAttribute('scale'), 3, [1, 1, 1]);
      const appliedScale = override?.applyUrdfScale === false
        ? parseNumbers(override.scale, 3, [1, 1, 1])
        : urdfScale;
      object.scale.fromArray(appliedScale);
      if (override?.origin) {
        origin = {
          xyz: parseNumbers(override.origin.xyz, 3, origin.xyz),
          rpy: parseNumbers(override.origin.rpy, 3, origin.rpy),
        };
      }
      visual.userData.sourceFile = filename;
      visual.userData.loadedFile = selectedFile;
      visual.userData.webOptimized = Boolean(override);
    } else {
      object = createPrimitive(geometryElement, material);
      if (!object) {
        material.dispose();
        throw new Error(`${linkName} 包含不支持的 URDF 几何类型`);
      }
    }

    applyOrigin(visual, origin);
    visual.add(object);
    link.add(visual);
    loadedVisuals += 1;
    onProgress?.({
      loaded: loadedVisuals,
      total: visualEntries.length,
      phase: `装配机器人模型 ${loadedVisuals}/${visualEntries.length}`,
    });
  });

  const childLinkNames = new Set();
  jointElements.forEach((jointElement) => {
    const parentName = childElement(jointElement, 'parent')?.getAttribute('link');
    const childName = childElement(jointElement, 'child')?.getAttribute('link');
    const parentLink = linkGroups.get(parentName);
    const childLink = linkGroups.get(childName);
    if (!parentLink || !childLink) return;
    const joint = new THREE.Group();
    joint.name = jointElement.getAttribute('name') || `${parentName}->${childName}`;
    joint.userData.urdfType = 'joint';
    joint.userData.jointType = jointElement.getAttribute('type') || 'fixed';
    applyOrigin(joint, readOrigin(childElement(jointElement, 'origin')));
    const axis = parseNumbers(
      childElement(jointElement, 'axis')?.getAttribute('xyz'),
      3,
      [0, 0, 1],
    );
    const axisLength = Math.hypot(...axis);
    const limitElement = childElement(jointElement, 'limit');
    const lower = Number(limitElement?.getAttribute('lower'));
    const upper = Number(limitElement?.getAttribute('upper'));
    joint.userData.jointAxis = axisLength > 1e-12
      ? axis.map((value) => value / axisLength)
      : [0, 0, 1];
    joint.userData.jointLimit = {
      lower: Number.isFinite(lower) ? lower : Number.NEGATIVE_INFINITY,
      upper: Number.isFinite(upper) ? upper : Number.POSITIVE_INFINITY,
    };
    joint.userData.restPosition = joint.position.toArray();
    joint.userData.restQuaternion = joint.quaternion.toArray();
    joint.userData.jointValue = 0;
    joint.add(childLink);
    parentLink.add(joint);
    childLinkNames.add(childName);
  });
  linkGroups.forEach((link, name) => {
    if (!childLinkNames.has(name)) robot.add(link);
  });

  const results = await Promise.allSettled(visualTasks);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) {
    disposeRobotModel(robot);
    throw failure.reason;
  }
  if (!robot.children.length) throw new Error('URDF 中没有可装配的根链接');

  robot.userData.robot = {
    format: 'urdf',
    linkCount: linkGroups.size,
    jointCount: jointElements.length,
    visualCount: loadedVisuals,
    zividCount: visualEntries.reduce((count, { visualElement }) => {
      const filename = childElement(childElement(visualElement, 'geometry'), 'mesh')
        ?.getAttribute('filename');
      const meshFileName = filename?.split('/').at(-1) || '';
      return count + Number(/zivid/i.test(meshFileName));
    }, 0),
    opticalFrameCount: [...linkGroups.keys()].filter((name) => /optical_frame$/i.test(name)).length,
    webOverrideCount: visualEntries.reduce((count, { visualElement }) => {
      const filename = childElement(childElement(visualElement, 'geometry'), 'mesh')
        ?.getAttribute('filename');
      return count + Number(Boolean(filename && meshOverrides[filename]));
    }, 0),
  };
  return robot;
}

async function loadDirectRobot(descriptor, signal, onProgress) {
  onProgress?.({ loaded: 0, total: 1, phase: `读取 ${descriptor.fileName}` });
  const asset = await loadAsset(new URL(descriptor.url, window.location.href).href, signal);
  const robot = new THREE.Group();
  robot.name = descriptor.name;
  robot.add(instantiateAsset(asset));
  robot.userData.robot = {
    format: descriptor.format,
    linkCount: 1,
    jointCount: 0,
    visualCount: 1,
    zividCount: 0,
    opticalFrameCount: 0,
    webOverrideCount: 0,
  };
  onProgress?.({ loaded: 1, total: 1, phase: '机器人模型已装配' });
  return robot;
}

export async function loadRobotModel(value, options = {}) {
  const descriptor = normalizeRobotDescriptor(value);
  if (!descriptor) throw new Error('机器人模型描述无效或格式不受支持');
  const { signal, onProgress } = options;
  const robot = descriptor.format === 'urdf'
    ? await loadUrdfRobot(descriptor, signal, onProgress)
    : await loadDirectRobot(descriptor, signal, onProgress);
  robot.position.set(0, 0, 0);
  robot.rotation.set(0, 0, 0);
  robot.name = `robot:${descriptor.name}`;
  robot.userData.descriptor = descriptor;
  robot.userData.mapOrigin = [0, 0, 0];
  robot.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(robot);
  const size = bounds.getSize(new THREE.Vector3());
  const frameNames = [
    'base_link',
    'ankle_pitch_L',
    'waist_yaw_L',
    'tool_left',
    'tool_right',
    'zivid_left_link',
    'zivid_right_link',
  ];
  const framePositions = Object.fromEntries(
    frameNames.flatMap((name) => {
      const frame = robot.getObjectByName(name);
      if (!frame) return [];
      return [[name, frame.getWorldPosition(new THREE.Vector3()).toArray()]];
    }),
  );
  robot.userData.robot.bounds = {
    min: bounds.min.toArray(),
    max: bounds.max.toArray(),
    size: size.toArray(),
  };
  robot.userData.robot.framePositions = framePositions;
  const endEffectorDefinitions = {
    left: ['tool_left', 'left_L7', 'zivid_left_link'],
    right: ['tool_right', 'right_L7', 'zivid_right_link'],
  };
  const availableEndEffectors = [];
  Object.entries(endEffectorDefinitions).forEach(([side, names]) => {
    const availableFrames = names
      .map((name) => robot.getObjectByName(name))
      .filter(Boolean);
    if (!availableFrames.length) return;
    availableEndEffectors.push(side);
    availableFrames.forEach((frame) => {
      frame.userData.endEffectorSide = side;
    });
  });
  robot.userData.robot.endEffectorCount = availableEndEffectors.length;
  robot.userData.robot.endEffectorSides = availableEndEffectors;
  return robot;
}

const movableJointTypes = new Set(['revolute', 'continuous', 'prismatic']);

export const setRobotJointValue = (joint, rawValue) => {
  if (!joint || !movableJointTypes.has(joint.userData?.jointType)) return 0;
  const limit = joint.userData.jointLimit || {};
  const value = THREE.MathUtils.clamp(
    Number(rawValue) || 0,
    Number.isFinite(limit.lower) ? limit.lower : Number.NEGATIVE_INFINITY,
    Number.isFinite(limit.upper) ? limit.upper : Number.POSITIVE_INFINITY,
  );
  const axis = new THREE.Vector3(...(joint.userData.jointAxis || [0, 0, 1])).normalize();
  const restPosition = joint.userData.restPosition || [0, 0, 0];
  const restQuaternion = joint.userData.restQuaternion || [0, 0, 0, 1];
  joint.position.fromArray(restPosition);
  joint.quaternion.fromArray(restQuaternion);
  if (joint.userData.jointType === 'prismatic') {
    joint.position.addScaledVector(axis, value);
  } else {
    joint.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, value));
  }
  joint.userData.jointValue = value;
  return value;
};

export function applyRobotJointValues(robot, values) {
  const normalized = normalizeRobotJointValues(values);
  if (!robot) return normalized;
  robot.traverse((object) => {
    if (!movableJointTypes.has(object.userData?.jointType)) return;
    if (!(object.name in normalized)) return;
    const serializedValue = normalized[object.name];
    const internalValue = object.userData.jointType === 'prismatic'
      ? serializedValue
      : THREE.MathUtils.degToRad(serializedValue);
    setRobotJointValue(object, internalValue);
  });
  robot.updateMatrixWorld(true);
  return readRobotJointValues(robot);
}

export function readRobotJointValues(robot) {
  const values = {};
  robot?.traverse((object) => {
    if (!movableJointTypes.has(object.userData?.jointType)) return;
    const internalValue = Number(object.userData.jointValue) || 0;
    values[object.name] = object.userData.jointType === 'prismatic'
      ? internalValue
      : THREE.MathUtils.radToDeg(internalValue);
  });
  return values;
}

export function getRobotEndEffector(robot, side) {
  if (!robot || !['left', 'right'].includes(side)) return null;
  const frame = robot.getObjectByName(`tool_${side}`);
  if (!frame) return null;
  const joints = [];
  let current = frame.parent;
  while (current && current !== robot) {
    if (movableJointTypes.has(current.userData?.jointType)) joints.push(current);
    current = current.parent;
  }
  return joints.length ? { side, robot, frame, joints } : null;
}

export function disposeRobotModel(robot) {
  if (!robot || robot.userData?.atlasDisposed) return;
  robot.userData.atlasDisposed = true;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  robot.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.filter(Boolean).forEach((material) => {
      materials.add(material);
      Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.add(value);
      });
    });
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  robot.removeFromParent();
  robot.clear();
}
