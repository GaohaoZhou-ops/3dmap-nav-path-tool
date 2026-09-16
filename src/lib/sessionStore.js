const DATABASE_NAME = 'atlas-route-studio';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace-session';
const VIEW_STATE_KEY = 'atlas-route-studio:view-state-v1';
const CURRENT_KEYS = ['meta', 'map', 'config'];
const RECOVERY_KEYS = ['recovery-meta', 'recovery-map', 'recovery-config'];

let databasePromise = null;

const browserStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export function saveWorkspaceViews(sessionId, mapId, views) {
  const storage = browserStorage();
  if (!storage || !sessionId || !mapId) return false;
  try {
    storage.setItem(
      VIEW_STATE_KEY,
      JSON.stringify({
        version: 1,
        sessionId,
        mapId,
        view2d: views?.view2d || null,
        view3d: views?.view3d || null,
        savedAt: Date.now(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspaceViews(sessionId, mapId) {
  const storage = browserStorage();
  if (!storage || !sessionId) return null;
  try {
    const payload = JSON.parse(storage.getItem(VIEW_STATE_KEY) || 'null');
    if (payload?.sessionId === sessionId && mapId && payload?.mapId === mapId) return payload;
    storage.removeItem(VIEW_STATE_KEY);
  } catch {
    try {
      storage.removeItem(VIEW_STATE_KEY);
    } catch {
      // A blocked storage backend should not prevent the IndexedDB fallback.
    }
  }
  return null;
}

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
  CURRENT_KEYS.forEach((key) => store.delete(key));
  store.put({ key: 'meta', sessionId, startedAt: Date.now() });
  await transactionComplete(transaction);
};

const readWorkspaceRecords = async (database) => {
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [meta, map, config, recoveryMeta, recoveryMap, recoveryConfig] = await Promise.all([
    requestResult(store.get('meta')),
    requestResult(store.get('map')),
    requestResult(store.get('config')),
    requestResult(store.get('recovery-meta')),
    requestResult(store.get('recovery-map')),
    requestResult(store.get('recovery-config')),
  ]);
  await completion;
  return { meta, map, config, recoveryMeta, recoveryMap, recoveryConfig };
};

const isRecoverableWorkspace = (map, config) => Boolean(
  map || config?.config?.project,
);

const createRecoveryId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const readViewsForRecovery = (meta, map, config) => {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const payload = JSON.parse(storage.getItem(VIEW_STATE_KEY) || 'null');
    const mapId = map?.mapId || config?.mapId || null;
    const sourceSessionIds = new Set([
      meta?.sessionId,
      map?.sessionId,
      config?.sessionId,
    ].filter(Boolean));
    if (
      payload?.version === 1
      && payload?.mapId === mapId
      && sourceSessionIds.has(payload?.sessionId)
    ) {
      return {
        view2d: payload.view2d || null,
        view3d: payload.view3d || null,
        savedAt: Number(payload.savedAt) || Date.now(),
      };
    }
  } catch {
    // The IndexedDB snapshot still carries its most recently completed views.
  }
  return null;
};

const restoreRecoveryRecord = (record, key, sessionId) => {
  const restored = { ...record, key, sessionId };
  delete restored.recoveryId;
  delete restored.sourceSessionId;
  return restored;
};

const summarizeRecovery = ({ recoveryId, sourceSessionId, archivedAt }, map, config) => {
  const snapshot = config?.config || null;
  const project = snapshot?.project || null;
  const teachingTasks = Array.isArray(project?.virtualTeaching?.tasks)
    ? project.virtualTeaching.tasks
    : Array.isArray(project?.teachingTasks)
      ? project.teachingTasks
      : [];
  const edges = Array.isArray(project?.paths)
    ? project.paths
    : Array.isArray(project?.edges)
      ? project.edges
      : [];
  const parkingPointCount = teachingTasks.reduce(
    (total, task) => total + (Array.isArray(task?.parkingPoints) ? task.parkingPoints.length : 0),
    0,
  );
  const teachingPoseCount = teachingTasks.reduce(
    (taskTotal, task) => taskTotal + (Array.isArray(task?.parkingPoints)
      ? task.parkingPoints.reduce(
          (parkingTotal, parkingPoint) => parkingTotal
            + (Array.isArray(parkingPoint?.poses) ? parkingPoint.poses.length : 0),
          0,
        )
      : 0),
    0,
  );
  const activeTask = teachingTasks.find(
    (task) => task?.id === snapshot?.ui?.activeTeachingTaskId,
  ) || teachingTasks[0] || null;
  const savedAt = Math.max(
    Number(map?.savedAt) || 0,
    Number(config?.savedAt) || 0,
  ) || Number(archivedAt) || Date.now();

  return {
    available: true,
    recoveryId,
    sourceSessionId: sourceSessionId || null,
    archivedAt: Number(archivedAt) || Date.now(),
    savedAt,
    mapId: map?.mapId || config?.mapId || null,
    mapName: map?.name || project?.map?.fileName || '未命名地图',
    activeTaskName: activeTask?.name || '',
    taskCount: teachingTasks.length,
    parkingPointCount,
    teachingPoseCount,
    waypointCount: Array.isArray(project?.waypoints) ? project.waypoints.length : 0,
    edgeCount: edges.length,
    robotName: project?.robot?.name || snapshot?.ui?.selectedRobot?.name || '',
  };
};

const archiveWorkspaceAndReplaceSession = async (
  database,
  sessionId,
  { meta, map, config, recoveryMeta },
) => {
  const shouldArchive = isRecoverableWorkspace(map, config);
  const archivedAt = Date.now();
  const recoveryId = shouldArchive ? createRecoveryId() : null;
  const workspaceViews = shouldArchive ? readViewsForRecovery(meta, map, config) : null;
  const summary = shouldArchive
    ? summarizeRecovery(
        { recoveryId, sourceSessionId: meta?.sessionId, archivedAt },
        map,
        config,
      )
    : recoveryMeta?.available
      ? recoveryMeta
      : null;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  CURRENT_KEYS.forEach((key) => store.delete(key));

  if (shouldArchive) {
    RECOVERY_KEYS.forEach((key) => store.delete(key));
    store.put({ key: 'recovery-meta', ...summary });
    if (map) {
      store.put({
        ...map,
        key: 'recovery-map',
        recoveryId,
        sourceSessionId: meta?.sessionId || map.sessionId || null,
        workspaceViews,
      });
    }
    if (config) {
      store.put({
        ...config,
        key: 'recovery-config',
        recoveryId,
        sourceSessionId: meta?.sessionId || config.sessionId || null,
        workspaceViews,
      });
    }
  }

  store.put({ key: 'meta', sessionId, startedAt: archivedAt });
  await transactionComplete(transaction);
  return summary;
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
  const records = await readWorkspaceRecords(database);
  const { meta, map, config, recoveryMeta } = records;

  if (meta?.sessionId !== sessionId) {
    const recovery = await archiveWorkspaceAndReplaceSession(database, sessionId, records);
    return {
      restarted: Boolean(meta?.sessionId),
      map: null,
      config: null,
      recovery,
      activatedRecoveryId: null,
    };
  }

  return {
    restarted: false,
    map: map?.sessionId === sessionId ? map : null,
    config: config?.sessionId === sessionId ? config : null,
    recovery: recoveryMeta?.available ? recoveryMeta : null,
    activatedRecoveryId: meta?.activatedRecoveryId || null,
  };
}

export async function activateWorkspaceRecovery(sessionId) {
  if (!sessionId) throw new Error('当前服务会话尚未就绪');
  const database = await openDatabase();
  const records = await readWorkspaceRecords(database);
  const { recoveryMeta, recoveryMap, recoveryConfig } = records;
  if (
    !recoveryMeta?.available
    || !recoveryMeta.recoveryId
    || !isRecoverableWorkspace(recoveryMap, recoveryConfig)
  ) {
    throw new Error('没有可恢复的上一次工程');
  }
  if (
    (recoveryMap && recoveryMap.recoveryId !== recoveryMeta.recoveryId)
    || (recoveryConfig && recoveryConfig.recoveryId !== recoveryMeta.recoveryId)
  ) {
    throw new Error('上一次工程的恢复清单不完整');
  }

  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  CURRENT_KEYS.forEach((key) => store.delete(key));
  store.put({
    key: 'meta',
    sessionId,
    startedAt: Date.now(),
    activatedRecoveryId: recoveryMeta.recoveryId,
  });
  if (recoveryMap) {
    store.put(restoreRecoveryRecord(recoveryMap, 'map', sessionId));
  }
  if (recoveryConfig) {
    store.put(restoreRecoveryRecord(recoveryConfig, 'config', sessionId));
  }
  RECOVERY_KEYS.forEach((key) => store.delete(key));
  await transactionComplete(transaction);

  const storage = browserStorage();
  try {
    storage?.removeItem(VIEW_STATE_KEY);
  } catch {
    // The project snapshot still contains both viewport states.
  }
  return recoveryMeta;
}

export async function finalizeWorkspaceRecovery(recoveryId) {
  if (!recoveryId) return false;
  const database = await openDatabase();
  const records = await readWorkspaceRecords(database);
  const meta = records.meta;
  if (meta?.activatedRecoveryId !== recoveryId) return false;
  if (records.recoveryMeta && records.recoveryMeta.recoveryId !== recoveryId) return false;

  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  RECOVERY_KEYS.forEach((key) => store.delete(key));
  store.put({ ...meta, activatedRecoveryId: null, recoveryRestoredAt: Date.now() });
  await transactionComplete(transaction);
  return true;
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
