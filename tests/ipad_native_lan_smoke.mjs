import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { packIPadModel } from '../src/lib/ipadTeaching.js';
import { validateIPadResult } from '../src/lib/ipadProtocol.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-native-ipad-'));
const serverDirectory = path.join(directory, 'server');
const middleware = createIPadTeachingService({ directory: serverDirectory });
const syncRequests = [];
const server = createServer((req, res) => {
  const action = req.url.split('/').at(-1);
  if (req.method === 'POST' && ['verify-model', 'result'].includes(action)) {
    res.on('finish', () => syncRequests.push(`${action}:${res.statusCode}`));
  }
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
try {
  const coordinatesBinary = path.join(directory, 'coordinates-test');
  const coordinatesResult = path.join(directory, 'coordinates-result.json');
  await run('xcrun', ['swiftc', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/Tests/main.swift', '-o', coordinatesBinary]);
  await run(coordinatesBinary, [coordinatesResult]);
  const tiltedResult = JSON.parse(await readFile(coordinatesResult, 'utf8'));
  assert.doesNotThrow(() => validateIPadResult(tiltedResult, { modelHash: tiltedResult.modelHash }, tiltedResult.sessionId),
    'the server accepts native Pose data with arbitrary model tilt');
  const geometryBinary = path.join(directory, 'geometry-test');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/ModelGeometry.swift', 'ipad/Tests/GeometryTests.swift', '-o', geometryBinary]);
  await run(geometryBinary, []);
  const binary = path.join(directory, 'native-test');
  await run('xcrun', ['swiftc', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/Tests/NetworkTests.swift', '-o', binary]);
  // Cross a native hashing chunk boundary so changes at the end of a larger file are checked.
  const positions = new Float32Array(70_003 * 3); positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setIndex([0, 1, 2]);
  const { buffer, manifest } = await packIPadModel({ geometry, name: 'native-test.ply', mapId: 'native-test', sourceHash: 'native-test' });
  const fixture = path.join(directory, 'fixture');
  await writeFile(`${fixture}.atls`, new Uint8Array(buffer)); await writeFile(`${fixture}.json`, JSON.stringify(manifest));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await run(binary, [`http://127.0.0.1:${server.address().port}`, fixture, path.join(directory, 'device'), serverDirectory]);
  assert.deepEqual(syncRequests, ['verify-model:409', 'verify-model:409', 'verify-model:200', 'result:200', 'verify-model:200', 'result:200'],
    'local failures send nothing; remote mismatches never send poses; every upload and retry verifies first');
} finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
