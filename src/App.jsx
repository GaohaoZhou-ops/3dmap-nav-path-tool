import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
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
import RobotPicker from './components/RobotPicker.jsx';
import SpaceMouseControl from './components/SpaceMouseControl.jsx';
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
  normalizeRobotDescriptor,
  normalizeRobotJointValues,
  normalizeRobotPose,
} from './lib/robotLoader.js';
import { normalizeRobotJointLocks } from './lib/robotJointLocks.js';
import { createRobotCollisionStatus } from './lib/robotCollision.js';
import { sha256ArrayBuffer } from './lib/hash.js';
import {
  normalizeMeshRenderQuality,
  prepareMapGeometryTopology,
} from './lib/mapGeometry.js';
import { createSpaceMouseInputState } from './lib/spaceMouse.js';
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

const clampJointValue = (rawValue, definition) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 0;
  const lower = definition?.lower === null || definition?.lower === undefined
    ? Number.NaN
    : Number(definition.lower);
  const upper = definition?.upper === null || definition?.upper === undefined
    ? Number.NaN
    : Number(definition.upper);
  return Math.max(
    Number.isFinite(lower) ? lower : Number.NEGATIVE_INFINITY,
    Math.min(Number.isFinite(upper) ? upper : Number.POSITIVE_INFINITY, parsed),
  );
};

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
  if (
    attribute.array instanceof Uint8Array
    && attribute.itemSize === 3
    && attribute.normalized
  ) {
    return attribute.array;
  }
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

function createGeometryCache(
  geometry,
  bounds,
  sourceByteLength,
  sourceHash = null,
  sourceHashKind = 'file',
) {
  const positionAttribute = geometry.getAttribute('position');
  const sourcePositions = positionAttribute?.array;
  if (!sourcePositions?.length) throw new Error('无法缓存空点云');
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : Float32Array.from(sourcePositions);
  const colors = packColorAttribute(geometry.getAttribute('color'));
  const sourceIndex = geometry.getIndex()?.array || null;
  const meshIndices = sourceIndex instanceof Uint16Array || sourceIndex instanceof Uint32Array
    ? sourceIndex
    : sourceIndex?.length ? Uint32Array.from(sourceIndex) : null;
  const sphere = geometry.boundingSphere;
  return {
    geometryCacheVersion: GEOMETRY_CACHE_VERSION,
    byteLength: Number(sourceByteLength) || positions.byteLength + (colors?.byteLength || 0),
    pointCount: positionAttribute.count,
    positionBuffer: exactArrayBuffer(positions),
    colorBuffer: colors ? exactArrayBuffer(colors) : null,
    indexBuffer: meshIndices ? exactArrayBuffer(meshIndices) : null,
    indexComponentType: meshIndices instanceof Uint16Array ? 'uint16' : 'uint32',
    faceCount: meshIndices ? Math.floor(meshIndices.length / 3) : 0,
    bounds,
    sphere: sphere ? serializeSphere(sphere) : null,
    sourceHash,
    sourceHashKind,
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
  if (record.indexBuffer instanceof ArrayBuffer) {
    const indices = record.indexComponentType === 'uint16'
      ? new Uint16Array(record.indexBuffer)
      : new Uint32Array(record.indexBuffer);
    if (indices.length >= 3) {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
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
  const robotNotificationRef = useRef('');
  const cameraTeachingRevisionRef = useRef(0);
  const zividCaptureProviderRef = useRef(null);
  const teachingCaptureBusyRef = useRef(false);
  const spaceMouseInputRef = useRef(createSpaceMouseInputState());
  const main3DCanvasRef = useRef(null);
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
  const [meshRenderQuality, setMeshRenderQuality] = useState('auto');
  const [showWaypoints3D, setShowWaypoints3D] = useState(true);
  const [collapsedPanel, setCollapsedPanel] = useState(null);
  const [synchronizedFocus, setSynchronizedFocus] = useState(null);
  const [viewResetRequest, setViewResetRequest] = useState(null);
  const [selectedRobot, setSelectedRobot] = useState(null);
  const [robotLoadState, setRobotLoadState] = useState({ status: 'idle' });
  const [robotPose, setRobotPose] = useState(() => normalizeRobotPose(null));
  const [robotJointValues, setRobotJointValues] = useState({});
  const [lockedRobotJointNames, setLockedRobotJointNames] = useState([]);
  const [robotControlEnabled, setRobotControlEnabled] = useState(false);
  const [robotCollisionProtectionEnabled, setRobotCollisionProtectionEnabled] = useState(false);
  const [robotCollisionStatus, setRobotCollisionStatus] = useState(
    () => createRobotCollisionStatus(),
  );
  const [teachingTasks, setTeachingTasks] = useState([]);
  const [activeTeachingTaskId, setActiveTeachingTaskId] = useState(null);
  const [jointPoses, setJointPoses] = useState([]);
  const [zividCameraPoses, setZividCameraPoses] = useState({});
  const [cameraTeachingCommand, setCameraTeachingCommand] = useState(null);
  const [cameraTeachingResult, setCameraTeachingResult] = useState({
    status: 'idle',
    revision: 0,
  });
  const [teachingCaptureState, setTeachingCaptureState] = useState({
    status: 'idle',
    message: '',
  });
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
    meshRenderQuality,
    showWaypoints3D,
    collapsedPanel,
    selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    teachingTasks,
    activeTeachingTaskId,
    jointPoses,
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
        notify('自动保护暂不可用，请到虚拟示教页导出工程备份', 'warning');
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
          robot: current.selectedRobot,
          robotPose: current.robotPose,
          robotJointValues: current.robotJointValues,
          lockedRobotJointNames: current.lockedRobotJointNames,
          teachingTasks: current.teachingTasks,
          jointPoses: current.jointPoses,
          meshRenderQuality: current.meshRenderQuality,
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
        activeTeachingTaskId: current.activeTeachingTaskId,
        validation: current.validation,
        pointColorMode: current.pointColorMode,
        meshRenderQuality: current.meshRenderQuality,
        showWaypoints3D: current.showWaypoints3D,
        collapsedPanel: current.collapsedPanel,
        selectedRobot: current.selectedRobot
          ? {
              ...current.selectedRobot,
              origin: current.robotPose,
              joints: current.robotJointValues,
              lockedJoints: current.lockedRobotJointNames,
            }
          : null,
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
        sourceHash = null,
        sourceHashKind = 'file',
      } = options;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const positions = geometry.getAttribute('position')?.array;
      if (!positions?.length || !geometry.boundingBox) {
        throw new Error('PLY 文件中没有可用的顶点坐标');
      }

      const packedColors = packColorAttribute(geometry.getAttribute('color'));
      if (packedColors) {
        geometry.setAttribute('color', new THREE.BufferAttribute(packedColors, 3, true));
      }
      const meshInfo = prepareMapGeometryTopology(geometry);
      geometry.userData.geometrySource = geometrySource;
      const colors = geometry.getAttribute('color')?.array || null;
      const bounds = serializeBounds(geometry.boundingBox);
      const nextSlice = clampSlice(preferredSlice || suggestedSlice(positions, bounds), bounds);
      const nextMap = {
        mapId,
        name,
        pointCount: positions.length / 3,
        faceCount: meshInfo.faceCount,
        meshInfo,
        bounds,
        positions,
        colors,
        geometry,
        geometrySource,
        sourceHash,
        sourceHashKind,
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
        setRobotPose(normalizeRobotPose(null));
        setRobotJointValues({});
        setLockedRobotJointNames([]);
        setRobotControlEnabled(false);
        setRobotCollisionProtectionEnabled(false);
        setRobotCollisionStatus(createRobotCollisionStatus());
        setTeachingTasks([]);
        setActiveTeachingTaskId(null);
        setJointPoses([]);
        setCameraTeachingCommand(null);
        setCameraTeachingResult({ status: 'idle', revision: 0 });
        setTeachingCaptureState({ status: 'idle', message: '' });
      }

      if (persistSnapshot && sessionReadyRef.current && sessionIdRef.current) {
        setLoadState({
          loading: true,
          progress: 1,
          phase: '缓存已解析地图',
          detail: meshInfo.hasMesh
            ? '正在保存点云、颜色与面索引，后续刷新无需再次解析 PLY'
            : '正在保存坐标缓存，后续刷新无需再次解析 PLY',
        });
        try {
          await saveWorkspaceMap(
            sessionIdRef.current,
            mapId,
            name,
            createGeometryCache(
              geometry,
              bounds,
              sourceByteLength,
              sourceHash,
              sourceHashKind,
            ),
          );
        } catch (error) {
          reportSessionFailure(error);
        }
      }

      if (!keepLoading) setLoadState({ loading: false, progress: 1, phase: '' });
      if (announce) {
        notify(
          meshInfo.hasMesh
            ? `${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点 / ${meshInfo.faceCount.toLocaleString('zh-CN')} 面`
            : `${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点`,
        );
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
        phase: '解析地图结构',
        detail: '首次载入正在构建点云、网格与空间索引',
      });
      await waitForPaint();
      let geometry;
      try {
        const sourceHashPromise = options.sourceHash
          ? Promise.resolve(options.sourceHash)
          : sha256ArrayBuffer(buffer).catch(() => null);
        const loader = new PLYLoader();
        geometry = loader.parse(buffer);
        const sourceHash = await sourceHashPromise;
        return await installMapGeometry(geometry, name, {
          ...options,
          sourceByteLength: buffer.byteLength,
          geometrySource: options.geometrySource || 'ply-parse',
          sourceHash,
          sourceHashKind: options.sourceHashKind || 'file',
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
        phase: '恢复地图缓存',
        detail: record.indexBuffer
          ? '正在直接装载已解析坐标与面索引，跳过 PLY 解析'
          : '正在直接装载已解析坐标，跳过 PLY 解析',
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
          sourceHash: record.sourceHash || null,
          sourceHashKind: record.sourceHashKind || 'file',
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
          const restoredRobot = normalizeRobotDescriptor(
            project?.robot || snapshot?.ui?.selectedRobot,
          );
          const restoredMapId = stored.map?.mapId || stored.config?.mapId || null;
          const instantViews = loadWorkspaceViews(identity.sessionId, restoredMapId);
          const preferredView2d = instantViews?.view2d ?? project?.view2d ?? null;
          const preferredView3d = instantViews?.view3d ?? project?.view3d ?? null;
          setCollapsedPanel(
            snapshot?.ui?.collapsedPanel === '3d' || snapshot?.ui?.collapsedPanel === '2d'
              ? snapshot.ui.collapsedPanel
              : null,
          );
          setMeshRenderQuality(normalizeMeshRenderQuality(
            snapshot?.ui?.meshRenderQuality ?? project?.rendering?.meshQuality,
          ));
          setShowWaypoints3D(snapshot?.ui?.showWaypoints3D !== false);
          setSelectedRobot(restoredRobot);
          setRobotPose(
            restoredRobot
              ? normalizeRobotPose(project?.robot?.origin || restoredRobot.origin)
              : normalizeRobotPose(null),
          );
          setRobotJointValues(
            restoredRobot ? normalizeRobotJointValues(project?.robot?.joints || restoredRobot.joints) : {},
          );
          setLockedRobotJointNames(
            restoredRobot
              ? normalizeRobotJointLocks(
                  project?.robot?.lockedJoints
                  ?? snapshot?.ui?.selectedRobot?.lockedJoints,
                )
              : [],
          );
          setRobotControlEnabled(false);
          setRobotLoadState({ status: restoredRobot ? 'pending' : 'idle' });
          restored = restored || Boolean(restoredRobot);

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
              createGeometryCache(
                restoredMap.geometry,
                restoredMap.bounds,
                buffer.byteLength,
                restoredMap.sourceHash,
                restoredMap.sourceHashKind,
              ),
            );
            if (!isCurrent()) return;
            restored = true;
          } else if (project?.map?.bounds) {
            const bounds = project.map.bounds;
            setMapData({
              mapId: stored.config?.mapId || createId('map-meta'),
              name: project.map.fileName || '未绑定地图',
              pointCount: Number(project.map.pointCount) || 0,
              faceCount: Number(project.map.faceCount) || 0,
              bounds,
              positions: null,
              colors: null,
              geometry: null,
              sourceHash: project.map.sourceHash || null,
              sourceHashKind: project.map.sourceHashKind || 'file',
              metadataOnly: true,
            });
            setHeightRange(
              clampSlice(project.slice || [bounds.min.z, bounds.max.z], bounds),
            );
            setRestoredView2d(preferredView2d);
            view2dRef.current = preferredView2d;
            setRestoredView3d(preferredView3d);
            view3dRef.current = preferredView3d;
            restored = true;
          }

          if (project) {
            const pointIds = new Set(project.waypoints.map((point) => point.id));
            const edgeIds = new Set(project.edges.map((edge) => edge.id));
            const teachingTaskIds = new Set(
              project.teachingTasks.map((task) => task.id),
            );
            const checked = project.edges.some((edge) => edge.status !== 'unchecked');
            const connected = project.edges.length > 0
              && project.edges.every((edge) => edge.status === 'connected');
            const savedValidation = snapshot?.ui?.validation;

            setWaypoints(project.waypoints);
            setEdges(project.edges);
            setTeachingTasks(project.teachingTasks);
            setJointPoses(project.jointPoses);
            setActiveTeachingTaskId(
              teachingTaskIds.has(snapshot?.ui?.activeTeachingTaskId)
                ? snapshot.ui.activeTeachingTaskId
                : project.teachingTasks[0]?.id || null,
            );
            if (!stored.map && project.slice) {
              setHeightRange(
                project.map?.bounds
                  ? clampSlice(project.slice, project.map.bounds)
                  : project.slice,
              );
            }
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
            restored = restored
              || project.waypoints.length > 0
              || project.edges.length > 0
              || project.teachingTasks.length > 0
              || project.jointPoses.length > 0
              || Boolean(restoredRobot);
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
          setMeshRenderQuality('auto');
          setShowWaypoints3D(true);
          setCollapsedPanel(null);
          setSelectedRobot(null);
          setRobotPose(normalizeRobotPose(null));
          setRobotJointValues({});
          setLockedRobotJointNames([]);
          setRobotControlEnabled(false);
          setTeachingTasks([]);
          setActiveTeachingTaskId(null);
          setJointPoses([]);
          setRobotLoadState({ status: 'idle' });
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
    meshRenderQuality,
    mode,
    pointColorMode,
    queueWorkspaceSave,
    selectedEdgeId,
    selectedWaypointId,
    selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    teachingTasks,
    activeTeachingTaskId,
    jointPoses,
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
      if (
        !options.preserveGraph
        && (waypoints.length || teachingTasks.length || jointPoses.length)
        && !window.confirm('加载新地图会清空当前导航图、虚拟示教任务与已记录关节姿态，继续吗？')
      ) return;
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
    [jointPoses.length, notify, processMapBuffer, teachingTasks.length, waypoints.length],
  );

  const handleMapFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (
      (waypoints.length || teachingTasks.length || jointPoses.length)
      && !window.confirm('加载新地图会清空当前导航图、虚拟示教任务与已记录关节姿态，继续吗？')
    ) return;
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
      setTeachingTasks(project.teachingTasks);
      setJointPoses(project.jointPoses);
      setActiveTeachingTaskId(project.teachingTasks[0]?.id || null);
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setConnectionSourceId(null);
      setMode('select');
      setMeshRenderQuality(normalizeMeshRenderQuality(project.rendering?.meshQuality));
      const importedRobot = normalizeRobotDescriptor(project.robot);
      setSelectedRobot(importedRobot);
      setZividCameraPoses({});
      setCameraTeachingCommand(null);
      setCameraTeachingResult({ status: 'idle', revision: 0 });
      zividCaptureProviderRef.current = null;
      teachingCaptureBusyRef.current = false;
      setTeachingCaptureState({ status: 'idle', message: '' });
      setRobotPose(
        importedRobot ? normalizeRobotPose(project.robot?.origin) : normalizeRobotPose(null),
      );
      setRobotJointValues(
        importedRobot ? normalizeRobotJointValues(project.robot?.joints) : {},
      );
      setLockedRobotJointNames(
        importedRobot ? normalizeRobotJointLocks(project.robot?.lockedJoints) : [],
      );
      setRobotControlEnabled(false);
      setRobotCollisionProtectionEnabled(false);
      setRobotCollisionStatus(createRobotCollisionStatus());
      setRobotLoadState({ status: importedRobot ? 'pending' : 'idle' });
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

      if (project.slice) {
        const importedBounds = mapData?.bounds || project.map?.bounds;
        setHeightRange(
          importedBounds ? clampSlice(project.slice, importedBounds) : project.slice,
        );
      }
      if (!mapData && project.map?.bounds) {
        setMapData({
          mapId: createId('map-meta'),
          name: project.map.fileName || '未绑定地图',
          pointCount: Number(project.map.pointCount) || 0,
          faceCount: Number(project.map.faceCount) || 0,
          bounds: project.map.bounds,
          positions: null,
          colors: null,
          geometry: null,
          metadataOnly: true,
        });
      }
      notify(
        `工程配置已加载 · ${project.waypoints.length} 导航点 / ${project.teachingTasks.length} 示教任务`,
      );

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

  const teachingContextMatches = useCallback(
    (task) => {
      if (!task || !selectedRobot || !mapData) return false;
      const taskRobotKey = task.robot?.id || task.robot?.relativePath;
      const currentRobotKey = selectedRobot.id || selectedRobot.relativePath;
      const sameRobot = Boolean(taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey);
      const sameMap = task.map?.sourceHash && mapData.sourceHash
        ? task.map.sourceHash === mapData.sourceHash
        : task.map?.fileName === mapData.name;
      return sameRobot && sameMap;
    },
    [mapData, selectedRobot],
  );

  const createTeachingTask = useCallback(() => {
    if (!mapData?.bounds) {
      notify('请先加载地图，再创建虚拟示教任务', 'warning');
      return;
    }
    if (!selectedRobot || robotLoadState.status !== 'loaded') {
      notify('请先完成机器人模型加载，再创建虚拟示教任务', 'warning');
      return;
    }
    const timestamp = new Date().toISOString();
    const task = {
      id: createId('teach-task'),
      name: `示教任务 ${String(teachingTasks.length + 1).padStart(2, '0')}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      coordinateFrame: 'map',
      robot: {
        id: selectedRobot.id || selectedRobot.relativePath,
        name: selectedRobot.name,
        relativePath: selectedRobot.relativePath,
      },
      map: {
        id: mapData.mapId || '',
        fileName: mapData.name || '',
        sourceHash: mapData.sourceHash || null,
      },
      points: [],
    };
    setTeachingTasks((current) => [...current, task]);
    setActiveTeachingTaskId(task.id);
    setTeachingCaptureState({ status: 'idle', message: '' });
    notify(`${task.name} 已创建 · 已绑定当前地图与机器人`, 'success');
  }, [mapData, notify, robotLoadState.status, selectedRobot, teachingTasks.length]);

  const selectTeachingTask = useCallback((id) => {
    setActiveTeachingTaskId(id);
    setTeachingCaptureState({ status: 'idle', message: '' });
  }, []);

  const renameTeachingTask = useCallback((id, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === id ? { ...task, name: nextName, updatedAt } : task
    )));
  }, []);

  const deleteTeachingTask = useCallback(
    (id) => {
      const task = teachingTasks.find((item) => item.id === id);
      const remaining = teachingTasks.filter((item) => item.id !== id);
      setTeachingTasks(remaining);
      if (activeTeachingTaskId === id) {
        setActiveTeachingTaskId(remaining[0]?.id || null);
      }
      notify(`${task?.name || '示教任务'} 已删除`, 'info');
    },
    [activeTeachingTaskId, notify, teachingTasks],
  );

  const captureTeachingPoint = useCallback(async () => {
    const task = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    if (!task) {
      notify('请先新建或选择一个示教任务', 'warning');
      return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该示教任务不一致，无法记录', 'warning');
      return;
    }
    if (teachingCaptureBusyRef.current) return;
    const pose = normalizeRobotPose(robotPose);
    const joints = normalizeRobotJointValues(robotJointValues);
    const timestamp = new Date().toISOString();
    const expectsZividCapture = Number(robotLoadState.zividCount) > 0;
    let cameraCapture = null;
    if (expectsZividCapture) {
      const provider = zividCaptureProviderRef.current;
      if (typeof provider !== 'function') {
        const message = '左右 Zivid 画面正在准备，请稍后重试';
        setTeachingCaptureState({ status: 'error', message });
        notify(message, 'warning');
        return;
      }
      teachingCaptureBusyRef.current = true;
      setTeachingCaptureState({
        status: 'capturing',
        message: '正在冻结左右 RGB 与点云快照',
      });
      try {
        const capturePromise = provider();
        await waitForPaint();
        cameraCapture = await capturePromise;
      } catch (error) {
        const message = error?.message || '双目视觉快照采集失败';
        setTeachingCaptureState({ status: 'error', message });
        notify(message, 'error');
        return;
      } finally {
        teachingCaptureBusyRef.current = false;
      }
    }
    const point = {
      id: createId('teach-point'),
      name: `T${String(task.points.length + 1).padStart(2, '0')}`,
      sequence: task.points.length + 1,
      capturedAt: timestamp,
      mapPose: {
        frameId: 'map',
        position: { ...pose.position },
        rpy: { ...pose.rpy },
      },
      fullBodyJoints: {
        angularUnit: 'degree',
        linearUnit: 'meter',
        source: 'urdf-movable-joints',
        count: Object.keys(joints).length,
        values: { ...joints },
      },
      cameraCapture,
    };
    setTeachingTasks((current) => current.map((item) => (
      item.id === task.id
        ? { ...item, points: [...item.points, point], updatedAt: timestamp }
        : item
    )));
    notify(
      `${point.name} 已示教 · MAP 6DOF + ${point.fullBodyJoints.count} 个全身关节${cameraCapture ? ' + 双目 RGB/XYZ' : ''}`,
      'success',
    );
    setTeachingCaptureState({
      status: 'complete',
      message: cameraCapture
        ? '左右 RGB 与点云已随示教点保存'
        : '机器人位姿与全身关节已保存',
      pointId: point.id,
      frameCount: cameraCapture ? Object.keys(cameraCapture.frames || {}).length : 0,
    });
  }, [
    activeTeachingTaskId,
    notify,
    robotJointValues,
    robotLoadState.status,
    robotLoadState.zividCount,
    robotPose,
    teachingContextMatches,
    teachingTasks,
  ]);

  const renameTeachingPoint = useCallback((taskId, pointId, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === taskId
        ? {
            ...task,
            updatedAt,
            points: task.points.map((point) => (
              point.id === pointId ? { ...point, name: nextName } : point
            )),
          }
        : task
    )));
  }, []);

  const deleteTeachingPoint = useCallback((taskId, pointId) => {
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      return {
        ...task,
        updatedAt,
        points: task.points
          .filter((point) => point.id !== pointId)
          .map((point, index) => ({ ...point, sequence: index + 1 })),
      };
    }));
    notify('示教点位已删除', 'info');
  }, [notify]);

  const applyTeachingPoint = useCallback(
    (taskId, pointId) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const point = task?.points.find((item) => item.id === pointId);
      if (!task || !point) return;
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        notify('当前地图或机器人与该示教点不一致，无法应用姿态', 'warning');
        return;
      }
      setRobotControlEnabled(false);
      setRobotPose(normalizeRobotPose(point.mapPose));
      setRobotJointValues(
        normalizeRobotJointValues(point.fullBodyJoints?.values),
      );
      notify(`${point.name} 已应用到机器人 · 地图定位与全身关节已恢复`, 'success');
    },
    [notify, robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const updateRobotJointValue = useCallback(
    (name, rawValue) => {
      if (robotLoadState.status !== 'loaded' || !name) return;
      const definition = robotLoadState.movableJoints?.find((joint) => joint.name === name);
      const value = clampJointValue(rawValue, definition);
      setRobotControlEnabled(false);
      setRobotJointValues((current) => ({ ...current, [name]: value }));
    },
    [robotLoadState.movableJoints, robotLoadState.status],
  );

  const toggleRobotJointLock = useCallback((name) => {
    const jointName = String(name || '').trim();
    if (!jointName || robotLoadState.status !== 'loaded') return;
    setLockedRobotJointNames((current) => {
      const normalized = normalizeRobotJointLocks(current);
      return normalized.includes(jointName)
        ? normalized.filter((candidate) => candidate !== jointName)
        : [...normalized, jointName];
    });
  }, [robotLoadState.status]);

  const unlockAllRobotJoints = useCallback(() => {
    setLockedRobotJointNames([]);
    notify('已解除全部关节 IK 锁定', 'info');
  }, [notify]);

  const zeroRobotJoints = useCallback(() => {
    if (robotLoadState.status !== 'loaded') {
      notify('机器人尚未完成装配，无法归零关节', 'warning');
      return;
    }
    const definitions = robotLoadState.movableJoints || [];
    const jointNames = definitions.length
      ? definitions.map((joint) => joint.name)
      : Object.keys(robotJointValues);
    const definitionByName = new Map(definitions.map((joint) => [joint.name, joint]));
    setRobotControlEnabled(false);
    setRobotJointValues(Object.fromEntries(
      jointNames.map((name) => [name, clampJointValue(0, definitionByName.get(name))]),
    ));
    notify(`${jointNames.length} 个可动关节已全部归零`, 'info');
  }, [notify, robotJointValues, robotLoadState.movableJoints, robotLoadState.status]);

  const captureJointPose = useCallback(
    (requestedName) => {
      if (!selectedRobot || robotLoadState.status !== 'loaded') {
        notify('请先完成机器人模型加载，再记录关节姿态', 'warning');
        return;
      }
      const values = normalizeRobotJointValues(robotJointValues);
      const jointCount = Object.keys(values).length;
      if (!jointCount) {
        notify('当前机器人没有可记录的可动关节', 'warning');
        return;
      }
      const timestamp = new Date().toISOString();
      const name = String(requestedName || '').trim()
        || `关节姿态 ${String(jointPoses.length + 1).padStart(2, '0')}`;
      const pose = {
        id: createId('joint-pose'),
        name,
        sequence: jointPoses.length + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        robot: {
          id: selectedRobot.id || selectedRobot.relativePath,
          name: selectedRobot.name,
          relativePath: selectedRobot.relativePath,
        },
        joints: {
          angularUnit: 'degree',
          linearUnit: 'meter',
          source: 'joint-console',
          count: jointCount,
          values: { ...values },
        },
      };
      setJointPoses((current) => [...current, pose]);
      notify(`${name} 已记录 · ${jointCount} 个关节值`, 'success');
    },
    [jointPoses.length, notify, robotJointValues, robotLoadState.status, selectedRobot],
  );

  const renameJointPose = useCallback((id, requestedName) => {
    const name = String(requestedName || '').trim();
    if (!name) return;
    const updatedAt = new Date().toISOString();
    setJointPoses((current) => current.map((pose) => (
      pose.id === id ? { ...pose, name, updatedAt } : pose
    )));
  }, []);

  const deleteJointPose = useCallback((id) => {
    const pose = jointPoses.find((item) => item.id === id);
    setJointPoses((current) => current
      .filter((item) => item.id !== id)
      .map((item, index) => ({ ...item, sequence: index + 1 })));
    notify(`${pose?.name || '关节姿态'} 已删除`, 'info');
  }, [jointPoses, notify]);

  const applyJointPose = useCallback(
    (id) => {
      const pose = jointPoses.find((item) => item.id === id);
      if (!pose || !selectedRobot || robotLoadState.status !== 'loaded') {
        notify('机器人尚未就绪，无法执行关节姿态', 'warning');
        return;
      }
      const poseRobotKey = pose.robot?.id || pose.robot?.relativePath;
      const currentRobotKey = selectedRobot.id || selectedRobot.relativePath;
      if (!poseRobotKey || poseRobotKey !== currentRobotKey) {
        notify('该关节姿态绑定了不同的机器人模型', 'warning');
        return;
      }
      const definitionByName = new Map(
        (robotLoadState.movableJoints || []).map((joint) => [joint.name, joint]),
      );
      const values = Object.fromEntries(
        Object.entries(normalizeRobotJointValues(pose.joints?.values)).map(([name, value]) => [
          name,
          clampJointValue(value, definitionByName.get(name)),
        ]),
      );
      setRobotControlEnabled(false);
      setRobotJointValues(values);
      notify(`${pose.name} 已应用到机器人`, 'success');
    },
    [jointPoses, notify, robotLoadState.movableJoints, robotLoadState.status, selectedRobot],
  );

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
      robot: selectedRobot,
      robotPose,
      robotJointValues,
      lockedRobotJointNames,
      teachingTasks,
      jointPoses,
      meshRenderQuality,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(payload, `virtual-teaching-${stamp}.json`);
    notify(
      teachingTasks.length
        ? '虚拟示教工程 JSON 已导出'
        : '工程 JSON 已导出 · 当前未包含示教任务',
      teachingTasks.length ? 'success' : 'info',
    );
  };

  const handleProjectionStats = useCallback((stats) => setProjectionStats(stats), []);
  const handleSelectRobot = useCallback(
    (value) => {
      const robot = normalizeRobotDescriptor(value);
      if (!robot) {
        notify('机器人模型描述无效', 'error');
        return;
      }
      robotNotificationRef.current = '';
      setSelectedRobot(robot);
      setRobotPose(normalizeRobotPose(null));
      setRobotJointValues({});
      setLockedRobotJointNames([]);
      setRobotControlEnabled(false);
      setRobotCollisionProtectionEnabled(false);
      setRobotCollisionStatus(createRobotCollisionStatus());
      setZividCameraPoses({});
      setCameraTeachingCommand(null);
      setCameraTeachingResult({ status: 'idle', revision: 0 });
      zividCaptureProviderRef.current = null;
      teachingCaptureBusyRef.current = false;
      setTeachingCaptureState({ status: 'idle', message: '' });
      setRobotLoadState({
        status: mapData?.geometry ? 'loading' : 'pending',
        robotId: robot.id,
        name: robot.name,
        loaded: 0,
        total: 0,
      });
      notify(
        mapData?.geometry
          ? `${robot.name} 已选择，正在装配到地图原点`
          : `${robot.name} 已选择，加载地图后将在原点显示`,
        'info',
      );
    },
    [mapData?.geometry, notify],
  );
  const handleRobotLoadState = useCallback((nextState) => {
    setRobotLoadState(nextState);
    if (nextState.status !== 'loaded') {
      setRobotControlEnabled(false);
      setZividCameraPoses({});
    } else {
      const availableJointNames = new Set(
        (nextState.movableJoints || []).flatMap((joint) => joint?.name ? [joint.name] : []),
      );
      setLockedRobotJointNames((current) => {
        const next = normalizeRobotJointLocks(current).filter(
          (name) => availableJointNames.has(name),
        );
        return next.length === current.length
          && next.every((name, index) => name === current[index])
          ? current
          : next;
      });
    }
  }, []);
  const handleRobotPoseChange = useCallback((nextPose) => {
    const normalized = normalizeRobotPose(nextPose);
    setRobotPose((current) => {
      const unchanged =
        current.position.x === normalized.position.x
        && current.position.y === normalized.position.y
        && current.position.z === normalized.position.z
        && current.rpy.roll === normalized.rpy.roll
        && current.rpy.pitch === normalized.rpy.pitch
        && current.rpy.yaw === normalized.rpy.yaw;
      return unchanged ? current : normalized;
    });
  }, []);
  const handleRobotCollisionProtectionStatus = useCallback((nextStatus) => {
    if (!nextStatus || typeof nextStatus !== 'object') return;
    const normalized = createRobotCollisionStatus({
      ...nextStatus,
      collisionLinks: Array.isArray(nextStatus.collisionLinks)
        ? [...nextStatus.collisionLinks]
        : [],
      nearLinks: Array.isArray(nextStatus.nearLinks) ? [...nextStatus.nearLinks] : [],
      excludedLinks: Array.isArray(nextStatus.excludedLinks)
        ? [...nextStatus.excludedLinks]
        : [],
    });
    setRobotCollisionStatus((current) => (
      JSON.stringify(current) === JSON.stringify(normalized) ? current : normalized
    ));
  }, []);
  const handleRobotCollisionProtectionChange = useCallback(
    (enabled) => {
      const nextEnabled = Boolean(enabled);
      if (
        nextEnabled
        && (!mapData?.geometry || robotLoadState.status !== 'loaded' || !selectedRobot)
      ) {
        notify('请先完成地图与机器人模型加载', 'warning');
        return;
      }
      setRobotCollisionProtectionEnabled(nextEnabled);
      setRobotCollisionStatus(createRobotCollisionStatus(nextEnabled
        ? {
            enabled: true,
            state: 'building',
            message: '正在建立环境空间索引',
            detail: '检测将在专用 Worker 中运行',
          }
        : {}));
      notify(
        nextEnabled
          ? '自碰撞保护已开启 · 底盘与轮组已排除'
          : '自碰撞保护已关闭 · 检测资源已释放',
        nextEnabled ? 'info' : 'success',
      );
    },
    [mapData?.geometry, notify, robotLoadState.status, selectedRobot],
  );
  const handleRobotJointValuesChange = useCallback((nextValues) => {
    const normalized = normalizeRobotJointValues(nextValues);
    setRobotJointValues((current) => {
      const currentEntries = Object.entries(current);
      const nextEntries = Object.entries(normalized);
      if (
        currentEntries.length === nextEntries.length
        && nextEntries.every(([name, value]) => current[name] === value)
      ) {
        return current;
      }
      return normalized;
    });
  }, []);
  const handleZividCameraPoseChange = useCallback((nextPoses) => {
    setZividCameraPoses(nextPoses && typeof nextPoses === 'object' ? nextPoses : {});
  }, []);
  const handleZividCaptureProviderChange = useCallback((provider) => {
    zividCaptureProviderRef.current = typeof provider === 'function' ? provider : null;
  }, []);
  const requestCameraTeachingMove = useCallback(
    (request) => {
      const side = request?.side === 'right' ? 'right' : 'left';
      if (robotLoadState.status !== 'loaded' || Number(robotLoadState.zividCount) < 1) {
        notify('Zivid 末端相机运动链尚未就绪', 'warning');
        return;
      }
      if (!zividCameraPoses[side]) {
        notify(`${side === 'left' ? '左' : '右'}臂相机坐标系正在同步，请稍后重试`, 'warning');
        return;
      }
      const revision = ++cameraTeachingRevisionRef.current;
      const command = {
        revision,
        side,
        action: String(request?.action || ''),
        linearStep: Number(request?.linearStep) || 0.025,
        angularStep: Number(request?.angularStep) || 3,
        source: request?.source === 'spacemouse' ? 'spacemouse' : 'button',
        inputMagnitude: Math.max(0, Math.min(1, Number(request?.inputMagnitude) || 0)),
      };
      setRobotControlEnabled(false);
      setCameraTeachingResult({
        revision,
        side,
        action: command.action,
        status: 'solving',
      });
      setCameraTeachingCommand(command);
    },
    [notify, robotLoadState.status, robotLoadState.zividCount, zividCameraPoses],
  );
  const handleCameraTeachingResult = useCallback(
    (result) => {
      const normalized = result && typeof result === 'object'
        ? result
        : { status: 'error', message: '相机示教逆解未返回结果' };
      setCameraTeachingResult(normalized);
      if (normalized.status === 'error') {
        notify(normalized.message || '相机示教逆解失败', 'warning');
      }
    },
    [notify],
  );
  const handleRobotControlChange = useCallback(
    (enabled) => {
      const nextEnabled = Boolean(enabled) && robotLoadState.status === 'loaded';
      setRobotControlEnabled(nextEnabled);
      notify(
        nextEnabled
          ? '机器人控制已启用 · WASD 全向移动 / ←→ 原地旋转'
          : '机器人控制已关闭 · WASD 与 ←→ 已交还相机',
        'info',
      );
    },
    [notify, robotLoadState.status],
  );

  useEffect(() => {
    if (!['loaded', 'error'].includes(robotLoadState.status)) return;
    const signature = `${robotLoadState.status}:${robotLoadState.robotId}:${robotLoadState.message || ''}`;
    if (robotNotificationRef.current === signature) return;
    robotNotificationRef.current = signature;
    if (robotLoadState.status === 'loaded') {
      notify(
        `${robotLoadState.name || '机器人'} 已加载 · X ${robotPose.position.x.toFixed(2)} / Y ${robotPose.position.y.toFixed(2)} / YAW ${robotPose.rpy.yaw.toFixed(1)}°`,
        'success',
      );
    } else {
      notify(`机器人加载失败：${robotLoadState.message || '未知错误'}`, 'error');
    }
  }, [notify, robotLoadState, robotPose]);
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
          {mapData?.pointCount > 0 && (
            <em>
              {(mapData.pointCount / 1_000_000).toFixed(2)}M PTS
              {mapData.faceCount > 0 ? ` · ${(mapData.faceCount / 1_000_000).toFixed(2)}M TRI` : ''}
            </em>
          )}
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
          <RobotPicker
            selectedRobot={selectedRobot}
            loadState={robotLoadState}
            onSelect={handleSelectRobot}
          />
          <SpaceMouseControl inputRef={spaceMouseInputRef} onNotify={notify} />
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
                <div>
                  <small>SPATIAL SOURCE</small>
                  <strong>{mapData?.faceCount > 0 ? '三维点云 / 网格' : '三维点云'}</strong>
                </div>
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
                meshRenderQuality={meshRenderQuality}
                onMeshRenderQualityChange={setMeshRenderQuality}
                showWaypoints={showWaypoints3D}
                onShowWaypointsChange={setShowWaypoints3D}
                onSelectWaypoint={selectWaypoint}
                onSelectEdge={selectEdge}
                onClearSelection={clearSelection}
                focusRequest={synchronizedFocus}
                initialView={restoredView3d}
                onViewChange={handleView3dChange}
                resetRequest={viewResetRequest}
                robotDescriptor={selectedRobot}
                robotLoadState={robotLoadState}
                robotPose={robotPose}
                robotJointValues={robotJointValues}
                lockedRobotJointNames={lockedRobotJointNames}
                robotControlEnabled={robotControlEnabled}
                spaceMouseInputRef={spaceMouseInputRef}
                viewportCanvasRef={main3DCanvasRef}
                cameraTeachingCommand={cameraTeachingCommand}
                collisionProtectionEnabled={robotCollisionProtectionEnabled}
                onRobotLoadState={handleRobotLoadState}
                onRobotPoseChange={handleRobotPoseChange}
                onRobotJointValuesChange={handleRobotJointValuesChange}
                onRobotControlChange={handleRobotControlChange}
                onZividCameraPoseChange={handleZividCameraPoseChange}
                onCameraTeachingResult={handleCameraTeachingResult}
                onCollisionProtectionChange={handleRobotCollisionProtectionChange}
                onCollisionProtectionStatus={handleRobotCollisionProtectionStatus}
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
          robot={selectedRobot}
          robotLoadState={robotLoadState}
          robotPose={robotPose}
          robotJointValues={robotJointValues}
          lockedRobotJointNames={lockedRobotJointNames}
          robotControlEnabled={robotControlEnabled}
          robotCollisionProtectionEnabled={robotCollisionProtectionEnabled}
          robotCollisionStatus={robotCollisionStatus}
          meshRenderQuality={meshRenderQuality}
          onMeshRenderQualityChange={setMeshRenderQuality}
          spaceMouseInputRef={spaceMouseInputRef}
          main3DCanvasRef={main3DCanvasRef}
          teachingTasks={teachingTasks}
          activeTeachingTaskId={activeTeachingTaskId}
          jointPoses={jointPoses}
          zividCameraPoses={zividCameraPoses}
          cameraTeachingResult={cameraTeachingResult}
          teachingCaptureState={teachingCaptureState}
          onRunConnectivity={runConnectivity}
          onSelectWaypoint={focusWaypointFromInspector}
          onSearchWaypoint={focusWaypointFromInspector}
          onSelectEdge={focusEdgeFromInspector}
          onClearSelection={clearSelection}
          onUpdateWaypoint={updateWaypoint}
          onUpdateEdge={updateEdge}
          onDeleteWaypoint={deleteWaypoint}
          onDeleteEdge={deleteEdge}
          onCreateTeachingTask={createTeachingTask}
          onSelectTeachingTask={selectTeachingTask}
          onRenameTeachingTask={renameTeachingTask}
          onDeleteTeachingTask={deleteTeachingTask}
          onCaptureTeachingPoint={captureTeachingPoint}
          onRenameTeachingPoint={renameTeachingPoint}
          onDeleteTeachingPoint={deleteTeachingPoint}
          onApplyTeachingPoint={applyTeachingPoint}
          onUpdateRobotJointValue={updateRobotJointValue}
          onToggleRobotJointLock={toggleRobotJointLock}
          onUnlockAllRobotJoints={unlockAllRobotJoints}
          onZeroRobotJoints={zeroRobotJoints}
          onCaptureJointPose={captureJointPose}
          onRenameJointPose={renameJointPose}
          onDeleteJointPose={deleteJointPose}
          onApplyJointPose={applyJointPose}
          onCameraTeachingMove={requestCameraTeachingMove}
          onZividCaptureProviderChange={handleZividCaptureProviderChange}
          onExportTeachingProject={exportProject}
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
              ? '自动保护不可用，请到虚拟示教页导出工程备份'
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
