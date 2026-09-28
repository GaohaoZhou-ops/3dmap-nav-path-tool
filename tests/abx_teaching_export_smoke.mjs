import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { strFromU8, unzipSync } from 'fflate';
import { buildAbxTeachingExport } from '../src/lib/abxTeachingExport.js';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = '2026-09-28T01:02:03.456Z';
const robotPath = 'fixture/robot.urdf';
const model = 'botx_abx_zivid_m70';
const values = {
  ankle_pitch_J: 25, knee_pitch_J: -50, waist_pitch_J: 25, waist_yaw_J: 0,
  head_yaw_J: 20, head_pitch_J: -15,
  ...Object.fromEntries([10, 30, -20, -30, 10, 10, -10].map((v, i) => [`left_J${i + 1}`, v])),
  ...Object.fromEntries([-10, -30, 20, 30, -10, -10, 10].map((v, i) => [`right_J${i + 1}`, v])),
  wheel_LF_J: 180, wheel_LR_J: -180, wheel_RF_J: 90, wheel_RR_J: -90,
};
const location = (x, y, yaw) => ({ frameId: 'map', position: { x, y, z: 0.12 }, rpy: { roll: 0, pitch: 0, yaw } });
const a = location(1.25, -2.5, 450);
const b = location(4.5, 6.75, -180);
const pose = (id, mapPose, sequence, unit = 'degree') => ({
  id, name: `姿态 ${id}`, sequence, capturedAt: stamp, mapPose,
  fullBodyJoints: {
    angularUnit: unit, linearUnit: 'meter', source: 'urdf-movable-joints', count: 24,
    values: Object.fromEntries(Object.entries(values).reverse().map(([name, v]) => [name, unit === 'rad' ? v * Math.PI / 180 : v])),
  },
  cameraCapture: null,
});
const payload = {
  schemaVersion: '1.3', exportedAt: stamp,
  coordinateSystem: { frameId: 'map', angleUnit: 'degree', distanceUnit: 'meter' },
  teachingSpace: { mode: 'map', frameId: 'map' }, workspace: { teachingSpaceMode: 'map' },
  map: { fileName: 'test.ply', sourceHash: 'test-map', coordinateFrame: 'map', teachingSpaceMode: 'map' },
  robot: { id: robotPath, relativePath: robotPath, format: 'urdf', name: '显示名称，不是模型名称' },
  virtualTeaching: { tasks: [{
    id: 'task/中文', name: '装配任务：中文校验', createdAt: stamp, updatedAt: stamp,
    coordinateFrame: 'map', robot: { id: robotPath, relativePath: robotPath },
    map: { fileName: 'test.ply', sourceHash: 'test-map' },
    parkingPoints: [
      { id: 'parking-b', name: '停车点 B', sequence: 2, mapPose: b, poses: [pose('b1', b, 1, 'rad')] },
      { id: 'parking-a', name: '停车点 A', sequence: 1, mapPose: a, poses: [pose('a2', a, 2), pose('a1', a, 1)] },
    ],
  }, { id: 'empty-task', name: '空任务', createdAt: stamp, parkingPoints: [] }] },
  waypoints: [
    { id: 'waypoint-a', name: '工位 A', pose: { x: a.position.x, y: a.position.y, z: 9, roll: 0, pitch: 0, yaw: 90 } },
    { id: 'waypoint-b', name: '工位 B', pose: { x: b.position.x, y: b.position.y, z: 8, roll: 0, pitch: 0, yaw: 180 } },
  ],
  paths: [{ id: 'a-to-b', from: 'waypoint-a', to: 'waypoint-b', directed: true,
    limits: { minSpeed: 0.2, maxSpeed: 1, minAcceleration: -0.8, maxAcceleration: 0.8 },
    motion: { direction: 'forward', enable3DObstacleAvoidance: true } }],
};
const robotPackage = { schemaVersion: 1, relativePath: robotPath, format: 'urdf', files: [{ path: robotPath,
  bytes: new TextEncoder().encode(`<?xml version="1.0"?><!-- <robot name="wrong"/> --><robot name="${model}"><link name="base_link"/></robot>`),
}] };
const parse = (files, name) => JSON.parse(strFromU8(files[name]));
const before = JSON.stringify(payload);
const native = await buildAbxTeachingExport(payload, { robotPackage });
assert.equal(native.summary.status, 'ready');
assert.equal(native.summary.taskCount, 2);
assert.equal(native.summary.navigationCount, 2);
assert.equal(JSON.stringify(payload), before, 'export must not mutate the working project');
const manifest = parse(native.files, 'abx/manifest.json');
assert.equal(manifest.schema, 'abx-teaching-export');
assert.equal(manifest.include_images, false);
const taskFile = `abx/${manifest.tasks[0].file}`;
const lines = strFromU8(native.files[taskFile]).trimEnd().split('\n');
const records = lines.map(JSON.parse);
assert.equal(records[0].version, 11);
assert.equal(records[0].point_count, '5');
assert.deepEqual(records.filter((v) => v.type === 'parking').map((v) => v.name), ['停车点 A', '停车点 B']);
assert.deepEqual(records.filter((v) => v.type === 'point').map((v) => v.record.type || 'pose'),
  ['route_navigation', 'pose', 'pose', 'route_navigation', 'pose']);
assert.deepEqual(records.filter((v) => v.type === 'point').map((v) => v.parking_seq), ['1', '2', '3', '1', '2']);
const poses = records.filter((v) => v.record?.joints_rad);
assert.deepEqual(poses.map((v) => v.label), ['姿态 a1', '姿态 a2', '姿态 b1']);
assert.equal(records[0].created_ns, String(BigInt(Date.parse(stamp)) * 1000000n));
for (const { record } of poses) {
  assert.equal(record.robot_model, model);
  assert.equal(Object.values(record.joints_rad).flat().length, 20);
  assert.ok(Math.abs(record.joints_rad.head[0] - 20 * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(record.joints_rad.torso[1] - -50 * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(record.joints_rad.left_arm[1] - 30 * Math.PI / 180) < 1e-14);
  assert.equal('localization' in record, false);
  assert.equal('arrival_action' in record, false);
}
assert.equal(records.at(-1).sha256, createHash('sha256').update(`${lines.slice(1, -1).join('\n')}\n`).digest('hex'));
const route = parse(native.files, 'abx/graph_route.geojson');
const headings = parse(native.files, 'abx/graph_yaw.geojson');
assert.deepEqual(route.features[0].geometry.coordinates, [1.25, -2.5], 'map XY must not use legacy XZY order');
assert.deepEqual(route.features[2].properties, { id: 2, startid: 0, endid: 1, cost: 0, overridable: true });
assert.ok(Math.abs(headings.features[0].pos[2] - Math.PI / 2) < 1e-14);
assert.ok(Math.abs(Math.abs(headings.features[1].pos[2]) - Math.PI) < 1e-14);
assert.deepEqual(await buildAbxTeachingExport(payload, { robotPackage }), native, 'same snapshot must produce stable IDs and bytes');

async function blocked(change, expected) {
  const invalid = structuredClone(payload);
  change(invalid);
  const result = await buildAbxTeachingExport(invalid, { robotPackage });
  assert.equal(result.summary.status, 'blocked');
  assert.match(result.summary.message, expected);
  assert.deepEqual(Object.keys(result.files).sort(), ['abx/README.txt', 'abx/export-status.json']);
  return invalid;
}
const unmatched = await blocked((p) => { p.virtualTeaching.tasks[0].parkingPoints[0].mapPose.position.x += 0.001; }, /无法匹配/);
await blocked((p) => { p.waypoints[0].pose.yaw = 95; }, /无法匹配/);
await blocked((p) => { p.paths = []; }, /无法.*到达/);
await blocked((p) => { [p.paths[0].from, p.paths[0].to] = [p.paths[0].to, p.paths[0].from]; }, /无法.*到达/);
await blocked((p) => { p.paths[0].to = 'missing'; }, /无效导航点/);
await blocked((p) => { p.paths[0].motion.direction = 'reverse'; }, /倒车/);
await blocked((p) => { p.paths[0].motion.enable3DObstacleAvoidance = false; }, /3D 避障/);
await blocked((p) => { p.waypoints.push({ ...p.waypoints[0], id: 'ambiguous' }); }, /多个导航点/);
await blocked((p) => { p.waypoints[0].pose.x = Infinity; }, /有限数值/);
await blocked((p) => { delete p.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.head_yaw_J; }, /head_yaw_J/);
await blocked((p) => { p.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.FY11 = 0; }, /无法表达.*FY11/);
await blocked((p) => { p.virtualTeaching.tasks[0].robot.relativePath = 'other/robot.urdf'; }, /机器人.*不一致/);
await blocked((p) => { p.virtualTeaching.tasks[0].map.sourceHash = 'other-map'; }, /地图摘要不一致/);
await blocked((p) => { p.virtualTeaching.tasks[0].name = 'a'.repeat(121); }, /120/);
await blocked((p) => { p.virtualTeaching.tasks[0].createdAt = 'not a time'; }, /时间无效/);
const withinParking = structuredClone(payload);
withinParking.virtualTeaching.tasks = [withinParking.virtualTeaching.tasks[0]];
withinParking.virtualTeaching.tasks[0].parkingPoints = [withinParking.virtualTeaching.tasks[0].parkingPoints[1]];
withinParking.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose = b;
const changedBase = await buildAbxTeachingExport(withinParking, { robotPackage });
assert.equal(changedBase.summary.status, 'ready');
assert.equal(changedBase.summary.navigationCount, 2, 'base changes within a parking must retain navigation');

const mapResource = { name: 'test.ply', geometryCacheVersion: 1,
  positionBuffer: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer };
const options = { mapResource, existingRobotPackage: robotPackage, includeAbxTeaching: true };
const archive = await buildProjectArchive(payload, options);
assert.equal(archive.manifest.abxExport.status, 'ready');
const extracted = unzipSync(archive.bytes);
assert.deepEqual(extracted[taskFile], native.files[taskFile]);
assert.ok(archive.manifest.files.some((file) => file.path === taskFile && /^[a-f0-9]{64}$/.test(file.sha256)));
const restored = await readProjectArchive(archive.bytes);
assert.deepEqual(restored.payload.waypoints, payload.waypoints);
assert.deepEqual(restored.payload.paths, payload.paths);
assert.deepEqual(restored.payload.virtualTeaching.tasks, payload.virtualTeaching.tasks);
const blockedArchive = await buildProjectArchive(unmatched, options);
assert.equal(blockedArchive.manifest.abxExport.status, 'blocked');
assert.deepEqual((await readProjectArchive(blockedArchive.bytes)).payload.virtualTeaching.tasks, unmatched.virtualTeaching.tasks);
assert.equal(Object.keys(unzipSync(blockedArchive.bytes)).some((name) => name.endsWith('.ndjson')), false);
const independent = structuredClone(payload);
independent.teachingSpace.mode = independent.workspace.teachingSpaceMode = 'independent';
assert.equal(await buildAbxTeachingExport(independent, { robotPackage }), null);
assert.equal((await buildProjectArchive(independent, options)).manifest.abxExport, undefined);
assert.equal((await buildProjectArchive(payload, { ...options, includeAbxTeaching: false })).manifest.abxExport, undefined);

const folder = await mkdtemp(path.join(tmpdir(), 'atlas-abx-export-'));
try {
  for (const [name, data] of Object.entries(native.files)) {
    const destination = path.join(folder, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  const brainRoot = path.resolve(process.env.ABX_BRAIN_ROOT || path.join(root, '../ABXBrainSystem'));
  await readFile(path.join(brainRoot, 'tools/web/teaching_store.py'));
  const verified = spawnSync(process.env.PYTHON || 'python3', ['-B', path.join(root, 'tests/abx_teaching_export_contract.py'), folder, brainRoot], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(verified.status, 0, verified.error?.message || verified.stdout + verified.stderr);
  process.stdout.write(verified.stdout);
} finally {
  await rm(folder, { recursive: true, force: true });
}
console.log('ABX map teaching export, rejection, archive restore and independent-mode regression passed');
