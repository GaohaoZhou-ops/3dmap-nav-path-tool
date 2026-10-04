import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { buildAbxTeachingArchive, buildAbxTeachingExport } from '../src/lib/abxTeachingExport.js';
import vm from 'node:vm';
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { payload, robotPackage, model, stamp, b } = abxTeachingFixture();
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
assert.equal(records[0].version, 15);
assert.equal(records[0].basic_pose_count, '0');
assert.equal(records[0].point_count, '3');
assert.deepEqual(records.filter((v) => v.type === 'parking').map((v) => v.name), ['停车点 A', '停车点 B']);
assert.deepEqual(records.filter((v) => v.type === 'point').map((v) => v.record.type || 'pose'),
  ['pose', 'pose', 'pose']);
assert.deepEqual(records.filter((v) => v.type === 'point').map((v) => v.parking_seq), ['1', '2', '1']);
const poses = records.filter((v) => v.record?.joints_rad);
assert.deepEqual(poses.map((v) => v.label), ['姿态 a1', '姿态 a2', '姿态 b1']);
assert.equal(records[0].created_ns, String(BigInt(Date.parse(stamp)) * 1000000n));
for (const { record } of poses) {
  assert.equal(record.robot_model, model);
  assert.equal(record.component, 'auto');
  assert.equal(Object.values(record.joints_rad).flat().length, 20);
  assert.ok(Math.abs(record.joints_rad.head[0] - 20 * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(record.joints_rad.torso[1] - -50 * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(record.joints_rad.left_arm[1] - 30 * Math.PI / 180) < 1e-14);
  assert.equal('localization' in record, false);
  assert.equal('arrival_action' in record, false);
}
assert.equal(records.at(-1).sha256, createHash('sha256').update(`${lines.slice(1, -1).join('\n')}\n`).digest('hex'));
const navigation = parse(native.files, 'abx/free-navigation.json');
assert.equal(native.summary.navigationMode, 'free');
assert.equal(native.summary.navigationImportSupported, false);
assert.equal(native.summary.poseCount, 3);
assert.equal(navigation.nativeTaskNavigationSupported, false);
assert.equal(Object.keys(native.files).some((name) => name.includes('graph_route') || name.includes('graph_yaw')), false);
assert.deepEqual(navigation.waypoints[0].target, { x_m: 1.25, y_m: -2.5, yaw_rad: Math.PI / 2 });
assert.equal(navigation.waypoints[0].sourcePose.z, 9, 'nonplanar source coordinates remain available for reference');
assert.ok(Math.abs(Math.abs(navigation.waypoints[1].target.yaw_rad) - Math.PI) < 1e-14);
assert.deepEqual(navigation.tasks[0].sequence.map((step) => step.type),
  ['free_navigation', 'pose', 'pose', 'free_navigation', 'pose']);
assert.deepEqual(navigation.tasks[0].sequence.filter((step) => step.type === 'free_navigation').map((step) => step.beforePoseSeq), ['1', '3']);
assert.deepEqual(parse(native.files, 'abx/source-mapping.json').paths, payload.paths);
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
for (const change of [
  (p) => { p.virtualTeaching.tasks[0].parkingPoints[0].mapPose.position.x += 0.001; },
  (p) => { p.waypoints = []; p.paths = []; },
  (p) => { p.paths = []; },
  (p) => { [p.paths[0].from, p.paths[0].to] = [p.paths[0].to, p.paths[0].from]; },
  (p) => { p.paths[0].motion.direction = 'reverse'; p.paths[0].motion.enable3DObstacleAvoidance = false; },
  (p) => { p.waypoints.push({ ...p.waypoints[0], id: 'same-coordinate-different-source' }); },
]) {
  const free = structuredClone(payload); change(free);
  const result = await buildAbxTeachingExport(free, { robotPackage });
  assert.equal(result.summary.status, 'ready', 'free navigation does not require a station graph or matching parking pose');
  assert.equal(result.summary.poseCount, 3);
  assert.equal(result.summary.navigationCount, 2);
}
const invalidCoordinates = await blocked((p) => { p.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.frameId = 'base_link'; }, /map 坐标系/);
await blocked((p) => { p.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.frameId = 'virtual_origin'; }, /map 坐标系/);
await blocked((p) => { p.virtualTeaching.tasks[0].mobileCapture = { samples: [{ id: 'camera-only' }] }; }, /iPad 相机 Pose/);
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
const blockedArchive = await buildProjectArchive(invalidCoordinates, options);
assert.equal(blockedArchive.manifest.abxExport.status, 'blocked');
assert.deepEqual((await readProjectArchive(blockedArchive.bytes)).payload.virtualTeaching.tasks, invalidCoordinates.virtualTeaching.tasks);
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
  const brainRoot = path.resolve(process.env.ABX_BRAIN_ROOT || path.join(root, '../workspace/ABXBrainSystem'));
  await readFile(path.join(brainRoot, 'tools/web/teaching_store.py'));
  const bundle = await buildAbxTeachingArchive(payload, { robotPackage });
  const context = { window: {}, TextDecoder, ReadableStream };
  vm.runInNewContext(await readFile(path.join(brainRoot, 'web/teaching-import.js'), 'utf8'), context);
  const opened = await context.window.ABXTeachingImport.open(bundle.blob);
  assert.equal(opened.archive, true);
  assert.equal(opened.tasks.length, manifest.tasks.length);
  for (const entry of opened.tasks) {
    assert.equal(await new Response(entry.file.stream()).text(), strFromU8(bundle.files[entry.file.name]));
  }
  await assert.rejects(context.window.ABXTeachingImport.open(new Blob([zipSync(extracted, { level: 0 })])), /格式或版本/,
    'the full project backup is distinct from the directly importable Brain ZIP');
  const verified = spawnSync(process.env.PYTHON || 'python3', ['-B', path.join(root, 'tests/abx_teaching_export_contract.py'), folder, brainRoot], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(verified.status, 0, verified.error?.message || verified.stdout + verified.stderr);
  process.stdout.write(verified.stdout);
} finally {
  await rm(folder, { recursive: true, force: true });
}
console.log('ABX v15 native ZIP import, Pose integrity, independent free-navigation targets, rejection and archive regression passed');
