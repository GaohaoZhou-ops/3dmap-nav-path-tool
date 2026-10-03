import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { IPAD_PROTOCOL } from '../src/lib/ipadProtocol.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-pairing-code-'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const model = Buffer.alloc(48); model.writeUInt32LE(0x534c5441); model.writeUInt32LE(1, 4); model.writeUInt32LE(1, 8);
const manifest = { protocol: IPAD_PROTOCOL, name: 'pairing-test', modelHash: digest(model), sourceHash: digest(model), sourceMapId: '',
  coordinateFrame: 'virtual_origin', distanceUnit: 'meter', verticalAxis: 'Z', vertices: 1, indices: 0, sampled: false, originalVertices: 1, byteLength: 48 };
// Force collisions across overlapping creations and renewal; random chance cannot make this test pass.
const codes = ['Q7Z2', 'Q7Z2', 'M8N3', 'Q7Z2', 'M8N3', '1234'];
let middleware = createIPadTeachingService({ directory, generatePairingCode: () => codes.shift() });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad`;
async function api(route, { body, token, method = 'POST', status = 200 } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
try {
  const tasks = await Promise.all([0, 1].map(() => api('/sessions', { body: { manifest }, status: 201 })));
  assert.deepEqual(new Set(tasks.map((t) => t.pairingCode)), new Set(['Q7Z2', 'M8N3']));
  for (const task of tasks) await api(`/sessions/${task.id}/model`, { method: 'PUT', token: task.ownerToken, body: model });
  const first = tasks.find((t) => t.pairingCode === 'Q7Z2'), second = tasks.find((t) => t.pairingCode === 'M8N3');
  const renewed = await api(`/sessions/${first.id}/renew`, { token: first.ownerToken });
  assert.equal(renewed.pairingCode, '1234', 'renewal also avoids existing codes');
  const deviceId = randomUUID();
  for (const code of ['', 'ABC', 'ABCDE', 'A1-2', 'A1B2C3D4E5F6', '中文12']) {
    await api('/pair', { body: { code, deviceId }, status: 400 });
  }
  await api('/pair', { body: { code: first.pairingCode, deviceId }, status: 404 });
  assert.equal((await api('/pair', { body: { code: '1234', deviceId } })).id, first.id);
  // Simulate an old 12-character unpaired task: renewal migrates it without re-uploading the model.
  const legacyPath = path.join(directory, second.id, 'session.json');
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8')); legacy.pairingCodeHash = digest('A1B2C3D4E5F6');
  await writeFile(legacyPath, JSON.stringify(legacy));
  // Persisted reservations remain effective after restarting the service.
  const restartedCodes = ['1234', 'WXYZ'];
  middleware = createIPadTeachingService({ directory, generatePairingCode: () => restartedCodes.shift() });
  const migrated = await api(`/sessions/${second.id}/renew`, { token: second.ownerToken });
  assert.equal(migrated.pairingCode, 'WXYZ');
  assert.equal((await api('/pair', { body: { code: ' wxyz ', deviceId } })).id, second.id);
  assert.deepEqual(await readFile(path.join(directory, second.id, 'model.atls')), model);
  await api('/pair', { body: { code: 'WXYZ', deviceId: randomUUID() }, status: 409 });
  console.log('Four-character pairing, concurrent collisions, renewal, legacy migration, restart and input validation passed.');
} finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
