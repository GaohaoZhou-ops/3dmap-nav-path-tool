import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_PREFIX = '/__atlas/surfaces/';
const CACHE_ALGORITHM = 'adaptive-voxel-surface-fusion-v1';
const CACHE_DIRECTORY = 'adaptive-voxel-v1';
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.end(JSON.stringify(payload));
}

function publicJob(job) {
  return {
    status: job.status,
    sourceHash: job.sourceHash,
    progress: job.progress,
    phase: job.phase,
    detail: job.detail || '',
    cacheHit: Boolean(job.cacheHit),
    ...(job.metadata || {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

async function receiveBody(request, targetPath) {
  const announcedLength = Number(request.headers['content-length']) || 0;
  if (announcedLength > MAX_UPLOAD_BYTES) throw new Error('点云建面数据超过 512 MB 安全上限');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        callback(new Error('点云建面数据超过 512 MB 安全上限'));
      } else {
        callback(null, chunk);
      }
    },
  });
  await pipeline(request, limiter, createWriteStream(targetPath, { flags: 'wx' }));
  return received;
}

export function createSurfaceService() {
  let projectRoot = process.cwd();
  const jobs = new Map();
  const activeChildren = new Set();

  const pathsFor = (sourceHash, token = '') => {
    const root = path.resolve(projectRoot, '.atlas-cache', 'surfaces', CACHE_DIRECTORY);
    const temporaryRoot = path.join(root, 'tmp');
    const suffix = token ? `.${token}.tmp` : '';
    return {
      root,
      temporaryRoot,
      surface: path.join(root, `${sourceHash}.atsurface.gz`),
      metadata: path.join(root, `${sourceHash}.json`),
      input: path.join(temporaryRoot, `${sourceHash}.${token}.point-buffer.tmp`),
      temporarySurface: path.join(temporaryRoot, `${sourceHash}.atsurface${suffix}`),
      temporaryMetadata: path.join(temporaryRoot, `${sourceHash}.json${suffix}`),
    };
  };

  const prepareDirectories = async (paths) => {
    await mkdir(paths.temporaryRoot, { recursive: true });
  };

  const readCachedSurface = async (sourceHash) => {
    const paths = pathsFor(sourceHash);
    try {
      const [metadataSource, surfaceStats] = await Promise.all([
        readFile(paths.metadata, 'utf8'),
        stat(paths.surface),
      ]);
      const metadata = JSON.parse(metadataSource);
      if (
        metadata?.sourceHash !== sourceHash
        || metadata?.algorithm !== CACHE_ALGORITHM
        || !surfaceStats.isFile()
      ) {
        return null;
      }
      return {
        ...metadata,
        compressedBytes: surfaceStats.size,
        meshUrl: `${API_PREFIX}${sourceHash}/mesh`,
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  };

  const beginBuild = (sourceHash, paths) => {
    const job = {
      status: 'building',
      sourceHash,
      progress: 0.05,
      phase: '提交本地建面任务',
      detail: '',
      cacheHit: false,
      metadata: null,
      error: null,
      child: null,
    };
    jobs.set(sourceHash, job);
    const workerPath = path.resolve(projectRoot, 'scripts', 'build_surface_cache.mjs');
    const child = spawn(
      process.execPath,
      [workerPath, paths.input, paths.temporarySurface, paths.temporaryMetadata, sourceHash],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    job.child = child;
    activeChildren.add(child);
    let stdoutBuffer = '';
    let stderrBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const update = JSON.parse(line);
          job.progress = Math.max(job.progress, Math.min(1, Number(update.progress) || 0));
          job.phase = update.phase || job.phase;
          job.detail = update.detail || '';
        } catch {
          // Ignore non-protocol diagnostic output from the worker.
        }
      });
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-12_000);
    });

    let finished = false;
    const finish = async (code, launchError = null) => {
      if (finished) return;
      finished = true;
      activeChildren.delete(child);
      job.child = null;
      try {
        if (launchError) throw launchError;
        if (code !== 0) throw new Error(stderrBuffer.trim() || `建面进程退出码 ${code}`);
        await rename(paths.temporarySurface, paths.surface);
        await rename(paths.temporaryMetadata, paths.metadata);
        const metadata = await readCachedSurface(sourceHash);
        if (!metadata) throw new Error('结构面输出校验失败');
        job.status = 'ready';
        job.progress = 1;
        job.phase = '结构面缓存完成';
        job.detail = `${Number(metadata.cellCount || 0).toLocaleString('zh-CN')} 单元`;
        job.metadata = { ...metadata, meshUrl: `${API_PREFIX}${sourceHash}/mesh` };
      } catch (error) {
        job.status = 'error';
        job.phase = '结构面生成失败';
        job.error = error.message || '未知建面错误';
        await Promise.allSettled([
          rm(paths.temporarySurface, { force: true }),
          rm(paths.temporaryMetadata, { force: true }),
        ]);
      } finally {
        await rm(paths.input, { force: true }).catch(() => undefined);
      }
    };
    child.once('error', (error) => void finish(-1, error));
    child.once('close', (code) => void finish(code));
    return job;
  };

  const handle = async (request, response) => {
    const pathname = request.url?.split('?')[0] || '';
    if (!pathname.startsWith(API_PREFIX)) return false;
    const match = /^\/__atlas\/surfaces\/([a-f0-9]{64})\/(status|build|mesh)$/.exec(pathname);
    if (!match || !HASH_PATTERN.test(match[1])) {
      sendJson(response, 400, { error: '结构面缓存哈希或路径无效' });
      return true;
    }
    const [, sourceHash, action] = match;
    const paths = pathsFor(sourceHash);

    try {
      if (action === 'status') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: '结构面状态仅支持 GET' });
          return true;
        }
        const job = jobs.get(sourceHash);
        if (job?.status === 'building' || job?.status === 'error') {
          sendJson(response, 200, publicJob(job));
          return true;
        }
        const cached = await readCachedSurface(sourceHash);
        if (cached) {
          sendJson(response, 200, {
            status: 'ready',
            progress: 1,
            phase: '命中本地结构面缓存',
            cacheHit: job?.status === 'ready' ? Boolean(job.cacheHit) : true,
            ...cached,
          });
        } else {
          sendJson(response, 200, {
            status: 'missing',
            sourceHash,
            progress: 0,
            phase: '尚未生成结构面',
            cacheHit: false,
          });
        }
        return true;
      }

      if (action === 'mesh') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { error: '结构面文件仅支持 GET/HEAD' });
          return true;
        }
        const cached = await readCachedSurface(sourceHash);
        if (!cached) {
          sendJson(response, 404, { error: '结构面缓存不存在' });
          return true;
        }
        const fileStats = await stat(paths.surface);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/vnd.atlas.surface');
        response.setHeader('Content-Encoding', 'gzip');
        response.setHeader('Content-Length', String(fileStats.size));
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.setHeader('ETag', `"${sourceHash}-${CACHE_DIRECTORY}"`);
        if (request.method === 'HEAD') {
          response.end();
        } else {
          const stream = createReadStream(paths.surface);
          stream.on('error', (error) => response.destroy(error));
          stream.pipe(response);
        }
        return true;
      }

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: '结构面生成仅支持 POST' });
        return true;
      }
      const cached = await readCachedSurface(sourceHash);
      if (cached) {
        request.resume();
        sendJson(response, 200, {
          status: 'ready',
          progress: 1,
          phase: '命中本地结构面缓存',
          cacheHit: true,
          ...cached,
        });
        return true;
      }
      const existing = jobs.get(sourceHash);
      if (existing?.status === 'building') {
        request.resume();
        sendJson(response, 202, publicJob(existing));
        return true;
      }
      if (existing?.status === 'error') jobs.delete(sourceHash);

      const token = randomUUID();
      const buildPaths = pathsFor(sourceHash, token);
      await prepareDirectories(buildPaths);
      const uploadJob = {
        status: 'building',
        sourceHash,
        progress: 0.03,
        phase: '接收点云快照',
        detail: '',
        cacheHit: false,
        metadata: null,
        error: null,
        child: null,
      };
      // Reserve this hash before streaming the request body. A refresh or a
      // second tab then observes the same job instead of uploading/rebuilding it.
      jobs.set(sourceHash, uploadJob);
      let uploadedBytes;
      try {
        uploadedBytes = await receiveBody(request, buildPaths.input);
      } catch (error) {
        await rm(buildPaths.input, { force: true }).catch(() => undefined);
        uploadJob.status = 'error';
        uploadJob.phase = '点云快照接收失败';
        uploadJob.error = error.message || '点云快照接收失败';
        throw error;
      }
      const job = beginBuild(sourceHash, buildPaths);
      job.progress = 0.08;
      job.phase = '点云快照已接收';
      job.detail = `${uploadedBytes.toLocaleString('zh-CN')} bytes`;
      sendJson(response, 202, publicJob(job));
      return true;
    } catch (error) {
      await rm(paths.input, { force: true }).catch(() => undefined);
      sendJson(response, error.code === 'ENOENT' ? 404 : 500, {
        error: error.message || '结构面服务失败',
      });
      return true;
    }
  };

  return {
    setProjectRoot(nextRoot) {
      projectRoot = nextRoot;
    },
    handle,
    dispose() {
      activeChildren.forEach((child) => child.kill('SIGTERM'));
      activeChildren.clear();
    },
  };
}
