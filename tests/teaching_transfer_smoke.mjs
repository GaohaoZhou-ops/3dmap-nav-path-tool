import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';
import { normalizeProject } from '../src/lib/io.js';
import { cropTeachingGeometry, extractTeachingWorkspace, identityTransferPose, placeTeachingWorkspace,
  placementTransform, transferMatrix, transformTeachingPose, writeBackTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const close = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
const samePose = (a, b) => transferMatrix(a).elements.forEach((value, index) => close(value, transferMatrix(b).elements[index]));
const source = teachingTransferFixture();
const original = structuredClone(source);
const sourceProject = normalizeProject(source.config.config.project);
const localToMap = sourceProject.robot.origin;
const bounds = { min: { x: 9, y: 19, z: 0 }, max: { x: 12, y: 22, z: 2 } };
const extracted = await extractTeachingWorkspace(source, { bounds, localToMap });
const local = normalizeProject(extracted.config.project);
assert.equal(extracted.map.pointCount, 3);
assert.equal(extracted.map.faceCount, 1);
assert.deepEqual([...new Uint32Array(extracted.map.indexBuffer)], [0, 1, 2]);
assert.deepEqual([...new Uint8Array(extracted.map.colorBuffer)], [...new Uint8Array(source.map.colorBuffer).slice(0,9)]);
samePose(local.robot.origin, identityTransferPose());
assert.equal(local.teachingTasks[0].parkingPoints.length, 1);
assert.equal(local.waypoints.length, 2);
assert.equal(local.edges.length, 1);
assert.equal(local.workspace.transfer.kind, 'extraction');
assert.equal(local.workspace.directoryAutosaveSuspended, true);
assert.deepEqual(source, original);
const transformedVertices = new Float32Array(extracted.map.positionBuffer);
for (let offset = 0; offset < transformedVertices.length; offset += 3) {
  const restored = new Vector3().fromArray(transformedVertices, offset).applyMatrix4(transferMatrix(localToMap));
  restored.toArray().forEach((value, axis) => close(value, new Float32Array(source.map.positionBuffer)[offset + axis]));
}
const localPoint = local.teachingTasks[0].parkingPoints[0].poses[0];
assert.deepEqual(localPoint.fullBodyJoints.values, { shoulder: 12, lift: 0.4 });
assert.equal(localPoint.cameraCapture.frames.left.pointCloud.positionData, 'AAABAAIA');
assert.equal(localPoint.cameraCapture.frames.left.rgb.dataUrl, 'data:image/png;base64,aGVsbG8=');

// Archive portability keeps the inverse relation and camera-local media intact.
const archive = await buildProjectArchive(extracted.config.project, { mapResource: extracted.map, existingRobotPackage: extracted.map.portableRobotPackage });
const imported = await readProjectArchive(archive.bytes);
assert.deepEqual(normalizeProject(imported.payload).workspace.transfer, local.workspace.transfer);
assert.equal(normalizeProject({ ...imported.payload, workspace: { ...imported.payload.workspace,
  transfer: { version: 1, kind: 'extraction' },
} }).workspace.transfer, null);

const independent = transferSnapshot(extracted);
const rawLocal = independent.config.config.project;
const editedParking = rawLocal.virtualTeaching.tasks[0].parkingPoints[0];
editedParking.mapPose.position.x += 0.25;
editedParking.poses[0].mapPose.position.x += 0.25;
editedParking.poses[0].fullBodyJoints.values.shoulder = 37;
const added = structuredClone(editedParking);
added.id = 'new-local-stop'; added.poses[0].id = 'new-local-pose'; added.name = 'New stop';
rawLocal.virtualTeaching.tasks[0].parkingPoints.push(added);
rawLocal.robot.origin.position.x = 0.4;
rawLocal.virtualTeaching.jointPoses[0].joints.values.shoulder = 48;
source.config.config.project.virtualTeaching.tasks[0].parkingPoints[1].name = 'Outside edited in map';
source.config.config.project.virtualTeaching.tasks[0].name = 'Renamed in map';
source.config.config.project.virtualTeaching.jointPoses.push({
  ...structuredClone(source.config.config.project.virtualTeaching.jointPoses[0]), id: 'map-new-preset', name: 'Added in map',
});
const returned = await writeBackTeachingWorkspace(independent, source);
const returnedProject = normalizeProject(returned.config.project);
assert.equal(returnedProject.teachingTasks[0].parkingPoints.length, 3);
assert.equal(returnedProject.teachingTasks[0].parkingPoints[1].name, 'Outside edited in map');
assert.equal(returnedProject.teachingTasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.shoulder, 37);
assert.equal(returnedProject.jointPoses.length, 2);
assert.equal(returnedProject.jointPoses.find((pose) => pose.id === 'joint-preset').joints.values.shoulder, 48);
samePose(returnedProject.robot.origin, transformTeachingPose(rawLocal.robot.origin, transferMatrix(localToMap)));
samePose(returnedProject.teachingTasks[0].parkingPoints[0].mapPose, transformTeachingPose(editedParking.mapPose, transferMatrix(localToMap)));
assert.deepEqual(returned.map.positionBuffer, source.map.positionBuffer);
assert.equal(returnedProject.edges.find((edge) => edge.id === 'cross-edge').status, 'unchecked');
const camera = returnedProject.teachingTasks[0].parkingPoints[0].poses[0].cameraCapture.frames.left.opticalPose;
const originalCamera = sourceProject.teachingTasks[0].parkingPoints[0].poses[0].cameraCapture.frames.left.opticalPose;
['x','y','z'].forEach((axis) => close(camera.position[axis], originalCamera.position[axis]));
close(Math.abs(new Quaternion(...Object.values(camera.quaternion)).dot(new Quaternion(...Object.values(originalCamera.quaternion)))), 1);

// Repeated writebacks update the baseline and never duplicate added stops.
independent.config.config = returned.sourceConfig;
const repeated = await writeBackTeachingWorkspace(independent, transferSnapshot(returned));
assert.equal(repeated.config.project.virtualTeaching.tasks[0].parkingPoints.length, 3);
assert.equal(repeated.config.project.virtualTeaching.tasks[0].name, 'Renamed in map');
assert.equal(repeated.config.project.virtualTeaching.jointPoses.length, 2);
const conflicting = transferSnapshot(returned);
conflicting.config.config.project.virtualTeaching.tasks[0].parkingPoints[0].name = 'Concurrent edit';
await assert.rejects(() => writeBackTeachingWorkspace(independent, conflicting), /对应内容已修改/);
const wrongMap = teachingTransferFixture(); wrongMap.map.sourceHash = 'another-map';
await assert.rejects(() => writeBackTeachingWorkspace(independent, wrongMap), /不是提取时的原地图/);
await assert.rejects(() => cropTeachingGeometry(source.map, { min: {x:-10,y:-10,z:-10}, max:{x:-1,y:-1,z:-1} }, localToMap), /没有点云/);

// Local deletions remove only linked records and keep unrelated stops and graph edges.
const deleted = transferSnapshot(extracted);
deleted.config.config.project.virtualTeaching.tasks = [];
deleted.config.config.project.waypoints = [];
deleted.config.config.project.edges = [];
const deletedResult = normalizeProject((await writeBackTeachingWorkspace(deleted, original)).config.project);
assert.deepEqual(deletedResult.teachingTasks[0].parkingPoints.map((point) => point.id), ['map-outside']);
assert.deepEqual(deletedResult.waypoints.map((point) => point.id), ['wp-2']);
assert.equal(deletedResult.edges.length, 0);

// Empty but retained tasks survive repeated writebacks without being deleted and re-created.
const whole = transferSnapshot(await extractTeachingWorkspace(original, { bounds: original.map.bounds, localToMap }));
whole.config.config.project.virtualTeaching.tasks[0].parkingPoints = [];
const emptied = await writeBackTeachingWorkspace(whole, original);
assert.equal(emptied.config.project.virtualTeaching.tasks.length, 1);
assert.equal(emptied.config.project.virtualTeaching.tasks[0].parkingPoints.length, 0);
whole.config.config = emptied.sourceConfig;
assert.equal((await writeBackTeachingWorkspace(whole, transferSnapshot(emptied))).config.project.virtualTeaching.tasks.length, 1);

// Placement uses the robot as anchor, with full SE(3), unique IDs and existing tasks preserved.
const destination = { position: { x: -4, y: 5, z: 2 }, rpy: { roll: 30, pitch: 20, yaw: -45 } };
const isolated = teachingTransferFixture('independent');
const placement = placementTransform(destination, isolated.config.config.project.robot.origin);
const placed = await placeTeachingWorkspace(isolated, source, { localToMap: placement });
const placedProject = normalizeProject(placed.config.project);
samePose(placedProject.robot.origin, destination);
assert.equal(placed.map.pointCount, source.map.pointCount + isolated.map.pointCount);
assert.equal(placed.map.faceCount, 4);
assert.equal(placedProject.teachingTasks.length, 2);
assert.equal(placedProject.jointPoses.length, 3);
assert.equal(new Set(placedProject.jointPoses.map((pose) => pose.id)).size, 3);
assert.equal(placedProject.teachingTasks[0].id, sourceProject.teachingTasks[0].id);
assert.notEqual(placedProject.teachingTasks[1].id, isolated.config.config.project.virtualTeaching.tasks[0].id);
assert.equal(new Set(placedProject.waypoints.map((point) => point.id)).size, 6);
const ids = new Set(placedProject.waypoints.map((point) => point.id));
assert.ok(placedProject.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
assert.equal(placed.map.sourceBlob, null);
assert.notEqual(placed.map.sourceHash, source.map.sourceHash);
assert.ok(placedProject.teachingTasks.every((task) => task.map.sourceHash === placed.map.sourceHash));
samePose(transformTeachingPose(transformTeachingPose(destination, transferMatrix(localToMap)), transferMatrix(localToMap).invert()), destination);
console.log('crop_mesh_and_full_pose_transform=ok');
console.log('camera_world_pose_and_local_media=ok');
console.log('writeback_conflicts_and_repeated_refinement=ok');
console.log('placement_and_archive_link_roundtrip=ok');
