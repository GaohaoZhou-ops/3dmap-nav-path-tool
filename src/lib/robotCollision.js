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
  threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
  minimumDistance: null,
  collisionLinks: [],
  nearLinks: [],
  excludedLinks: [],
  monitoredLinkCount: 0,
  monitoredProxyCount: 0,
  sourcePointCount: 0,
  indexedPointCount: 0,
  meshSampleCount: 0,
  checkCount: 0,
  message: '自碰撞保护未开启',
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
  const redMaterial = createWarningMaterial(RED_WARNING_COLOR);
  const yellowMaterial = createWarningMaterial(YELLOW_WARNING_COLOR);
  let proxyIndex = 0;

  robot?.traverse((object) => {
    if (object.userData?.urdfType === 'link' && isExcludedRobotCollisionLink(object.name)) {
      excludedLinks.add(object.name);
    }
    if (
      !object.isMesh
      || object.userData?.robotChassisDragHandle
      || !object.geometry?.getAttribute?.('position')
      || !materialAllowsCollisionOverlay(object)
    ) return;

    const link = findOwningLink(object, robot);
    const linkName = link?.name || robot?.name || 'robot';
    if (isExcludedRobotCollisionLink(linkName)) {
      excludedLinks.add(linkName);
      return;
    }

    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    if (!box || box.isEmpty()) return;
    const localCenter = box.getCenter(new THREE.Vector3());
    const localHalfSize = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    if (![...localCenter.toArray(), ...localHalfSize.toArray()].every(Number.isFinite)) return;

    monitoredLinks.add(linkName);
    proxies.push({
      id: `proxy-${proxyIndex += 1}`,
      linkName,
      mesh: object,
      localCenter,
      localHalfSize,
      originalMaterial: object.material,
      warningMaterials: {
        collision: warningMaterialForMesh(object, redMaterial),
        near: warningMaterialForMesh(object, yellowMaterial),
      },
      warningState: 'safe',
    });
  });

  return {
    proxies,
    excludedLinks: [...excludedLinks].sort(),
    monitoredLinks: [...monitoredLinks].sort(),
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
  if (!collection?.proxies) return;
  const collisionLinks = new Set(result.collisionLinks || []);
  const nearLinks = new Set(result.nearLinks || []);
  collection.proxies.forEach((proxy) => {
    const collision = collisionLinks.has(proxy.linkName);
    const near = !collision && nearLinks.has(proxy.linkName);
    const nextState = collision ? 'collision' : near ? 'near' : 'safe';
    if (proxy.warningState === nextState) return;
    proxy.warningState = nextState;
    proxy.mesh.material = nextState === 'safe'
      ? proxy.originalMaterial
      : proxy.warningMaterials[nextState];
  });
}

export function disposeRobotCollisionProxies(collection) {
  collection?.proxies?.forEach((proxy) => {
    proxy.mesh.material = proxy.originalMaterial;
    proxy.warningState = 'safe';
  });
  collection?.warningMaterials?.forEach((material) => material.dispose());
}
