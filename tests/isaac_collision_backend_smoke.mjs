import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyRobotCollisionHighlights,
  collectRobotCollisionProxies,
  disposeRobotCollisionProxies,
  serializeRobotCollisionProxies,
} from '../src/lib/robotCollision.js';
import { resolveRobotCollisionBackend } from '../src/lib/robotCollisionBackend.js';
import { setRobotVisualBounds } from '../src/lib/robotLoader.js';

const material = () => new THREE.MeshBasicMaterial({ color: '#78909c' });

const createLink = (name, { collision = true } = {}) => {
  const link = new THREE.Group();
  link.name = name;
  link.userData.urdfType = 'link';
  const visualGroup = new THREE.Group();
  visualGroup.userData.urdfType = 'visual';
  const visual = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material());
  visualGroup.add(visual);
  link.add(visualGroup);
  if (collision) {
    const collisionGroup = new THREE.Group();
    collisionGroup.userData.urdfType = 'collision';
    collisionGroup.visible = false;
    collisionGroup.position.z = 10;
    const collider = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.8), material());
    collider.userData.robotCollisionGeometry = true;
    collisionGroup.add(collider);
    link.add(collisionGroup);
  }
  return { link, visual };
};

const robot = new THREE.Group();
robot.name = 'test-robot';
const arm = createLink('arm_link');
const tool = createLink('tool_link', { collision: false });
const base = createLink('base_link');
tool.link.position.set(1, 0, 0);
robot.add(arm.link, tool.link, base.link);
robot.updateMatrixWorld(true);

const collection = collectRobotCollisionProxies(robot);
assert.deepEqual(collection.excludedLinks, ['base_link']);
assert.equal(collection.collisionModelProxyCount, 1);
assert.equal(collection.visualFallbackProxyCount, 1);
assert.equal(collection.proxies.length, 2);
assert.equal(
  collection.proxies.find((proxy) => proxy.linkName === 'arm_link').source,
  'urdf-collision',
);
assert.equal(
  collection.proxies.find((proxy) => proxy.linkName === 'tool_link').source,
  'visual-fallback',
);

const serialized = serializeRobotCollisionProxies(collection);
const armProxy = serialized.records.find((proxy) => proxy.linkName === 'arm_link');
assert.deepEqual(armProxy.halfSize.map((value) => Number(value.toFixed(3))), [0.2, 0.3, 0.4]);
assert.equal(armProxy.source, 'urdf-collision');

const armMaterial = arm.visual.material;
applyRobotCollisionHighlights(collection, { collisionLinks: ['arm_link'] });
assert.notEqual(arm.visual.material, armMaterial);
assert.equal(collection.proxies[0].mesh.visible, true);
applyRobotCollisionHighlights(collection, {});
assert.equal(arm.visual.material, armMaterial);
disposeRobotCollisionProxies(collection);

const visualBounds = setRobotVisualBounds(new THREE.Box3(), robot);
assert.deepEqual(
  visualBounds.getSize(new THREE.Vector3()).toArray().map((value) => Number(value.toFixed(3))),
  [3, 2, 2],
);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    apiVersion: 1,
    requestedBackend: 'auto',
    activeBackend: 'local',
    localAvailable: true,
    isaac: { available: false, error: 'offline' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fallback = await resolveRobotCollisionBackend();
  assert.equal(fallback.activeBackend, 'local');
  assert.equal(fallback.requestedBackend, 'auto');

  globalThis.fetch = async () => new Response(JSON.stringify({
    apiVersion: 1,
    requestedBackend: 'isaac',
    activeBackend: 'unavailable',
    localAvailable: true,
    isaac: { available: false, error: 'PhysX offline' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(resolveRobotCollisionBackend(), /PhysX offline/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('URDF collision preference, visual fallback/highlight, and backend policy passed.');
