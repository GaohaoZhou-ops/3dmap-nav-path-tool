import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { sha256BytesFallback } from '../src/lib/hash.js';
import {
  PROJECT_ARCHIVE_MAP_COLORS,
  PROJECT_ARCHIVE_MAP_INDICES_U16,
  PROJECT_ARCHIVE_MAP_POSITIONS,
  PROJECT_ARCHIVE_VERSION,
  buildProjectArchive,
  readProjectArchive,
} from '../src/lib/projectArchive.js';
import {
  normalizeRobotDescriptor,
  registerPortableRobotPackage,
  releasePortableRobotPackage,
} from '../src/lib/robotLoader.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';

assert.equal(
  await sha256BytesFallback(new TextEncoder().encode('')),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
);
assert.equal(
  await sha256BytesFallback(new TextEncoder().encode('abc')),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
);

const recoveredOpticalTarget = {
  frameName: 'zivid_left_optical_frame',
  position: { x: 1, y: 2, z: 3 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
};
const [recoveredTask] = normalizeTeachingTasks([{
  id: 'recovered-task',
  parkingPoints: [{
    id: 'recovered-parking',
    poses: [{
      id: 'recovered-pose',
      jointValues: { joint_a: 12 },
      opticalTargets: { left: recoveredOpticalTarget },
    }],
  }],
}]);
assert.deepEqual(
  recoveredTask.parkingPoints[0].poses[0].opticalTargets.left,
  recoveredOpticalTarget,
);

const positions = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
]);
const colors = new Uint8Array([
  255, 0, 0,
  0, 255, 0,
  0, 0, 255,
]);
const indices = new Uint16Array([0, 1, 2]);
const robotBytes = new TextEncoder().encode(`<?xml version="1.0"?>
<robot name="portable_test_robot">
  <link name="base_link">
    <visual>
      <geometry><box size="0.4 0.3 0.2" /></geometry>
      <material name="portable"><color rgba="0.2 0.7 0.8 1" /></material>
    </visual>
  </link>
</robot>`);

const payload = {
  schemaVersion: '1.3',
  exportedAt: '2026-09-15T00:00:00.000Z',
  map: {
    fileName: 'portable-test.ply',
    format: 'ply',
    byteLength: 1234,
    pointCount: 3,
    faceCount: 1,
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 0 },
    },
    sourceHash: 'source-map-sha256',
    sourceHashKind: 'file',
  },
  projection: { minHeight: -0.1, maxHeight: 0.1 },
  workspace: {
    activeTeachingTaskId: recoveredTask.id,
    activeTeachingParkingPointId: recoveredTask.parkingPoints[0].id,
  },
  robot: {
    id: 'portable/robot.urdf',
    name: 'Portable robot',
    fileName: 'robot.urdf',
    relativePath: 'portable/robot.urdf',
    format: 'urdf',
    packageName: 'portable',
    packagePath: 'portable',
    joints: {},
    origin: {
      position: { x: 0, y: 0, z: 0 },
      rpy: { roll: 0, pitch: 0, yaw: 0 },
    },
  },
  virtualTeaching: { tasks: [recoveredTask], jointPoses: [] },
  waypoints: [],
  paths: [],
};

const mapResource = {
  geometryCacheVersion: 1,
  name: payload.map.fileName,
  byteLength: payload.map.byteLength,
  pointCount: 3,
  faceCount: 1,
  positionBuffer: positions.buffer,
  colorBuffer: colors.buffer,
  indexBuffer: indices.buffer,
  indexComponentType: 'uint16',
  bounds: payload.map.bounds,
  sphere: { center: { x: 0.5, y: 0.5, z: 0 }, radius: Math.SQRT1_2 },
  sourceHash: payload.map.sourceHash,
  sourceHashKind: payload.map.sourceHashKind,
};

const robotPackage = {
  schemaVersion: 1,
  packageName: 'portable',
  packagePath: 'portable',
  relativePath: 'portable/robot.urdf',
  format: 'urdf',
  files: [{
    path: 'portable/robot.urdf',
    mimeType: 'application/xml',
    bytes: robotBytes.buffer,
  }],
};

const archive = await buildProjectArchive(payload, {
  mapResource,
  existingRobotPackage: robotPackage,
});
assert.equal(archive.manifest.archiveVersion, PROJECT_ARCHIVE_VERSION);
assert.equal(archive.manifest.portable, true);
assert.ok(archive.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));

const unpacked = unzipSync(archive.bytes);
assert.deepEqual(
  [...new Float32Array(unpacked[PROJECT_ARCHIVE_MAP_POSITIONS].buffer)],
  [...positions],
);
assert.deepEqual([...unpacked[PROJECT_ARCHIVE_MAP_COLORS]], [...colors]);
assert.deepEqual(
  [...new Uint16Array(unpacked[PROJECT_ARCHIVE_MAP_INDICES_U16].buffer)],
  [...indices],
);

const restored = await readProjectArchive(archive.bytes);
assert.equal(restored.portable, true);
assert.equal(restored.resources.map.pointCount, 3);
assert.equal(restored.resources.map.faceCount, 1);
assert.equal(restored.resources.map.sourceHash, payload.map.sourceHash);
assert.equal(restored.resources.robot.relativePath, payload.robot.relativePath);
assert.equal(restored.payload.virtualTeaching.tasks.length, 1);
assert.equal(restored.payload.virtualTeaching.tasks[0].parkingPoints.length, 1);
assert.equal(
  restored.payload.virtualTeaching.tasks[0].parkingPoints[0].poses[0]
    .opticalTargets.left.frameName,
  recoveredOpticalTarget.frameName,
);
assert.deepEqual(
  [...new Uint8Array(restored.resources.robot.files[0].bytes)],
  [...robotBytes],
);

const resourceId = registerPortableRobotPackage(restored.resources.robot);
const descriptor = normalizeRobotDescriptor({ ...restored.payload.robot, portableResourceId: resourceId });
assert.ok(descriptor.url.startsWith('blob:'));
assert.equal(releasePortableRobotPackage(resourceId), true);

const tamperedFiles = unzipSync(archive.bytes);
tamperedFiles[PROJECT_ARCHIVE_MAP_POSITIONS][0] ^= 0xff;
const tamperedArchive = zipSync(tamperedFiles);
await assert.rejects(
  () => readProjectArchive(tamperedArchive),
  /SHA-256 校验失败/,
);

const legacyArchive = zipSync({
  'manifest.json': strToU8(JSON.stringify({
    format: 'atlas-route-studio-project',
    archiveVersion: 1,
    projectFile: 'config/project.json',
  })),
  'config/project.json': strToU8(JSON.stringify({
    schemaVersion: '1.3',
    map: payload.map,
    virtualTeaching: { tasks: [] },
    waypoints: [],
    paths: [],
  })),
});
const restoredLegacy = await readProjectArchive(legacyArchive);
assert.equal(restoredLegacy.portable, false);
assert.equal(restoredLegacy.resources.map, null);

console.log(`archive_version=${archive.manifest.archiveVersion}`);
console.log(`archive_files=${archive.manifest.statistics.fileCount}`);
console.log(`archive_bytes=${archive.byteLength}`);
console.log('tamper_detection=ok');
console.log('legacy_v1=ok');

if (process.argv[2]) {
  await writeFile(process.argv[2], archive.bytes);
  console.log(`fixture=${process.argv[2]}`);
}
