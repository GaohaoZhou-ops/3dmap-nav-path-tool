import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Download,
  FileJson,
  FolderOpen,
  GitBranch,
  Layers2,
  Map as MapIcon,
  MousePointer2,
  Plus,
  RotateCcw,
  Route,
  ScanLine,
  Server,
  ShieldAlert,
  ShieldCheck,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import HeightRange from './components/HeightRange.jsx';
import Inspector from './components/Inspector.jsx';
import Map2DView from './components/Map2DView.jsx';
import PointCloudViewer from './components/PointCloudViewer.jsx';
import { inspectConnectivity } from './lib/graph.js';
import {
  buildExport,
  clampSlice,
  createId,
  downloadJson,
  fetchBufferWithProgress,
  normalizeProject,
  readFileWithProgress,
} from './lib/io.js';
import {
  fetchServiceSession,
  loadWorkspaceViews,
  prepareWorkspaceSession,
  resetWorkspaceSession,
  saveWorkspaceConfig,
  saveWorkspaceMap,
  saveWorkspaceViews,
} from './lib/sessionStore.js';

const initialValidation = { status: 'idle', unreachableCount: 0, checkedAt: null };
const pointColorModes = new Set(['height', 'source', 'white']);

const defaultLimits = {
  minSpeed: 0.2,
  maxSpeed: 1,
  minAcceleration: -0.8,
  maxAcceleration: 0.8,
};

const defaultMotion = {
  direction: 'forward',
  enable3DObstacleAvoidance: true,
};

const waitForPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));

const GEOMETRY_CACHE_VERSION = 1;

function serializeBounds(box) {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

function serializeSphere(sphere) {
  return {
    center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
    radius: sphere.radius,
  };
}

function exactArrayBuffer(array) {
  if (array.byteOffset === 0 && array.byteLength === array.buffer.byteLength) return array.buffer;
  return array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
}

function packColorAttribute(attribute) {
  if (!attribute?.array?.length || attribute.itemSize < 3) return null;
  const source = attribute.array;
  const packed = new Uint8Array(attribute.count * 3);
  let scale = source.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  if (source.BYTES_PER_ELEMENT !== 1) {
    const sampleLength = Math.min(source.length, 4096);
    for (let index = 0; index < sampleLength; index += 1) {
      if (Math.abs(source[index]) > 1.5) {
        scale = 1;
        break;
      }
    }
  }
  for (let point = 0; point < attribute.count; point += 1) {
    const sourceOffset = point * attribute.itemSize;
    const targetOffset = point * 3;
    packed[targetOffset] = Math.round(Math.max(0, Math.min(255, source[sourceOffset] * scale)));
    packed[targetOffset + 1] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 1] * scale)),
    );
    packed[targetOffset + 2] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 2] * scale)),
    );
  }
  return packed;
}

function createGeometryCache(geometry, bounds, sourceByteLength) {
  const positionAttribute = geometry.getAttribute('position');
  const sourcePositions = positionAttribute?.array;
  if (!sourcePositions?.length) throw new Error('无法缓存空点云');
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : Float32Array.from(sourcePositions);
  const colors = packColorAttribute(geometry.getAttribute('color'));
  const sphere = geometry.boundingSphere;
  return {
    geometryCacheVersion: GEOMETRY_CACHE_VERSION,
    byteLength: Number(sourceByteLength) || positions.byteLength + (colors?.byteLength || 0),
    pointCount: positionAttribute.count,
    positionBuffer: exactArrayBuffer(positions),
    colorBuffer: colors ? exactArrayBuffer(colors) : null,
    bounds,
    sphere: sphere ? serializeSphere(sphere) : null,
  };
}

function restoreGeometryFromCache(record) {
  if (
    record?.geometryCacheVersion !== GEOMETRY_CACHE_VERSION
    || !(record.positionBuffer instanceof ArrayBuffer)
  ) {
    throw new Error('点云几何缓存版本无效');
  }

  const positions = new Float32Array(record.positionBuffer);
  if (!positions.length || positions.length % 3 !== 0) {
    throw new Error('点云几何缓存坐标无效');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (record.colorBuffer instanceof ArrayBuffer) {
    const colors = new Uint8Array(record.colorBuffer);
    if (colors.length === positions.length) {
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    }
  }

  const cachedBounds = record.bounds;
  if (cachedBounds?.min && cachedBounds?.max) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(cachedBounds.min.x, cachedBounds.min.y, cachedBounds.min.z),
      new THREE.Vector3(cachedBounds.max.x, cachedBounds.max.y, cachedBounds.max.z),
    );
  } else {
    geometry.computeBoundingBox();
  }

  if (record.sphere?.center && Number.isFinite(record.sphere.radius)) {
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(
        record.sphere.center.x,
        record.sphere.center.y,
        record.sphere.center.z,
      ),
      record.sphere.radius,
    );
  } else {
    geometry.computeBoundingSphere();
  }
  geometry.userData.geometrySource = 'session-cache';
  return geometry;
}

function suggestedSlice(positions, bounds) {
  const values = [];
  const count = positions.length / 3;
  const stride = Math.max(1, Math.floor(count / 60000));
  for (let index = 2; index < positions.length; index += stride * 3) {
    const value = positions[index];
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  if (!values.length) return [bounds.min.z, bounds.max.z];
  const at = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  const low = at(0.12);
  const high = at(0.72);
  return high > low ? [low, high] : [bounds.min.z, bounds.max.z];
}

export default function App() {
  const mapInputRef = useRef(null);
  const pathInputRef = useRef(null);
  const toastTimerRef = useRef(null);
  const view2dRef = useRef(null);
  const view3dRef = useRef(null);
  const sessionIdRef = useRef(null);
  const sessionReadyRef = useRef(false);
  const sessionSaveTimerRef = useRef(null);
  const sessionWriteChainRef = useRef(Promise.resolve());
  const sessionFailureNotifiedRef = useRef(false);
  const hydrationRevisionRef = useRef(0);
  const latestWorkspaceRef = useRef(null);
  const focusRevisionRef = useRef(0);
  const viewResetRevisionRef = useRef(0);
  const [mapData, setMapData] = useState(null);
  const [heightRange, setHeightRange] = useState([0, 1]);
  const [waypoints, setWaypoints] = useState([]);
  const [edges, setEdges] = useState([]);
  const [mode, setMode] = useState('select');
  const [connectionSourceId, setConnectionSourceId] = useState(null);
  const [selectedWaypointId, setSelectedWaypointId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [validation, setValidation] = useState(initialValidation);
  const [projectionStats, setProjectionStats] = useState({ selectedCount: 0 });
  const [restoredView2d, setRestoredView2d] = useState(null);
  const [restoredView3d, setRestoredView3d] = useState(null);
  const [pointColorMode, setPointColorMode] = useState('height');
  const [showWaypoints3D, setShowWaypoints3D] = useState(true);
  const [collapsedPanel, setCollapsedPanel] = useState(null);
  const [synchronizedFocus, setSynchronizedFocus] = useState(null);
  const [viewResetRequest, setViewResetRequest] = useState(null);
  const [sessionState, setSessionState] = useState({ status: 'checking', restored: false });
  const [loadState, setLoadState] = useState({
    loading: true,
    progress: 0.08,
    phase: '检查工作会话',
    detail: '正在确认服务实例并查找上次快照',
  });
  const [toast, setToast] = useState(null);

  latestWorkspaceRef.current = {
    mapData,
    heightRange,
    waypoints,
    edges,
    mode,
    connectionSourceId,
    selectedWaypointId,
    selectedEdgeId,
    validation,
    pointColorMode,
    showWaypoints3D,
    collapsedPanel,
  };

  useEffect(() => {
    const geometry = mapData?.geometry;
    return () => geometry?.dispose?.();
  }, [mapData?.geometry]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
    },
    [],
  );

  const notify = useCallback((message, kind = 'success') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, kind });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const reportSessionFailure = useCallback(
    (error) => {
      console.warn('工作会话自动保护失败', error);
      sessionReadyRef.current = false;
      setSessionState({ status: 'error', restored: false });
      if (!sessionFailureNotifiedRef.current) {
        sessionFailureNotifiedRef.current = true;
        notify('自动保护暂不可用，请及时导出 JSON 备份', 'warning');
      }
    },
    [notify],
  );

  const persistWorkspaceNow = useCallback(() => {
    const sessionId = sessionIdRef.current;
    const current = latestWorkspaceRef.current;
    if (!sessionReadyRef.current || !sessionId || !current) return Promise.resolve();

    const mapId = current.mapData?.mapId || null;
    saveWorkspaceViews(sessionId, mapId, {
      view2d: view2dRef.current,
      view3d: view3dRef.current,
    });

    const project = current.mapData
      ? buildExport({
          mapData: current.mapData,
          heightRange: current.heightRange,
          waypoints: current.waypoints,
          edges: current.edges,
          view2d: view2dRef.current,
          view3d: view3dRef.current,
        })
      : null;
    const snapshot = {
      schemaVersion: 1,
      project,
      ui: {
        mode: current.mode,
        connectionSourceId: current.connectionSourceId,
        selectedWaypointId: current.selectedWaypointId,
        selectedEdgeId: current.selectedEdgeId,
        validation: current.validation,
        pointColorMode: current.pointColorMode,
        showWaypoints3D: current.showWaypoints3D,
        collapsedPanel: current.collapsedPanel,
      },
    };
    sessionWriteChainRef.current = sessionWriteChainRef.current
      .catch(() => undefined)
      .then(() => saveWorkspaceConfig(sessionId, mapId, snapshot))
      .catch(reportSessionFailure);
    return sessionWriteChainRef.current;
  }, [reportSessionFailure]);

  const queueWorkspaceSave = useCallback(() => {
    if (!sessionReadyRef.current) return;
    if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      persistWorkspaceNow();
    }, 180);
  }, [persistWorkspaceNow]);

  const invalidateConnectivity = useCallback(() => {
    setValidation(initialValidation);
    setEdges((current) => current.map((edge) => ({ ...edge, status: 'unchecked' })));
  }, []);

  const installMapGeometry = useCallback(
    async (geometry, name, options = {}) => {
      const {
        preserveGraph = false,
        preferredSlice = null,
        preferredView = null,
        preferredView3d = null,
        persistSnapshot = true,
        announce = true,
        keepLoading = false,
        mapId = createId('map'),
        sourceByteLength = 0,
        geometrySource = 'ply-parse',
      } = options;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const positions = geometry.getAttribute('position')?.array;
      if (!positions?.length || !geometry.boundingBox) {
        throw new Error('PLY 文件中没有可用的顶点坐标');
      }

      geometry.userData.geometrySource = geometrySource;
      const colors = geometry.getAttribute('color')?.array || null;
      const bounds = serializeBounds(geometry.boundingBox);
      const nextSlice = clampSlice(preferredSlice || suggestedSlice(positions, bounds), bounds);
      const nextMap = {
        mapId,
        name,
        pointCount: positions.length / 3,
        bounds,
        positions,
        colors,
        geometry,
        geometrySource,
        metadataOnly: false,
      };
      setMapData(nextMap);
      setHeightRange(nextSlice);
      setRestoredView2d(preferredView);
      view2dRef.current = preferredView;
      setRestoredView3d(preferredView3d);
      view3dRef.current = preferredView3d;
      setProjectionStats({ selectedCount: 0 });
      setSynchronizedFocus(null);
      if (!preserveGraph) {
        setWaypoints([]);
        setEdges([]);
        setSelectedWaypointId(null);
        setSelectedEdgeId(null);
        setConnectionSourceId(null);
        setValidation(initialValidation);
      }

      if (persistSnapshot && sessionReadyRef.current && sessionIdRef.current) {
        setLoadState({
          loading: true,
          progress: 1,
          phase: '缓存已解析点云',
          detail: '正在保存坐标缓存，后续刷新无需再次解析 PLY',
        });
        try {
          await saveWorkspaceMap(
            sessionIdRef.current,
            mapId,
            name,
            createGeometryCache(geometry, bounds, sourceByteLength),
          );
        } catch (error) {
          reportSessionFailure(error);
        }
      }

      if (!keepLoading) setLoadState({ loading: false, progress: 1, phase: '' });
      if (announce) {
        notify(`${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点`);
      }
      return nextMap;
    },
    [notify, reportSessionFailure],
  );

  const processMapBuffer = useCallback(
    async (buffer, name, options = {}) => {
      setLoadState({
        loading: true,
        progress: 1,
        phase: '解析点云结构',
        detail: '首次载入正在构建三维几何与空间索引',
      });
      await waitForPaint();
      let geometry;
      try {
        const loader = new PLYLoader();
        geometry = loader.parse(buffer);
        return await installMapGeometry(geometry, name, {
          ...options,
          sourceByteLength: buffer.byteLength,
          geometrySource: options.geometrySource || 'ply-parse',
        });
      } catch (error) {
        geometry?.dispose?.();
        setLoadState({ loading: false, progress: 0, phase: '' });
        throw error;
      }
    },
    [installMapGeometry],
  );

  const processMapCache = useCallback(
    async (record, options = {}) => {
      setLoadState({
        loading: true,
        progress: 1,
        phase: '恢复点云缓存',
        detail: '正在直接装载已解析坐标，跳过 PLY 解析',
      });
      await waitForPaint();
      let geometry;
      try {
        geometry = restoreGeometryFromCache(record);
        return await installMapGeometry(geometry, record.name, {
          ...options,
          persistSnapshot: false,
          sourceByteLength: record.byteLength,
          geometrySource: 'session-cache',
          mapId: record.mapId,
        });
      } catch (error) {
        geometry?.dispose?.();
        setLoadState({ loading: false, progress: 0, phase: '' });
        throw error;
      }
    },
    [installMapGeometry],
  );

  useEffect(() => {
    const revision = ++hydrationRevisionRef.current;
    const isCurrent = () => hydrationRevisionRef.current === revision;

    const restoreWorkspace = async () => {
      try {
        const identity = await fetchServiceSession();
        if (!isCurrent()) return;
        sessionIdRef.current = identity.sessionId;

        const stored = await prepareWorkspaceSession(identity.sessionId);
        if (!isCurrent()) return;

        let restored = false;
        let repaired = false;
        try {
          const configMatchesMap =
            !stored.map || (stored.config && stored.config.mapId === stored.map.mapId);
          const snapshot = configMatchesMap ? stored.config?.config : null;
          const project = snapshot?.project ? normalizeProject(snapshot.project) : null;
          const restoredMapId = stored.map?.mapId || stored.config?.mapId || null;
          const instantViews = loadWorkspaceViews(identity.sessionId, restoredMapId);
          const preferredView2d = instantViews?.view2d ?? project?.view2d ?? null;
          const preferredView3d = instantViews?.view3d ?? project?.view3d ?? null;
          setCollapsedPanel(
            snapshot?.ui?.collapsedPanel === '3d' || snapshot?.ui?.collapsedPanel === '2d'
              ? snapshot.ui.collapsedPanel
              : null,
          );
          setShowWaypoints3D(snapshot?.ui?.showWaypoints3D !== false);

          if (
            stored.map?.geometryCacheVersion === GEOMETRY_CACHE_VERSION
            && stored.map.positionBuffer instanceof ArrayBuffer
          ) {
            await processMapCache(stored.map, {
              preserveGraph: true,
              preferredSlice: project?.slice,
              preferredView: preferredView2d,
              preferredView3d,
              announce: false,
              keepLoading: true,
            });
            if (!isCurrent()) return;
            restored = true;
          } else if (stored.map?.blob) {
            setLoadState({
              loading: true,
              progress: 0.3,
              phase: '恢复上次地图',
              detail: `${stored.map.name} · ${Number(stored.map.byteLength || 0).toLocaleString('zh-CN')} bytes`,
            });
            const buffer = await stored.map.blob.arrayBuffer();
            if (!isCurrent()) return;
            const restoredMap = await processMapBuffer(buffer, stored.map.name, {
              preserveGraph: true,
              preferredSlice: project?.slice,
              preferredView: preferredView2d,
              preferredView3d,
              persistSnapshot: false,
              announce: false,
              keepLoading: true,
              mapId: stored.map.mapId,
              geometrySource: 'legacy-ply-cache',
            });
            if (!isCurrent()) return;
            setLoadState({
              loading: true,
              progress: 1,
              phase: '升级点云缓存',
              detail: '旧版快照仅需此次解析，正在转换为已解析坐标缓存',
            });
            await saveWorkspaceMap(
              identity.sessionId,
              stored.map.mapId,
              stored.map.name,
              createGeometryCache(restoredMap.geometry, restoredMap.bounds, buffer.byteLength),
            );
            if (!isCurrent()) return;
            restored = true;
          } else if (project?.map?.bounds) {
            const bounds = project.map.bounds;
            setMapData({
              mapId: stored.config?.mapId || createId('map-meta'),
              name: project.map.fileName || '未绑定地图',
              pointCount: Number(project.map.pointCount) || 0,
              bounds,
              positions: null,
              colors: null,
              geometry: null,
              metadataOnly: true,
            });
            setHeightRange(project.slice || [bounds.min.z, bounds.max.z]);
            setRestoredView2d(preferredView2d);
            view2dRef.current = preferredView2d;
            setRestoredView3d(preferredView3d);
            view3dRef.current = preferredView3d;
            restored = true;
          }

          if (project) {
            const pointIds = new Set(project.waypoints.map((point) => point.id));
            const edgeIds = new Set(project.edges.map((edge) => edge.id));
            const checked = project.edges.some((edge) => edge.status !== 'unchecked');
            const connected = project.edges.length > 0
              && project.edges.every((edge) => edge.status === 'connected');
            const savedValidation = snapshot?.ui?.validation;

            setWaypoints(project.waypoints);
            setEdges(project.edges);
            if (!stored.map && project.slice) setHeightRange(project.slice);
            setRestoredView2d(preferredView2d);
            view2dRef.current = preferredView2d;
            setRestoredView3d(preferredView3d);
            view3dRef.current = preferredView3d;
            setMode(['select', 'box', 'add', 'connect'].includes(snapshot?.ui?.mode) ? snapshot.ui.mode : 'select');
            setConnectionSourceId(
              pointIds.has(snapshot?.ui?.connectionSourceId)
                ? snapshot.ui.connectionSourceId
                : null,
            );
            setSelectedWaypointId(
              pointIds.has(snapshot?.ui?.selectedWaypointId)
                ? snapshot.ui.selectedWaypointId
                : null,
            );
            setSelectedEdgeId(
              edgeIds.has(snapshot?.ui?.selectedEdgeId) ? snapshot.ui.selectedEdgeId : null,
            );
            setPointColorMode(
              pointColorModes.has(snapshot?.ui?.pointColorMode)
                ? snapshot.ui.pointColorMode
                : 'height',
            );
            setValidation(
              savedValidation && ['idle', 'connected', 'partial'].includes(savedValidation.status)
                ? savedValidation
                : {
                    status: checked ? (connected ? 'connected' : 'partial') : 'idle',
                    unreachableCount: project.edges.filter(
                      (edge) => edge.status === 'unreachable',
                    ).length,
                    checkedAt: null,
                  },
            );
            restored = restored || project.waypoints.length > 0 || project.edges.length > 0;
          }
        } catch (error) {
          console.warn('已忽略损坏的工作区快照', error);
          await resetWorkspaceSession(identity.sessionId);
          if (!isCurrent()) return;
          setMapData(null);
          setWaypoints([]);
          setEdges([]);
          setHeightRange([0, 1]);
          setPointColorMode('height');
          setShowWaypoints3D(true);
          setCollapsedPanel(null);
          setRestoredView2d(null);
          view2dRef.current = null;
          setRestoredView3d(null);
          view3dRef.current = null;
          repaired = true;
        }

        sessionReadyRef.current = true;
        sessionFailureNotifiedRef.current = false;
        setSessionState({ status: 'ready', restored });
        setLoadState({ loading: false, progress: 1, phase: '' });

        if (stored.restarted) {
          notify('服务已重启，已建立全新工作会话', 'info');
        } else if (repaired) {
          notify('上次快照无法读取，已安全重置', 'warning');
        } else if (restored) {
          notify('已恢复上次工作现场', 'success');
        }
      } catch (error) {
        if (!isCurrent()) return;
        setLoadState({ loading: false, progress: 0, phase: '' });
        reportSessionFailure(error);
      }
    };

    restoreWorkspace();
    return () => {
      if (hydrationRevisionRef.current === revision) hydrationRevisionRef.current += 1;
    };
  }, [notify, processMapBuffer, processMapCache, reportSessionFailure]);

  useEffect(() => {
    queueWorkspaceSave();
  }, [
    collapsedPanel,
    connectionSourceId,
    edges,
    heightRange,
    mapData?.mapId,
    mode,
    pointColorMode,
    queueWorkspaceSave,
    selectedEdgeId,
    selectedWaypointId,
    sessionState.status,
    showWaypoints3D,
    validation,
    waypoints,
  ]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') persistWorkspaceNow();
    };
    window.addEventListener('pagehide', persistWorkspaceNow);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', persistWorkspaceNow);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  }, [persistWorkspaceNow]);

  useEffect(() => {
    if (sessionState.status !== 'ready') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const identity = await fetchServiceSession();
        if (identity.sessionId !== sessionIdRef.current) window.location.reload();
      } catch {
        // A stopped service is expected; reset only after a new instance responds.
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [sessionState.status]);

  const loadExample = useCallback(
    async (options = {}) => {
      if (!options.preserveGraph && waypoints.length && !window.confirm('加载新地图会清空当前导航点和路径，继续吗？')) return;
      setLoadState({ loading: true, progress: 0, phase: '读取示例地图' });
      try {
        const buffer = await fetchBufferWithProgress('/xian_map.ply', (progress) =>
          setLoadState({ loading: true, progress, phase: '读取示例地图' }),
        );
        await processMapBuffer(buffer, 'xian_map.ply', options);
      } catch (error) {
        setLoadState({ loading: false, progress: 0, phase: '' });
        notify(error.message || '示例地图加载失败', 'error');
      }
    },
    [notify, processMapBuffer, waypoints.length],
  );

  const handleMapFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (waypoints.length && !window.confirm('加载新地图会清空当前导航点和路径，继续吗？')) return;
    if (!file.name.toLowerCase().endsWith('.ply')) {
      notify('请选择 .ply 点云地图文件', 'error');
      return;
    }
    setLoadState({ loading: true, progress: 0, phase: '读取本地地图' });
    try {
      const buffer = await readFileWithProgress(file, (progress) =>
        setLoadState({ loading: true, progress, phase: '读取本地地图' }),
      );
      await processMapBuffer(buffer, file.name);
    } catch (error) {
      setLoadState({ loading: false, progress: 0, phase: '' });
      notify(error.message || '地图加载失败', 'error');
    }
  };

  const handlePathFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const project = normalizeProject(payload);
      setWaypoints(project.waypoints);
      setEdges(project.edges);
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setConnectionSourceId(null);
      setMode('select');
      setSynchronizedFocus(null);
      setRestoredView2d(project.view2d);
      view2dRef.current = project.view2d;
      setRestoredView3d(project.view3d);
      view3dRef.current = project.view3d;
      const importedConnected = project.edges.length > 0 && project.edges.every((edge) => edge.status === 'connected');
      const importedChecked = project.edges.some((edge) => edge.status !== 'unchecked');
      setValidation(
        importedChecked
          ? {
              status: importedConnected ? 'connected' : 'partial',
              unreachableCount: project.edges.filter((edge) => edge.status === 'unreachable').length,
              checkedAt: null,
            }
          : initialValidation,
      );

      if (project.slice) setHeightRange(project.slice);
      if (!mapData && project.map?.bounds) {
        setMapData({
          mapId: createId('map-meta'),
          name: project.map.fileName || '未绑定地图',
          pointCount: Number(project.map.pointCount) || 0,
          bounds: project.map.bounds,
          positions: null,
          colors: null,
          geometry: null,
          metadataOnly: true,
        });
      }
      notify(`路径配置已加载 · ${project.waypoints.length} 点 / ${project.edges.length} 边`);

      const referencedMap = project.map?.fileName;
      if ((!mapData || mapData.metadataOnly) && referencedMap === 'xian_map.ply') {
        await loadExample({
          preserveGraph: true,
          preferredSlice: project.slice,
          preferredView: project.view2d,
          preferredView3d: project.view3d,
        });
      } else if (project.slice && mapData?.bounds) {
        setHeightRange(clampSlice(project.slice, mapData.bounds));
      }
    } catch (error) {
      notify(`路径文件无效：${error.message}`, 'error');
    }
  };

  const setActiveMode = (nextMode) => {
    setMode(nextMode);
    setConnectionSourceId(null);
    if (nextMode === 'box') notify('框选模式：在二维图空白处按住左键拖框', 'info');
    if (nextMode === 'add') notify('添加模式：在二维截面上点击放置导航点', 'info');
    if (nextMode === 'connect') notify('连接模式：先选择起点，再选择终点', 'info');
  };

  const toggleCollapsedPanel = (panel) => {
    setCollapsedPanel((current) => (current === panel ? null : panel));
  };

  const addWaypoint = useCallback(
    (pose) => {
      const point = {
        id: createId('wp'),
        name: `P${String(waypoints.length + 1).padStart(2, '0')}`,
        pose: { ...pose, roll: 0, pitch: 0, yaw: 0 },
        source: 'point-cloud-slice',
      };
      setWaypoints((current) => [...current, point]);
      setSelectedWaypointId(point.id);
      setSelectedEdgeId(null);
      invalidateConnectivity();
      notify(`${point.name} 已绑定原始三维坐标`, 'success');
    },
    [invalidateConnectivity, notify, waypoints.length],
  );

  const selectWaypoint = useCallback((id) => {
    setSelectedWaypointId(id);
    setSelectedEdgeId(null);
  }, []);

  const requestSynchronizedFocus = useCallback((type, id) => {
    focusRevisionRef.current += 1;
    setSynchronizedFocus({ type, id, revision: focusRevisionRef.current });
  }, []);

  const focusWaypointFromInspector = useCallback(
    (id) => {
      setShowWaypoints3D(true);
      selectWaypoint(id);
      requestSynchronizedFocus('waypoint', id);
    },
    [requestSynchronizedFocus, selectWaypoint],
  );

  const selectEdge = useCallback((id) => {
    setSelectedEdgeId(id);
    setSelectedWaypointId(null);
  }, []);

  const focusEdgeFromInspector = useCallback(
    (id) => {
      selectEdge(id);
      requestSynchronizedFocus('edge', id);
    },
    [requestSynchronizedFocus, selectEdge],
  );

  const clearSelection = useCallback(() => {
    setSelectedWaypointId(null);
    setSelectedEdgeId(null);
  }, []);

  const connectTarget = useCallback(
    (id) => {
      if (!connectionSourceId) {
        setConnectionSourceId(id);
        setSelectedWaypointId(id);
        setSelectedEdgeId(null);
        notify('起点已锁定，请选择终点', 'info');
        return;
      }
      if (connectionSourceId === id) {
        setConnectionSourceId(null);
        notify('已取消起点选择', 'info');
        return;
      }
      const existing = edges.find((edge) => edge.from === connectionSourceId && edge.to === id);
      if (existing) {
        setSelectedEdgeId(existing.id);
        setSelectedWaypointId(null);
        setConnectionSourceId(null);
        notify('该方向路径已存在，已打开配置', 'info');
        return;
      }
      const edge = {
        id: createId('edge'),
        from: connectionSourceId,
        to: id,
        directed: true,
        limits: { ...defaultLimits },
        motion: { ...defaultMotion },
        status: 'unchecked',
      };
      setEdges((current) => [
        ...current.map((item) => ({ ...item, status: 'unchecked' })),
        edge,
      ]);
      setValidation(initialValidation);
      setConnectionSourceId(null);
      setSelectedWaypointId(null);
      setSelectedEdgeId(edge.id);
      notify('有向路径已创建，请配置运动约束');
    },
    [connectionSourceId, edges, notify],
  );

  const updateWaypoint = useCallback((id, patch) => {
    setWaypoints((current) =>
      current.map((point) => (point.id === id ? { ...point, ...patch } : point)),
    );
  }, []);

  const updateEdge = useCallback((id, patch) => {
    setEdges((current) =>
      current.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)),
    );
  }, []);

  const deleteMapSelection = useCallback(
    ({ waypointIds = [], edgeIds = [] }) => {
      const waypointIdSet = new Set(waypointIds);
      const edgeIdSet = new Set(edgeIds);
      const removedWaypointCount = waypoints.reduce(
        (count, point) => count + (waypointIdSet.has(point.id) ? 1 : 0),
        0,
      );
      const removedEdgeCount = edges.reduce(
        (count, edge) =>
          count
          + (
            edgeIdSet.has(edge.id)
            || waypointIdSet.has(edge.from)
            || waypointIdSet.has(edge.to)
              ? 1
              : 0
          ),
        0,
      );
      if (!removedWaypointCount && !removedEdgeCount) return;

      setWaypoints((current) =>
        current.filter((point) => !waypointIdSet.has(point.id)),
      );
      setEdges((current) =>
        current
          .filter(
            (edge) =>
              !edgeIdSet.has(edge.id)
              && !waypointIdSet.has(edge.from)
              && !waypointIdSet.has(edge.to),
          )
          .map((edge) => ({ ...edge, status: 'unchecked' })),
      );
      setConnectionSourceId((current) =>
        current && waypointIdSet.has(current) ? null : current,
      );
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setSynchronizedFocus(null);
      setValidation(initialValidation);

      const removed = [];
      if (removedWaypointCount) removed.push(`${removedWaypointCount} 个导航点`);
      if (removedEdgeCount) removed.push(`${removedEdgeCount} 条路径`);
      notify(`已删除 ${removed.join('和')}`, 'info');
    },
    [edges, notify, waypoints],
  );

  const deleteWaypoint = useCallback(
    (id) => {
      setWaypoints((current) => current.filter((point) => point.id !== id));
      setEdges((current) =>
        current
          .filter((edge) => edge.from !== id && edge.to !== id)
          .map((edge) => ({ ...edge, status: 'unchecked' })),
      );
      setSelectedWaypointId(null);
      setConnectionSourceId(null);
      setValidation(initialValidation);
      notify('导航点及关联路径已删除', 'info');
    },
    [notify],
  );

  const deleteEdge = useCallback(
    (id) => {
      setEdges((current) => current.filter((edge) => edge.id !== id).map((edge) => ({ ...edge, status: 'unchecked' })));
      setSelectedEdgeId(null);
      setValidation(initialValidation);
      notify('路径已删除', 'info');
    },
    [notify],
  );

  const runConnectivity = useCallback(() => {
    const result = inspectConnectivity(waypoints, edges);
    const unreachableCount = edges.reduce(
      (count, edge) => count + (result.edgeStatus.get(edge.id) === 'unreachable' ? 1 : 0),
      0,
    );
    setEdges((current) =>
      current.map((edge) => ({
        ...edge,
        status: result.edgeStatus.get(edge.id) || 'unreachable',
      })),
    );
    setValidation({
      status: result.stronglyConnected ? 'connected' : 'partial',
      unreachableCount,
      checkedAt: new Date().toISOString(),
    });
    notify(
      result.stronglyConnected ? '检测完成：有向图已强连通' : '检测完成：黄色路径尚未形成双向可达',
      result.stronglyConnected ? 'success' : 'warning',
    );
  }, [edges, notify, waypoints]);

  const exportProject = () => {
    if (!mapData) {
      notify('请先加载地图或路径配置', 'error');
      return;
    }
    const invalid = edges.find(
      (edge) =>
        edge.limits.minSpeed > edge.limits.maxSpeed ||
        edge.limits.minAcceleration > edge.limits.maxAcceleration,
    );
    if (invalid) {
      selectEdge(invalid.id);
      notify('存在无效的路径约束，请修正后再导出', 'error');
      return;
    }
    const payload = buildExport({
      mapData,
      heightRange,
      waypoints,
      edges,
      view2d: view2dRef.current,
      view3d: view3dRef.current,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(payload, `route-graph-${stamp}.json`);
    notify('JSON 路径工程已导出');
  };

  const handleProjectionStats = useCallback((stats) => setProjectionStats(stats), []);
  const handleViewChange = useCallback(
    (nextView) => {
      view2dRef.current = nextView;
      queueWorkspaceSave();
    },
    [queueWorkspaceSave],
  );
  const handleView3dChange = useCallback(
    (nextView) => {
      view3dRef.current = nextView;
      queueWorkspaceSave();
    },
    [queueWorkspaceSave],
  );

  const resetAllViews = useCallback(() => {
    if (!mapData?.bounds) {
      notify('请先加载地图', 'warning');
      return;
    }
    setSynchronizedFocus(null);
    viewResetRevisionRef.current += 1;
    setViewResetRequest({ revision: viewResetRevisionRef.current });
    notify('2D 与 3D 视角已重置', 'info');
  }, [mapData?.bounds, notify]);

  const modeOptions = [
    { id: 'select', label: '选择 / 漫游', icon: MousePointer2 },
    { id: 'box', label: '框选', icon: ScanLine },
    { id: 'add', label: '添加导航点', icon: Plus },
    { id: 'connect', label: '连接路径', icon: GitBranch },
  ];

  const progressLabel = loadState.progress < 1
    ? `${Math.round(loadState.progress * 100)}%`
    : 'PROCESS';

  return (
    <div className="app-shell">
      <input ref={mapInputRef} className="visually-hidden" type="file" accept=".ply" onChange={handleMapFile} />
      <input ref={pathInputRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={handlePathFile} />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Route size={20} strokeWidth={1.8} /></div>
          <div>
            <span>ATLAS / ROUTE</span>
            <strong>路径图谱工坊</strong>
          </div>
        </div>

        <div className="map-identity">
          <span className={`map-state-dot ${mapData?.geometry ? 'online' : ''}`} />
          <div>
            <small>ACTIVE MAP</small>
            <strong>{mapData?.name || 'NO MAP LOADED'}</strong>
          </div>
          {mapData?.pointCount > 0 && <em>{(mapData.pointCount / 1_000_000).toFixed(2)}M PTS</em>}
        </div>

        <div className="topbar-actions">
          <button type="button" className="action-button subtle" onClick={() => loadExample()}>
            <Box size={15} /> 示例地图
          </button>
          <button type="button" className="action-button" onClick={() => mapInputRef.current?.click()}>
            <Upload size={15} /> 加载地图
          </button>
          <button type="button" className="action-button" onClick={() => pathInputRef.current?.click()}>
            <FileJson size={15} /> 加载路径
          </button>
          <button
            type="button"
            className="action-button view-reset-action"
            onClick={resetAllViews}
            disabled={!mapData?.bounds}
            aria-label="重置全部视角"
            title="同时恢复 3D 与 2D 地图的初始视角"
          >
            <RotateCcw size={15} /> 重置视角
          </button>
          <button type="button" className="action-button primary" onClick={exportProject}>
            <Download size={15} /> 导出 JSON
          </button>
          <div className="service-pill" title="本地服务默认端口">
            <Server size={13} />
            <span>LOCAL</span>
            <strong>:21990</strong>
          </div>
        </div>
      </header>

      <main className="workspace">
        <div
          className={`visual-workspace ${collapsedPanel ? `is-${collapsedPanel}-collapsed` : ''}`}
          data-collapsed-panel={collapsedPanel || 'none'}
        >
          <section
            className={`viewport-panel panel-3d ${collapsedPanel === '3d' ? 'is-collapsed' : ''}`}
            data-collapsed={collapsedPanel === '3d' ? 'true' : 'false'}
          >
            <div className="panel-heading">
              <div className="panel-heading__title">
                <span className="panel-index">01</span>
                <div><small>SPATIAL SOURCE</small><strong>三维点云</strong></div>
              </div>
              <div className="panel-stats">
                <span><i className="axis x">X</i>{mapData ? `${mapData.bounds.min.x.toFixed(1)} / ${mapData.bounds.max.x.toFixed(1)}` : '—'}</span>
                <span><i className="axis y">Y</i>{mapData ? `${mapData.bounds.min.y.toFixed(1)} / ${mapData.bounds.max.y.toFixed(1)}` : '—'}</span>
                <span><i className="axis z">Z</i>{mapData ? `${mapData.bounds.min.z.toFixed(1)} / ${mapData.bounds.max.z.toFixed(1)}` : '—'}</span>
              </div>
              <button
                type="button"
                className="panel-collapse-button"
                aria-label={collapsedPanel === '3d' ? '展开3D窗口' : '折叠3D窗口'}
                aria-expanded={collapsedPanel !== '3d'}
                aria-controls="panel-body-3d"
                onClick={() => toggleCollapsedPanel('3d')}
              >
                {collapsedPanel === '3d' ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                <span>{collapsedPanel === '3d' ? '展开' : '折叠'}</span>
              </button>
            </div>
            <div
              id="panel-body-3d"
              className="panel-body"
              aria-hidden={collapsedPanel === '3d'}
            >
              <PointCloudViewer
                mapData={mapData}
                heightRange={heightRange}
                waypoints={waypoints}
                edges={edges}
                selectedWaypointId={selectedWaypointId}
                selectedEdgeId={selectedEdgeId}
                colorMode={pointColorMode}
                onColorModeChange={setPointColorMode}
                showWaypoints={showWaypoints3D}
                onShowWaypointsChange={setShowWaypoints3D}
                onSelectWaypoint={selectWaypoint}
                onSelectEdge={selectEdge}
                onClearSelection={clearSelection}
                focusRequest={synchronizedFocus}
                initialView={restoredView3d}
                onViewChange={handleView3dChange}
                resetRequest={viewResetRequest}
              />
              <HeightRange
                bounds={mapData?.bounds}
                value={heightRange}
                onChange={setHeightRange}
                disabled={!mapData?.geometry}
              />
              {!mapData && (
                <button type="button" className="placeholder-load" onClick={() => mapInputRef.current?.click()}>
                  <FolderOpen size={15} /> 选择 PLY 地图
                </button>
              )}
            </div>
          </section>

          <section
            className={`viewport-panel panel-2d ${collapsedPanel === '2d' ? 'is-collapsed' : ''}`}
            data-collapsed={collapsedPanel === '2d' ? 'true' : 'false'}
          >
            <div className="panel-heading map-heading">
              <div className="panel-heading__title">
                <span className="panel-index">02</span>
                <div><small>LIVE VECTOR SLICE</small><strong>二维路径图</strong></div>
              </div>
              <div className="mode-switcher" role="toolbar" aria-label="二维地图工具">
                {modeOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={mode === option.id ? 'is-active' : ''}
                      onClick={() => setActiveMode(option.id)}
                      disabled={!mapData?.bounds}
                    >
                      <Icon size={14} /> {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="slice-badge">
                <Layers2 size={13} />
                <span>Z {heightRange[0].toFixed(2)} — {heightRange[1].toFixed(2)} m</span>
                <strong>{projectionStats.selectedCount.toLocaleString('zh-CN')}</strong>
              </div>
              <button
                type="button"
                className="panel-collapse-button"
                aria-label={collapsedPanel === '2d' ? '展开2D窗口' : '折叠2D窗口'}
                aria-expanded={collapsedPanel !== '2d'}
                aria-controls="panel-body-2d"
                onClick={() => toggleCollapsedPanel('2d')}
              >
                {collapsedPanel === '2d' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <span>{collapsedPanel === '2d' ? '展开' : '折叠'}</span>
              </button>
            </div>
            <div
              id="panel-body-2d"
              className="panel-body"
              aria-hidden={collapsedPanel === '2d'}
            >
              <Map2DView
                mapData={mapData}
                initialView={restoredView2d}
                heightRange={heightRange}
                waypoints={waypoints}
                edges={edges}
                mode={mode}
                connectionSourceId={connectionSourceId}
                selectedWaypointId={selectedWaypointId}
                selectedEdgeId={selectedEdgeId}
                colorMode={pointColorMode}
                onAddWaypoint={addWaypoint}
                onSelectWaypoint={selectWaypoint}
                onSelectEdge={selectEdge}
                onConnectTarget={connectTarget}
                onClearSelection={clearSelection}
                onDeleteSelection={deleteMapSelection}
                onProjectionStats={handleProjectionStats}
                onViewChange={handleViewChange}
                focusRequest={synchronizedFocus}
                resetRequest={viewResetRequest}
              />
            </div>
          </section>
        </div>

        <Inspector
          mapData={mapData}
          heightRange={heightRange}
          waypoints={waypoints}
          edges={edges}
          selectedWaypointId={selectedWaypointId}
          selectedEdgeId={selectedEdgeId}
          validation={validation}
          onRunConnectivity={runConnectivity}
          onSelectWaypoint={focusWaypointFromInspector}
          onSearchWaypoint={focusWaypointFromInspector}
          onSelectEdge={focusEdgeFromInspector}
          onClearSelection={clearSelection}
          onUpdateWaypoint={updateWaypoint}
          onUpdateEdge={updateEdge}
          onDeleteWaypoint={deleteWaypoint}
          onDeleteEdge={deleteEdge}
        />
      </main>

      <footer className="statusbar">
        <span><CircleDot size={10} /> FRAME / XY + Z-UP</span>
        <span><Zap size={10} /> GPU POINT RENDER</span>
        <span
          className={`session-guard is-${sessionState.status}`}
          data-session-state={sessionState.status}
          data-session-restored={sessionState.restored ? 'true' : 'false'}
          title={
            sessionState.status === 'error'
              ? '自动保护不可用，请手动导出 JSON'
              : '刷新页面可恢复当前工作现场，服务重启后重置'
          }
        >
          {sessionState.status === 'error' ? <ShieldAlert size={10} /> : <ShieldCheck size={10} />}
          {sessionState.status === 'checking'
            ? 'SESSION CHECK'
            : sessionState.status === 'error'
              ? 'SESSION UNPROTECTED'
              : 'SESSION AUTO-SAVE'}
        </span>
        <span className="statusbar__hint">
          {mode === 'connect' && connectionSourceId ? '起点已锁定 · 请选择终点' : mode === 'add' ? '点击二维截面添加导航点' : mode === 'box' ? '二维图左键拉框 · Delete 删除所选' : '拖动二维地图平移 · 滚轮缩放'}
        </span>
        <span>SCHEMA 1.0</span>
      </footer>

      {loadState.loading && (
        <div className="loading-curtain" role="status" aria-live="polite">
          <div className="loading-module">
            <div className="loading-module__top"><MapIcon size={18} /><span>{loadState.phase}</span><strong>{progressLabel}</strong></div>
            <div className="loading-track"><span style={{ width: `${Math.max(loadState.progress * 100, 4)}%` }} /></div>
            <small>{loadState.detail || '大型点云解析可能需要数秒，请保持页面开启'}</small>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast-message ${toast.kind}`} role="status">
          <span>{toast.kind === 'error' ? <X size={14} /> : <Check size={14} />}</span>
          {toast.message}
        </div>
      )}
    </div>
  );
}
