const DB_NAME = 'atlas-project-directory-bindings';
const DB_VERSION = 1;
const STORE_NAME = 'bindings';
const ACTIVE_KEY = 'active-project';

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
}) => {
  if (!handle || handle.kind !== 'directory') return false;
  await runTransaction('readwrite', (store) => store.put({
    key: ACTIVE_KEY,
    handle,
    name: String(name || handle.name || '工程目录'),
    projectFile: String(projectFile || 'config/project.json'),
    sessionId: String(sessionId || ''),
    savedAt: new Date().toISOString(),
  }));
  return true;
};

export const loadProjectDirectoryBinding = async () => {
  const result = await runTransaction('readonly', (store) => store.get(ACTIVE_KEY));
  return result?.handle?.kind === 'directory' ? result : null;
};

export const clearProjectDirectoryBinding = async () => {
  await runTransaction('readwrite', (store) => store.delete(ACTIVE_KEY));
};

