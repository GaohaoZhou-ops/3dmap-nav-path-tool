const DB_NAME = 'atlas-project-directory-bindings';
const DB_VERSION = 1;
const STORE_NAME = 'bindings';
const ACTIVE_KEY = 'active-project';
const PROJECT_MODES = ['map', 'independent'];
const normalizeMode = (value) => value === 'independent' ? 'independent' : 'map';
const modeKey = (mode) => `project:${normalizeMode(mode)}`;

const openDatabase = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) {
    reject(new Error('当前浏览器不支持保存工程目录授权'));
    return;
  }
  const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
  request.onerror = () => reject(request.error || new Error('工程目录授权数据库打开失败'));
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    }
  };
  request.onsuccess = () => resolve(request.result);
});

const runTransaction = async (mode, operation) => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      request.onerror = () => reject(request.error || new Error('工程目录授权操作失败'));
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
};

export const saveProjectDirectoryBinding = async ({
  handle,
  name,
  projectFile,
  sessionId,
  teachingSpaceMode = 'map',
}) => {
  if (!handle || handle.kind !== 'directory') return false;
  const mode = normalizeMode(teachingSpaceMode);
  const record = {
    key: modeKey(mode),
    handle,
    name: String(name || handle.name || '工程目录'),
    projectFile: String(projectFile || 'config/project.json'),
    sessionId: String(sessionId || ''),
    teachingSpaceMode: mode,
    savedAt: new Date().toISOString(),
  };
  await runTransaction('readwrite', (store) => store.put(record));
  await runTransaction('readwrite', (store) => store.put({ ...record, key: ACTIVE_KEY }));
  return true;
};

export const loadProjectDirectoryBinding = async (teachingSpaceMode = 'map') => {
  const mode = normalizeMode(teachingSpaceMode);
  let result = await runTransaction('readonly', (store) => store.get(modeKey(mode)));
  if (!result) {
    const legacy = await runTransaction('readonly', (store) => store.get(ACTIVE_KEY));
    if (legacy && (!legacy.teachingSpaceMode || normalizeMode(legacy.teachingSpaceMode) === mode)) {
      result = { ...legacy, key: modeKey(mode), teachingSpaceMode: mode };
      await runTransaction('readwrite', (store) => store.put(result));
    }
  }
  return result?.handle?.kind === 'directory' ? result : null;
};

export const clearProjectDirectoryBinding = async (teachingSpaceMode = null) => {
  if (teachingSpaceMode === null) {
    await Promise.all([
      runTransaction('readwrite', (store) => store.delete(ACTIVE_KEY)),
      ...PROJECT_MODES.map((mode) => runTransaction('readwrite', (store) => store.delete(modeKey(mode)))),
    ]);
    return;
  }
  await Promise.all([
    runTransaction('readwrite', (store) => store.delete(ACTIVE_KEY)),
    runTransaction('readwrite', (store) => store.delete(modeKey(teachingSpaceMode))),
  ]);
};
