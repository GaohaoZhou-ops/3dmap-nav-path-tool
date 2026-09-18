import assert from 'node:assert/strict';

import {
  buildExport,
  normalizeProject,
  normalizeTeachingSpaceMode,
  teachingCoordinateFrame,
} from '../src/lib/io.js';

const mapData = {
  name: 'local-scan.ply',
  pointCount: 3,
  faceCount: 1,
  bounds: {
    min: { x: -1, y: -2, z: -0.5 },
    max: { x: 3, y: 4, z: 2.5 },
  },
  sourceHash: 'scan-sha256',
  sourceHashKind: 'file',
};

const task = {
  id: 'task-local',
  name: '独立示教任务',
  coordinateFrame: 'virtual_origin',
  robot: { id: 'robot-a', name: 'Robot A', relativePath: 'robot.urdf' },
  map: {
    id: 'map-local',
    fileName: mapData.name,
    sourceHash: mapData.sourceHash,
    teachingSpaceMode: 'independent',
    coordinateFrame: 'virtual_origin',
  },
  parkingPoints: [{
    id: 'parking-1',
    name: '停车点 P01',
    mapPose: {
      frameId: 'virtual_origin',
      position: { x: 0, y: 0, z: 0 },
      rpy: { roll: 0, pitch: 0, yaw: 0 },
    },
    poses: [{
      id: 'pose-1',
      name: 'A01',
      mapPose: {
        frameId: 'virtual_origin',
        position: { x: 0, y: 0, z: 0 },
        rpy: { roll: 0, pitch: 0, yaw: 0 },
      },
      fullBodyJoints: { values: { shoulder: 12 } },
    }],
  }],
};

const exported = buildExport({
  mapData,
  teachingSpaceMode: 'independent',
  heightRange: [-0.5, 2.5],
  waypoints: [],
  edges: [],
  teachingTasks: [task],
});

assert.equal(normalizeTeachingSpaceMode('standalone'), 'independent');
assert.equal(teachingCoordinateFrame('independent'), 'virtual_origin');
assert.equal(exported.workspace.teachingSpaceMode, 'independent');
assert.deepEqual(exported.teachingSpace.origin, { x: 0, y: 0, z: 0 });
assert.equal(exported.teachingSpace.originSource, 'point-cloud-origin');
assert.equal(exported.coordinateSystem.frameId, 'virtual_origin');
assert.equal(exported.map.coordinateFrame, 'virtual_origin');
assert.equal(exported.virtualTeaching.coordinateFrame, 'virtual_origin');
assert.equal(exported.virtualTeaching.tasks[0].coordinateFrame, 'virtual_origin');
assert.equal(
  exported.virtualTeaching.tasks[0].parkingPoints[0].mapPose.frameId,
  'virtual_origin',
);
assert.equal(
  exported.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.frameId,
  'virtual_origin',
);

const restored = normalizeProject(exported);
assert.equal(restored.workspace.teachingSpaceMode, 'independent');
assert.equal(restored.teachingTasks[0].coordinateFrame, 'virtual_origin');
assert.equal(restored.teachingTasks[0].map.teachingSpaceMode, 'independent');
assert.equal(restored.teachingTasks[0].parkingPoints[0].mapPose.frameId, 'virtual_origin');

const legacy = normalizeProject({
  map: mapData,
  waypoints: [],
  paths: [],
});
assert.equal(legacy.workspace.teachingSpaceMode, 'map');
assert.equal(teachingCoordinateFrame(legacy.workspace.teachingSpaceMode), 'map');

console.log('independent teaching mode smoke test passed');
