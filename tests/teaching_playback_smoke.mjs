import assert from 'node:assert/strict';

import {
  buildTeachingTaskTrajectory,
  sampleTeachingTrajectorySegment,
} from '../src/lib/teachingPlayback.js';

const firstPose = {
  id: 'pose-1',
  sequence: 1,
  mapPose: {
    position: { x: 2, y: -3, z: 0.4 },
    rpy: { roll: 5, pitch: -10, yaw: 179 },
  },
  fullBodyJoints: { values: { elbow: 15, wrist: 370, lift: 0.2 } },
};
const secondPose = {
  ...firstPose,
  id: 'pose-2',
  sequence: 2,
  fullBodyJoints: { values: { elbow: 45, wrist: -340, lift: 0.1 } },
};
const finalPose = {
  ...secondPose,
  id: 'pose-3',
  sequence: 1,
  mapPose: {
    position: { x: 4, y: -3, z: 0.4 },
    rpy: { roll: 5, pitch: -10, yaw: -179 },
  },
};
const task = {
  id: 'task',
  parkingPoints: [
    { id: 'stop-2', sequence: 2, poses: [finalPose] },
    {
      id: 'stop-1',
      sequence: 1,
      mapPose: { position: { x: 1, y: 1, z: 0 } },
      poses: [secondPose, firstPose],
    },
    { id: 'empty-stop', sequence: 0, poses: [] },
  ],
};
const originalTask = structuredClone(task);
const plan = buildTeachingTaskTrajectory({
  task,
  jointDefinitions: [
    { name: 'elbow', type: 'revolute' },
    { name: 'wrist', type: 'continuous' },
    { name: 'lift', type: 'prismatic' },
  ],
});

// Sequence order chooses the first recording, skipping empty parking points.
// Restore its full base pose and joints without adding an approach segment.
assert.deepEqual(plan.initialRobotPose, firstPose.mapPose);
assert.deepEqual(plan.initialJointValues, firstPose.fullBodyJoints.values);
assert.equal(plan.segments[0].phase, 'hold');
assert.equal(plan.segments[0].target.parkingPointId, 'stop-1');
assert.deepEqual(sampleTeachingTrajectorySegment(plan.segments[0], 0).robotPose, firstPose.mapPose);
assert.deepEqual(
  sampleTeachingTrajectorySegment(plan.segments[0], 0).robotJointValues,
  firstPose.fullBodyJoints.values,
);
assert.deepEqual(
  plan.segments.filter((segment) => segment.phase === 'hold').map((segment) => segment.target.poseId),
  ['pose-1', 'pose-2', 'pose-3'],
);
assert.equal(plan.poseCount, 3);
assert.equal(plan.populatedParkingPointCount, 2);

// Subsequent recorded motions still interpolate, including shortest turns.
const jointSegment = plan.segments.find((segment) => segment.phase === 'joints');
assert.equal(jointSegment.target.poseId, 'pose-2');
assert.deepEqual(jointSegment.toJointValues, { elbow: 45, wrist: 380, lift: 0.1 });
const midpoint = sampleTeachingTrajectorySegment(jointSegment, 0.5);
assert.equal(midpoint.robotJointValues.elbow, 30);
assert.equal(midpoint.robotJointValues.wrist, 375);
assert.ok(Math.abs(midpoint.robotJointValues.lift - 0.15) < 1e-9);
assert.deepEqual(plan.finalRobotPose, finalPose.mapPose);
assert.deepEqual(task, originalTask);

// Legacy poses may inherit the parking point's base pose; a single recording
// has only a hold segment and can be replayed without any synthetic motion.
const inheritedPose = { ...firstPose, mapPose: undefined };
const single = buildTeachingTaskTrajectory({
  task: { parkingPoints: [{ mapPose: firstPose.mapPose, poses: [inheritedPose] }] },
});
assert.deepEqual(single.initialRobotPose, firstPose.mapPose);
assert.deepEqual(single.segments.map((segment) => segment.phase), ['hold']);
assert.ok(single.totalDurationMs > 0);

const empty = buildTeachingTaskTrajectory({ task: { parkingPoints: [{ poses: [] }] } });
assert.equal(empty.poseCount, 0);
assert.deepEqual(empty.segments, []);

console.log('teaching playback trajectory smoke test passed');
