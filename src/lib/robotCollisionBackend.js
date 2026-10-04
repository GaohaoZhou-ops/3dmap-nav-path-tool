const PHYSICS_CONFIG_URL = '/__atlas/physics/config';
const PHYSICS_API_URL = '/__atlas/physics/v1';

const readErrorPayload = async (response) => {
  try {
    const payload = await response.json();
    return payload?.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(await readErrorPayload(response));
  return response.json();
};

const typedArrayBase64 = (array) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error || new Error('碰撞环境编码失败'));
  reader.onload = () => {
    const result = String(reader.result || '');
    const comma = result.indexOf(',');
    if (comma < 0) reject(new Error('碰撞环境编码结果无效'));
    else resolve(result.slice(comma + 1));
  };
  reader.readAsDataURL(new Blob([
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
  ], { type: 'application/octet-stream' }));
});

const encodeTypedArray = async (array, dtype) => ({
  encoding: 'base64',
  dtype,
  count: array.length,
  data: await typedArrayBase64(array),
});

class IsaacRobotCollisionBackend {
  constructor(config) {
    this.atlasBackend = 'isaac';
    this.atlasRequestedBackend = config?.requestedBackend || 'isaac';
    this.atlasEngine = config?.isaac?.engine || 'NVIDIA PhysX';
    this.onmessage = null;
    this.onerror = null;
    this.sessionId = null;
    this.terminated = false;
    this.abortController = new AbortController();
    this.initializing = null;
  }

  _message(data) {
    if (this.terminated) return;
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data });
    });
  }

  _error(error, fallback) {
    if (this.terminated) return;
    const message = error?.message || fallback;
    this._message({ type: 'error', message, backend: 'isaac' });
  }

  async _initialize(message) {
    try {
      const [positions, indices] = await Promise.all([
        encodeTypedArray(message.positions, 'float32-le'),
        encodeTypedArray(message.indices, 'uint32-le'),
      ]);
      if (this.terminated) return;
      const payload = await fetchJson(`${PHYSICS_API_URL}/sessions`, {
        method: 'POST',
        signal: this.abortController.signal,
        body: JSON.stringify({
          apiVersion: 1,
          requestedCellSize: message.requestedCellSize,
          environment: { positions, indices },
        }),
      });
      if (this.terminated) return;
      if (!payload?.sessionId) throw new Error('Isaac 碰撞服务未返回会话标识');
      this.sessionId = payload.sessionId;
      this._message({
        type: 'ready',
        backend: 'isaac',
        engine: payload.engine || this.atlasEngine,
        sourcePointCount: payload.sourcePointCount,
        indexedPointCount: payload.indexedPointCount,
        meshSampleCount: payload.meshSampleCount,
        sourceFaceCount: payload.sourceFaceCount,
        cellSize: payload.cellSize,
        bucketCount: payload.bucketCount,
        buildMs: payload.buildMs,
        physxMeshReady: payload.physxMeshReady,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') this._error(error, 'Isaac 碰撞环境初始化失败');
    }
  }

  async _check(message) {
    try {
      await this.initializing;
      if (this.terminated || !this.sessionId) return;
      const payload = await fetchJson(
        `${PHYSICS_API_URL}/sessions/${encodeURIComponent(this.sessionId)}/check`,
        {
          method: 'POST',
          signal: this.abortController.signal,
          body: JSON.stringify({
            apiVersion: 1,
            revision: message.revision,
            proxies: message.proxies,
            threshold: message.threshold,
            contactMargin: message.contactMargin,
          }),
        },
      );
      this._message({ ...payload, type: 'result', backend: 'isaac' });
    } catch (error) {
      if (error?.name !== 'AbortError') this._error(error, 'Isaac 碰撞查询失败');
    }
  }

  postMessage(message) {
    if (this.terminated) return;
    if (message?.type === 'init') {
      this.initializing = this._initialize(message);
    } else if (message?.type === 'check') {
      void this._check(message);
    }
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.abortController.abort();
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) {
      void fetch(`${PHYSICS_API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => {});
    }
  }
}

const localConfig = (requestedBackend = 'local', error = null) => ({
  apiVersion: 1,
  requestedBackend,
  activeBackend: 'local',
  localAvailable: true,
  isaac: { available: false, error },
});

export async function resolveRobotCollisionBackend() {
  try {
    const config = await fetchJson(PHYSICS_CONFIG_URL);
    if (config?.apiVersion !== 1) throw new Error('碰撞后端配置协议不兼容');
    if (config.activeBackend === 'isaac') return config;
    if (config.activeBackend === 'local') return config;
    const unavailable = new Error(config?.isaac?.error || 'Isaac 碰撞后端不可用');
    unavailable.atlasBackendRequired = true;
    throw unavailable;
  } catch (error) {
    // A static deployment may not expose the optional server endpoint. It must
    // retain the pre-existing browser collision engine without user action.
    if (error?.atlasBackendRequired) throw error;
    return localConfig('local', error?.message || null);
  }
}

export async function createRobotCollisionBackend() {
  const config = await resolveRobotCollisionBackend();
  if (config.activeBackend === 'isaac') {
    return new IsaacRobotCollisionBackend(config);
  }
  const worker = new Worker(new URL('../workers/robotCollision.worker.js', import.meta.url), {
    type: 'module',
  });
  worker.atlasBackend = 'local';
  worker.atlasRequestedBackend = config.requestedBackend || 'local';
  worker.atlasEngine = 'Browser spatial worker';
  worker.atlasFallbackReason = config.requestedBackend === 'auto'
    ? config.isaac?.error || null
    : null;
  return worker;
}
