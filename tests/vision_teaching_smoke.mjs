import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BoxGeometry } from 'three';
import { packIPadModel, ipadResultTask } from '../src/lib/ipadTeaching.js';
import { validateIPadResult } from '../src/lib/ipadProtocol.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-vision-'));
const middleware = createIPadTeachingService({ directory: path.join(directory, 'server') });
const writes = [];
const server = createServer((req, res) => {
  if (req.method === 'POST' && /\/(verify-model|result)$/.test(req.url)) res.on('finish', () => writes.push([req.url.split('/').at(-1), res.statusCode]));
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
const geometry = new BoxGeometry(1, 1, 1); geometry.computeBoundingBox();
const map = { geometry, name: 'vision-test.ply', mapId: 'vision-test', sourceHash: 'vision-test', bounds: geometry.boundingBox };
try {
  const packed = await packIPadModel(map), fixture = path.join(directory, 'fixture');
  await writeFile(`${fixture}.atls`, new Uint8Array(packed.buffer));
  await writeFile(`${fixture}.json`, JSON.stringify(packed.manifest));
  const binary = path.join(directory, 'vision-native');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift',
    'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/AtlasTeaching/ModelGeometry.swift', 'vision/AtlasVisionTeaching/VisionPoseMath.swift',
    'vision/AtlasVisionTeaching/VisionMeshData.swift', 'vision/Tests/VisionCoreTests.swift', '-o', binary]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const resultFile = path.join(directory, 'result.json');
  await run(binary, [`http://127.0.0.1:${server.address().port}`, fixture, path.join(directory, 'device'), resultFile]);
  assert.deepEqual(writes, [['verify-model', 200], ['result', 200], ['verify-model', 200], ['result', 200]], 'unfinished and corrupted local data sends no poses; every retry verifies model identity');
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  const validate = value => validateIPadResult(value, packed.manifest, result.sessionId);
  assert.doesNotThrow(() => validate(result));
  for (const mutate of [
    r => { r.device.platform = 'visionOS-simulator'; },
    r => { r.device.poseSource = 'eyeGaze'; },
    r => { r.device.lidar = true; },
    r => { r.samples[0].cameraPose.frameName = 'ipad_camera_optical_frame'; },
    r => { delete r.device.platform; },
    r => { r.samples[0].tracking = 'limited'; },
    r => { r.calibrations[0].worldFromModel[0] *= 2; },
  ]) {
    const bad = structuredClone(result); mutate(bad); assert.throws(() => validate(bad));
  }
  const task = await ipadResultTask(result, { id: result.sessionId, manifest: packed.manifest }, map);
  assert.match(task.name, /^Vision Pro 示教/);
  assert.deepEqual(task.mobileCapture, result);
  assert.deepEqual(task.parkingPoints, [], 'head poses are never fabricated robot joints');
  const exported = buildExport({ mapData: map, teachingSpaceMode: 'independent', heightRange: [-1, 1], waypoints: [], edges: [], teachingTasks: [task] });
  assert.deepEqual(normalizeProject(exported).teachingTasks[0].mobileCapture, result);
  const archive = await buildProjectArchive(exported, { mapResource: {
    positionBuffer: geometry.attributes.position.array.buffer, indexBuffer: geometry.index.array.buffer,
    indexComponentType: 'uint16', pointCount: geometry.attributes.position.count, faceCount: geometry.index.count / 3,
    bounds: geometry.boundingBox, sourceHash: map.sourceHash,
  } });
  assert.deepEqual(normalizeProject((await readProjectArchive(archive.bytes)).payload).teachingTasks[0].mobileCapture, result);
  console.log('Vision Pro protocol, simulator rejection, desktop import and archive round trip passed.');
} finally {
  geometry.dispose(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
