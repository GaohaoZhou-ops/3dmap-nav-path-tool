import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createSurfaceService } from './scripts/surface_service.mjs';

const ROBOT_FILE_PREFIX = '/__atlas/robot-files/';
const DIRECT_ROBOT_EXTENSIONS = new Set(['.glb', '.gltf', '.stl']);
const ROBOT_RESOURCE_DIRECTORIES = new Set(['meshes', 'mesh', 'textures', 'materials']);

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
  const surfaceService = createSurfaceService();
  let projectRoot = process.cwd();

  const installEndpoints = (middlewares) => {
    middlewares.use(async (request, response, next) => {
      const rawPathname = request.url?.split('?')[0] || '';
      if (await surfaceService.handle(request, response)) return;
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
      surfaceService.setProjectRoot(projectRoot);
    },
    configureServer(server) {
      installEndpoints(server.middlewares);
      server.httpServer?.once('close', () => surfaceService.dispose());
    },
    configurePreviewServer(server) {
      installEndpoints(server.middlewares);
      server.httpServer?.once('close', () => surfaceService.dispose());
    },
  };
}

export default defineConfig({
  plugins: [react(), atlasWorkspacePlugin()],
  publicDir: 'maps',
  server: {
    host: '127.0.0.1',
    port: 21990,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 21990,
    strictPort: true,
  },
});
