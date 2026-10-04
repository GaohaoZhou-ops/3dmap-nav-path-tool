export function abxTeachingFixture() {
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
  return { payload, robotPackage, robotPath, model, stamp, values, a, b };
}
