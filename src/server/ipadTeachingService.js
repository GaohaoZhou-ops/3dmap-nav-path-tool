import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { IPAD_PROTOCOL, MAX_MODEL_BYTES, validateModelBytes, validateIPadResult } from '../lib/ipadProtocol.js';
import { advertiseIPadService } from './ipadDiscovery.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const randomPairingCode = () => randomInt(36 ** 4).toString(36).padStart(4, '0').toUpperCase();
const lanAddresses = (port) => [...new Set(Object.values(networkInterfaces()).flat()
  .filter((item) => item?.family === 'IPv4' && !item.internal).map((item) => `http://${item.address}:${port}`))];
const fail = (code, message) => { const error = new Error(message); error.status = code; throw error; };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
const atomicWrite = async (file, data) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
};
async function readBody(req, limit, asJSON = true) {
  if (Number(req.headers['content-length']) > limit) fail(413, '传输数据超出限制');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, '传输数据超出限制'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  if (!asJSON) return body;
  try { return JSON.parse(body.toString('utf8')); } catch { fail(400, 'JSON 数据无效'); }
}

export function createIPadTeachingService({ directory, serverId = randomUUID(), serverName = hostname().replace(/\.local$/i, '').slice(0, 120), generatePairingCode = randomPairingCode, getAddresses = lanAddresses }) {
  const locks = new Map(), attempts = new Map();
  async function serialized(id, run) {
    const previous = locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(run);
    locks.set(id, operation);
    try { return await operation; } finally { if (locks.get(id) === operation) locks.delete(id); }
  }
  const sessionFile = (id) => path.join(directory, id, 'session.json');
  const save = (session) => atomicWrite(sessionFile(session.id), JSON.stringify(session));
  async function load(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, '配对任务不存在');
    try { return JSON.parse(await readFile(sessionFile(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail(404, '配对任务不存在'); throw error; }
  }
  // Creation and renewal share one reservation lock, including the durable write.
  // Keep existing stored codes reserved so an older task cannot shadow a new one.
  const withNewPairingCode = (persist) => serialized('pairing-codes', async () => {
    const entries = await readdir(directory, { withFileTypes: true });
    const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)).map((entry) => load(entry.name)));
    const used = new Set(sessions.map((session) => session.pairingCodeHash));
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const code = generatePairingCode();
      if (/^[A-Z0-9]{4}$/.test(code) && !used.has(hash(code))) return persist(code);
    }
    fail(503, '暂时无法分配配对码，请稍后重试');
  });
  const authorize = (req, session, role) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!equal(hash(String(token || '')), session[`${role}TokenHash`])) fail(401, '配对凭据无效');
    if (session.status === 'cancelled') fail(410, '配对任务已结束');
  };
  const publicSession = (session) => ({ id: session.id, status: session.status, manifest: session.manifest,
    createdAt: session.createdAt, pairedAt: session.pairedAt, completedAt: session.completedAt,
    importedAt: session.importedAt, sampleCount: session.sampleCount || 0, deviceName: session.deviceName || '' });
  async function verifyModel(session, identity) {
    if (!/^[a-f0-9]{64}$/.test(identity?.modelHash) || !Number.isInteger(identity?.byteLength)
      || identity.byteLength < 48 || identity.byteLength > MAX_MODEL_BYTES) fail(400, '模型校验信息无效');
    if (identity.modelHash !== session.manifest.modelHash || identity.byteLength !== session.manifest.byteLength) {
      fail(409, '设备与电脑配对任务中的模型内容不一致，已停止同步；请确认使用的是同一模型');
    }
    // Re-read the actual frozen model. Names, project metadata and all poses are excluded.
    const digest = createHash('sha256'); let byteLength = 0;
    try {
      for await (const chunk of createReadStream(path.join(directory, session.id, 'model.atls'))) {
        byteLength += chunk.length;
        if (byteLength > session.manifest.byteLength) fail(409, '电脑端模型文件已改变，已停止同步；请恢复配对时的模型后重试');
        digest.update(chunk);
      }
    } catch (error) {
      if (error.code === 'ENOENT') fail(409, '电脑端缺少配对时的模型文件，已停止同步；请恢复模型后重试');
      throw error;
    }
    const modelHash = digest.digest('hex');
    if (byteLength !== identity.byteLength || modelHash !== identity.modelHash) {
      fail(409, '电脑端模型文件已改变，已停止同步；请恢复配对时的模型后重试');
    }
    return { sessionId: session.id, modelHash, byteLength, verified: true };
  }

  return async function ipadMiddleware(req, res, next) {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith('/__atlas/ipad/')) return next();
    try {
      // No cross-origin access or ambient cookies; native iPad calls use bearer credentials.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, '不允许跨站访问配对服务');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const route = pathname.slice('/__atlas/ipad'.length);
      if (route === '/info' && req.method === 'GET') {
        const port = req.socket.localPort;
        const addresses = getAddresses(port);
        return json(res, 200, { protocol: IPAD_PROTOCOL, serverId, serverName, port, addresses, maxModelBytes: MAX_MODEL_BYTES });
      }
      if (route === '/sessions' && req.method === 'POST') {
        const { manifest } = await readBody(req, 16384);
        if (manifest?.protocol !== IPAD_PROTOCOL || manifest.coordinateFrame !== 'virtual_origin'
          || manifest.distanceUnit !== 'meter' || manifest.verticalAxis !== 'Z'
          || !/^[a-f0-9]{64}$/.test(manifest.modelHash) || typeof manifest.name !== 'string'
          || !Number.isInteger(manifest.byteLength) || manifest.byteLength < 48 || manifest.byteLength > MAX_MODEL_BYTES) fail(400, '独立示教物体清单无效');
        return await withNewPairingCode(async (pairingCode) => {
          const id = randomUUID(), ownerToken = secret();
          const session = { id, manifest, status: 'preparing', createdAt: new Date().toISOString(),
            ownerTokenHash: hash(ownerToken), pairingCodeHash: hash(pairingCode),
            pairingExpiresAt: Date.now() + 15 * 60 * 1000 };
          await mkdir(path.join(directory, id), { mode: 0o700 });
          await save(session);
          return json(res, 201, { ...publicSession(session), ownerToken, pairingCode, pairingExpiresAt: session.pairingExpiresAt });
        });
      }
      if (route === '/pair' && req.method === 'POST') {
        const peer = req.socket.remoteAddress, now = Date.now();
        for (const [key, value] of attempts) if (now - value.start > 60000) attempts.delete(key);
        const attempt = attempts.get(peer) || { start: now, count: 0 }; attempt.count += 1; attempts.set(peer, attempt);
        if (attempt.count > 20) fail(429, '配对尝试过于频繁，请一分钟后重试');
        const body = await readBody(req, 4096);
        if ((body.sessionId != null || body.serverId != null)
          && (body.serverId !== serverId || !/^[a-f0-9-]{36}$/.test(body.sessionId || ''))) fail(409, '二维码对应的服务已变更，请重新扫描电脑上的二维码');
        const code = String(body.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) fail(400, '请输入 4 位配对码，仅支持大写字母 A–Z 和数字 0–9');
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.deviceId || '')) fail(400, '配对设备标识无效');
        const dirs = await readdir(directory, { withFileTypes: true });
        for (const dir of dirs.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))) {
          const candidate = await load(dir.name);
          if (!equal(candidate.pairingCodeHash, hash(code))) continue;
          return await serialized(candidate.id, async () => {
            const session = await load(candidate.id);
            if (body.sessionId != null && body.sessionId !== session.id) fail(409, '二维码与当前传输任务不匹配，请重新扫描');
            if (!equal(session.pairingCodeHash, hash(code))) fail(404, '配对码已更新，请使用电脑显示的新配对码');
            if (now > session.pairingExpiresAt) fail(410, '配对码已过期，请在电脑上重新生成');
            if (!['ready', 'paired'].includes(session.status)) fail(409, '该任务当前不可配对');
            if (session.deviceId && session.deviceId !== body.deviceId) fail(409, '配对码已被另一台设备使用');
            const deviceToken = secret();
            Object.assign(session, { status: 'paired', deviceId: body.deviceId, deviceName: String(body.deviceName || 'iPad Pro').slice(0, 80),
              deviceTokenHash: hash(deviceToken), pairedAt: new Date().toISOString() });
            await save(session);
            return json(res, 200, { ...publicSession(session), deviceToken });
          });
        }
        fail(404, '找不到配对码，请确认电脑地址与配对码');
      }
      const match = /^\/sessions\/([a-f0-9-]{36})(?:\/(model|verify-model|result|imported|renew|pairing-qr))?$/.exec(route);
      if (!match) fail(404, '接口不存在');
      const [, id, action] = match;
      await serialized(id, async () => {
        const session = await load(id);
        const role = (action === 'model' && req.method === 'GET')
          || (['verify-model', 'result'].includes(action) && req.method === 'POST') ? 'device' : 'owner';
        authorize(req, session, role);
        if (!action && req.method === 'GET') return json(res, 200, publicSession(session));
        if (!action && req.method === 'DELETE') {
          session.status = 'cancelled'; await save(session); return json(res, 200, { status: 'cancelled' });
        }
        if (action === 'pairing-qr' && req.method === 'POST') {
          if (session.status !== 'ready') fail(409, '只有尚未配对的任务可以生成二维码');
          if (Date.now() >= session.pairingExpiresAt) fail(410, '配对码已过期，请点击「更新配对码」');
          const { address, code } = await readBody(req, 4096);
          if (!getAddresses(req.socket.localPort).includes(address)) fail(400, '请选择当前电脑的局域网地址');
          if (typeof code !== 'string' || !/^[A-Z0-9]{4}$/.test(code)
            || !equal(session.pairingCodeHash, hash(code))) fail(409, '配对码已更新，请刷新任务或更新配对码');
          const payload = { protocol: 'atlas-ipad-pairing/1', address, code,
            sessionId: session.id, serverId, expiresAt: session.pairingExpiresAt };
          const image = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 4, scale: 8 });
          return json(res, 200, { image, expiresAt: session.pairingExpiresAt });
        }
        if (action === 'renew' && req.method === 'POST') {
          if (session.status !== 'ready') fail(409, '只有尚未配对的任务可以更新配对码');
          return await withNewPairingCode(async (pairingCode) => {
            session.pairingCodeHash = hash(pairingCode); session.pairingExpiresAt = Date.now() + 15 * 60 * 1000;
            await save(session); return json(res, 200, { pairingCode, pairingExpiresAt: session.pairingExpiresAt });
          });
        }
        if (action === 'model' && req.method === 'PUT') {
          if (session.status !== 'preparing') fail(409, '模型已冻结，请创建新的配对任务');
          const body = await readBody(req, MAX_MODEL_BYTES, false);
          if (body.length !== session.manifest.byteLength || hash(body) !== session.manifest.modelHash) fail(400, '模型传输校验失败');
          const counts = validateModelBytes(body);
          if (counts.vertices !== session.manifest.vertices || counts.indices !== session.manifest.indices) fail(400, '模型清单与数据不一致');
          await atomicWrite(path.join(directory, id, 'model.atls'), body);
          session.status = 'ready'; await save(session); return json(res, 200, publicSession(session));
        }
        if (action === 'model' && req.method === 'GET') {
          const file = path.join(directory, id, 'model.atls');
          const stats = await stat(file);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stats.size,
            'Cache-Control': 'no-store', 'X-Content-SHA256': session.manifest.modelHash });
          const stream = createReadStream(file); stream.on('error', (error) => res.destroy(error)); stream.pipe(res); return;
        }
        if (action === 'verify-model' && req.method === 'POST') {
          const identity = await readBody(req, 4096);
          return json(res, 200, await verifyModel(session, identity));
        }
        if (action === 'result' && req.method === 'POST') {
          const result = await readBody(req, 48 * 1024 * 1024);
          validateIPadResult(result, session.manifest, id);
          // Recheck on receipt as well, including older clients and a file changed after preflight.
          await verifyModel(session, { modelHash: result.modelHash, byteLength: session.manifest.byteLength });
          const body = JSON.stringify(result), digest = hash(body);
          // Exactly one immutable completed result. Retrying after a lost response is safe.
          if (session.resultHash && session.resultHash !== digest) fail(409, '已收到不同的完成结果，不能覆盖');
          await atomicWrite(path.join(directory, id, 'result.json'), body);
          Object.assign(session, { status: session.importedAt ? 'imported' : 'completed', resultHash: digest,
            completedAt: result.completedAt, sampleCount: result.samples.length });
          await save(session); return json(res, 200, { id: result.id, received: true, sampleCount: session.sampleCount });
        }
        if (action === 'result' && req.method === 'GET') {
          if (!session.resultHash) fail(409, '设备尚未提交完成结果');
          return json(res, 200, JSON.parse(await readFile(path.join(directory, id, 'result.json'), 'utf8')));
        }
        if (action === 'imported' && req.method === 'POST') {
          if (!session.resultHash) fail(409, '尚无结果可以接收');
          session.importedAt = new Date().toISOString(); session.status = 'imported'; await save(session);
          return json(res, 200, publicSession(session));
        }
        fail(405, '不支持该操作');
      });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || (error.code ? 500 : 400), { error: error.code ? '局域网文件服务暂时不可用' : error.message });
      else res.destroy(error);
    }
  };
}

export function ipadTeachingPlugin() {
  let root, logger;
  const cleanups = new Set();
  const install = (server) => {
    const identity = { serverId: randomUUID(), serverName: hostname().replace(/\.local$/i, '').slice(0, 120) };
    server.middlewares.use(createIPadTeachingService({ directory: path.join(root, '.atlas-cache', 'ipad-teaching'), ...identity }));
    if (server.httpServer) cleanups.add(advertiseIPadService(server.httpServer, { ...identity,
      onError: (error) => logger?.warn(`iPad 局域网发现暂不可用，仍可手动填写地址：${error.message}`) }));
  };
  return { name: 'atlas-ipad-teaching', configResolved(config) { root = config.root; logger = config.logger; },
    configureServer: install, configurePreviewServer: install,
    closeBundle() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } };
}
