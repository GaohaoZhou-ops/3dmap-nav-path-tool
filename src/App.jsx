import { useCallback, useEffect, useRef, useState } from 'react';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  Box,
  Check,
  CircleDot,
  Download,
  FileJson,
  FolderOpen,
  GitBranch,
  Layers2,
  Map as MapIcon,
  MousePointer2,
  Plus,
  Route,
  Server,
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

const initialValidation = { status: 'idle', unreachableCount: 0, checkedAt: null };

const defaultLimits = {
  minSpeed: 0.2,
  maxSpeed: 1,
  minAcceleration: -0.8,
  maxAcceleration: 0.8,
};

const waitForPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));

function serializeBounds(box) {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
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
  const [loadState, setLoadState] = useState({ loading: false, progress: 0, phase: '' });
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const geometry = mapData?.geometry;
    return () => geometry?.dispose?.();
  }, [mapData?.geometry]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const notify = useCallback((message, kind = 'success') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, kind });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const invalidateConnectivity = useCallback(() => {
    setValidation(initialValidation);
    setEdges((current) => current.map((edge) => ({ ...edge, status: 'unchecked' })));
  }, []);

  const processMapBuffer = useCallback(
    async (buffer, name, options = {}) => {
      const { preserveGraph = false, preferredSlice = null } = options;
      setLoadState({ loading: true, progress: 1, phase: '解析点云结构' });
      await waitForPaint();
      let geometry;
      try {
        const loader = new PLYLoader();
        geometry = loader.parse(buffer);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const positions = geometry.getAttribute('position')?.array;
        if (!positions?.length || !geometry.boundingBox) {
          geometry.dispose();
          throw new Error('PLY 文件中没有可用的顶点坐标');
        }
        const colors = geometry.getAttribute('color')?.array || null;
        const bounds = serializeBounds(geometry.boundingBox);
        const nextSlice = clampSlice(preferredSlice || suggestedSlice(positions, bounds), bounds);
        const nextMap = {
          name,
          pointCount: positions.length / 3,
          bounds,
          positions,
          colors,
          geometry,
          metadataOnly: false,
        };
        setMapData(nextMap);
        setHeightRange(nextSlice);
        setProjectionStats({ selectedCount: 0 });
        if (!preserveGraph) {
          setWaypoints([]);
          setEdges([]);
          setSelectedWaypointId(null);
          setSelectedEdgeId(null);
          setConnectionSourceId(null);
          setValidation(initialValidation);
        }
        setLoadState({ loading: false, progress: 1, phase: '' });
        notify(`${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点`);
        return nextMap;
      } catch (error) {
        geometry?.dispose?.();
        setLoadState({ loading: false, progress: 0, phase: '' });
        throw error;
      }
    },
    [notify],
  );

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
        await loadExample({ preserveGraph: true, preferredSlice: project.slice });
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
    if (nextMode === 'add') notify('添加模式：在二维截面上点击放置导航点', 'info');
    if (nextMode === 'connect') notify('连接模式：先选择起点，再选择终点', 'info');
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

  const selectEdge = useCallback((id) => {
    setSelectedEdgeId(id);
    setSelectedWaypointId(null);
  }, []);

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
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(payload, `route-graph-${stamp}.json`);
    notify('JSON 路径工程已导出');
  };

  const handleProjectionStats = useCallback((stats) => setProjectionStats(stats), []);
  const handleViewChange = useCallback((nextView) => {
    view2dRef.current = nextView;
  }, []);

  const modeOptions = [
    { id: 'select', label: '选择 / 漫游', icon: MousePointer2 },
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
        <div className="visual-workspace">
          <section className="viewport-panel panel-3d">
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
            </div>
            <div className="panel-body">
              <PointCloudViewer
                mapData={mapData}
                heightRange={heightRange}
                waypoints={waypoints}
                edges={edges}
                selectedWaypointId={selectedWaypointId}
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

          <section className="viewport-panel panel-2d">
            <div className="panel-heading map-heading">
              <div className="panel-heading__title">
                <span className="panel-index">02</span>
                <div><small>COMPRESSED SLICE</small><strong>二维路径图</strong></div>
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
            </div>
            <div className="panel-body">
              <Map2DView
                mapData={mapData}
                heightRange={heightRange}
                waypoints={waypoints}
                edges={edges}
                mode={mode}
                connectionSourceId={connectionSourceId}
                selectedWaypointId={selectedWaypointId}
                selectedEdgeId={selectedEdgeId}
                onAddWaypoint={addWaypoint}
                onSelectWaypoint={selectWaypoint}
                onSelectEdge={selectEdge}
                onConnectTarget={connectTarget}
                onClearSelection={clearSelection}
                onProjectionStats={handleProjectionStats}
                onViewChange={handleViewChange}
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
          onSelectWaypoint={selectWaypoint}
          onSelectEdge={selectEdge}
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
        <span className="statusbar__hint">
          {mode === 'connect' && connectionSourceId ? '起点已锁定 · 请选择终点' : mode === 'add' ? '点击二维截面添加导航点' : '拖动二维地图平移 · 滚轮缩放'}
        </span>
        <span>SCHEMA 1.0</span>
      </footer>

      {loadState.loading && (
        <div className="loading-curtain" role="status" aria-live="polite">
          <div className="loading-module">
            <div className="loading-module__top"><MapIcon size={18} /><span>{loadState.phase}</span><strong>{progressLabel}</strong></div>
            <div className="loading-track"><span style={{ width: `${Math.max(loadState.progress * 100, 4)}%` }} /></div>
            <small>大型点云解析可能需要数秒，请保持页面开启</small>
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
