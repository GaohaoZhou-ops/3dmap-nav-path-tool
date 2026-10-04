import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { packIPadModel, ipadResultTask } from '../src/lib/ipadTeaching.js';
import { IPAD_PROTOCOL, MAX_MODEL_VERTICES, MAX_MODEL_INDICES, validateIPadResult, validateModelBytes } from '../src/lib/ipadProtocol.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';
import { transformTeachingTasks, transferMatrix, placeTeachingWorkspace, writeBackTeachingWorkspace, extractTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { createIPadCaptureLayer, disposeIPadCaptureLayer, mobileSamplePosition } from '../src/lib/ipadCaptureDisplay.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-ipad-'));
let middleware = createIPadTeachingService({ directory });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad`;
async function request(route, { method = 'GET', token, body, expected = 200, origin } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(origin ? { Origin: origin } : {}), 'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json)); return json;
}
try {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([1, 2, 3, 2, 2, 3, 1, 3, 3], 3));
  geometry.setAttribute('color', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  geometry.setIndex([0, 1, 2]); geometry.computeBoundingBox();
  const map = { geometry, name: 'workpiece.ply', mapId: 'test-independent-map', sourceHash: 'source-hash', bounds: geometry.boundingBox, pointCount: 3, faceCount: 1 };
  const packed = await packIPadModel(map);
  assert.deepEqual(validateModelBytes(new Uint8Array(packed.buffer)), { vertices: 3, indices: 3 });
  assert.equal(packed.manifest.sampled, false);
  assert.equal(new DataView(packed.buffer).getFloat32(32 + 2 * 4, true), 3, 'Z-up values survive packing');
  const oversized = new BufferGeometry(); oversized.setAttribute('position', new Float32BufferAttribute(new Float32Array(750001 * 3).fill(1), 3));
  oversized.setIndex([0, 750000, 1]);
  const preserved = await packIPadModel({ ...map, geometry: oversized });
  assert.equal(preserved.manifest.sampled, false); assert.equal(preserved.manifest.vertices, 750001);
  assert.equal(preserved.manifest.indices, 3, 'large workpieces retain real mesh data for local quality changes');
  validateModelBytes(new Uint8Array(preserved.buffer)); oversized.dispose();
  await assert.rejects(packIPadModel({ geometry: { getAttribute: () => ({ count: MAX_MODEL_VERTICES + 1 }), getIndex: () => null } }), /传输上限/);
  await assert.rejects(packIPadModel({ geometry: { getAttribute: () => ({ count: 3 }), getIndex: () => ({ count: MAX_MODEL_INDICES + 3 }) } }), /传输上限/);
  const invalidIndex = geometry.clone(); invalidIndex.setIndex([0, 1, 3]);
  await assert.rejects(packIPadModel({ ...map, geometry: invalidIndex }), /索引越界/); invalidIndex.dispose();
  await request('/info', { origin: 'http://outside.invalid', expected: 403 });
  const info = await request('/info');
  assert.equal(info.protocol, IPAD_PROTOCOL);
  assert.equal(info.port, server.address().port);
  assert.match(info.serverId, /^[a-f0-9-]{36}$/);
  assert.ok(info.serverName);
  assert.deepEqual(Object.keys(info).sort(), ['addresses', 'maxModelBytes', 'port', 'protocol', 'serverId', 'serverName'].sort(), 'discovery never exposes pairing codes or credentials');
  const created = await request('/sessions', { method: 'POST', body: { manifest: packed.manifest }, expected: 201 });
  assert.match(created.pairingCode, /^[A-Z0-9]{4}$/);
  const sessionPath = `/sessions/${created.id}`, owner = created.ownerToken;
  await request(sessionPath, { expected: 401 });
  await request(sessionPath + '/model', { method: 'PUT', token: owner, body: new ArrayBuffer(50), expected: 400 });
  await request(sessionPath + '/model', { method: 'PUT', token: owner, body: packed.buffer });
  await request(sessionPath + '/model', { method: 'PUT', token: owner, body: packed.buffer, expected: 409 });
  const pairing = { code: created.pairingCode, deviceId: randomUUID(), deviceName: 'Test iPad Pro' };
  const paired = await request('/pair', { method: 'POST', body: pairing });
  await request('/pair', { method: 'POST', body: { ...pairing, deviceId: randomUUID() }, expected: 409 });
  await request(sessionPath, { token: paired.deviceToken, expected: 401 });
  const model = await fetch(base + sessionPath + '/model', { headers: { Authorization: `Bearer ${paired.deviceToken}` } });
  assert.equal(model.status, 200); assert.deepEqual(new Uint8Array(await model.arrayBuffer()), new Uint8Array(packed.buffer));
  await request(sessionPath + '/result', { token: owner, expected: 409 });
  const result = { protocol: IPAD_PROTOCOL, id: randomUUID(), sessionId: created.id, modelHash: packed.manifest.modelHash,
    coordinateFrame: 'virtual_origin', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    device: { model: 'iPad Pro', lidar: true }, calibrations: [{ id: 'segment-1', worldFromModel: new Matrix4().makeRotationX(-Math.PI / 2).toArray() }],
    samples: [0, 1].map((index) => ({ id: `sample-${index}`, name: `Pose ${index + 1}`, segmentId: 'segment-1', capturedAt: new Date().toISOString(), kind: 'keyframe', tracking: 'normal',
      cameraPose: { frameName: 'ipad_camera_optical_frame', position: { x: index + 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, surfacePoint: { x: 1, y: 1, z: 1 } })) };
  const identity = { modelHash: packed.manifest.modelHash, byteLength: packed.buffer.byteLength };
  const verify = (body = identity, expected = 200) => request(sessionPath + '/verify-model', { method: 'POST', token: paired.deviceToken, body, expected });
  await request(sessionPath + '/verify-model', { method: 'POST', body: identity, expected: 401 });
  await request(sessionPath + '/verify-model', { method: 'POST', token: owner, body: identity, expected: 401 });
  await verify({ ...identity, byteLength: -1 }, 400);
  await verify({ ...identity, modelHash: '0'.repeat(64) }, 409);
  await verify({ ...identity, byteLength: identity.byteLength + 1 }, 409);
  assert.deepEqual(await verify(), { ...identity, sessionId: created.id, verified: true });
  // A same-size model replacement after verification must also fail at result receipt.
  const modelFile = path.join(directory, created.id, 'model.atls');
  const changed = packed.buffer.slice(0); new DataView(changed).setFloat32(32, 42, true);
  await writeFile(modelFile, new Uint8Array(changed));
  assert.match((await verify(identity, 409)).error, /模型文件已改变/);
  await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: result, expected: 409 });
  assert.equal((await request(sessionPath, { token: owner })).status, 'paired', 'failed checks never mark a result completed');
  await request(sessionPath + '/result', { token: owner, expected: 409 });
  await rm(modelFile);
  assert.match((await verify(identity, 409)).error, /缺少.*模型文件/);
  await writeFile(modelFile, new Uint8Array(packed.buffer));
  await verify();
  assert.throws(() => validateIPadResult({ ...result, modelHash: 'wrong' }, packed.manifest, created.id), /不匹配/);
  const reflected = structuredClone(result); reflected.calibrations[0].worldFromModel = new Matrix4().makeScale(-1, 1, 1).toArray();
  assert.throws(() => validateIPadResult(reflected, packed.manifest, created.id), /镜像/);
  const invalid = structuredClone(result); invalid.samples[0].tracking = 'limited';
  await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: invalid, expected: 400 });
  const receipt = await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: result });
  assert.equal(receipt.received, true);
  middleware = createIPadTeachingService({ directory }); // Restart without losing models, credentials or results.
  assert.equal((await request(sessionPath, { token: owner })).status, 'completed');
  await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: result });
  await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: { ...result, id: randomUUID() }, expected: 409 });
  const received = await request(sessionPath + '/result', { token: owner }); assert.deepEqual(received, result);
  const ticket = { ...created, manifest: packed.manifest };
  const task = await ipadResultTask(result, ticket, map);
  assert.equal((await ipadResultTask(result, ticket, { ...map, mapId: 'reopened-project', name: 'renamed.ply', sourceHash: 'different-metadata' })).id,
    task.id, 'identical model bytes match regardless of names or project metadata');
  for (const field of ['position', 'color', 'index']) {
    const different = geometry.clone();
    if (field === 'index') different.setIndex([0, 2, 1]);
    else different.getAttribute(field).setX(0, field === 'position' ? 42 : 0.5);
    await assert.rejects(ipadResultTask(result, ticket, { ...map, geometry: different }), /模型内容不一致/,
      `same filename, IDs, counts and source hash must not hide changed ${field}`);
    different.dispose();
  }
  const desktopTasks = teachingTransferFixture('independent').config.config.project.virtualTeaching.tasks;
  const desktopBefore = structuredClone(desktopTasks), ipadBefore = structuredClone(result);
  const withDesktopPoses = { ...map, teachingTasks: desktopTasks, samples: desktopTasks[0].parkingPoints[0].poses };
  assert.equal((await packIPadModel(withDesktopPoses)).manifest.modelHash, packed.manifest.modelHash, 'desktop poses are excluded from model fingerprints');
  const withBoth = normalizeProject(buildExport({ mapData: map, teachingSpaceMode: 'independent', heightRange: [0, 4], waypoints: [], edges: [],
    teachingTasks: [...desktopTasks, await ipadResultTask(result, ticket, withDesktopPoses)] }));
  assert.equal(withBoth.teachingTasks.length, desktopTasks.length + 1, 'different desktop and iPad poses coexist');
  assert.deepEqual(withBoth.teachingTasks.at(-1).mobileCapture, result);
  assert.deepEqual(desktopTasks, desktopBefore, 'model checking never changes desktop poses');
  assert.deepEqual(result, ipadBefore, 'model checking never changes iPad poses');
  const exported = buildExport({ mapData: map, teachingSpaceMode: 'independent', heightRange: [0, 4], waypoints: [], edges: [], teachingTasks: [task] });
  const normalized = normalizeProject(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(normalized.teachingTasks[0].mobileCapture, result);
  const archive = await buildProjectArchive(exported, { mapResource: {
    positionBuffer: geometry.getAttribute('position').array.buffer, indexBuffer: geometry.index.array.buffer,
    indexComponentType: 'uint16', pointCount: 3, faceCount: 1, bounds: map.bounds, sourceHash: map.sourceHash,
  } });
  const restored = await readProjectArchive(archive.bytes);
  assert.deepEqual(normalizeProject(restored.payload).teachingTasks[0].mobileCapture, result, 'full ZIP preserves Pose names, orientations and calibrations');
  assert.equal(normalized.teachingTasks[0].parkingPoints.length, 0, 'iPad poses are never fabricated robot poses');
  const transform = transferMatrix({ position: { x: 10, y: 20, z: 5 }, rpy: { roll: 10, pitch: 20, yaw: 90 } });
  const moved = transformTeachingTasks(normalized.teachingTasks, transform, 'map', map)[0];
  const expected = new Vector3(1, 2, 3).applyMatrix4(transform);
  assert.ok(mobileSamplePosition(result.samples[0], moved).distanceTo(expected) < 1e-6);
  assert.deepEqual(moved.mobileCapture, result, 'raw capture remains immutable across workspace transforms');
  const layer = createIPadCaptureLayer([moved]); assert.equal(layer.children.length, 3); disposeIPadCaptureLayer(layer);
  // Real transfer pipeline: new mobile tasks survive placement and extraction/write-back.
  const independent = teachingTransferFixture('independent'), background = teachingTransferFixture('map');
  independent.config.config.project.virtualTeaching.tasks.push({ ...task, map: { ...task.map, id: independent.map.mapId } });
  const pose = { position: { x: 10, y: 20, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
  const placed = await placeTeachingWorkspace(independent, background, { localToMap: pose });
  assert.equal(placed.config.project.virtualTeaching.tasks.filter((item) => item.mobileCapture).length, 1);
  const extraction = await extractTeachingWorkspace(background, { bounds: { min: { x: 9, y: 19, z: 0 }, max: { x: 12, y: 22, z: 4 } }, localToMap: pose, name: 'local' });
  extraction.config.project.virtualTeaching.tasks.push(task);
  const written = await writeBackTeachingWorkspace(transferSnapshot(extraction), background);
  assert.equal(written.config.project.virtualTeaching.tasks.filter((item) => item.mobileCapture).length, 1);
  await request(sessionPath + '/imported', { token: owner, method: 'POST' });
  assert.equal((await verify()).verified, true, 'model checks do not compare already imported poses');
  await request(sessionPath + '/result', { method: 'POST', token: paired.deviceToken, body: result });
  assert.equal((await request(sessionPath, { token: owner })).status, 'imported');
  await request(sessionPath, { method: 'DELETE', token: owner });
  await request(sessionPath + '/result', { token: paired.deviceToken, method: 'POST', body: result, expected: 410 });
  geometry.dispose(); console.log('iPad LAN, pre-sync model content checks, same-name mismatch rejection, independent poses, completion retry, persistence and workspace transforms passed.');
} finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
