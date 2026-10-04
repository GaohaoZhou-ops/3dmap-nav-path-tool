import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ipadTeachingPlugin } from './src/server/ipadTeachingService.js';

const ROBOT_FILE_PREFIX = '/__atlas/robot-files/';
const DIRECT_ROBOT_EXTENSIONS = new Set(['.glb', '.gltf', '.stl']);
const ROBOT_RESOURCE_DIRECTORIES = new Set(['meshes', 'mesh', 'textures', 'materials']);
const PHYSICS_API_PREFIX = '/__atlas/physics';
const PHYSICS_BACKENDS = new Set(['local', 'auto', 'isaac']);

const encodePath = (value) =>
  value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const contentTypes = {
  '.dae': 'model/vnd.collada+xml; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.stl': 'model/stl',
  '.urdf': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function walkFiles(directory, baseDirectory = directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkFiles(absolutePath, baseDirectory);
        if (!entry.isFile()) return [];
        return [path.relative(baseDirectory, absolutePath).split(path.sep).join('/')];
      }),
  );
  return nested.flat();
}

async function findPackageRoot(robotsRoot, relativePath) {
  let directory = path.dirname(path.resolve(robotsRoot, relativePath));
  while (directory.startsWith(`${robotsRoot}${path.sep}`) || directory === robotsRoot) {
    try {
      const packageXml = await readFile(path.join(directory, 'package.xml'), 'utf8');
      const name = packageXml.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim();
      return {
        name: name || path.basename(directory),
        relativePath: path.relative(robotsRoot, directory).split(path.sep).join('/'),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (directory === robotsRoot) break;
    directory = path.dirname(directory);
  }
  const firstSegment = relativePath.split('/')[0] || '';
  return { name: firstSegment || null, relativePath: firstSegment };
}

async function listRobotModels(robotsRoot) {
  const files = await walkFiles(robotsRoot);
  const candidates = files.filter((relativePath) => {
    const extension = path.extname(relativePath).toLowerCase();
    if (extension === '.urdf') return true;
    if (!DIRECT_ROBOT_EXTENSIONS.has(extension)) return false;
    const directories = relativePath.split('/').slice(0, -1).map((part) => part.toLowerCase());
    return !directories.some((directory) => ROBOT_RESOURCE_DIRECTORIES.has(directory));
  });

  const models = await Promise.all(
    candidates.map(async (relativePath) => {
      const extension = path.extname(relativePath).toLowerCase();
      const packageInfo = await findPackageRoot(robotsRoot, relativePath);
      let robotName = path.basename(relativePath, extension);
      if (extension === '.urdf') {
        try {
          const source = await readFile(path.join(robotsRoot, relativePath), 'utf8');
          robotName = source.match(/<robot\b[^>]*\bname=["']([^"']+)["']/i)?.[1] || robotName;
        } catch {
          // A file that disappears during the scan will fail naturally when selected.
        }
      }
      const packageBaseUrl = packageInfo.relativePath
        ? `${ROBOT_FILE_PREFIX}${encodePath(packageInfo.relativePath)}/`
        : ROBOT_FILE_PREFIX;
      const manifestPath = packageInfo.relativePath
        ? path.join(robotsRoot, packageInfo.relativePath, 'web-model.json')
        : null;
      let manifestUrl = null;
      if (manifestPath) {
        try {
          const manifestStats = await stat(manifestPath);
          if (manifestStats.isFile()) manifestUrl = `${packageBaseUrl}web-model.json`;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return {
        id: relativePath,
        name: robotName,
        fileName: path.basename(relativePath),
        relativePath,
        format: extension.slice(1),
        url: `${ROBOT_FILE_PREFIX}${encodePath(relativePath)}`,
        packageName: packageInfo.name,
        packagePath: packageInfo.relativePath,
        packageBaseUrl,
        manifestUrl,
      };
    }),
  );

  return models.sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN', { numeric: true }),
  );
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.end(JSON.stringify(payload));
}

const normalizePhysicsBackend = (value) => {
  const normalized = String(value || 'local').trim().toLowerCase();
  return PHYSICS_BACKENDS.has(normalized) ? normalized : 'local';
};

const physicsTransport = (url) => (url.protocol === 'https:' ? https : http);

function requestIsaacHealth(baseUrl, token) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const target = new URL('/health', baseUrl);
    const request = physicsTransport(target).request(target, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 64 * 1024) {
          finish({ available: false, error: 'Isaac 健康检查响应过大' });
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode === 200 && payload?.ok && payload?.apiVersion === 1) {
            finish({ available: true, health: payload });
          } else {
            finish({
              available: false,
              error: payload?.error || `Isaac 碰撞服务返回 HTTP ${response.statusCode}`,
            });
          }
        } catch {
          finish({ available: false, error: 'Isaac 健康检查响应格式无效' });
        }
      });
    });
    request.setTimeout(1200, () => {
      request.destroy();
      finish({ available: false, error: 'Isaac 碰撞服务连接超时' });
    });
    request.on('error', (error) => finish({
      available: false,
      error: error.code === 'ECONNREFUSED'
        ? 'Isaac 碰撞服务尚未启动'
        : error.message || 'Isaac 碰撞服务不可达',
    }));
    request.end();
  });
}

function relayIsaacRequest(request, response, baseUrl, token) {
  const suffix = request.url.slice(PHYSICS_API_PREFIX.length);
  const target = new URL(suffix, baseUrl);
  const headers = {
    ...request.headers,
    host: target.host,
    connection: 'close',
  };
  delete headers.origin;
  delete headers.referer;
  if (token) headers.authorization = `Bearer ${token}`;
  const upstream = physicsTransport(target).request(target, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.statusCode = upstreamResponse.statusCode || 502;
    Object.entries(upstreamResponse.headers).forEach(([name, value]) => {
      if (value !== undefined && !['connection', 'keep-alive'].includes(name.toLowerCase())) {
        response.setHeader(name, value);
      }
    });
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(95_000, () => {
    upstream.destroy(new Error('Isaac collision request timed out'));
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) {
      sendJson(response, 503, {
        error: error.message || 'Isaac 碰撞服务不可达',
        code: 'isaac_unavailable',
      });
    } else {
      response.destroy(error);
    }
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function atlasPhysicsPlugin() {
  const requestedBackend = normalizePhysicsBackend(process.env.ATLAS_PHYSICS_BACKEND);
  let isaacUrl;
  try {
    isaacUrl = new URL(
      process.env.ISAAC_SIM_COLLISION_URL || 'http://127.0.0.1:49101',
    );
    if (!['http:', 'https:'].includes(isaacUrl.protocol)) throw new Error('unsupported protocol');
  } catch {
    isaacUrl = new URL('http://127.0.0.1:49101');
  }
  const token = process.env.ISAAC_SIM_COLLISION_TOKEN || '';

  const installEndpoints = (middlewares) => {
    middlewares.use(async (request, response, next) => {
      const pathname = request.url?.split('?')[0] || '';
      if (pathname === `${PHYSICS_API_PREFIX}/config`) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: '仅支持 GET' });
          return;
        }
        const probe = requestedBackend === 'local'
          ? { available: false, error: null }
          : await requestIsaacHealth(isaacUrl, token);
        const activeBackend = probe.available
          ? 'isaac'
          : requestedBackend === 'auto' || requestedBackend === 'local'
            ? 'local'
            : 'unavailable';
        sendJson(response, 200, {
          apiVersion: 1,
          requestedBackend,
          activeBackend,
          localAvailable: true,
          isaac: {
            available: probe.available,
            engine: probe.health?.engine || 'NVIDIA PhysX',
            isaacSimVersion: probe.health?.isaacSimVersion || null,
            apiVersion: probe.health?.apiVersion || null,
            error: probe.error || null,
          },
        });
        return;
      }
      if (!pathname.startsWith(`${PHYSICS_API_PREFIX}/v1/`)) {
        next();
        return;
      }
      if (requestedBackend === 'local') {
        sendJson(response, 409, {
          error: '服务端当前配置为本地碰撞后端',
          code: 'backend_disabled',
        });
        return;
      }
      relayIsaacRequest(request, response, isaacUrl, token);
    });
  };

  return {
    name: 'atlas-physics-services',
    configureServer(server) {
      installEndpoints(server.middlewares);
    },
    configurePreviewServer(server) {
      installEndpoints(server.middlewares);
    },
  };
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header || '');
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    start ??= 0;
    end ??= size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

function atlasWorkspacePlugin() {
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  let projectRoot = process.cwd();

  const installEndpoints = (middlewares) => {
    middlewares.use(async (request, response, next) => {
      const rawPathname = request.url?.split('?')[0] || '';
      if (rawPathname === '/__atlas/session') {
        sendJson(response, 200, { sessionId, startedAt });
        return;
      }

      const robotsRoot = path.resolve(projectRoot, 'robots');
      if (rawPathname === '/__atlas/robots') {
        try {
          const robots = await listRobotModels(robotsRoot);
          sendJson(response, 200, { robots });
        } catch (error) {
          sendJson(response, 500, { error: error.message || '机器人目录读取失败' });
        }
        return;
      }

      if (!rawPathname.startsWith(ROBOT_FILE_PREFIX)) {
        next();
        return;
      }

      try {
        const relativePath = decodeURIComponent(rawPathname.slice(ROBOT_FILE_PREFIX.length));
        if (!relativePath || relativePath.includes('\0')) {
          sendJson(response, 400, { error: '机器人资源路径无效' });
          return;
        }
        const absolutePath = path.resolve(robotsRoot, relativePath);
        if (absolutePath !== robotsRoot && !absolutePath.startsWith(`${robotsRoot}${path.sep}`)) {
          sendJson(response, 403, { error: '机器人资源路径越界' });
          return;
        }
        const fileStats = await stat(absolutePath);
        if (!fileStats.isFile()) {
          sendJson(response, 404, { error: '机器人资源不存在' });
          return;
        }

        const range = parseByteRange(request.headers.range, fileStats.size);
        if (range?.invalid) {
          response.statusCode = 416;
          response.setHeader('Content-Range', `bytes */${fileStats.size}`);
          response.end();
          return;
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? fileStats.size - 1;
        response.statusCode = range ? 206 : 200;
        response.setHeader(
          'Content-Type',
          contentTypes[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream',
        );
        response.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Cache-Control', 'no-cache');
        if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${fileStats.size}`);
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const stream = createReadStream(absolutePath, { start, end });
        stream.on('error', (error) => response.destroy(error));
        stream.pipe(response);
      } catch (error) {
        if (error instanceof URIError) {
          sendJson(response, 400, { error: '机器人资源路径编码无效' });
        } else if (error.code === 'ENOENT') {
          sendJson(response, 404, { error: '机器人资源不存在' });
        } else {
          sendJson(response, 500, { error: error.message || '机器人资源读取失败' });
        }
      }
    });
  };

  return {
    name: 'atlas-workspace-services',
    configResolved(config) {
      projectRoot = config.root;
    },
    configureServer(server) {
      installEndpoints(server.middlewares);
    },
    configurePreviewServer(server) {
      installEndpoints(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), atlasPhysicsPlugin(), atlasWorkspacePlugin(), ipadTeachingPlugin()],
  publicDir: 'maps',
  server: {
    host: '0.0.0.0',
    port: 21990,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 21990,
    strictPort: true,
  },
});
