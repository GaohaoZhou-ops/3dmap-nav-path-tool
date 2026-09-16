import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import {
  PROJECT_ARCHIVE_CONFIG,
  PROJECT_ARCHIVE_MANIFEST,
  PROJECT_ARCHIVE_MAP_POSITIONS,
  PROJECT_DIRECTORY_DESCRIPTOR,
  buildProjectArchive,
  readProjectDirectoryHandle,
  updateProjectDirectory,
} from '../src/lib/projectArchive.js';

class MemoryFileHandle {
  kind = 'file';

  constructor(name, bytes = new Uint8Array()) {
    this.name = name;
    this.bytes = new Uint8Array(bytes);
    this.writeCount = 0;
  }

  async getFile() {
    return new File([this.bytes], this.name);
  }

  async createWritable() {
    return {
      write: async (value) => {
        this.bytes = new Uint8Array(
          value instanceof Uint8Array ? value : await new Blob([value]).arrayBuffer(),
        );
        this.writeCount += 1;
      },
      close: async () => {},
      abort: async () => {},
    };
  }
}

class MemoryDirectoryHandle {
  kind = 'directory';

  constructor(name) {
    this.name = name;
    this.directories = new Map();
    this.files = new Map();
  }

  async queryPermission() {
    return 'granted';
  }

  async requestPermission() {
    return 'granted';
  }

  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name)) {
      if (!options.create) throw new DOMException('Not found', 'NotFoundError');
      this.directories.set(name, new MemoryDirectoryHandle(name));
    }
    return this.directories.get(name);
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw new DOMException('Not found', 'NotFoundError');
      this.files.set(name, new MemoryFileHandle(name));
    }
    return this.files.get(name);
  }

  install(path, bytes) {
    const parts = path.split('/');
    const name = parts.pop();
    let directory = this;
    parts.forEach((part) => {
      if (!directory.directories.has(part)) {
        directory.directories.set(part, new MemoryDirectoryHandle(part));
      }
      directory = directory.directories.get(part);
    });
    directory.files.set(name, new MemoryFileHandle(name, bytes));
  }

  resolveFile(path) {
    const parts = path.split('/');
    const name = parts.pop();
    let directory = this;
    parts.forEach((part) => {
      directory = directory?.directories.get(part);
    });
    return directory?.files.get(name) || null;
  }
}

const payload = {
  schemaVersion: '1.3',
  exportedAt: '2026-09-15T00:00:00.000Z',
  map: {
    fileName: 'directory-map.ply',
    format: 'ply',
    byteLength: 36,
    pointCount: 3,
    faceCount: 1,
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 0 },
    },
    sourceHash: 'directory-map-source',
    sourceHashKind: 'file',
  },
  projection: { minHeight: -0.1, maxHeight: 0.1 },
  workspace: {},
  robot: null,
  virtualTeaching: { tasks: [], jointPoses: [] },
  waypoints: [],
  paths: [],
};
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const colors = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
const indices = new Uint16Array([0, 1, 2]);
const archive = await buildProjectArchive(payload, {
  mapResource: {
    geometryCacheVersion: 1,
    name: payload.map.fileName,
    byteLength: payload.map.byteLength,
    positionBuffer: positions.buffer,
    colorBuffer: colors.buffer,
    indexBuffer: indices.buffer,
    indexComponentType: 'uint16',
    bounds: payload.map.bounds,
    sourceHash: payload.map.sourceHash,
    sourceHashKind: payload.map.sourceHashKind,
  },
});
const root = new MemoryDirectoryHandle('sample.atlas-project');
Object.entries(unzipSync(archive.bytes)).forEach(([path, bytes]) => root.install(path, bytes));

assert.ok(root.resolveFile(PROJECT_DIRECTORY_DESCRIPTOR));
const mapHandle = root.resolveFile(PROJECT_ARCHIVE_MAP_POSITIONS);
const originalMapBytes = new Uint8Array(mapHandle.bytes);
mapHandle.bytes[0] ^= 0xff;
await assert.rejects(
  () => readProjectDirectoryHandle(root),
  /SHA-256 校验失败/,
);
mapHandle.bytes = originalMapBytes;
const opened = await readProjectDirectoryHandle(root);
assert.equal(opened.source, 'directory');
assert.equal(opened.directory.writable, true);
assert.equal(opened.resources.map.pointCount, 3);

const nextPayload = structuredClone(opened.payload);
nextPayload.waypoints.push({
  id: 'waypoint-directory-save',
  name: 'P01',
  pose: { x: 0.2, y: 0.3, z: 0, roll: 0, pitch: 0, yaw: 0 },
  xzy: [0.2, 0, 0.3],
  rpy: [0, 0, 0],
});
nextPayload.virtualTeaching.tasks.push({
  id: 'task-directory-save',
  name: '目录示教',
  sequence: 1,
  parkingPoints: [{
    id: 'parking-directory-save',
    name: '停车点 P01',
    sequence: 1,
    poses: [{
      id: 'pose-directory-save',
      name: 'A01',
      sequence: 1,
      cameraCapture: {
        capturedAt: '2026-09-15T01:02:03.000Z',
        cameraModel: 'Zivid 2 M70',
        frames: {
          left: {
            capturedAt: '2026-09-15T01:02:03.000Z',
            rgb: {
              mimeType: 'image/png',
              width: 1,
              height: 1,
              byteLength: 3,
              dataUrl: 'data:image/png;base64,AQID',
            },
            pointCloud: {
              pointCount: 1,
              visiblePointCount: 1,
              byteLength: 9,
              positionOffset: [0, 0, 0],
              positionScale: [1, 1, 1],
              positionData: 'AQIDBAUG',
              colorData: 'BwgJ',
            },
          },
        },
      },
    }],
  }],
});

const mapWritesBefore = mapHandle.writeCount;
const firstSave = await updateProjectDirectory(root, nextPayload, {
  manifest: opened.manifest,
  rawPayload: opened.rawPayload,
});
assert.equal(mapHandle.writeCount, mapWritesBefore, 'static map geometry must not be rewritten');
assert.equal(firstSave.manifest.saveMode, 'incremental-directory');
assert.ok(firstSave.manifest.files.some((file) => file.role === 'teaching-rgb'));
assert.ok(firstSave.manifest.files.some((file) => file.role === 'teaching-pointcloud'));

const rgbRecord = firstSave.manifest.files.find((file) => file.role === 'teaching-rgb');
const rgbHandle = root.resolveFile(rgbRecord.path);
const rgbWritesBefore = rgbHandle.writeCount;
const poseRecord = firstSave.manifest.files.find((file) => file.path.endsWith('/pose.json'));
const poseHandle = root.resolveFile(poseRecord.path);
const poseWritesBefore = poseHandle.writeCount;
const secondSave = await updateProjectDirectory(root, nextPayload, {
  manifest: firstSave.manifest,
  rawPayload: firstSave.rawPayload,
});
assert.equal(rgbHandle.writeCount, rgbWritesBefore, 'unchanged RGB snapshot must be reused');
assert.equal(poseHandle.writeCount, poseWritesBefore, 'unchanged pose metadata must not be rewritten');

const reopened = await readProjectDirectoryHandle(root);
assert.equal(reopened.payload.waypoints[0].id, 'waypoint-directory-save');
assert.equal(reopened.payload.virtualTeaching.tasks[0].parkingPoints[0].poses.length, 1);
const rgbWritesAfterReopen = rgbHandle.writeCount;
await updateProjectDirectory(root, reopened.payload, {
  manifest: reopened.manifest,
  rawPayload: reopened.rawPayload,
});
assert.equal(
  rgbHandle.writeCount,
  rgbWritesAfterReopen,
  'hydrated RGB snapshot must retain a reusable external-file identity',
);
assert.ok(root.resolveFile(PROJECT_ARCHIVE_CONFIG).writeCount >= 1);
assert.ok(root.resolveFile(PROJECT_ARCHIVE_MANIFEST).writeCount >= 2);

console.log(`directory_files=${secondSave.manifest.statistics.fileCount}`);
console.log('directory_tamper_detection=ok');
console.log('incremental_static_resources=untouched');
console.log('incremental_media_reuse=ok');
