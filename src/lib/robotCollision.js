import * as THREE from 'three';

export const ROBOT_COLLISION_SAFETY_DISTANCE = 0.1;
export const ROBOT_COLLISION_CONTACT_MARGIN = 0.008;
export const ROBOT_COLLISION_CHECK_INTERVAL_MS = 160;

const CHASSIS_LINK_PATTERN = /(?:^base(?:[_-]|$)|(?:^|[_-])(?:chassis|wheel|caster|mecanum)(?:[_-]|$)|(?:mobile|robot)[_-]base)/i;

const RED_WARNING_COLOR = '#ff4545';
const YELLOW_WARNING_COLOR = '#ffc84a';

export const createRobotCollisionStatus = (overrides = {}) => ({
  enabled: false,
  state: 'disabled',
  backend: 'local',
  requestedBackend: 'local',
  engine: 'Browser spatial worker',
  threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
  minimumDistance: null,
  collisionLinks: [],
  nearLinks: [],
  excludedLinks: [],
  monitoredLinkCount: 0,
  monitoredProxyCount: 0,
  collisionModelProxyCount: 0,
  visualFallbackProxyCount: 0,
  sourcePointCount: 0,
  indexedPointCount: 0,
  meshSampleCount: 0,
  checkCount: 0,
  message: '碰撞保护未开启',
  detail: '专用空间索引与距离检测尚未占用硬件资源',
  ...overrides,
});

export const isExcludedRobotCollisionLink = (name) => (
  CHASSIS_LINK_PATTERN.test(String(name || '').trim())
);

const findOwningLink = (object, robot) => {
  let current = object;
  while (current && current !== robot) {
    if (current.userData?.urdfType === 'link') return current;
    current = current.parent;
  }
  return null;
};

const hasUrdfAncestor = (object, robot, type) => {
  let current = object;
  while (current && current !== robot) {
    if (current.userData?.urdfType === type) return true;
    current = current.parent;
  }
  return false;
};

const materialAllowsCollisionOverlay = (mesh) => {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => (
    material
    && material.visible !== false
    && material.colorWrite !== false
    && Number(material.opacity ?? 1) > 0.01
  ));
};

const createWarningMaterial = (color) => new THREE.MeshBasicMaterial({
  color,
  transparent: false,
  opacity: 1,
  depthTest: true,
  depthWrite: true,
  toneMapped: false,
  fog: false,
});

const warningMaterialForMesh = (mesh, material) => (
  Array.isArray(mesh.material) ? mesh.material.map(() => material) : material
);

export function collectRobotCollisionProxies(robot) {
  const proxies = [];
  const excludedLinks = new Set();
  const monitoredLinks = new Set();
  const visualMeshes = new Map();
  const collisionMeshes = new Map();
  const highlightEntries = [];
  const redMaterial = createWarningMaterial(RED_WARNING_COLOR);
  const yellowMaterial = createWarningMaterial(YELLOW_WARNING_COLOR);
  let proxyIndex = 0;

  robot?.traverse((object) => {
    if (object.userData?.urdfType === 'link' && isExcludedRobotCollisionLink(object.name)) {
      excludedLinks.add(object.name);
    }
    if (!object.isMesh || !object.geometry?.getAttribute?.('position')) return;

    const link = findOwningLink(object, robot);
    const linkName = link?.name || robot?.name || 'robot';
    if (isExcludedRobotCollisionLink(linkName)) {
      excludedLinks.add(linkName);
      return;
    }

    const isCollisionGeometry = Boolean(object.userData?.robotCollisionGeometry)
      || hasUrdfAncestor(object, robot, 'collision');
    if (isCollisionGeometry) {
      if (!collisionMeshes.has(linkName)) collisionMeshes.set(linkName, []);
      collisionMeshes.get(linkName).push(object);
      return;
    }
    if (object.userData?.robotChassisDragHandle || !materialAllowsCollisionOverlay(object)) return;
    if (!visualMeshes.has(linkName)) visualMeshes.set(linkName, []);
    visualMeshes.get(linkName).push(object);
  });

  const linkNames = new Set([...visualMeshes.keys(), ...collisionMeshes.keys()]);
  linkNames.forEach((linkName) => {
    const dedicatedCollisionMeshes = collisionMeshes.get(linkName) || [];
    const fallbackVisualMeshes = visualMeshes.get(linkName) || [];
    const detectionMeshes = dedicatedCollisionMeshes.length
      ? dedicatedCollisionMeshes
      : fallbackVisualMeshes;
    const proxySource = dedicatedCollisionMeshes.length ? 'urdf-collision' : 'visual-fallback';

    detectionMeshes.forEach((mesh) => {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      const localCenter = box.getCenter(new THREE.Vector3());
      const localHalfSize = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      if (![...localCenter.toArray(), ...localHalfSize.toArray()].every(Number.isFinite)) return;

      monitoredLinks.add(linkName);
      proxies.push({
        id: `proxy-${proxyIndex += 1}`,
        linkName,
        mesh,
        source: proxySource,
        localCenter,
        localHalfSize,
      });
    });

    fallbackVisualMeshes.forEach((mesh) => {
      highlightEntries.push({
        linkName,
        mesh,
        originalMaterial: mesh.material,
        warningMaterials: {
          collision: warningMaterialForMesh(mesh, redMaterial),
          near: warningMaterialForMesh(mesh, yellowMaterial),
        },
        warningState: 'safe',
      });
    });
  });

  return {
    proxies,
    highlightEntries,
    excludedLinks: [...excludedLinks].sort(),
    monitoredLinks: [...monitoredLinks].sort(),
    collisionModelProxyCount: proxies.filter(
      (proxy) => proxy.source === 'urdf-collision',
    ).length,
    visualFallbackProxyCount: proxies.filter(
      (proxy) => proxy.source === 'visual-fallback',
    ).length,
    warningMaterials: [redMaterial, yellowMaterial],
  };
}

const readWorldAxis = (elements, offset, target) => {
  target.set(elements[offset], elements[offset + 1], elements[offset + 2]);
  const scale = target.length();
  if (scale > 1e-12) target.multiplyScalar(1 / scale);
  else target.set(offset === 0 ? 1 : 0, offset === 4 ? 1 : 0, offset === 8 ? 1 : 0);
  return scale || 1;
};

export function serializeRobotCollisionProxies(collection) {
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const axisZ = new THREE.Vector3();
  const center = new THREE.Vector3();
  const records = collection?.proxies?.map((proxy) => {
    proxy.mesh.updateWorldMatrix(true, false);
    const elements = proxy.mesh.matrixWorld.elements;
    const scaleX = readWorldAxis(elements, 0, axisX);
    const scaleY = readWorldAxis(elements, 4, axisY);
    const scaleZ = readWorldAxis(elements, 8, axisZ);
    center.copy(proxy.localCenter).applyMatrix4(proxy.mesh.matrixWorld);
    const halfSize = [
      Math.max(0.0005, proxy.localHalfSize.x * scaleX),
      Math.max(0.0005, proxy.localHalfSize.y * scaleY),
      Math.max(0.0005, proxy.localHalfSize.z * scaleZ),
    ];
    const axes = [
      axisX.x, axisX.y, axisX.z,
      axisY.x, axisY.y, axisY.z,
      axisZ.x, axisZ.y, axisZ.z,
    ];
    const extentX = Math.abs(axisX.x) * halfSize[0]
      + Math.abs(axisY.x) * halfSize[1]
      + Math.abs(axisZ.x) * halfSize[2];
    const extentY = Math.abs(axisX.y) * halfSize[0]
      + Math.abs(axisY.y) * halfSize[1]
      + Math.abs(axisZ.y) * halfSize[2];
    const extentZ = Math.abs(axisX.z) * halfSize[0]
      + Math.abs(axisY.z) * halfSize[1]
      + Math.abs(axisZ.z) * halfSize[2];
    return {
      id: proxy.id,
      linkName: proxy.linkName,
      source: proxy.source,
      center: center.toArray(),
      axes,
      halfSize,
      aabbMin: [center.x - extentX, center.y - extentY, center.z - extentZ],
      aabbMax: [center.x + extentX, center.y + extentY, center.z + extentZ],
    };
  }) || [];

  const signature = records.map((record) => (
    [...record.center, ...record.axes, ...record.halfSize]
      .map((value) => Number(value).toFixed(4))
      .join(',')
  )).join('|');
  return { records, signature };
}

export function selectRobotCollisionProbe(records) {
  if (!records?.length) return null;
  const candidates = records
    .filter((record) => record.center[2] > 0.25)
    .sort((left, right) => {
      const leftSpan = Math.max(...left.halfSize);
      const rightSpan = Math.max(...right.halfSize);
      return leftSpan - rightSpan;
    });
  const selected = candidates[0] || records[0];
  return {
    linkName: selected.linkName,
    center: [...selected.center],
  };
}

export function applyRobotCollisionHighlights(collection, result = {}) {
  if (!collection?.highlightEntries) return;
  const collisionLinks = new Set(result.collisionLinks || []);
  const nearLinks = new Set(result.nearLinks || []);
  collection.highlightEntries.forEach((entry) => {
    const collision = collisionLinks.has(entry.linkName);
    const near = !collision && nearLinks.has(entry.linkName);
    const nextState = collision ? 'collision' : near ? 'near' : 'safe';
    if (entry.warningState === nextState) return;
    entry.warningState = nextState;
    entry.mesh.material = nextState === 'safe'
      ? entry.originalMaterial
      : entry.warningMaterials[nextState];
  });
}

export function disposeRobotCollisionProxies(collection) {
  collection?.highlightEntries?.forEach((entry) => {
    entry.mesh.material = entry.originalMaterial;
    entry.warningState = 'safe';
  });
  collection?.warningMaterials?.forEach((material) => material.dispose());
}
