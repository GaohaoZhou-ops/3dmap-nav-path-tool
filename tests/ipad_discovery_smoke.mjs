import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { advertiseIPadService } from '../src/server/ipadDiscovery.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-discovery-'));
const identity = { serverId: randomUUID(), serverName: 'Atlas Discovery Test' };
const wrongIdentity = { serverId: randomUUID(), serverName: 'Other Service' };
let reads = 0, writes = 0;
const middleware = createIPadTeachingService({ directory, ...identity });
const server = createServer((req, res) => {
  req.method === 'GET' ? reads++ : writes++;
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
const wrongServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...wrongIdentity, protocol: 'unrelated/1', port: wrongServer.address().port }));
});
const errors = [], cleanups = [];
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
try {
  const binary = path.join(directory, 'discovery-test');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift',
    'ipad/AtlasTeaching/LANServiceDiscovery.swift', 'ipad/Tests/DiscoveryTests.swift', '-o', binary]);
  await Promise.all([server, wrongServer].map((server) => new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))));
  const onError = (error) => errors.push(error);
  cleanups.push(advertiseIPadService(server, { ...identity, onError }));
  cleanups.push(advertiseIPadService(server, { ...identity, serverName: 'Second interface name', onError }));
  cleanups.push(advertiseIPadService(wrongServer, { ...wrongIdentity, onError }));
  await run(binary, [identity.serverId, wrongIdentity.serverId]);
  assert.ok(reads > 0, 'Bonjour results are verified through the actual HTTP service');
  assert.equal(writes, 0, 'Discovery cannot pair, download a model or upload results');
  assert.equal(errors.length, 0, String(errors));
} finally {
  for (const stop of cleanups) stop();
  await Promise.all([server, wrongServer].map((server) => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  })));
  await rm(directory, { recursive: true, force: true });
}
