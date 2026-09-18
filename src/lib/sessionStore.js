const DATABASE_NAME = 'atlas-route-studio';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace-session';
const VIEW_STATE_KEY = 'atlas-route-studio:view-state-v1';
const CURRENT_KEYS = ['meta', 'map', 'config'];
const RECOVERY_KEYS = ['recovery-meta', 'recovery-map', 'recovery-config'];
const WORKSPACE_INDEX_KEY = 'workspace-slots';
const WORKSPACE_MODES = ['map', 'independent'];

const normalizeWorkspaceMode = (value) => value === 'independent' ? 'independent' : 'map';
const workspaceMapKey = (mode) => `workspace-map:${normalizeWorkspaceMode(mode)}`;
const workspaceConfigKey = (mode) => `workspace-config:${normalizeWorkspaceMode(mode)}`;
const workspaceViewKey = (mode) => `${VIEW_STATE_KEY}:${normalizeWorkspaceMode(mode)}`;
const ALL_WORKSPACE_KEYS = [
  ...CURRENT_KEYS,
  WORKSPACE_INDEX_KEY,
  ...WORKSPACE_MODES.flatMap((mode) => [workspaceMapKey(mode), workspaceConfigKey(mode)]),
];

let databasePromise = null;

const browserStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export function saveWorkspaceViews(sessionId, mapId, views, mode = 'map') {
  const storage = browserStorage();
  if (!storage || !sessionId || !mapId) return false;
  try {
    const payload = JSON.stringify({
      version: 2,
      sessionId,
      mapId,
      teachingSpaceMode: normalizeWorkspaceMode(mode),
      view2d: views?.view2d || null,
      view3d: views?.view3d || null,
      savedAt: Date.now(),
    });
    storage.setItem(workspaceViewKey(mode), payload);
    storage.setItem(VIEW_STATE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspaceViews(sessionId, mapId, mode = 'map') {
  const storage = browserStorage();
  if (!storage || !sessionId) return null;
  try {
    const modeKey = workspaceViewKey(mode);
    const payload = JSON.parse(
      storage.getItem(modeKey)
      || storage.getItem(VIEW_STATE_KEY)
      || 'null',
    );
    if (payload?.sessionId === sessionId && mapId && payload?.mapId === mapId) return payload;
    storage.removeItem(modeKey);
  } catch {
    try {
      storage.removeItem(workspaceViewKey(mode));
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
  ALL_WORKSPACE_KEYS.forEach((key) => store.delete(key));
  store.put({ key: 'meta', sessionId, startedAt: Date.now(), activeMode: 'map' });
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: 'map',
    modes: { map: null, independent: null },
    updatedAt: Date.now(),
  });
  await transactionComplete(transaction);
};

const readWorkspaceRecords = async (database) => {
  const headerTransaction = database.transaction(STORE_NAME, 'readonly');
  const headerStore = headerTransaction.objectStore(STORE_NAME);
  const headerCompletion = transactionComplete(headerTransaction);
  const [meta, workspaceIndex, recoveryMeta, recoveryMap, recoveryConfig] = await Promise.all([
    requestResult(headerStore.get('meta')),
    requestResult(headerStore.get(WORKSPACE_INDEX_KEY)),
    requestResult(headerStore.get('recovery-meta')),
    requestResult(headerStore.get('recovery-map')),
    requestResult(headerStore.get('recovery-config')),
  ]);
  await headerCompletion;

  const indexedMode = workspaceIndex?.activeMode
    ? normalizeWorkspaceMode(workspaceIndex.activeMode ?? meta?.activeMode)
    : null;
  const activeMode = indexedMode || normalizeWorkspaceMode(meta?.activeMode);
  const workspaceTransaction = database.transaction(STORE_NAME, 'readonly');
  const workspaceStore = workspaceTransaction.objectStore(STORE_NAME);
  const workspaceCompletion = transactionComplete(workspaceTransaction);
  const [map, config] = indexedMode
    ? await Promise.all([
        requestResult(workspaceStore.get(workspaceMapKey(activeMode))),
        requestResult(workspaceStore.get(workspaceConfigKey(activeMode))),
      ])
    : await Promise.all([
        requestResult(workspaceStore.get('map')),
        requestResult(workspaceStore.get('config')),
      ]);
  await workspaceCompletion;
  return {
    meta,
    map,
    config,
    workspaceIndex,
    activeMode,
    legacyWorkspace: !indexedMode,
    recoveryMeta,
    recoveryMap,
    recoveryConfig,
  };
};

const isRecoverableWorkspace = (map, config) => Boolean(
  map || config?.config?.project,
);

const inferWorkspaceMode = (map, config, fallback = 'map') => normalizeWorkspaceMode(
  config?.config?.project?.workspace?.teachingSpaceMode
  ?? config?.config?.ui?.teachingSpaceMode
  ?? map?.teachingSpaceMode
  ?? fallback,
);

const summarizeWorkspace = (mode, map, config, previous = null) => {
  const snapshot = config?.config || null;
  const project = snapshot?.project || null;
  const teachingTasks = Array.isArray(project?.virtualTeaching?.tasks)
    ? project.virtualTeaching.tasks
    : Array.isArray(project?.teachingTasks)
      ? project.teachingTasks
      : [];
  const hasWorkspace = Boolean(map || project || snapshot?.ui?.selectedRobot);
  if (!hasWorkspace) return null;
  return {
    ...(previous || {}),
    available: true,
    mode: normalizeWorkspaceMode(mode),
    mapId: map?.mapId || config?.mapId || project?.map?.mapId || null,
    mapName: map?.name || project?.map?.fileName || previous?.mapName || '未命名工作现场',
    pointCount: Number(map?.pointCount ?? project?.map?.pointCount ?? previous?.pointCount) || 0,
    faceCount: Number(map?.faceCount ?? project?.map?.faceCount ?? previous?.faceCount) || 0,
    waypointCount: Array.isArray(project?.waypoints)
      ? project.waypoints.length
      : Number(previous?.waypointCount) || 0,
    edgeCount: Array.isArray(project?.paths)
      ? project.paths.length
      : Array.isArray(project?.edges)
        ? project.edges.length
        : Number(previous?.edgeCount) || 0,
    taskCount: project ? teachingTasks.length : Number(previous?.taskCount) || 0,
    robotName: project
      ? project.robot?.name || snapshot?.ui?.selectedRobot?.name || ''
      : previous?.robotName || '',
    savedAt: Math.max(
      Number(map?.savedAt) || 0,
      Number(config?.savedAt) || 0,
      Number(previous?.savedAt) || 0,
      Date.now(),
    ),
  };
};

const normalizeWorkspaceIndex = (sessionId, activeMode, index, map, config) => {
  const mode = normalizeWorkspaceMode(activeMode);
  const modes = {
    map: index?.modes?.map || null,
    independent: index?.modes?.independent || null,
  };
  modes[mode] = summarizeWorkspace(mode, map, config, modes[mode]);
  return {
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: mode,
    modes,
    updatedAt: Date.now(),
  };
};

const clearWorkspaceViewState = (mode = null) => {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (mode) storage.removeItem(workspaceViewKey(mode));
    else WORKSPACE_MODES.forEach((workspaceMode) => storage.removeItem(workspaceViewKey(workspaceMode)));
    storage.removeItem(VIEW_STATE_KEY);
  } catch {
    // IndexedDB remains the authoritative fallback.
  }
};

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
      (payload?.version === 1 || payload?.version === 2)
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
  { meta, map, config, recoveryMeta, activeMode },
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
  ALL_WORKSPACE_KEYS.forEach((key) => store.delete(key));

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

  const nextMode = normalizeWorkspaceMode(activeMode);
  store.put({ key: 'meta', sessionId, startedAt: archivedAt, activeMode: nextMode });
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: nextMode,
    modes: { map: null, independent: null },
    updatedAt: archivedAt,
  });
  await transactionComplete(transaction);
  clearWorkspaceViewState();
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
  const { meta, recoveryMeta } = records;

  if (meta?.sessionId !== sessionId) {
    const recovery = await archiveWorkspaceAndReplaceSession(database, sessionId, records);
    return {
      restarted: Boolean(meta?.sessionId),
      map: null,
      config: null,
      activeMode: 'map',
      workspaceSlots: { map: null, independent: null },
      recovery,
      activatedRecoveryId: null,
    };
  }

  const map = records.map?.sessionId === sessionId ? records.map : null;
  const config = records.config?.sessionId === sessionId ? records.config : null;
  const activeMode = inferWorkspaceMode(
    map,
    config,
    records.workspaceIndex?.activeMode ?? records.activeMode ?? meta?.activeMode,
  );
  const workspaceIndex = normalizeWorkspaceIndex(
    sessionId,
    activeMode,
    records.workspaceIndex,
    map,
    config,
  );

  if (records.legacyWorkspace || !records.workspaceIndex) {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.delete('map');
    store.delete('config');
    if (map) store.put({ ...map, key: workspaceMapKey(activeMode) });
    if (config) store.put({ ...config, key: workspaceConfigKey(activeMode) });
    store.put(workspaceIndex);
    store.put({ ...meta, key: 'meta', sessionId, activeMode });
    await transactionComplete(transaction);
  } else if (
    records.workspaceIndex.activeMode !== activeMode
    || meta?.activeMode !== activeMode
  ) {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(workspaceIndex);
    store.put({ ...meta, key: 'meta', sessionId, activeMode });
    await transactionComplete(transaction);
  }

  return {
    restarted: false,
    map,
    config,
    activeMode,
    workspaceSlots: workspaceIndex.modes,
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

  const activeMode = inferWorkspaceMode(recoveryMap, recoveryConfig, 'map');
  const restoredMap = recoveryMap
    ? restoreRecoveryRecord(recoveryMap, workspaceMapKey(activeMode), sessionId)
    : null;
  const restoredConfig = recoveryConfig
    ? restoreRecoveryRecord(recoveryConfig, workspaceConfigKey(activeMode), sessionId)
    : null;
  const workspaceIndex = normalizeWorkspaceIndex(
    sessionId,
    activeMode,
    null,
    restoredMap,
    restoredConfig,
  );

  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  ALL_WORKSPACE_KEYS.forEach((key) => store.delete(key));
  store.put({
    key: 'meta',
    sessionId,
    startedAt: Date.now(),
    activeMode,
    activatedRecoveryId: recoveryMeta.recoveryId,
  });
  store.put(workspaceIndex);
  if (restoredMap) store.put(restoredMap);
  if (restoredConfig) store.put(restoredConfig);
  RECOVERY_KEYS.forEach((key) => store.delete(key));
  await transactionComplete(transaction);
  clearWorkspaceViewState();
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

export async function saveWorkspaceMap(sessionId, mapId, name, mapCache, mode = null) {
  const database = await openDatabase();
  const workspaceMode = normalizeWorkspaceMode(mode ?? mapCache?.teachingSpaceMode);
  const savedAt = Date.now();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [workspaceIndex, meta] = await Promise.all([
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get('meta')),
  ]);
  const legacyBuffer = mapCache instanceof ArrayBuffer ? mapCache : null;
  const mapRecord = legacyBuffer
    ? {
        key: workspaceMapKey(workspaceMode),
        sessionId,
        mapId,
        name,
        teachingSpaceMode: workspaceMode,
        byteLength: legacyBuffer.byteLength,
        blob: new Blob([legacyBuffer], { type: 'application/octet-stream' }),
        savedAt,
      }
    : {
        ...mapCache,
        key: workspaceMapKey(workspaceMode),
        sessionId,
        mapId,
        name,
        teachingSpaceMode: workspaceMode,
        savedAt,
      };
  const previousSummary = workspaceIndex?.modes?.[workspaceMode] || null;
  const replacesMap = previousSummary?.mapId !== mapId;
  const modes = {
    map: workspaceIndex?.modes?.map || null,
    independent: workspaceIndex?.modes?.independent || null,
  };
  modes[workspaceMode] = summarizeWorkspace(
    workspaceMode,
    mapRecord,
    null,
    replacesMap ? null : previousSummary,
  );
  store.put(mapRecord);
  if (replacesMap) store.delete(workspaceConfigKey(workspaceMode));
  store.delete('map');
  store.delete('config');
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: workspaceMode,
    modes,
    updatedAt: savedAt,
  });
  store.put({
    ...(meta || {}),
    key: 'meta',
    sessionId,
    activeMode: workspaceMode,
    startedAt: Number(meta?.startedAt) || savedAt,
  });
  await completion;
  return modes[workspaceMode];
}

export async function saveWorkspaceConfig(sessionId, mapId, config, mode = null) {
  const database = await openDatabase();
  const workspaceMode = normalizeWorkspaceMode(
    mode
    ?? config?.project?.workspace?.teachingSpaceMode
    ?? config?.ui?.teachingSpaceMode,
  );
  const savedAt = Date.now();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [workspaceIndex, meta] = await Promise.all([
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get('meta')),
  ]);
  const configRecord = {
    key: workspaceConfigKey(workspaceMode),
    sessionId,
    mapId,
    config,
    teachingSpaceMode: workspaceMode,
    savedAt,
  };
  const modes = {
    map: workspaceIndex?.modes?.map || null,
    independent: workspaceIndex?.modes?.independent || null,
  };
  modes[workspaceMode] = summarizeWorkspace(
    workspaceMode,
    null,
    configRecord,
    modes[workspaceMode],
  );
  store.put(configRecord);
  store.delete('map');
  store.delete('config');
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: workspaceMode,
    modes,
    updatedAt: savedAt,
  });
  store.put({
    ...(meta || {}),
    key: 'meta',
    sessionId,
    activeMode: workspaceMode,
    startedAt: Number(meta?.startedAt) || savedAt,
  });
  await completion;
  return modes[workspaceMode];
}

export async function activateWorkspaceMode(sessionId, mode) {
  if (!sessionId) throw new Error('当前服务会话尚未就绪');
  const workspaceMode = normalizeWorkspaceMode(mode);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [workspaceIndex, meta] = await Promise.all([
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get('meta')),
  ]);
  if (meta?.sessionId !== sessionId || workspaceIndex?.sessionId !== sessionId) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw new Error('工作会话已变化，请刷新页面后重试');
  }
  const summary = workspaceIndex?.modes?.[workspaceMode] || null;
  if (!summary?.available) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw new Error(workspaceMode === 'independent' ? '没有可继续的独立示教缓存' : '没有可继续的地图示教缓存');
  }
  store.put({
    ...workspaceIndex,
    activeMode: workspaceMode,
    updatedAt: Date.now(),
  });
  store.put({ ...meta, activeMode: workspaceMode });
  await completion;
  return summary;
}

export async function resetWorkspaceSession(sessionId) {
  const database = await openDatabase();
  await replaceSession(database, sessionId);
  clearWorkspaceViewState();
}
