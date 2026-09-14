import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Compass,
  MoveHorizontal,
  Route,
  Ruler,
  ScanLine,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { calculatePathDistances } from '../lib/pathMetrics.js';
import { resolveMeshRenderQuality } from '../lib/mapGeometry.js';
import FloatingRobotJointPanel from './FloatingRobotJointPanel.jsx';
import VirtualTeachingPanel from './VirtualTeachingPanel.jsx';
import ZividCameraPanel from './ZividCameraPanel.jsx';

function NumericField({ label, value, unit, step = '0.01', onCommit }) {
  const [draft, setDraft] = useState(String(Number(value).toFixed(2)));

  useEffect(() => {
    setDraft(String(Number(value).toFixed(2)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(Number(value).toFixed(2)));
  };

  return (
    <label className="numeric-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}

const statusMeta = {
  connected: { label: '可互达', className: 'connected' },
  unreachable: { label: '未互达', className: 'unreachable' },
  unchecked: { label: '待检测', className: 'unchecked' },
};

export default function Inspector({
  mapData,
  heightRange,
  waypoints,
  edges,
  selectedWaypointId,
  selectedEdgeId,
  validation,
  robot,
  robotLoadState,
  robotPose,
  robotJointValues,
  lockedRobotJointNames = [],
  robotControlEnabled,
  meshRenderQuality = 'auto',
  onMeshRenderQualityChange,
  spaceMouseInputRef,
  main3DCanvasRef,
  teachingTasks = [],
  activeTeachingTaskId,
  jointPoses = [],
  zividCameraPoses,
  cameraTeachingResult,
  teachingCaptureState,
  onRunConnectivity,
  onSelectWaypoint,
  onSearchWaypoint,
  onSelectEdge,
  onClearSelection,
  onUpdateWaypoint,
  onUpdateEdge,
  onDeleteWaypoint,
  onDeleteEdge,
  onCreateTeachingTask,
  onSelectTeachingTask,
  onCaptureTeachingPoint,
  onOpenTeachingDataPage,
  onUpdateRobotJointValue,
  onToggleRobotJointLock,
  onUnlockAllRobotJoints,
  onZeroRobotJoints,
  onCaptureJointPose,
  onRenameJointPose,
  onDeleteJointPose,
  onApplyJointPose,
  onCameraTeachingMove,
  onZividCaptureProviderChange,
  isWorkbenchActive = true,
}) {
  const [activePage, setActivePage] = useState('project');
  const [activeTeachingCameraSide, setActiveTeachingCameraSide] = useState('left');
  const [jointWindowOpen, setJointWindowOpen] = useState(false);
  const scrollRef = useRef(null);
  const workbenchActivityRef = useRef(isWorkbenchActive);
  const selectedWaypoint = waypoints.find((point) => point.id === selectedWaypointId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const meshQualityPlan = resolveMeshRenderQuality(meshRenderQuality, mapData?.faceCount);
  const pointById = useMemo(() => new Map(waypoints.map((point) => [point.id, point])), [waypoints]);
  const activeTeachingTask = teachingTasks.find((task) => task.id === activeTeachingTaskId)
    || teachingTasks[0]
    || null;
  const taskRobotKey = activeTeachingTask?.robot?.id
    || activeTeachingTask?.robot?.relativePath;
  const currentRobotKey = robot?.id || robot?.relativePath;
  const sameTeachingRobot = Boolean(
    taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey,
  );
  const sameTeachingMap = activeTeachingTask?.map?.sourceHash && mapData?.sourceHash
    ? activeTeachingTask.map.sourceHash === mapData.sourceHash
    : Boolean(
        activeTeachingTask?.map?.fileName
        && activeTeachingTask.map.fileName === mapData?.name,
      );
  const cameraTeachingEnabled = Boolean(
    activeTeachingTask
    && sameTeachingRobot
    && sameTeachingMap
    && robotLoadState?.status === 'loaded'
    && Number(robotLoadState?.zividCount) > 0
    && zividCameraPoses?.[activeTeachingCameraSide],
  );
  const selectedPathMetrics = useMemo(
    () =>
      selectedEdge
        ? calculatePathDistances(
            pointById.get(selectedEdge.from)?.pose,
            pointById.get(selectedEdge.to)?.pose,
          )
        : null,
    [pointById, selectedEdge],
  );

  useEffect(() => {
    const resumed = isWorkbenchActive && !workbenchActivityRef.current;
    workbenchActivityRef.current = isWorkbenchActive;
    if (!isWorkbenchActive) {
      setActivePage('project');
    } else if (resumed) {
      setActivePage('teaching');
    }
  }, [isWorkbenchActive]);

  const validationCopy =
    validation.status === 'connected'
      ? { title: '全图强连通', detail: '所有导航点均可往返到达', icon: CheckCircle2 }
      : validation.status === 'partial'
        ? { title: '存在单向断路', detail: `${validation.unreachableCount} 条路径尚未形成回路`, icon: TriangleAlert }
        : { title: '等待连通性检测', detail: '按有向图检查任意两点能否互达', icon: ScanSearch };
  const ValidationIcon = validationCopy.icon;

  const updatePose = (key, value) => {
    onUpdateWaypoint(selectedWaypoint.id, {
      pose: { ...selectedWaypoint.pose, [key]: value },
    });
  };

  const updateLimit = (key, value) => {
    onUpdateEdge(selectedEdge.id, {
      limits: { ...selectedEdge.limits, [key]: value },
    });
  };

  const updateMotion = (patch) => {
    onUpdateEdge(selectedEdge.id, {
      motion: {
        direction: selectedEdge.motion?.direction === 'reverse' ? 'reverse' : 'forward',
        enable3DObstacleAvoidance: selectedEdge.motion?.enable3DObstacleAvoidance !== false,
        ...patch,
      },
    });
  };

  const invalidLimits = selectedEdge
    ? selectedEdge.limits.minSpeed > selectedEdge.limits.maxSpeed ||
      selectedEdge.limits.minAcceleration > selectedEdge.limits.maxAcceleration
    : false;
  const inspectorPages = [
    {
      id: 'navigation',
      index: '01',
      label: '路径与导航',
      compactLabel: '路径 / 导航',
      summary: `${waypoints.length}P · ${edges.length}E`,
      icon: Route,
    },
    {
      id: 'project',
      index: '02',
      label: '工程配置',
      compactLabel: '工程配置',
      summary: mapData?.bounds ? 'MAP · ON' : 'NO MAP',
      icon: Compass,
    },
    {
      id: 'teaching',
      index: '03',
      label: '虚拟示教与相机',
      compactLabel: '示教 / 相机',
      summary: `${teachingTasks.length}T · ${robotLoadState?.zividCount || 0}C`,
      icon: Bot,
    },
  ];
  const activePageMeta = inspectorPages.find((page) => page.id === activePage)
    || inspectorPages[0];
  const ActivePageIcon = activePageMeta.icon;

  useEffect(() => {
    if (selectedWaypointId || selectedEdgeId) setActivePage('navigation');
  }, [selectedEdgeId, selectedWaypointId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activePage]);

  const handleZividExpandedChange = useCallback((isExpanded) => {
    if (isExpanded) setJointWindowOpen(false);
  }, []);

  const activateInspectorPage = (pageId) => {
    setActivePage(pageId);
    if (pageId === 'teaching') setJointWindowOpen(true);
  };

  const handleTabKeyDown = (event, pageIndex) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? inspectorPages.length - 1
        : (pageIndex + (event.key === 'ArrowRight' ? 1 : -1) + inspectorPages.length)
          % inspectorPages.length;
    const nextPage = inspectorPages[nextIndex];
    activateInspectorPage(nextPage.id);
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${nextPage.id}`)?.focus());
  };

  return (
    <>
      <aside className="inspector-panel" data-active-page={activePage}>
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">CONTROL DECK / {activePageMeta.index}</span>
          <h2>图谱控制台</h2>
        </div>
        <div className="inspector-heading__tools">
          <button
            type="button"
            className={`joint-float-toggle ${jointWindowOpen ? 'is-active' : ''}`}
            aria-label={jointWindowOpen ? '隐藏全关节浮动窗口' : '打开全关节浮动窗口'}
            aria-pressed={jointWindowOpen}
            title="浮动显示全部机器人关节，不遮断地图与相机操作"
            onClick={() => setJointWindowOpen((current) => !current)}
          >
            <SlidersHorizontal size={12} />
            <span>关节</span>
          </button>
          <div className="graph-count"><ActivePageIcon size={14} /> {activePageMeta.summary}</div>
        </div>
      </div>

      <nav className="inspector-pagination" role="tablist" aria-label="控制台子页">
        {inspectorPages.map((page, pageIndex) => {
          const PageIcon = page.icon;
          const selected = activePage === page.id;
          return (
            <button
              type="button"
              role="tab"
              id={`inspector-tab-${page.id}`}
              key={page.id}
              className={selected ? 'is-active' : ''}
              aria-label={page.label}
              aria-selected={selected}
              aria-controls={`inspector-page-${page.id}`}
              tabIndex={selected ? 0 : -1}
              data-page={page.id}
              onClick={() => activateInspectorPage(page.id)}
              onKeyDown={(event) => handleTabKeyDown(event, pageIndex)}
            >
              <i>{page.index}</i>
              <span><PageIcon size={12} />{page.compactLabel}</span>
              <small>{page.summary}</small>
            </button>
          );
        })}
      </nav>

      <div className="inspector-scroll" data-page-scroll={activePage} ref={scrollRef}>
        {activePage === 'navigation' && (
          <div
            className="inspector-page inspector-page--navigation"
            role="tabpanel"
            id="inspector-page-navigation"
            aria-labelledby="inspector-tab-navigation"
          >
            <section className={`connectivity-card ${validation.status}`}>
              <div className="connectivity-card__icon"><ValidationIcon size={18} /></div>
              <div className="connectivity-card__copy">
                <strong>{validationCopy.title}</strong>
                <span>{validationCopy.detail}</span>
              </div>
              <button
                type="button"
                onClick={onRunConnectivity}
                disabled={!edges.length}
                title="运行有向图强连通检测"
              >
                检测
              </button>
            </section>

            <section className="waypoint-search" aria-label="导航点搜索">
              <div className="waypoint-search__copy">
                <Search size={14} />
                <div>
                  <strong>定位导航点</strong>
                  <span>仅显示当前地图已配置点位</span>
                </div>
              </div>
              <label>
                <span className="visually-hidden">搜索导航点</span>
                <select
                  aria-label="搜索导航点"
                  value={selectedWaypointId || ''}
                  disabled={!waypoints.length}
                  onChange={(event) => {
                    if (event.target.value) onSearchWaypoint(event.target.value);
                    else onClearSelection();
                  }}
                >
                  <option value="">{waypoints.length ? '选择导航点…' : '暂无导航点'}</option>
                  {waypoints.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.name} · X {point.pose.x.toFixed(2)} / Y {point.pose.y.toFixed(2)}
                    </option>
                  ))}
                </select>
              </label>
            </section>

        {(selectedWaypoint || selectedEdge) && (
          <button type="button" className="back-link" onClick={onClearSelection}>
            <ArrowLeft size={13} /> 返回路径与导航
          </button>
        )}

        {selectedWaypoint && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="point-glyph"><span /></div>
              <div>
                <span className="eyebrow">WAYPOINT / 3D POSE</span>
                <h3>{selectedWaypoint.name}</h3>
              </div>
            </div>

            <label className="text-field">
              <span>导航点名称</span>
              <input
                value={selectedWaypoint.name}
                onChange={(event) => onUpdateWaypoint(selectedWaypoint.id, { name: event.target.value })}
              />
            </label>

            <div className="field-section-heading">
              <span>原始三维坐标</span>
              <small>XYZ · meter</small>
            </div>
            <div className="field-grid three">
              <NumericField label="X" value={selectedWaypoint.pose.x} unit="m" onCommit={(value) => updatePose('x', value)} />
              <NumericField label="Y" value={selectedWaypoint.pose.y} unit="m" onCommit={(value) => updatePose('y', value)} />
              <NumericField label="Z" value={selectedWaypoint.pose.z} unit="m" onCommit={(value) => updatePose('z', value)} />
            </div>

            <div className="field-section-heading">
              <span>姿态角</span>
              <small>RPY · degree</small>
            </div>
            <div className="field-grid three">
              <NumericField label="ROLL" value={selectedWaypoint.pose.roll} unit="°" onCommit={(value) => updatePose('roll', value)} />
              <NumericField label="PITCH" value={selectedWaypoint.pose.pitch} unit="°" onCommit={(value) => updatePose('pitch', value)} />
              <NumericField label="YAW" value={selectedWaypoint.pose.yaw} unit="°" onCommit={(value) => updatePose('yaw', value)} />
            </div>

            <div className="capture-note">
              <CrosshairMark />
              <span>Z 值取自点击位置附近的原始点云；导出时同时写入 <code>pose</code>、<code>xzy</code> 与 <code>rpy</code>。</span>
            </div>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (window.confirm(`删除 ${selectedWaypoint.name} 及其关联路径？`)) {
                  onDeleteWaypoint(selectedWaypoint.id);
                }
              }}
            >
              <Trash2 size={14} /> 删除导航点
            </button>
          </section>
        )}

        {selectedEdge && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="route-glyph"><Route size={17} /></div>
              <div>
                <span className="eyebrow">DIRECTED PATH</span>
                <h3>路径参数</h3>
              </div>
            </div>

            <div className="direction-card">
              <div>
                <small>FROM</small>
                <strong>{pointById.get(selectedEdge.from)?.name || selectedEdge.from}</strong>
              </div>
              <div className="direction-arrow"><ArrowRight size={18} /></div>
              <div>
                <small>TO</small>
                <strong>{pointById.get(selectedEdge.to)?.name || selectedEdge.to}</strong>
              </div>
            </div>

            {selectedPathMetrics && (
              <div
                className="path-distance-card"
                aria-label="路径距离"
                data-straight-distance={selectedPathMetrics.straight3D}
                data-xy-distance={selectedPathMetrics.planarXY}
                data-vertical-delta={selectedPathMetrics.verticalDelta}
              >
                <div className="path-distance-card__heading">
                  <Ruler size={13} />
                  <span>几何距离</span>
                  <small>LIVE CALC</small>
                </div>
                <div className="path-distance-card__metrics">
                  <div>
                    <Ruler size={14} />
                    <span>3D 直线距离</span>
                    <strong>{selectedPathMetrics.straight3D.toFixed(3)} <em>m</em></strong>
                  </div>
                  <div>
                    <MoveHorizontal size={14} />
                    <span>XY 平面距离</span>
                    <strong>{selectedPathMetrics.planarXY.toFixed(3)} <em>m</em></strong>
                  </div>
                </div>
                <p>
                  XY 距离已排除定位高度误差
                  <span>ΔZ {selectedPathMetrics.verticalDelta.toFixed(3)} m</span>
                </p>
              </div>
            )}

            <div className="field-section-heading">
              <span>执行策略</span>
              <small>motion behavior</small>
            </div>
            <div className="motion-config">
              <div className="motion-config__row">
                <div>
                  <strong>车体行驶方式</strong>
                  <span>不改变 FROM → TO 的有向关系</span>
                </div>
                <div className="motion-direction-toggle" role="group" aria-label="行驶方向">
                  <button
                    type="button"
                    aria-pressed={selectedEdge.motion?.direction !== 'reverse'}
                    className={selectedEdge.motion?.direction !== 'reverse' ? 'is-active' : ''}
                    onClick={() => updateMotion({ direction: 'forward' })}
                  >
                    正走
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedEdge.motion?.direction === 'reverse'}
                    className={selectedEdge.motion?.direction === 'reverse' ? 'is-active' : ''}
                    onClick={() => updateMotion({ direction: 'reverse' })}
                  >
                    倒车
                  </button>
                </div>
              </div>
              <div className="motion-config__row">
                <div className="motion-config__perception">
                  <ScanLine size={15} />
                  <div>
                    <strong>3D 感知避障</strong>
                    <span>行进过程中启用空间障碍物检测</span>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="3D感知避障"
                  aria-checked={selectedEdge.motion?.enable3DObstacleAvoidance !== false}
                  className={`perception-switch ${selectedEdge.motion?.enable3DObstacleAvoidance !== false ? 'is-on' : ''}`}
                  title={
                    selectedEdge.motion?.enable3DObstacleAvoidance !== false
                      ? '点击关闭行进中的 3D 感知避障'
                      : '点击启用行进中的 3D 感知避障'
                  }
                  onClick={() =>
                    updateMotion({
                      enable3DObstacleAvoidance:
                        selectedEdge.motion?.enable3DObstacleAvoidance === false,
                    })
                  }
                >
                  <span><i /></span>
                  <em>
                    {selectedEdge.motion?.enable3DObstacleAvoidance !== false ? '已启用' : '已关闭'}
                  </em>
                </button>
              </div>
            </div>

            <div className="field-section-heading">
              <span>速度约束</span>
              <small>meter / second</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小速度" value={selectedEdge.limits.minSpeed} unit="m/s" onCommit={(value) => updateLimit('minSpeed', value)} />
              <NumericField label="最大速度" value={selectedEdge.limits.maxSpeed} unit="m/s" onCommit={(value) => updateLimit('maxSpeed', value)} />
            </div>

            <div className="field-section-heading">
              <span>加速度约束</span>
              <small>meter / second²</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小加速度" value={selectedEdge.limits.minAcceleration} unit="m/s²" onCommit={(value) => updateLimit('minAcceleration', value)} />
              <NumericField label="最大加速度" value={selectedEdge.limits.maxAcceleration} unit="m/s²" onCommit={(value) => updateLimit('maxAcceleration', value)} />
            </div>

            {invalidLimits && (
              <div className="inline-warning"><TriangleAlert size={14} /> 最小值不能大于最大值</div>
            )}

            <div className={`path-status ${selectedEdge.status}`}>
              <span />
              {statusMeta[selectedEdge.status]?.label || '待检测'}
              <small>有向 {pointById.get(selectedEdge.from)?.name} → {pointById.get(selectedEdge.to)?.name}</small>
            </div>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (window.confirm('删除这条有向路径？')) onDeleteEdge(selectedEdge.id);
              }}
            >
              <Trash2 size={14} /> 删除路径
            </button>
          </section>
        )}

        {!selectedWaypoint && !selectedEdge && (
          <>
            <section className="route-index">
              <div className="section-title">
                <Route size={14} />
                <span>有向路径</span>
                <small>{edges.length}</small>
              </div>
              {!edges.length && (
                <div className="empty-list">
                  <CircleGauge size={24} strokeWidth={1.3} />
                  <span>切换到“连接路径”，依次选择起点与终点</span>
                </div>
              )}
              {edges.map((edge, index) => {
                const meta = statusMeta[edge.status] || statusMeta.unchecked;
                return (
                  <button type="button" className="route-index__item" key={edge.id} onClick={() => onSelectEdge(edge.id)}>
                    <span className={`status-dot ${meta.className}`} />
                    <span className="route-index__number">E{String(index + 1).padStart(2, '0')}</span>
                    <strong>{pointById.get(edge.from)?.name || '?'} <ArrowRight size={12} /> {pointById.get(edge.to)?.name || '?'}</strong>
                    <small>{edge.limits.maxSpeed.toFixed(1)} m/s</small>
                    <ChevronRight size={14} />
                  </button>
                );
              })}
            </section>

            <section className="waypoint-index">
              <div className="section-title"><span>导航点</span><small>{waypoints.length}</small></div>
              <div className="waypoint-chips">
                {waypoints.map((point, index) => (
                  <button type="button" key={point.id} onClick={() => onSelectWaypoint(point.id)}>
                    <i>{String(index + 1).padStart(2, '0')}</i>{point.name}
                  </button>
                ))}
                {!waypoints.length && <span className="muted-copy">暂无导航点</span>}
              </div>
            </section>
          </>
        )}
          </div>
        )}

        {activePage === 'project' && (
          <div
            className="inspector-page inspector-page--project"
            role="tabpanel"
            id="inspector-page-project"
            aria-labelledby="inspector-tab-project"
          >
            <section className="project-overview">
              <div className="section-title"><Compass size={14} /><span>工程配置</span></div>
              <dl className="config-list">
                <div><dt>地图文件</dt><dd title={mapData?.name}>{mapData?.name || '尚未加载'}</dd></div>
                <div><dt>点云数量</dt><dd>{mapData?.pointCount ? mapData.pointCount.toLocaleString('zh-CN') : '—'}</dd></div>
                <div><dt>网格三角面</dt><dd>{mapData?.faceCount ? mapData.faceCount.toLocaleString('zh-CN') : '—'}</dd></div>
                <div>
                  <dt>网格质量</dt>
                  <dd>{mapData?.faceCount ? `${meshQualityPlan.requestedLabel} · ${meshQualityPlan.renderedFaceCount.toLocaleString('zh-CN')} 面` : '—'}</dd>
                </div>
                <div className={robot ? `robot-config-row is-${robotLoadState?.status || 'pending'}` : ''}>
                  <dt><Bot size={11} />机器人模型</dt>
                  <dd title={robot?.relativePath}>
                    {robot
                      ? `${robot.name} · ${robotLoadState?.status === 'loaded' ? '已加载' : robotLoadState?.status === 'error' ? '异常' : robotLoadState?.status === 'pending' ? '等待地图' : '装配中'}`
                      : '尚未加载'}
                  </dd>
                </div>
                {robot && (
                  <div
                    className="robot-pose-row"
                    data-robot-x={robotPose?.position?.x ?? 0}
                    data-robot-y={robotPose?.position?.y ?? 0}
                    data-robot-z={robotPose?.position?.z ?? 0}
                    data-robot-yaw={robotPose?.rpy?.yaw ?? 0}
                  >
                    <dt>当前位姿</dt>
                    <dd>
                      X {(robotPose?.position?.x ?? 0).toFixed(2)} / Y {(robotPose?.position?.y ?? 0).toFixed(2)} / Z {(robotPose?.position?.z ?? 0).toFixed(2)} · YAW {(robotPose?.rpy?.yaw ?? 0).toFixed(1)}°
                    </dd>
                  </div>
                )}
                {robot && (
                  <div className={`robot-drive-row ${robotControlEnabled ? 'is-active' : ''}`}>
                    <dt>麦轮控制</dt>
                    <dd>{robotControlEnabled ? '键盘已接管 · WASD / ←→' : '待机 · 点击 3D“机器人”'}</dd>
                  </div>
                )}
                {robotLoadState?.status === 'loaded' && robotLoadState.zividCount > 0 && (
                  <div><dt>末端相机</dt><dd>{robotLoadState.zividCount} × Zivid · {robotLoadState.opticalFrameCount || 0} optical frames</dd></div>
                )}
                <div><dt>投影平面</dt><dd>XY / Z 轴切片</dd></div>
                <div><dt>截面下限</dt><dd>{heightRange[0].toFixed(2)} m</dd></div>
                <div><dt>截面上限</dt><dd>{heightRange[1].toFixed(2)} m</dd></div>
                <div><dt>截面跨度</dt><dd>{Math.max(0, heightRange[1] - heightRange[0]).toFixed(2)} m</dd></div>
              </dl>
            </section>
          </div>
        )}

        {activePage === 'teaching' && (
          <div
            className="inspector-page inspector-page--teaching"
            role="tabpanel"
            id="inspector-page-teaching"
            aria-labelledby="inspector-tab-teaching"
          >
            <VirtualTeachingPanel
              tasks={teachingTasks}
              activeTaskId={activeTeachingTaskId}
              mapData={mapData}
              robot={robot}
              robotLoadState={robotLoadState}
              robotJointValues={robotJointValues}
              view="capture"
              captureState={teachingCaptureState}
              onCreateTask={onCreateTeachingTask}
              onSelectTask={onSelectTeachingTask}
              onCapturePoint={onCaptureTeachingPoint}
              onOpenDataPage={onOpenTeachingDataPage}
            />

            <div
              className="camera-teaching-workspace is-active"
              data-camera-controls-location="adjacent-to-viewport"
              data-camera-inverse-activation="automatic"
            >
              <ZividCameraPanel
                mapData={mapData}
                robot={robot}
                robotLoadState={robotLoadState}
                cameraPoses={zividCameraPoses}
                activeSide={activeTeachingCameraSide}
                onActiveSideChange={setActiveTeachingCameraSide}
                cameraTeachingEnabled={cameraTeachingEnabled}
                cameraTeachingResult={cameraTeachingResult}
                meshRenderQuality={meshRenderQuality}
                onMeshRenderQualityChange={onMeshRenderQualityChange}
                spaceMouseInputRef={spaceMouseInputRef}
                mainViewportCanvasRef={main3DCanvasRef}
                jointControlOpen={jointWindowOpen}
                onExpandedChange={handleZividExpandedChange}
                onOpenJointControl={() => setJointWindowOpen(true)}
                onCameraTeachingMove={onCameraTeachingMove}
                onCaptureProviderChange={onZividCaptureProviderChange}
              />
            </div>

          </div>
        )}
      </div>
      </aside>

      <FloatingRobotJointPanel
        open={jointWindowOpen}
        onClose={() => setJointWindowOpen(false)}
        robot={robot}
        robotLoadState={robotLoadState}
        jointValues={robotJointValues}
        lockedJointNames={lockedRobotJointNames}
        poses={jointPoses}
        onChangeJoint={onUpdateRobotJointValue}
        onToggleJointLock={onToggleRobotJointLock}
        onUnlockAllJoints={onUnlockAllRobotJoints}
        onZeroJoints={onZeroRobotJoints}
        onCapturePose={onCaptureJointPose}
        onRenamePose={onRenameJointPose}
        onDeletePose={onDeleteJointPose}
        onApplyPose={onApplyJointPose}
      />
    </>
  );
}

function CrosshairMark() {
  return (
    <span className="crosshair-mark" aria-hidden="true">
      <i /><i />
    </span>
  );
}
