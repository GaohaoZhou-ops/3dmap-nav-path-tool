import { buildExport } from '../src/lib/io.js';
import { buildProjectArchive } from '../src/lib/projectArchive.js';
import { unzipSync } from 'fflate';
import { Box3, BoxGeometry, Float32BufferAttribute, PlaneGeometry } from 'three';

export function teachingTransferFixture(mode = 'map') {
  const position = { x: 10, y: 20, z: 1 };
  const pose = (x = 10) => ({ frameId: mode === 'map' ? 'map' : 'virtual_origin',
    position: { ...position, x }, rpy: { roll: 15, pitch: -12, yaw: 90 } });
  const opticalPose = { frameName: 'zivid_left_optical_frame', position: { x: 10.5, y: 20.2, z: 1.8 },
    quaternion: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } };
  const robot = { id: 'transfer/robot.urdf', relativePath: 'transfer/robot.urdf', name: 'Transfer robot',
    fileName: 'robot.urdf', format: 'urdf', packagePath: 'transfer', packageName: 'transfer' };
  const robotPackage = { ...robot, files: [{ path: 'transfer/robot.urdf', mimeType: 'application/xml', bytes: new TextEncoder().encode(
    '<robot name="transfer_robot"><link name="base_link"><visual><geometry><box size="0.5 0.3 0.3"/></geometry></visual></link></robot>',
  ) }] };
  const map = { geometryCacheVersion: 1, mapId: `fixture-${mode}`, name: `${mode}-transfer.ply`,
    pointCount: 6, faceCount: 2, byteLength: 120, teachingSpaceMode: mode,
    sourceHash: `fixture-${mode}-hash`, sourceHashKind: 'file',
    positionBuffer: new Float32Array([10,20,1, 11,20,1, 10,21,1, 30,20,1, 31,20,1, 30,21,1]).buffer,
    colorBuffer: new Uint8Array([255,0,0, 0,255,0, 0,0,255, 200,100,0, 0,100,200, 100,0,200]).buffer,
    indexBuffer: new Uint16Array([0,1,2, 3,4,5]).buffer, indexComponentType: 'uint16',
    bounds: { min: { x: 10, y: 20, z: 1 }, max: { x: 31, y: 21, z: 1 } },
    portableRobotPackage: robotPackage,
  };
  const parking = (id, x) => ({ id, name: id, mapPose: pose(x), poses: [{ id: `${id}-pose`, name: 'pose', mapPose: pose(x),
    fullBodyJoints: { values: { shoulder: 12, lift: 0.4 } },
    opticalTargets: { left: opticalPose },
    cameraCapture: { frames: { left: { opticalPose, rgb: { dataUrl: 'data:image/png;base64,aGVsbG8=', width: 1, height: 1 },
      pointCloud: { pointCount: 1, coordinateFrame: 'zivid_left_optical_frame', positionData: 'AAABAAIA', colorData: '/wAA' },
    } } },
    replanningHistory: [{ sourceMapPose: pose(x), commonMapPose: pose(x) }],
  }], mergeHistory: [{ id: 'history', sourceParkingPoints: [{ id: 'before', name: 'before', mapPose: pose(x) }] }] });
  const tasks = [{ id: `${mode}-task`, name: `${mode} task`, coordinateFrame: pose().frameId, robot,
    map: { id: map.mapId, fileName: map.name, sourceHash: map.sourceHash },
    parkingPoints: [parking(`${mode}-inside`, 10), parking(`${mode}-outside`, 30)],
  }];
  const waypoints = [10,11,30].map((x, index) => ({ id: `wp-${index}`, name: `W${index}`, pose: { x, y: 20, z: 1, roll: 0, pitch: 0, yaw: 90 } }));
  const edges = [{ id: 'inside-edge', from: 'wp-0', to: 'wp-1' }, { id: 'cross-edge', from: 'wp-1', to: 'wp-2' }]
    .map((edge) => ({ ...edge, limits: { minSpeed: 0.2, maxSpeed: 1, minAcceleration: -0.5, maxAcceleration: 0.5 }, status: 'connected' }));
  const project = buildExport({ mapData: map, teachingSpaceMode: mode, heightRange: [0.5, 1.5], waypoints, edges,
    robot, robotPose: pose(), robotJointValues: { shoulder: 12, lift: 0.4 }, teachingTasks: tasks,
    jointPoses: [{ id: 'joint-preset', name: 'Reference joints', robot, joints: { values: { shoulder: 12, lift: 0.4 } } }],
    activeTeachingTaskId: tasks[0].id, activeTeachingParkingPointId: tasks[0].parkingPoints[0].id,
  });
  return { mode, map, config: { mapId: map.mapId, config: { schemaVersion: 1, project,
    ui: { ...project.workspace, selectedRobot: project.robot, robotHeightLocked: false } } } };
}

export const transferSnapshot = (result) => ({ mode: result.mode, map: result.map,
  config: { mapId: result.map.mapId, config: result.config } });

export async function transferFixtureFiles(fixture) {
  const archive = await buildProjectArchive(fixture.config.config.project, {
    mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage,
  });
  return unzipSync(archive.bytes);
}

// A small room and a separate workpiece make 3D manipulation observable without
// loading a user's real map or robot assets into the browser test.
export function teachingTransfer3DFixture(mode = 'map') {
  const fixture = teachingTransferFixture(mode);
  const parts = mode === 'map' ? [
    new PlaneGeometry(30, 18, 30, 18).translate(20, 21, 0),
    new BoxGeometry(30, 0.2, 4).translate(20, 30, 2),
    new BoxGeometry(0.2, 18, 4).translate(5, 21, 2),
    new BoxGeometry(2, 1.5, 1.2).translate(10, 20, 0.6),
    new BoxGeometry(3, 2, 2).translate(28, 25, 1),
  ] : [
    new BoxGeometry(1.8, 1.2, 0.3).translate(11, 20, 1.15),
    new BoxGeometry(0.3, 1.2, 1.7).translate(11.7, 20, 2.15),
    new BoxGeometry(1.1, 0.7, 0.5).translate(10.7, 20, 1.55),
  ];
  const positions = [], indices = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.attributes.position.array);
    indices.push(...Array.from(part.index.array, (index) => index + offset));
    part.dispose();
  }
  const attribute = new Float32BufferAttribute(positions, 3);
  const box = new Box3().setFromBufferAttribute(attribute);
  Object.assign(fixture.map, {
    positionBuffer: attribute.array.buffer, colorBuffer: null,
    indexBuffer: new Uint32Array(indices).buffer, indexComponentType: 'uint32',
    pointCount: positions.length / 3, faceCount: indices.length / 3,
    bounds: { min: { ...box.min }, max: { ...box.max } },
    sourceHash: `fixture-3d-${mode}`,
  });
  Object.assign(fixture.config.config.project.map, { sourceHash: fixture.map.sourceHash, bounds: fixture.map.bounds,
    pointCount: fixture.map.pointCount, faceCount: fixture.map.faceCount });
  fixture.config.config.project.virtualTeaching.tasks.forEach((task) => { task.map.sourceHash = fixture.map.sourceHash; });
  return fixture;
}
