import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { IPAD_PROTOCOL } from '../src/lib/ipadProtocol.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-pairing-qr-'));
const serverId = randomUUID();
const middleware = createIPadTeachingService({ directory, serverId,
  getAddresses: (port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`] });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const model = Buffer.alloc(48); model.writeUInt32LE(0x534c5441); model.writeUInt32LE(1, 4); model.writeUInt32LE(1, 8);
const hash = createHash('sha256').update(model).digest('hex');
const manifest = { protocol: IPAD_PROTOCOL, name: 'qr-test', modelHash: hash, sourceHash: hash, sourceMapId: '',
  coordinateFrame: 'virtual_origin', distanceUnit: 'meter', verticalAxis: 'Z', vertices: 1, indices: 0,
  sampled: false, originalVertices: 1, byteLength: model.length };
async function api(route, { body, token, method = 'POST', status = 200 } = {}) {
  const response = await fetch(address + '/__atlas/ipad' + route, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
const qr = (task, options = {}) => api(`/sessions/${task.id}/pairing-qr`, {
  body: { address, code: task.pairingCode }, token: task.ownerToken, ...options });
async function ready() {
  const task = await api('/sessions', { body: { manifest }, status: 201 });
  await qr(task, { status: 409 });
  await api(`/sessions/${task.id}/model`, { method: 'PUT', token: task.ownerToken, body: model });
  return task;
}
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
try {
  const task = await ready(), other = await ready();
  await qr(task, { token: undefined, status: 401 });
  await qr(task, { token: other.ownerToken, status: 401 });
  await qr(task, { body: { address: 'http://8.8.8.8:21990', code: task.pairingCode }, status: 400 });
  await qr(task, { body: { address, code: 'ABCDE' }, status: 409 });
  const initial = await qr(task);
  assert.match(initial.image, /^data:image\/png;base64,/);
  assert.equal(initial.expiresAt, task.pairingExpiresAt);
  const alternate = await qr(task, { body: { address: `http://localhost:${server.address().port}`, code: task.pairingCode } });
  assert.notEqual(alternate.image, initial.image, 'changing the selected address changes the QR image');
  const updated = { ...task, ...await api(`/sessions/${task.id}/renew`, { token: task.ownerToken }) };
  await qr(task, { status: 409 });
  await api('/pair', { body: { code: task.pairingCode, deviceId: randomUUID(), sessionId: task.id, serverId }, status: 404 });
  const renewed = await qr(updated);
  assert.notEqual(renewed.image, initial.image);
  const file = path.join(directory, 'pairing.png'), modelFile = path.join(directory, 'fixture.atls');
  await writeFile(file, Buffer.from(renewed.image.split(',')[1], 'base64'));
  await writeFile(modelFile, model);
  const binary = path.join(directory, 'qr-test');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/LANClient.swift', 'ipad/Tests/QRCodeTests.swift', '-o', binary]);
  await run(binary, [file, address, task.id, serverId, modelFile]);
  await qr(updated, { status: 409 });
  // Original manual code flow remains compatible, without QR-only identity fields.
  const paired = await api('/pair', { body: { code: other.pairingCode.toLowerCase(), deviceId: randomUUID() } });
  assert.equal(paired.id, other.id);
  const expired = await ready();
  const sessionFile = path.join(directory, expired.id, 'session.json');
  const data = JSON.parse(await readFile(sessionFile, 'utf8')); data.pairingExpiresAt = Date.now() - 1;
  await writeFile(sessionFile, JSON.stringify(data));
  await qr(expired, { status: 410 });
  console.log('QR ownership, LAN address selection, code renewal, expiry, task binding and manual fallback passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
