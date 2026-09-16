import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeProject } from '../src/lib/io.js';
import { readProjectArchive } from '../src/lib/projectArchive.js';

const archivePath = process.argv[2];
if (!archivePath) throw new Error('usage: node tests/recovered_project_smoke.mjs <project.zip>');

const source = await readFile(archivePath);
const restored = await readProjectArchive(
  new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
);
const project = normalizeProject(restored.payload);
const task = project.teachingTasks[0];
const poses = task?.parkingPoints.flatMap((parkingPoint) => parkingPoint.poses) || [];

assert.equal(restored.portable, true);
assert.equal(restored.resources.map.pointCount, 13_550_386);
assert.equal(restored.resources.map.faceCount, 5_062_629);
assert.equal(restored.resources.robot.files.length, 32);
assert.equal(project.teachingTasks.length, 1);
assert.equal(task.parkingPoints.length, 6);
assert.equal(poses.length, 6);
assert.deepEqual(poses.map((pose) => pose.fullBodyJoints.count), Array(6).fill(24));
assert.deepEqual(poses.map((pose) => Object.keys(pose.opticalTargets).sort()), Array(6).fill(['left', 'right']));
assert.equal(project.workspace.activeTeachingTaskId, task.id);
assert.equal(
  project.workspace.activeTeachingParkingPointId,
  task.parkingPoints.at(-1).id,
);

console.log(`archive_files=${restored.archiveFileCount}`);
console.log(`map_points=${restored.resources.map.pointCount}`);
console.log(`map_faces=${restored.resources.map.faceCount}`);
console.log(`robot_files=${restored.resources.robot.files.length}`);
console.log(`teaching_tasks=${project.teachingTasks.length}`);
console.log(`parking_points=${task.parkingPoints.length}`);
console.log(`teaching_poses=${poses.length}`);
console.log('recovered_project=ok');
