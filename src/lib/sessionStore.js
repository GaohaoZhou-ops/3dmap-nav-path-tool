const DATABASE_NAME = 'atlas-route-studio';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace-session';

let databasePromise = null;

const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地存储请求失败'));
  });

const transactionComplete = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('本地存储事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('本地存储事务已取消'));
  });

const openDatabase = () => {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('无法打开本地工作区'));
    };
  });

  return databasePromise;
};

const replaceSession = async (database, sessionId) => {
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.clear();
  store.put({ key: 'meta', sessionId, startedAt: Date.now() });
  await transactionComplete(transaction);
};

export async function fetchServiceSession() {
  const response = await fetch('/__atlas/session', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`无法读取服务会话（${response.status}）`);
  const payload = await response.json();
  if (!payload?.sessionId) throw new Error('服务会话标识无效');
  return payload;
}

export async function prepareWorkspaceSession(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const metaRequest = store.get('meta');
  const mapRequest = store.get('map');
  const configRequest = store.get('config');
  const [meta, map, config] = await Promise.all([
    requestResult(metaRequest),
    requestResult(mapRequest),
    requestResult(configRequest),
    transactionComplete(transaction),
  ]);

  if (meta?.sessionId !== sessionId) {
    await replaceSession(database, sessionId);
    return { restarted: Boolean(meta?.sessionId), map: null, config: null };
  }

  return {
    restarted: false,
    map: map?.sessionId === sessionId ? map : null,
    config: config?.sessionId === sessionId ? config : null,
  };
}

export async function saveWorkspaceMap(sessionId, mapId, name, mapCache) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const legacyBuffer = mapCache instanceof ArrayBuffer ? mapCache : null;
  transaction.objectStore(STORE_NAME).put(
    legacyBuffer
      ? {
          key: 'map',
          sessionId,
          mapId,
          name,
          byteLength: legacyBuffer.byteLength,
          blob: new Blob([legacyBuffer], { type: 'application/octet-stream' }),
          savedAt: Date.now(),
        }
      : {
          ...mapCache,
          key: 'map',
          sessionId,
          mapId,
          name,
          savedAt: Date.now(),
        },
  );
  await transactionComplete(transaction);
}

export async function saveWorkspaceConfig(sessionId, mapId, config) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({
    key: 'config',
    sessionId,
    mapId,
    config,
    savedAt: Date.now(),
  });
  await transactionComplete(transaction);
}

export async function resetWorkspaceSession(sessionId) {
  const database = await openDatabase();
  await replaceSession(database, sessionId);
}
