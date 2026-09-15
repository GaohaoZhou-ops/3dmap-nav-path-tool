import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Database,
  FileArchive,
  FileSearch,
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
import MapDetailsDialog from './components/MapDetailsDialog.jsx';
import PointCloudViewer from './components/PointCloudViewer.jsx';
import RobotPicker from './components/RobotPicker.jsx';
import SpaceMouseControl from './components/SpaceMouseControl.jsx';
import TeachingDataPage from './components/TeachingDataPage.jsx';
import TeachingPlaybackDock from './components/TeachingPlaybackDock.jsx';
import { inspectConnectivity } from './lib/graph.js';
import {
  buildExport,
  clampSlice,
  createId,
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
import { sha256ArrayBuffer } from './lib/hash.js';
import {
  normalizeMeshRenderQuality,
  prepareMapGeometryTopology,
} from './lib/mapGeometry.js';
import { createSpaceMouseInputState } from './lib/spaceMouse.js';
import {
  buildTeachingTaskTrajectory,
  sampleTeachingTrajectorySegment,
} from './lib/teachingPlayback.js';
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
const APP_PAGE_WORKBENCH = 'workbench';
const APP_PAGE_TEACHING_DATA = 'teaching-data';

const createIdleTeachingPlayback = () => ({
  status: 'idle',
  taskId: '',
  taskName: '',
  phase: '',
  segmentIndex: 0,
  segmentCount: 0,
  parkingPointName: '',
  poseName: '',
  poseOrdinal: 0,
  poseCount: 0,
  elapsedDurationMs: 0,
  totalDurationMs: 0,
  overallProgress: 0,
  segmentProgress: 0,
  speed: 1,
});

const teachingPlaybackStateFromRuntime = (runtime, status = runtime?.status || 'idle') => {
  const segment = runtime?.plan?.segments?.[runtime.segmentIndex] || null;
  if (!runtime || !segment) return createIdleTeachingPlayback();
  const segmentProgress = segment.durationMs > 0
    ? Math.max(0, Math.min(1, runtime.segmentElapsedMs / segment.durationMs))
    : 1;
  const elapsedDurationMs = Math.min(
    runtime.plan.totalDurationMs,
    segment.startOffsetMs + runtime.segmentElapsedMs,
  );
  return {
    status,
    taskId: runtime.plan.taskId,
    taskName: runtime.plan.taskName,
    phase: segment.phase,
    segmentIndex: runtime.segmentIndex,
    segmentCount: runtime.plan.segments.length,
    parkingPointId: segment.target?.parkingPointId || '',
    parkingPointName: segment.target?.parkingPointName || '',
    poseId: segment.target?.poseId || '',
    poseName: segment.target?.poseName || '',
    poseOrdinal: segment.target?.poseOrdinal || 0,
    poseCount: runtime.plan.poseCount,
    elapsedDurationMs,
    totalDurationMs: runtime.plan.totalDurationMs,
    overallProgress: runtime.plan.totalDurationMs > 0
      ? elapsedDurationMs / runtime.plan.totalDurationMs
      : 1,
    segmentProgress,
    speed: runtime.speed,
  };
};

const appPageFromLocation = () => {
  if (typeof window === 'undefined') return APP_PAGE_WORKBENCH;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path.endsWith('/teaching-data') ? APP_PAGE_TEACHING_DATA : APP_PAGE_WORKBENCH;
};

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

const normalizeTimestamp = (value) => {
  if (!value) return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

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
  sourceDetails = {},
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
    fileModifiedAt: normalizeTimestamp(sourceDetails.fileModifiedAt),
    mimeType: String(sourceDetails.mimeType || 'application/octet-stream'),
    loadedAt: normalizeTimestamp(sourceDetails.loadedAt),
    sourceKind: String(sourceDetails.sourceKind || 'unknown'),
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
  const mapDetailsButtonRef = useRef(null);
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
  const parkingMergePlannerRef = useRef(null);
  const teachingCaptureBusyRef = useRef(false);
  const projectExportBusyRef = useRef(false);
  const teachingPlaybackFrameRef = useRef(null);
  const teachingPlaybackRuntimeRef = useRef(null);
  const spaceMouseInputRef = useRef(createSpaceMouseInputState());
  const main3DCanvasRef = useRef(null);
  const [appPage, setAppPage] = useState(appPageFromLocation);
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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [mapDetailsOpen, setMapDetailsOpen] = useState(false);
  const [synchronizedFocus, setSynchronizedFocus] = useState(null);
  const [viewResetRequest, setViewResetRequest] = useState(null);
  const [selectedRobot, setSelectedRobot] = useState(null);
  const [robotLoadState, setRobotLoadState] = useState({ status: 'idle' });
  const [robotPose, setRobotPose] = useState(() => normalizeRobotPose(null));
  const [robotJointValues, setRobotJointValues] = useState({});
  const [lockedRobotJointNames, setLockedRobotJointNames] = useState([]);
  const [robotControlEnabled, setRobotControlEnabled] = useState(false);
  const [robotCollisionProtectionEnabled, setRobotCollisionProtectionEnabled] = useState(false);
  const [teachingTasks, setTeachingTasks] = useState([]);
  const [activeTeachingTaskId, setActiveTeachingTaskId] = useState(null);
  const [activeTeachingParkingPointId, setActiveTeachingParkingPointId] = useState(null);
  const [robotParkingGhost, setRobotParkingGhost] = useState(null);
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
  const [parkingMergePlannerReady, setParkingMergePlannerReady] = useState(false);
  const [projectExportState, setProjectExportState] = useState({
    status: 'idle',
    byteLength: 0,
  });
  const [teachingPlayback, setTeachingPlayback] = useState(createIdleTeachingPlayback);
  const [sessionState, setSessionState] = useState({ status: 'checking', restored: false });
  const [loadState, setLoadState] = useState({
    loading: true,
    progress: 0.08,
    phase: '检查工作会话',
    detail: '正在确认服务实例并查找上次快照',
  });
  const [toast, setToast] = useState(null);
  const closeMapDetails = useCallback(() => setMapDetailsOpen(false), []);

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
    inspectorCollapsed,
    selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    teachingTasks,
    activeTeachingTaskId,
    activeTeachingParkingPointId,
    jointPoses,
  };

  useEffect(() => {
    const geometry = mapData?.geometry;
    return () => geometry?.dispose?.();
  }, [mapData?.geometry]);

  useEffect(() => {
    setRobotParkingGhost((current) => {
      if (!current) return current;
      const task = teachingTasks.find((item) => item.id === current.taskId);
      const parkingPoint = task?.parkingPoints?.find(
        (item) => item.id === current.parkingPointId,
      );
      const currentMapKey = mapData?.sourceHash || mapData?.mapId || mapData?.name || '';
      const currentRobotKey = selectedRobot?.id || selectedRobot?.relativePath || '';
      if (
        !parkingPoint
        || !currentMapKey
        || !currentRobotKey
        || current.mapKey !== currentMapKey
        || current.robotKey !== currentRobotKey
      ) return null;
      if (
        current.parkingPointName !== parkingPoint.name
        || current.taskName !== task.name
      ) {
        return {
          ...current,
          parkingPointName: parkingPoint.name,
          taskName: task.name,
        };
      }
      return current;
    });
  }, [
    mapData?.mapId,
    mapData?.name,
    mapData?.sourceHash,
    selectedRobot?.id,
    selectedRobot?.relativePath,
    teachingTasks,
  ]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      if (teachingPlaybackFrameRef.current !== null) {
        window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
      }
      teachingPlaybackFrameRef.current = null;
      teachingPlaybackRuntimeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const syncPageFromHistory = () => {
      const nextPage = appPageFromLocation();
      setAppPage(nextPage);
    };
    window.addEventListener('popstate', syncPageFromHistory);
    return () => window.removeEventListener('popstate', syncPageFromHistory);
  }, []);

  useEffect(() => {
    document.title = appPage === APP_PAGE_TEACHING_DATA
      ? '示教数据 · Atlas Route Studio'
      : 'Atlas Route Studio';
  }, [appPage]);

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
        activeTeachingParkingPointId: current.activeTeachingParkingPointId,
        validation: current.validation,
        pointColorMode: current.pointColorMode,
        meshRenderQuality: current.meshRenderQuality,
        showWaypoints3D: current.showWaypoints3D,
        collapsedPanel: current.collapsedPanel,
        inspectorCollapsed: current.inspectorCollapsed,
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
        sourceModifiedAt = null,
        sourceMimeType = 'application/octet-stream',
        sourceKind = 'unknown',
        loadedAt = null,
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
      const normalizedByteLength = Math.max(0, Number(sourceByteLength) || 0);
      const normalizedLoadedAt = normalizeTimestamp(loadedAt) || new Date().toISOString();
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
        byteLength: normalizedByteLength,
        fileModifiedAt: normalizeTimestamp(sourceModifiedAt),
        mimeType: String(sourceMimeType || 'application/octet-stream'),
        loadedAt: normalizedLoadedAt,
        sourceKind: String(sourceKind || 'unknown'),
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
        setTeachingTasks([]);
        setActiveTeachingTaskId(null);
        setActiveTeachingParkingPointId(null);
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
              {
                fileModifiedAt: nextMap.fileModifiedAt,
                mimeType: nextMap.mimeType,
                loadedAt: nextMap.loadedAt,
                sourceKind: nextMap.sourceKind,
              },
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
          sourceModifiedAt: record.fileModifiedAt || null,
          sourceMimeType: record.mimeType || 'application/octet-stream',
          sourceKind: record.sourceKind || 'session-cache',
          loadedAt: record.loadedAt || record.savedAt || null,
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
          setInspectorCollapsed(snapshot?.ui?.inspectorCollapsed === true);
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
                {
                  fileModifiedAt: restoredMap.fileModifiedAt,
                  mimeType: restoredMap.mimeType,
                  loadedAt: restoredMap.loadedAt,
                  sourceKind: restoredMap.sourceKind,
                },
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
              byteLength: Math.max(0, Number(project.map.byteLength) || 0),
              fileModifiedAt: normalizeTimestamp(
                project.map.fileModifiedAt || project.map.modifiedAt,
              ),
              mimeType: String(project.map.mimeType || 'application/octet-stream'),
              loadedAt: normalizeTimestamp(project.map.loadedAt),
              sourceKind: String(project.map.sourceKind || 'project-metadata'),
              geometrySource: 'project-metadata',
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
            const restoredTeachingTaskId = teachingTaskIds.has(snapshot?.ui?.activeTeachingTaskId)
              ? snapshot.ui.activeTeachingTaskId
              : project.teachingTasks[0]?.id || null;
            const restoredTeachingTask = project.teachingTasks.find(
              (task) => task.id === restoredTeachingTaskId,
            );
            const restoredParkingPointIds = new Set(
              (restoredTeachingTask?.parkingPoints || []).map((parkingPoint) => parkingPoint.id),
            );
            setActiveTeachingTaskId(restoredTeachingTaskId);
            setActiveTeachingParkingPointId(
              restoredParkingPointIds.has(snapshot?.ui?.activeTeachingParkingPointId)
                ? snapshot.ui.activeTeachingParkingPointId
                : restoredTeachingTask?.parkingPoints?.[0]?.id || null,
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
          setInspectorCollapsed(false);
          setSelectedRobot(null);
          setRobotPose(normalizeRobotPose(null));
          setRobotJointValues({});
          setLockedRobotJointNames([]);
          setRobotControlEnabled(false);
          setTeachingTasks([]);
          setActiveTeachingTaskId(null);
          setActiveTeachingParkingPointId(null);
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
    inspectorCollapsed,
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
    activeTeachingParkingPointId,
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
        let responseMetadata = null;
        const buffer = await fetchBufferWithProgress(
          '/xian_map.ply',
          (progress) => setLoadState({ loading: true, progress, phase: '读取示例地图' }),
          (metadata) => { responseMetadata = metadata; },
        );
        await processMapBuffer(buffer, 'xian_map.ply', {
          ...options,
          sourceModifiedAt: options.sourceModifiedAt ?? responseMetadata?.modifiedAt,
          sourceMimeType: options.sourceMimeType ?? responseMetadata?.mimeType,
          sourceKind: options.sourceKind || 'example-map',
        });
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
      await processMapBuffer(buffer, file.name, {
        sourceModifiedAt: file.lastModified || null,
        sourceMimeType: file.type || 'application/octet-stream',
        sourceKind: 'local-file',
      });
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
      const { readProjectFile } = await import('./lib/projectArchive.js');
      const importedFile = await readProjectFile(file);
      const payload = importedFile.payload;
      const project = normalizeProject(payload);
      setWaypoints(project.waypoints);
      setEdges(project.edges);
      setTeachingTasks(project.teachingTasks);
      setJointPoses(project.jointPoses);
      setActiveTeachingTaskId(project.teachingTasks[0]?.id || null);
      setActiveTeachingParkingPointId(project.teachingTasks[0]?.parkingPoints?.[0]?.id || null);
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
          sourceHash: project.map.sourceHash || null,
          sourceHashKind: project.map.sourceHashKind || 'file',
          byteLength: Math.max(0, Number(project.map.byteLength) || 0),
          fileModifiedAt: normalizeTimestamp(
            project.map.fileModifiedAt || project.map.modifiedAt,
          ),
          mimeType: String(project.map.mimeType || 'application/octet-stream'),
          loadedAt: normalizeTimestamp(project.map.loadedAt),
          sourceKind: String(project.map.sourceKind || 'project-metadata'),
          geometrySource: 'project-metadata',
          metadataOnly: true,
        });
      }
      notify(
        `${importedFile.source === 'zip' ? 'ZIP 工程包' : '工程配置'}已加载 · ${project.waypoints.length} 导航点 / ${project.teachingTasks.length} 示教任务${importedFile.source === 'zip' ? ` / ${importedFile.manifest?.statistics?.cameraFrameCount || 0} 相机帧` : ''}`,
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
      notify(`工程文件无效：${error.message}`, 'error');
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
    (pose, options = {}) => {
      const source = options.source || 'point-cloud-slice';
      const finitePoseValue = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const point = {
        id: createId('wp'),
        name: `P${String(waypoints.length + 1).padStart(2, '0')}`,
        pose: {
          x: finitePoseValue(pose?.x),
          y: finitePoseValue(pose?.y),
          z: finitePoseValue(pose?.z),
          roll: finitePoseValue(pose?.roll),
          pitch: finitePoseValue(pose?.pitch),
          yaw: finitePoseValue(pose?.yaw),
        },
        source,
      };
      setWaypoints((current) => [...current, point]);
      setSelectedWaypointId(point.id);
      setSelectedEdgeId(null);
      invalidateConnectivity();
      notify(
        options.message
          || (source === 'robot-current-pose'
            ? `${point.name} 已记录机器人当前 MAP 位姿`
            : `${point.name} 已绑定原始三维坐标`),
        'success',
      );
    },
    [invalidateConnectivity, notify, waypoints.length],
  );

  const addWaypointFromToolbar = useCallback(() => {
    setMode('add');
    setConnectionSourceId(null);

    if (!selectedRobot || robotLoadState.status !== 'loaded') {
      notify(
        '二维点选模式已开启；加载机器人后再次点击可直接记录机器人当前位置',
        'info',
      );
      return;
    }

    const currentPose = normalizeRobotPose(robotPose);
    setShowWaypoints3D(true);
    addWaypoint(
      {
        x: currentPose.position.x,
        y: currentPose.position.y,
        z: currentPose.position.z,
        roll: currentPose.rpy.roll,
        pitch: currentPose.rpy.pitch,
        yaw: currentPose.rpy.yaw,
      },
      {
        source: 'robot-current-pose',
        message: `已记录机器人当前位置 · 可继续点击二维截面添加导航点`,
      },
    );
  }, [addWaypoint, notify, robotLoadState.status, robotPose, selectedRobot]);

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

  const createTeachingTask = useCallback((options = {}) => {
    if (!mapData?.bounds) {
      notify('请先加载地图，再创建虚拟示教任务', 'warning');
      return;
    }
    if (!selectedRobot || robotLoadState.status !== 'loaded') {
      notify('请先完成机器人模型加载，再创建虚拟示教任务', 'warning');
      return;
    }
    const timestamp = new Date().toISOString();
    const pose = normalizeRobotPose(robotPose);
    const includeCurrentParkingPoint = Boolean(options?.includeCurrentParkingPoint);
    const requestedName = String(options?.name || '').trim();
    const initialParkingPoint = includeCurrentParkingPoint
      ? {
          id: createId('parking-point'),
          name: '停车点 P01',
          sequence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          mapPose: {
            frameId: 'map',
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          },
          poses: [],
        }
      : null;
    const task = {
      id: createId('teach-task'),
      name: requestedName || `示教任务 ${String(teachingTasks.length + 1).padStart(2, '0')}`,
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
      parkingPoints: initialParkingPoint ? [initialParkingPoint] : [],
    };
    setRobotParkingGhost(null);
    setTeachingTasks((current) => [...current, task]);
    setActiveTeachingTaskId(task.id);
    setActiveTeachingParkingPointId(initialParkingPoint?.id || null);
    setTeachingCaptureState({ status: 'idle', message: '' });
    notify(
      initialParkingPoint
        ? `${task.name} 已创建 · ${initialParkingPoint.name} 已记录`
        : `${task.name} 已创建 · 可随时添加停车点`,
      'success',
    );
  }, [mapData, notify, robotLoadState.status, robotPose, selectedRobot, teachingTasks.length]);

  const selectTeachingTask = useCallback((id) => {
    const task = teachingTasks.find((item) => item.id === id);
    setActiveTeachingTaskId(id);
    setActiveTeachingParkingPointId(task?.parkingPoints?.[0]?.id || null);
    setRobotParkingGhost(null);
    setTeachingCaptureState({ status: 'idle', message: '' });
  }, [teachingTasks]);

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
        setActiveTeachingParkingPointId(remaining[0]?.parkingPoints?.[0]?.id || null);
      }
      notify(`${task?.name || '示教任务'} 已删除`, 'info');
    },
    [activeTeachingTaskId, notify, teachingTasks],
  );

  const createTeachingParkingPoint = useCallback(() => {
    const task = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    if (!task) {
      notify('请先新建或选择一个示教任务', 'warning');
      return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该示教任务不一致，无法记录停车点', 'warning');
      return;
    }
    const timestamp = new Date().toISOString();
    const pose = normalizeRobotPose(robotPose);
    const parkingPoints = task.parkingPoints || [];
    const parkingPoint = {
      id: createId('parking-point'),
      name: `停车点 P${String(parkingPoints.length + 1).padStart(2, '0')}`,
      sequence: parkingPoints.length + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      mapPose: {
        frameId: 'map',
        position: { ...pose.position },
        rpy: { ...pose.rpy },
      },
      poses: [],
    };
    setRobotParkingGhost(null);
    setTeachingTasks((current) => current.map((item) => (
      item.id === task.id
        ? {
            ...item,
            parkingPoints: [...(item.parkingPoints || []), parkingPoint],
            updatedAt: timestamp,
          }
        : item
    )));
    setActiveTeachingParkingPointId(parkingPoint.id);
    setTeachingCaptureState({ status: 'idle', message: '' });
    notify(`${parkingPoint.name} 已记录 · MAP XYZ/RPY`, 'success');
  }, [
    activeTeachingTaskId,
    notify,
    robotLoadState.status,
    robotPose,
    teachingContextMatches,
    teachingTasks,
  ]);

  const selectTeachingParkingPoint = useCallback((id) => {
    setActiveTeachingParkingPointId(id);
    setRobotParkingGhost(null);
    setTeachingCaptureState({ status: 'idle', message: '' });
  }, []);

  const previewTeachingParkingPoint = useCallback((id) => {
    const task = teachingTasks.find((item) => (
      (item.parkingPoints || []).some((parkingPoint) => parkingPoint.id === id)
    ));
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === id);
    const currentTask = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    const currentParkingPoint = currentTask?.parkingPoints?.find(
      (item) => item.id === activeTeachingParkingPointId,
    );

    setActiveTeachingTaskId(task?.id || activeTeachingTaskId);
    setActiveTeachingParkingPointId(id);
    setTeachingCaptureState({ status: 'idle', message: '' });

    if (!task || !parkingPoint) {
      setRobotParkingGhost(null);
      return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      setRobotParkingGhost(null);
      notify('停车点已选择；请加载与任务匹配的地图和机器人后再生成虚影', 'warning');
      return;
    }

    const currentPose = normalizeRobotPose(robotPose);
    const targetPose = normalizeRobotPose(parkingPoint.mapPose);
    const deltaX = targetPose.position.x - currentPose.position.x;
    const deltaY = targetPose.position.y - currentPose.position.y;
    const deltaZ = targetPose.position.z - currentPose.position.z;
    const planarDistance = Math.hypot(deltaX, deltaY);
    const straightDistance = Math.hypot(deltaX, deltaY, deltaZ);
    const sourceParkingPose = currentParkingPoint
      ? normalizeRobotPose(currentParkingPoint.mapPose)
      : null;
    const sourceParkingDistance = sourceParkingPose
      ? Math.hypot(
          sourceParkingPose.position.x - currentPose.position.x,
          sourceParkingPose.position.y - currentPose.position.y,
          sourceParkingPose.position.z - currentPose.position.z,
        )
      : Number.POSITIVE_INFINITY;

    setRobotParkingGhost({
      revision: createId('robot-parking-ghost'),
      taskId: task.id,
      taskName: task.name,
      parkingPointId: parkingPoint.id,
      parkingPointName: parkingPoint.name,
      sourceParkingPointId: sourceParkingDistance <= 0.15 ? currentParkingPoint?.id || '' : '',
      sourceName: sourceParkingDistance <= 0.15
        ? currentParkingPoint?.name || '当前机器人'
        : '当前机器人',
      targetPose,
      jointValues: { ...normalizeRobotJointValues(robotJointValues) },
      mapKey: mapData?.sourceHash || mapData?.mapId || mapData?.name || '',
      robotKey: selectedRobot?.id || selectedRobot?.relativePath || '',
      createdAt: new Date().toISOString(),
    });
    setCollapsedPanel((current) => current === '3d' ? null : current);
    requestSynchronizedFocus('robot-ghost', parkingPoint.id);
    notify(
      `${parkingPoint.name} 虚影已生成 · XY ${planarDistance.toFixed(2)} m / 直线 ${straightDistance.toFixed(2)} m`,
      'info',
    );
  }, [
    activeTeachingParkingPointId,
    activeTeachingTaskId,
    mapData,
    notify,
    requestSynchronizedFocus,
    robotJointValues,
    robotLoadState.status,
    robotPose,
    selectedRobot,
    teachingContextMatches,
    teachingTasks,
  ]);

  const clearRobotParkingGhost = useCallback(() => {
    setRobotParkingGhost(null);
  }, []);

  const renameTeachingParkingPoint = useCallback((taskId, parkingPointId, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === taskId
        ? {
            ...task,
            updatedAt,
            parkingPoints: (task.parkingPoints || []).map((parkingPoint) => (
              parkingPoint.id === parkingPointId
                ? { ...parkingPoint, name: nextName, updatedAt }
                : parkingPoint
            )),
          }
        : task
    )));
  }, []);

  const deleteTeachingParkingPoint = useCallback((taskId, parkingPointId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    if (!task) return;
    const removed = task.parkingPoints?.find((item) => item.id === parkingPointId);
    const remaining = (task.parkingPoints || [])
      .filter((item) => item.id !== parkingPointId)
      .map((item, index) => ({ ...item, sequence: index + 1 }));
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((item) => (
      item.id === taskId ? { ...item, parkingPoints: remaining, updatedAt } : item
    )));
    if (activeTeachingParkingPointId === parkingPointId) {
      setActiveTeachingParkingPointId(remaining[0]?.id || null);
    }
    notify(`${removed?.name || '停车点'} 已删除`, 'info');
  }, [activeTeachingParkingPointId, notify, teachingTasks]);

  const applyTeachingParkingPoint = useCallback(
    (taskId, parkingPointId) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
      if (!task || !parkingPoint) return;
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        notify('当前地图或机器人与该停车点不一致，无法应用', 'warning');
        return;
      }
      setRobotControlEnabled(false);
      setRobotPose(normalizeRobotPose(parkingPoint.mapPose));
      notify(`${parkingPoint.name} 已应用 · 机器人底盘已恢复到停车位置`, 'success');
    },
    [notify, robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const captureTeachingPoint = useCallback(async (options = {}) => {
    const createParkingPoint = options?.createParkingPoint === true;
    const task = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    if (!task) {
      notify('请先新建或选择一个示教任务', 'warning');
      return;
    }
    const selectedParkingPoint = task.parkingPoints?.find(
      (item) => item.id === activeTeachingParkingPointId,
    );
    if (!selectedParkingPoint && !createParkingPoint) {
      notify('请先新增或选择一个停车点', 'warning');
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
    const parkingPoints = task.parkingPoints || [];
    const parkingPoint = createParkingPoint
      ? {
          id: createId('parking-point'),
          name: `停车点 P${String(parkingPoints.length + 1).padStart(2, '0')}`,
          sequence: parkingPoints.length + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          mapPose: {
            frameId: 'map',
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          },
          poses: [],
        }
      : selectedParkingPoint;
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
      id: createId('teach-pose'),
      name: `A${String(parkingPoint.poses.length + 1).padStart(2, '0')}`,
      sequence: parkingPoint.poses.length + 1,
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
        ? {
            ...item,
            parkingPoints: createParkingPoint
              ? [
                  ...(item.parkingPoints || []),
                  { ...parkingPoint, poses: [point], updatedAt: timestamp },
                ]
              : item.parkingPoints.map((candidate) => (
                  candidate.id === parkingPoint.id
                    ? {
                        ...candidate,
                        poses: [...candidate.poses, point],
                        updatedAt: timestamp,
                      }
                    : candidate
                )),
            updatedAt: timestamp,
          }
        : item
    )));
    if (createParkingPoint) setActiveTeachingParkingPointId(parkingPoint.id);
    notify(
      `${parkingPoint.name} / ${point.name} ${createParkingPoint ? '已新建并示教' : '已示教'} · ${point.fullBodyJoints.count} 个全身关节${cameraCapture ? ' + 双目 RGB/XYZ' : ''}`,
      'success',
    );
    setTeachingCaptureState({
      status: 'complete',
      message: cameraCapture
        ? '左右 RGB 与点云已随机械臂姿态保存'
        : '机械臂姿态与全身关节已保存',
      pointId: point.id,
      parkingPointId: parkingPoint.id,
      frameCount: cameraCapture ? Object.keys(cameraCapture.frames || {}).length : 0,
    });
  }, [
    activeTeachingParkingPointId,
    activeTeachingTaskId,
    notify,
    robotJointValues,
    robotLoadState.status,
    robotLoadState.zividCount,
    robotPose,
    teachingContextMatches,
    teachingTasks,
  ]);

  const renameTeachingPoint = useCallback((taskId, parkingPointId, pointId, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === taskId
        ? {
            ...task,
            updatedAt,
            parkingPoints: task.parkingPoints.map((parkingPoint) => (
              parkingPoint.id === parkingPointId
                ? {
                    ...parkingPoint,
                    updatedAt,
                    poses: parkingPoint.poses.map((point) => (
                      point.id === pointId ? { ...point, name: nextName } : point
                    )),
                  }
                : parkingPoint
            )),
          }
        : task
    )));
  }, []);

  const deleteTeachingPoint = useCallback((taskId, parkingPointId, pointId) => {
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      return {
        ...task,
        updatedAt,
        parkingPoints: task.parkingPoints.map((parkingPoint) => (
          parkingPoint.id === parkingPointId
            ? {
                ...parkingPoint,
                updatedAt,
                poses: parkingPoint.poses
                  .filter((point) => point.id !== pointId)
                  .map((point, index) => ({ ...point, sequence: index + 1 })),
              }
            : parkingPoint
        )),
      };
    }));
    notify('机械臂示教姿态已删除', 'info');
  }, [notify]);

  const applyTeachingPoint = useCallback(
    (taskId, parkingPointId, pointId) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
      const point = parkingPoint?.poses?.find((item) => item.id === pointId);
      if (!task || !point) return;
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        notify('当前地图或机器人与该机械臂姿态不一致，无法应用', 'warning');
        return;
      }
      setRobotControlEnabled(false);
      setRobotPose(normalizeRobotPose(point.mapPose));
      setRobotJointValues(
        normalizeRobotJointValues(point.fullBodyJoints?.values),
      );
      notify(`${parkingPoint.name} / ${point.name} 已应用 · 地图定位与全身关节已恢复`, 'success');
    },
    [notify, robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const handleParkingMergePlannerChange = useCallback((provider) => {
    const normalized = typeof provider === 'function' ? provider : null;
    parkingMergePlannerRef.current = normalized;
    setParkingMergePlannerReady(Boolean(normalized));
  }, []);

  const analyzeTeachingParkingPointMerge = useCallback(
    async (taskId, options = {}) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      if (!task) throw new Error('示教任务不存在或已经被删除');
      if ((task.parkingPoints?.length || 0) < 2) {
        throw new Error('至少需要两个停车点才能执行近邻聚类');
      }
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        throw new Error('请加载该任务绑定的地图与机器人后再分析');
      }
      const planner = parkingMergePlannerRef.current;
      if (typeof planner !== 'function') {
        throw new Error('机器人运动学规划器正在准备，请稍后重新分析');
      }
      return planner({ task, ...options });
    },
    [robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const mergeTeachingParkingPoints = useCallback(
    (taskId, requestedClusters = [], analysis = {}) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const mergeableClusters = requestedClusters.filter((cluster) => (
        cluster?.feasible
        && cluster.candidate?.mapPose
        && Array.isArray(cluster.memberIds)
        && cluster.memberIds.length >= 2
      ));
      if (!task || !mergeableClusters.length) {
        notify('没有可执行的停车点合并方案', 'warning');
        return { success: false, mergedClusterCount: 0 };
      }

      const timestamp = new Date().toISOString();
      let parkingPoints = [...(task.parkingPoints || [])];
      let firstRetainedParkingPointId = null;
      let mergedClusterCount = 0;
      let removedParkingPointCount = 0;
      let replannedPoseCount = 0;
      const consumedParkingPointIds = new Set();

      mergeableClusters.forEach((cluster) => {
        const memberIdSet = new Set(
          cluster.memberIds.filter((id) => !consumedParkingPointIds.has(id)),
        );
        const memberParkingPoints = parkingPoints.filter((item) => memberIdSet.has(item.id));
        if (memberParkingPoints.length < 2) return;
        const sourcePoses = memberParkingPoints.flatMap((parkingPoint) => (
          (parkingPoint.poses || []).map((pose) => ({ parkingPoint, pose }))
        ));
        const plannedByPoseId = new Map(
          (cluster.plannedPoses || []).map((plannedPose) => [plannedPose.poseId, plannedPose]),
        );
        if (
          sourcePoses.some(({ pose }) => {
            const plan = plannedByPoseId.get(pose.id);
            return !plan?.feasible || !plan.jointValues;
          })
        ) return;

        const normalizeMapPose = (value) => {
          const pose = normalizeRobotPose(value);
          return {
            frameId: 'map',
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          };
        };
        const commonMapPose = normalizeMapPose(cluster.candidate.mapPose);
        const retainedParkingPoint = memberParkingPoints.find(
          (item) => item.id === cluster.candidate.anchorParkingPointId,
        ) || memberParkingPoints[0];
        const mergeId = createId('parking-merge');
        const sourceParkingPoints = memberParkingPoints.map((parkingPoint) => ({
          id: parkingPoint.id,
          name: parkingPoint.name,
          mapPose: normalizeMapPose(parkingPoint.mapPose),
          poseCount: parkingPoint.poses?.length || 0,
        }));
        const mergedPoses = sourcePoses.map(({ parkingPoint, pose }, index) => {
          const plan = plannedByPoseId.get(pose.id);
          const jointValues = normalizeRobotJointValues(plan.jointValues);
          return {
            ...pose,
            sequence: index + 1,
            mapPose: normalizeMapPose(commonMapPose),
            fullBodyJoints: {
              ...pose.fullBodyJoints,
              source: 'parking-point-merge-dls-replan',
              count: Object.keys(jointValues).length,
              values: jointValues,
            },
            replanningHistory: [
              ...(Array.isArray(pose.replanningHistory) ? pose.replanningHistory : []),
              {
                mergeId,
                replannedAt: timestamp,
                method: analysis.method || 'common-base-dual-optical-dls',
                sourceParkingPointId: parkingPoint.id,
                sourceParkingPointName: parkingPoint.name,
                sourceMapPose: normalizeMapPose(pose.mapPose),
                sourceJointValues: normalizeRobotJointValues(
                  pose.fullBodyJoints?.values,
                ),
                commonMapPose: normalizeMapPose(commonMapPose),
                positionTolerance: Number(analysis.positionTolerance) || 0,
                rotationTolerance: Number(analysis.rotationTolerance) || 0,
                positionError: Number(plan.positionError) || 0,
                rotationError: Number(plan.rotationError) || 0,
                sideErrors: plan.sideErrors || {},
              },
            ],
          };
        });
        const originalIndices = memberParkingPoints.map((parkingPoint) => (
          parkingPoints.findIndex((item) => item.id === parkingPoint.id)
        ));
        const insertionIndex = Math.max(0, Math.min(...originalIndices));
        const priorMergeIds = new Set();
        const priorMergeHistory = memberParkingPoints.flatMap((parkingPoint) => (
          Array.isArray(parkingPoint.mergeHistory) ? parkingPoint.mergeHistory : []
        )).filter((history) => {
          const historyId = String(history?.id || '');
          if (historyId && priorMergeIds.has(historyId)) return false;
          if (historyId) priorMergeIds.add(historyId);
          return true;
        });
        const mergedParkingPoint = {
          ...retainedParkingPoint,
          updatedAt: timestamp,
          mapPose: commonMapPose,
          poses: mergedPoses,
          mergeHistory: [
            ...priorMergeHistory,
            {
              id: mergeId,
              mergedAt: timestamp,
              method: analysis.method || 'xy-single-link+common-base-dual-optical-dls',
              candidateSource: cluster.candidate.source,
              distanceThreshold: Number(analysis.distanceThreshold) || 0,
              positionTolerance: Number(analysis.positionTolerance) || 0,
              rotationTolerance: Number(analysis.rotationTolerance) || 0,
              sourceParkingPoints,
              poseCount: mergedPoses.length,
              maximumPositionError: Number(cluster.candidate.maximumPositionError) || 0,
              maximumRotationError: Number(cluster.candidate.maximumRotationError) || 0,
            },
          ],
        };

        parkingPoints = parkingPoints.filter((item) => !memberIdSet.has(item.id));
        parkingPoints.splice(insertionIndex, 0, mergedParkingPoint);
        memberIdSet.forEach((id) => consumedParkingPointIds.add(id));
        firstRetainedParkingPointId ||= retainedParkingPoint.id;
        mergedClusterCount += 1;
        removedParkingPointCount += memberParkingPoints.length - 1;
        replannedPoseCount += mergedPoses.length;
      });

      if (!mergedClusterCount) {
        notify('分析结果已经过期，请重新计算停车点合并方案', 'warning');
        return { success: false, mergedClusterCount: 0 };
      }
      parkingPoints = parkingPoints.map((parkingPoint, index) => ({
        ...parkingPoint,
        sequence: index + 1,
      }));
      setTeachingTasks((current) => current.map((item) => (
        item.id === taskId
          ? { ...item, parkingPoints, updatedAt: timestamp }
          : item
      )));
      setActiveTeachingTaskId(taskId);
      setActiveTeachingParkingPointId(firstRetainedParkingPointId);
      setTeachingCaptureState({ status: 'idle', message: '' });
      notify(
        `${mergedClusterCount} 组停车点已融合 · 减少 ${removedParkingPointCount} 个停车点 / 重规划 ${replannedPoseCount} 组姿态`,
        'success',
      );
      return {
        success: true,
        mergedClusterCount,
        removedParkingPointCount,
        replannedPoseCount,
        retainedParkingPointId: firstRetainedParkingPointId,
      };
    },
    [notify, teachingTasks],
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

  const exportProject = async () => {
    if (!mapData) {
      notify('请先加载地图或路径配置', 'error');
      return;
    }
    if (projectExportBusyRef.current) return;
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
    projectExportBusyRef.current = true;
    setProjectExportState({ status: 'packing', byteLength: 0 });
    notify('正在整理配置、RGB 与点云资源…', 'info');
    try {
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
      const { downloadProjectArchive } = await import('./lib/projectArchive.js');
      const archive = await downloadProjectArchive(
        payload,
        `virtual-teaching-${stamp}.zip`,
      );
      setProjectExportState({
        status: 'ready',
        byteLength: archive.byteLength,
        statistics: archive.manifest.statistics,
      });
      const sizeMb = archive.byteLength / (1024 * 1024);
      notify(
        teachingTasks.length
          ? `示教工程 ZIP 已导出 · ${sizeMb >= 0.1 ? `${sizeMb.toFixed(1)} MB` : `${Math.max(1, Math.round(archive.byteLength / 1024))} KB`}`
          : '工程 ZIP 已导出 · 当前未包含示教任务',
        teachingTasks.length ? 'success' : 'info',
      );
    } catch (error) {
      setProjectExportState({ status: 'error', byteLength: 0 });
      notify(`工程打包失败：${error.message}`, 'error');
    } finally {
      projectExportBusyRef.current = false;
    }
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
      notify(
        nextEnabled
          ? '碰撞保护已开启 · 底盘与轮组已排除'
          : '碰撞保护已关闭 · 检测资源已释放',
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

  const navigateAppPage = useCallback((nextPage) => {
    const normalized = nextPage === APP_PAGE_TEACHING_DATA
      ? APP_PAGE_TEACHING_DATA
      : APP_PAGE_WORKBENCH;
    if (normalized === APP_PAGE_TEACHING_DATA) {
      if (appPageFromLocation() !== APP_PAGE_TEACHING_DATA) {
        window.history.pushState(
          { atlasPage: APP_PAGE_TEACHING_DATA },
          '',
          '/teaching-data',
        );
      }
      setAppPage(APP_PAGE_TEACHING_DATA);
      return;
    }

    if (window.location.pathname !== '/') {
      window.history.replaceState({ atlasPage: APP_PAGE_WORKBENCH }, '', '/');
    }
    setAppPage(APP_PAGE_WORKBENCH);
  }, []);

  const advanceTeachingPlayback = useCallback(function advancePlayback(timestamp) {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'playing') {
      teachingPlaybackFrameRef.current = null;
      return;
    }

    if (runtime.lastTimestamp === null) {
      runtime.lastTimestamp = timestamp;
    } else {
      const frameDuration = Math.max(0, Math.min(250, timestamp - runtime.lastTimestamp));
      runtime.lastTimestamp = timestamp;
      runtime.segmentElapsedMs += frameDuration * runtime.speed;
    }

    let crossedBoundary = false;
    while (runtime.segmentIndex < runtime.plan.segments.length) {
      const activeSegment = runtime.plan.segments[runtime.segmentIndex];
      if (runtime.segmentElapsedMs < activeSegment.durationMs) break;
      const finalSample = sampleTeachingTrajectorySegment(activeSegment, 1);
      setRobotPose(normalizeRobotPose(finalSample.robotPose));
      setRobotJointValues(normalizeRobotJointValues(finalSample.robotJointValues));
      runtime.segmentElapsedMs -= activeSegment.durationMs;
      runtime.segmentIndex += 1;
      crossedBoundary = true;
    }

    if (runtime.segmentIndex >= runtime.plan.segments.length) {
      const finalSegment = runtime.plan.segments.at(-1);
      runtime.segmentIndex = Math.max(0, runtime.plan.segments.length - 1);
      runtime.segmentElapsedMs = finalSegment?.durationMs || 0;
      runtime.status = 'completed';
      const completedState = teachingPlaybackStateFromRuntime(runtime, 'completed');
      setTeachingPlayback({
        ...completedState,
        elapsedDurationMs: runtime.plan.totalDurationMs,
        overallProgress: 1,
        segmentProgress: 1,
      });
      teachingPlaybackRuntimeRef.current = null;
      teachingPlaybackFrameRef.current = null;
      notify(`${runtime.plan.taskName} 播放完成 · ${runtime.plan.poseCount} 个姿态已按规划到达`, 'success');
      return;
    }

    const segment = runtime.plan.segments[runtime.segmentIndex];
    if (runtime.activeParkingPointId !== segment.target?.parkingPointId) {
      runtime.activeParkingPointId = segment.target?.parkingPointId || null;
      setActiveTeachingParkingPointId(runtime.activeParkingPointId);
    }
    const shouldRender = crossedBoundary
      || runtime.lastAppliedTimestamp === null
      || timestamp - runtime.lastAppliedTimestamp >= 30;
    if (shouldRender) {
      const progress = segment.durationMs > 0
        ? runtime.segmentElapsedMs / segment.durationMs
        : 1;
      const sample = sampleTeachingTrajectorySegment(segment, progress);
      if (segment.phase === 'chassis') {
        setRobotPose(normalizeRobotPose(sample.robotPose));
      } else if (segment.phase === 'joints') {
        setRobotJointValues(normalizeRobotJointValues(sample.robotJointValues));
      }
      setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime));
      runtime.lastAppliedTimestamp = timestamp;
    }

    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advancePlayback);
  }, [notify]);

  const startTeachingTaskPlayback = useCallback((taskId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    if (!task) {
      notify('示教任务不存在或已经被删除', 'warning');
      return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('请先加载该任务绑定的地图与机器人，再播放轨迹', 'warning');
      return;
    }

    const current = latestWorkspaceRef.current;
    const plan = buildTeachingTaskTrajectory({
      task,
      currentRobotPose: current?.robotPose || robotPose,
      currentJointValues: current?.robotJointValues || robotJointValues,
      jointDefinitions: robotLoadState.movableJoints || [],
    });
    if (!plan.poseCount || !plan.segments.length) {
      notify('当前任务还没有可播放的机械臂示教姿态', 'warning');
      return;
    }

    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    const runtime = {
      plan,
      status: 'playing',
      segmentIndex: 0,
      segmentElapsedMs: 0,
      lastTimestamp: null,
      lastAppliedTimestamp: null,
      activeParkingPointId: null,
      speed: 1,
      context: {
        mapId: mapData?.mapId || mapData?.sourceHash || mapData?.name || '',
        robotId: selectedRobot?.id || selectedRobot?.relativePath || '',
      },
    };
    teachingPlaybackRuntimeRef.current = runtime;
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime));
    setRobotParkingGhost(null);
    setActiveTeachingTaskId(task.id);
    setActiveTeachingParkingPointId(plan.segments[0]?.target?.parkingPointId || null);
    setRobotControlEnabled(false);
    setCollapsedPanel((currentPanel) => currentPanel === '3d' ? null : currentPanel);
    focusRevisionRef.current += 1;
    setSynchronizedFocus({
      type: 'robot',
      id: selectedRobot?.id || selectedRobot?.relativePath || 'active-robot',
      revision: focusRevisionRef.current,
    });
    navigateAppPage(APP_PAGE_WORKBENCH);
    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advanceTeachingPlayback);
    notify(
      `${plan.taskName} 开始播放 · ${plan.populatedParkingPointCount} 个停车点 / ${plan.poseCount} 个姿态`,
      'info',
    );
  }, [
    advanceTeachingPlayback,
    mapData,
    navigateAppPage,
    notify,
    robotJointValues,
    robotLoadState,
    robotPose,
    selectedRobot,
    teachingContextMatches,
    teachingTasks,
  ]);

  const pauseTeachingTaskPlayback = useCallback(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'playing') return;
    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    teachingPlaybackFrameRef.current = null;
    runtime.status = 'paused';
    runtime.lastTimestamp = null;
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime, 'paused'));
  }, []);

  const resumeTeachingTaskPlayback = useCallback(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'paused') return;
    runtime.status = 'playing';
    runtime.lastTimestamp = null;
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime, 'playing'));
    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advanceTeachingPlayback);
  }, [advanceTeachingPlayback]);

  const stopTeachingTaskPlayback = useCallback((announce = true) => {
    const runtime = teachingPlaybackRuntimeRef.current;
    const wasRunning = Boolean(runtime && ['playing', 'paused'].includes(runtime.status));
    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    teachingPlaybackFrameRef.current = null;
    teachingPlaybackRuntimeRef.current = null;
    setTeachingPlayback(createIdleTeachingPlayback());
    if (announce && wasRunning) notify('示教轨迹播放已停止，机器人保留在当前位置', 'info');
  }, [notify]);

  const changeTeachingPlaybackSpeed = useCallback((requestedSpeed) => {
    const speed = [0.5, 1, 1.5, 2].includes(Number(requestedSpeed))
      ? Number(requestedSpeed)
      : 1;
    const runtime = teachingPlaybackRuntimeRef.current;
    if (runtime) runtime.speed = speed;
    setTeachingPlayback((current) => ({ ...current, speed }));
  }, []);

  useEffect(() => {
    if (appPage === APP_PAGE_TEACHING_DATA) pauseTeachingTaskPlayback();
  }, [appPage, pauseTeachingTaskPlayback]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState !== 'visible') pauseTeachingTaskPlayback();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [pauseTeachingTaskPlayback]);

  useEffect(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime) return;
    const mapId = mapData?.mapId || mapData?.sourceHash || mapData?.name || '';
    const robotId = selectedRobot?.id || selectedRobot?.relativePath || '';
    if (
      robotLoadState.status !== 'loaded'
      || runtime.context.mapId !== mapId
      || runtime.context.robotId !== robotId
    ) {
      stopTeachingTaskPlayback(false);
    }
  }, [
    mapData?.mapId,
    mapData?.name,
    mapData?.sourceHash,
    robotLoadState.status,
    selectedRobot,
    stopTeachingTaskPlayback,
  ]);

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
    <>
    <div
      className={`app-shell ${appPage === APP_PAGE_TEACHING_DATA ? 'is-route-background' : ''}`}
      data-app-page="workbench"
      aria-hidden={appPage === APP_PAGE_TEACHING_DATA}
    >
      <input ref={mapInputRef} className="visually-hidden" type="file" accept=".ply" onChange={handleMapFile} />
      <input ref={pathInputRef} className="visually-hidden" type="file" accept=".zip,.json,application/zip,application/x-zip-compressed,application/json" onChange={handlePathFile} />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Route size={20} strokeWidth={1.8} /></div>
          <div>
            <span>ATLAS / ROUTE</span>
            <strong>虚拟示教平台</strong>
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
          <button type="button" className="action-button" onClick={() => pathInputRef.current?.click()} title="加载 ZIP 工程包或兼容旧版 JSON">
            <FileArchive size={15} /> 加载路径
          </button>
          <RobotPicker
            selectedRobot={selectedRobot}
            loadState={robotLoadState}
            onSelect={handleSelectRobot}
          />
          <SpaceMouseControl inputRef={spaceMouseInputRef} onNotify={notify} />
          <button
            type="button"
            className="action-button teaching-data-page-link"
            aria-label="打开示教数据管理页"
            onClick={() => navigateAppPage(APP_PAGE_TEACHING_DATA)}
            disabled={teachingCaptureState.status === 'capturing'}
            title={teachingCaptureState.status === 'capturing'
              ? '请等待当前机器人姿态与相机快照完成记录'
              : '在独立页面中管理示教任务、点位与视觉快照'}
          >
            <Database size={15} />
            <span>示教数据</span>
            <b>{teachingTasks.length}</b>
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
          <div className="service-pill" title="局域网服务默认端口">
            <Server size={13} />
            <span>LAN</span>
            <strong>:21990</strong>
          </div>
        </div>
      </header>

      <main
        className={`workspace ${inspectorCollapsed ? 'is-inspector-collapsed' : ''}`}
        data-inspector-collapsed={inspectorCollapsed ? 'true' : 'false'}
      >
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
                className="panel-details-button"
                ref={mapDetailsButtonRef}
                aria-label="查看地图详细信息"
                disabled={!mapData?.bounds}
                onClick={() => setMapDetailsOpen(true)}
                title={mapData?.bounds ? '查看当前地图文件与空间范围' : '请先加载地图'}
              >
                <FileSearch size={13} />
                <span>地图详情</span>
              </button>
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
                robotTrajectoryActive={['playing', 'paused'].includes(teachingPlayback.status)}
                robotParkingGhost={robotParkingGhost}
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
                onParkingMergePlannerChange={handleParkingMergePlannerChange}
                onCollisionProtectionChange={handleRobotCollisionProtectionChange}
                onClearRobotParkingGhost={clearRobotParkingGhost}
                isActive={appPage === APP_PAGE_WORKBENCH}
              />
              <HeightRange
                bounds={mapData?.bounds}
                value={heightRange}
                onChange={setHeightRange}
                disabled={!mapData?.geometry}
              />
              <TeachingPlaybackDock
                playback={teachingPlayback}
                onPause={pauseTeachingTaskPlayback}
                onResume={resumeTeachingTaskPlayback}
                onStop={() => stopTeachingTaskPlayback()}
                onReplay={() => startTeachingTaskPlayback(teachingPlayback.taskId)}
                onSpeedChange={changeTeachingPlaybackSpeed}
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
                  const robotWaypointReady = option.id === 'add'
                    && Boolean(selectedRobot)
                    && robotLoadState.status === 'loaded';
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={mode === option.id ? 'is-active' : ''}
                      aria-label={option.label}
                      aria-pressed={mode === option.id}
                      data-robot-waypoint-ready={robotWaypointReady ? 'true' : undefined}
                      title={option.id === 'add'
                        ? robotWaypointReady
                          ? '记录机器人当前 MAP 位姿，并保持二维地图点选添加模式'
                          : '进入二维地图点选添加模式；加载机器人后可直接记录当前位置'
                        : undefined}
                      onClick={() => {
                        if (option.id === 'add') addWaypointFromToolbar();
                        else setActiveMode(option.id);
                      }}
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
          meshRenderQuality={meshRenderQuality}
          onMeshRenderQualityChange={setMeshRenderQuality}
          spaceMouseInputRef={spaceMouseInputRef}
          main3DCanvasRef={main3DCanvasRef}
          teachingTasks={teachingTasks}
          activeTeachingTaskId={activeTeachingTaskId}
          activeTeachingParkingPointId={activeTeachingParkingPointId}
          robotParkingGhostId={robotParkingGhost?.parkingPointId || null}
          jointPoses={jointPoses}
          zividCameraPoses={zividCameraPoses}
          cameraTeachingResult={cameraTeachingResult}
          teachingCaptureState={teachingCaptureState}
          collapsed={inspectorCollapsed}
          onCollapsedChange={setInspectorCollapsed}
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
          onCreateTeachingParkingPoint={createTeachingParkingPoint}
          onSelectTeachingParkingPoint={previewTeachingParkingPoint}
          onCaptureTeachingPoint={captureTeachingPoint}
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
          isWorkbenchActive={appPage === APP_PAGE_WORKBENCH}
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
          {mode === 'connect' && connectionSourceId
            ? '起点已锁定 · 请选择终点'
            : mode === 'add'
              ? selectedRobot && robotLoadState.status === 'loaded'
                ? '再次点击“添加导航点”记录机器人 · 或点击二维截面继续添加'
                : '点击二维截面添加导航点'
              : mode === 'box'
                ? '二维图左键拉框 · Delete 删除所选'
                : '拖动二维地图平移 · 滚轮缩放'}
        </span>
        <span>SCHEMA 1.3</span>
      </footer>

      {appPage === APP_PAGE_WORKBENCH && loadState.loading && (
        <div className="loading-curtain" role="status" aria-live="polite">
          <div className="loading-module">
            <div className="loading-module__top"><MapIcon size={18} /><span>{loadState.phase}</span><strong>{progressLabel}</strong></div>
            <div className="loading-track"><span style={{ width: `${Math.max(loadState.progress * 100, 4)}%` }} /></div>
            <small>{loadState.detail || '大型点云解析可能需要数秒，请保持页面开启'}</small>
          </div>
        </div>
      )}

      {appPage === APP_PAGE_WORKBENCH && toast && (
        <div className={`toast-message ${toast.kind}`} role="status">
          <span>{toast.kind === 'error' ? <X size={14} /> : <Check size={14} />}</span>
          {toast.message}
        </div>
      )}
      {appPage === APP_PAGE_WORKBENCH && mapDetailsOpen && mapData?.bounds && (
        <MapDetailsDialog
          mapData={mapData}
          onClose={closeMapDetails}
          returnFocusRef={mapDetailsButtonRef}
        />
      )}
    </div>
    {appPage === APP_PAGE_TEACHING_DATA && (
      <div className="app-shell is-teaching-data-page" data-app-page="teaching-data">
        <TeachingDataPage
          tasks={teachingTasks}
          activeTaskId={activeTeachingTaskId}
          activeParkingPointId={activeTeachingParkingPointId}
          mapData={mapData}
          heightRange={heightRange}
          pointColorMode={pointColorMode}
          robot={selectedRobot}
          robotLoadState={robotLoadState}
          robotJointValues={robotJointValues}
          captureState={teachingCaptureState}
          parkingMergePlannerReady={parkingMergePlannerReady}
          projectExportState={projectExportState}
          sessionState={sessionState}
          onBack={() => navigateAppPage(APP_PAGE_WORKBENCH)}
          onSelectTask={selectTeachingTask}
          onRenameTask={renameTeachingTask}
          onDeleteTask={deleteTeachingTask}
          onSelectParkingPoint={selectTeachingParkingPoint}
          onRenameParkingPoint={renameTeachingParkingPoint}
          onDeleteParkingPoint={deleteTeachingParkingPoint}
          onApplyParkingPoint={applyTeachingParkingPoint}
          onRenamePoint={renameTeachingPoint}
          onDeletePoint={deleteTeachingPoint}
          onApplyPoint={applyTeachingPoint}
          onPlayTask={startTeachingTaskPlayback}
          onAnalyzeParkingPointMerge={analyzeTeachingParkingPointMerge}
          onMergeParkingPoints={mergeTeachingParkingPoints}
          onExportProject={exportProject}
        />

        {loadState.loading && (
          <div className="loading-curtain" role="status" aria-live="polite">
            <div className="loading-module">
              <div className="loading-module__top"><Database size={18} /><span>{loadState.phase}</span><strong>{progressLabel}</strong></div>
              <div className="loading-track"><span style={{ width: `${Math.max(loadState.progress * 100, 4)}%` }} /></div>
              <small>{loadState.detail || '正在恢复示教任务与视觉快照'}</small>
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
    )}
    </>
  );
}
