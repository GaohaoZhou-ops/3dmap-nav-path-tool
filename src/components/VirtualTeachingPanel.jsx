import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Camera,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  Cloud,
  Crosshair,
  Database,
  Download,
  FileJson,
  FolderOpen,
  MapPin,
  Maximize2,
  Navigation,
  Play,
  Save,
  Trash2,
  X,
} from 'lucide-react';

const formatCapturedAt = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '当前会话';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
};

const formatValue = (value, digits = 3) => {
  const parsed = Number(value);
  const precision = Number.isInteger(digits) && digits >= 0 ? digits : 3;
  return Number.isFinite(parsed) ? parsed.toFixed(precision) : '--';
};

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
};

export default function VirtualTeachingPanel({
  tasks,
  activeTaskId,
  activeParkingPointId,
  mapData,
  robot,
  robotLoadState,
  robotPose,
  robotJointValues,
  view = 'capture',
  captureState = { status: 'idle', message: '' },
  onCreateTask,
  onSelectTask,
  onCreateParkingPoint,
  onSelectParkingPoint,
  onRenameParkingPoint,
  onDeleteParkingPoint,
  onApplyParkingPoint,
  onRenameTask,
  onDeleteTask,
  onCapturePoint,
  onRenamePoint,
  onDeletePoint,
  onApplyPoint,
  onExportProject,
  onOpenDataPage,
  onOpenCapturePage,
}) {
  const isDataView = view === 'data';
  const HeaderIcon = isDataView ? Database : Crosshair;
  const activeTask = tasks.find((task) => task.id === activeTaskId) || tasks[0] || null;
  const parkingPoints = activeTask?.parkingPoints || [];
  const activeParkingPoint = parkingPoints.find(
    (parkingPoint) => parkingPoint.id === activeParkingPointId,
  ) || parkingPoints[0] || null;
  const activePoses = activeParkingPoint?.poses || [];
  const [taskNameDraft, setTaskNameDraft] = useState(activeTask?.name || '');
  const [parkingPointNameDraft, setParkingPointNameDraft] = useState(
    activeParkingPoint?.name || '',
  );
  const [selectedPointId, setSelectedPointId] = useState(
    activePoses.at(-1)?.id || null,
  );
  const selectedPoint = activePoses.find((point) => point.id === selectedPointId) || null;
  const [pointNameDraft, setPointNameDraft] = useState(selectedPoint?.name || '');
  const [visionPreview, setVisionPreview] = useState(null);
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [taskCreateName, setTaskCreateName] = useState('');
  const [includeCurrentParkingPoint, setIncludeCurrentParkingPoint] = useState(false);

  useEffect(() => {
    setTaskNameDraft(activeTask?.name || '');
  }, [activeTask?.id, activeTask?.name]);

  useEffect(() => {
    setParkingPointNameDraft(activeParkingPoint?.name || '');
  }, [activeParkingPoint?.id, activeParkingPoint?.name]);

  useEffect(() => {
    setSelectedPointId(activePoses.at(-1)?.id || null);
  }, [activeParkingPoint?.id, activePoses.length]);

  useEffect(() => {
    setPointNameDraft(selectedPoint?.name || '');
  }, [selectedPoint?.id, selectedPoint?.name]);

  useEffect(() => {
    setVisionPreview(null);
  }, [selectedPoint?.id]);

  useEffect(() => {
    if (!visionPreview) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setVisionPreview(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [visionPreview]);

  useEffect(() => {
    if (!taskCreateOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setTaskCreateOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [taskCreateOpen]);

  const jointEntries = useMemo(
    () => Object.entries(selectedPoint?.fullBodyJoints?.values || {})
      .sort(([left], [right]) => left.localeCompare(right)),
    [selectedPoint],
  );
  const currentJointCount = Object.keys(robotJointValues || {}).length;
  const selectedCameraFrames = ['left', 'right'].flatMap((side) => {
    const frame = selectedPoint?.cameraCapture?.frames?.[side];
    return frame ? [{ side, frame }] : [];
  });
  const taskRobotKey = activeTask?.robot?.id || activeTask?.robot?.relativePath;
  const currentRobotKey = robot?.id || robot?.relativePath;
  const sameRobot = Boolean(taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey);
  const sameMap = activeTask?.map?.sourceHash && mapData?.sourceHash
    ? activeTask.map.sourceHash === mapData.sourceHash
    : Boolean(activeTask?.map?.fileName && activeTask.map.fileName === mapData?.name);
  const contextMatches = Boolean(activeTask && sameRobot && sameMap);
  const robotReady = robotLoadState?.status === 'loaded' && Boolean(robot);
  const canCreate = Boolean(mapData?.bounds && robotReady);
  const canCapture = Boolean(activeTask && activeParkingPoint && robotReady && contextMatches);
  const canCreateParkingPoint = Boolean(activeTask && robotReady && contextMatches);
  const captureInProgress = captureState?.status === 'capturing';
  const canExport = Boolean(mapData?.bounds);
  const teachingPointCount = tasks.reduce(
    (count, task) => count + (task.parkingPoints || []).reduce(
      (poseCount, parkingPoint) => poseCount + (parkingPoint.poses?.length || 0),
      0,
    ),
    0,
  );
  const parkingPointCount = tasks.reduce(
    (count, task) => count + (task.parkingPoints?.length || 0),
    0,
  );
  const activeTaskPoseCount = parkingPoints.reduce(
    (count, parkingPoint) => count + (parkingPoint.poses?.length || 0),
    0,
  );

  const commitTaskName = () => {
    if (!activeTask) return;
    const nextName = taskNameDraft.trim();
    if (!nextName) {
      setTaskNameDraft(activeTask.name);
      return;
    }
    if (nextName !== activeTask.name) onRenameTask(activeTask.id, nextName);
  };

  const commitPointName = () => {
    if (!activeTask || !activeParkingPoint || !selectedPoint) return;
    const nextName = pointNameDraft.trim();
    if (!nextName) {
      setPointNameDraft(selectedPoint.name);
      return;
    }
    if (nextName !== selectedPoint.name) {
      onRenamePoint(activeTask.id, activeParkingPoint.id, selectedPoint.id, nextName);
    }
  };

  const commitParkingPointName = () => {
    if (!activeTask || !activeParkingPoint) return;
    const nextName = parkingPointNameDraft.trim();
    if (!nextName) {
      setParkingPointNameDraft(activeParkingPoint.name);
      return;
    }
    if (nextName !== activeParkingPoint.name) {
      onRenameParkingPoint(activeTask.id, activeParkingPoint.id, nextName);
    }
  };

  const openTaskCreateDialog = () => {
    if (!canCreate) return;
    setTaskCreateName(`示教任务 ${String(tasks.length + 1).padStart(2, '0')}`);
    setIncludeCurrentParkingPoint(false);
    setTaskCreateOpen(true);
  };

  const submitTaskCreate = () => {
    const name = taskCreateName.trim();
    if (!name || !canCreate) return;
    onCreateTask({ name, includeCurrentParkingPoint });
    setTaskCreateOpen(false);
  };

  return (
    <>
    <section
      className={`virtual-teaching ${isDataView ? 'is-data-view' : 'is-capture-view'} ${activeTask ? 'has-task' : 'is-empty'}`}
      aria-label={isDataView ? '示教数据管理' : '虚拟示教'}
      data-teaching-view={isDataView ? 'data' : 'capture'}
      data-teaching-task-count={tasks.length}
      data-active-teaching-task={activeTask?.id || ''}
      data-parking-point-count={parkingPointCount}
      data-active-parking-point={activeParkingPoint?.id || ''}
      data-teaching-context-match={contextMatches ? 'true' : 'false'}
      data-current-joint-count={currentJointCount}
      data-camera-inverse-mode="automatic"
      data-capture-surface={isDataView ? 'archive-management' : 'task-actions'}
      data-camera-capture-status={captureState?.status || 'idle'}
    >
      <div className="virtual-teaching__header">
        <div className="virtual-teaching__identity">
          <span><HeaderIcon size={14} /></span>
          <div>
            <small>{isDataView ? 'TEACHING DATA / ARCHIVE' : 'VIRTUAL TEACH / CAPTURE'}</small>
            <strong>{isDataView ? '示教数据管理' : '虚拟示教'}</strong>
          </div>
        </div>
        {isDataView ? (
          <button
            type="button"
            className="teaching-new-task teaching-back-to-capture"
            onClick={onOpenCapturePage}
            title="返回示教采集与实时相机画面"
          >
            <Crosshair size={12} /> 继续示教
          </button>
        ) : (
          <button
            type="button"
            className="teaching-new-task"
            onClick={openTaskCreateDialog}
            disabled={!canCreate}
            title={canCreate ? '以当前地图和机器人新建示教任务' : '请先加载地图与机器人'}
          >
            <CirclePlus size={12} /> 新建示教任务
          </button>
        )}
      </div>

      {isDataView && <div
        className="teaching-project-export"
        data-export-task-count={tasks.length}
        data-export-parking-point-count={parkingPointCount}
        data-export-point-count={teachingPointCount}
      >
        <div className="teaching-project-export__identity">
          <span><FileJson size={14} /></span>
          <div>
            <strong>示教工程包</strong>
            <small>{tasks.length} TASKS · {parkingPointCount} STOPS · {teachingPointCount} POSES</small>
          </div>
        </div>
        <button
          type="button"
          onClick={onExportProject}
          disabled={!canExport}
          aria-label="导出示教工程 JSON"
          title={canExport
            ? '导出地图、导航图、机器人状态与全部示教任务'
            : '请先加载地图或工程配置'}
        >
          <Download size={12} /> 导出工程
        </button>
      </div>}

      {!isDataView && (
        <div className="teaching-task-open" data-task-available={tasks.length ? 'true' : 'false'}>
          <div className="teaching-task-open__identity">
            <span><FolderOpen size={13} /></span>
            <div>
              <small>OPEN / RESUME</small>
              <strong>打开已有任务</strong>
            </div>
          </div>
          <label>
            <span className="visually-hidden">打开已有示教任务</span>
            <select
              aria-label="打开已有示教任务"
              value={activeTask?.id || ''}
              disabled={!tasks.length}
              onChange={(event) => onSelectTask(event.target.value)}
            >
              {!tasks.length && <option value="">暂无已有任务</option>}
              {tasks.map((task, index) => (
                <option key={task.id} value={task.id}>
                  {String(index + 1).padStart(2, '0')} · {task.name} · {task.parkingPoints.length} 停车点
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {!activeTask && (
        <div className="teaching-empty-state">
          <div className="teaching-empty-state__reticle"><i /><span /></div>
          <strong>
            {isDataView
              ? '暂无可管理的示教数据'
              : canCreate ? '建立第一条示教任务' : '等待地图与机器人'}
          </strong>
          <span>
            {isDataView
              ? '请先返回主工作台，在“示教 / 相机”中新建任务并采集机器人姿态。'
              : canCreate
                ? '任务将绑定当前地图和机器人；调整完成后逐点记录全身状态。'
                : '机器人装配完成后，可记录地图定位与所有可动关节。'}
          </span>
        </div>
      )}

      {activeTask && (
        <>
          {isDataView && <div className="teaching-task-bar">
            <label>
              <span className="visually-hidden">选择示教任务</span>
              <select
                aria-label="选择示教任务"
                value={activeTask.id}
                onChange={(event) => onSelectTask(event.target.value)}
              >
                {tasks.map((task, index) => (
                  <option key={task.id} value={task.id}>
                    {String(index + 1).padStart(2, '0')} · {task.name} · {task.parkingPoints.length} 停车点
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="删除当前示教任务"
              title="删除当前示教任务"
              onClick={() => {
                if (window.confirm(`删除 ${activeTask.name} 及其全部停车点和机械臂姿态？`)) {
                  onDeleteTask(activeTask.id);
                }
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>}

          {isDataView && <label className="teaching-name-field">
            <span>任务名称</span>
            <input
              aria-label="示教任务名称"
              value={taskNameDraft}
              onChange={(event) => setTaskNameDraft(event.target.value)}
              onBlur={commitTaskName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </label>}

          {isDataView && <div className={`teaching-context ${contextMatches ? 'is-matched' : 'is-mismatch'}`}>
            <div title={activeTask.map.fileName}>
              <MapPin size={11} />
              <span>MAP</span>
              <strong>{activeTask.map.fileName || '未绑定'}</strong>
            </div>
            <div title={activeTask.robot.name}>
              <Bot size={11} />
              <span>ROBOT</span>
              <strong>{activeTask.robot.name || '未绑定'}</strong>
            </div>
            <em>{contextMatches ? 'CONTEXT OK' : 'CONTEXT MISMATCH'}</em>
          </div>}

          {!isDataView && (
            <section
              className={`teaching-parking-selector ${activeParkingPoint ? 'has-selection' : 'is-empty'}`}
              aria-label="当前停车点"
              data-active-parking-point={activeParkingPoint?.id || ''}
            >
              <div className="teaching-parking-selector__top">
                <span><MapPin size={13} /></span>
                <div>
                  <small>PARKING / MAP POSE</small>
                  <strong>当前停车点</strong>
                </div>
                <button
                  type="button"
                  onClick={onCreateParkingPoint}
                  disabled={!canCreateParkingPoint || captureInProgress}
                  aria-label="新增停车点"
                  title="以机器人当前地图位姿新增停车点"
                >
                  <CirclePlus size={11} /> 新增
                </button>
              </div>
              <label>
                <span className="visually-hidden">选择当前停车点</span>
                <select
                  aria-label="选择当前停车点"
                  value={activeParkingPoint?.id || ''}
                  disabled={!parkingPoints.length || captureInProgress}
                  onChange={(event) => onSelectParkingPoint(event.target.value)}
                >
                  {!parkingPoints.length && <option value="">暂无停车点</option>}
                  {parkingPoints.map((parkingPoint, index) => (
                    <option key={parkingPoint.id} value={parkingPoint.id}>
                      P{String(index + 1).padStart(2, '0')} · {parkingPoint.name} · {parkingPoint.poses.length} 姿态
                    </option>
                  ))}
                </select>
              </label>
              {activeParkingPoint ? (
                <div className="teaching-parking-selector__pose">
                  <span>X <b>{formatValue(activeParkingPoint.mapPose.position.x, 2)}</b></span>
                  <span>Y <b>{formatValue(activeParkingPoint.mapPose.position.y, 2)}</b></span>
                  <span>Z <b>{formatValue(activeParkingPoint.mapPose.position.z, 2)}</b></span>
                  <span>YAW <b>{formatValue(activeParkingPoint.mapPose.rpy.yaw, 1)}°</b></span>
                </div>
              ) : (
                <p>新增停车点后，机械臂姿态会归档到该位置下。</p>
              )}
            </section>
          )}

          {isDataView && (
            <section
              className="teaching-parking-manager"
              aria-label="停车点管理"
              data-parking-point-count={parkingPoints.length}
            >
              <div className="teaching-sequence-heading teaching-parking-heading">
                <span>停车点</span>
                <i />
                <small>{parkingPoints.length} STOPS</small>
              </div>
              {!parkingPoints.length && (
                <div className="teaching-points-empty">
                  <MapPin size={18} strokeWidth={1.3} />
                  <span>当前任务还没有停车点，请返回主工作台按当前底盘位置新增。</span>
                </div>
              )}
              {!!parkingPoints.length && (
                <div className="teaching-parking-tabs" role="group" aria-label="任务停车点">
                  {parkingPoints.map((parkingPoint, index) => (
                    <button
                      type="button"
                      key={parkingPoint.id}
                      className={parkingPoint.id === activeParkingPoint?.id ? 'is-selected' : ''}
                      data-parking-point-id={parkingPoint.id}
                      aria-label={`选择停车点 ${parkingPoint.name}`}
                      onClick={() => onSelectParkingPoint(parkingPoint.id)}
                    >
                      <i>P{String(index + 1).padStart(2, '0')}</i>
                      <span><strong>{parkingPoint.name}</strong><small>{parkingPoint.poses.length} ARM POSES</small></span>
                    </button>
                  ))}
                </div>
              )}
              {activeParkingPoint && (
                <div
                  className="teaching-parking-detail"
                  data-selected-parking-point={activeParkingPoint.id}
                >
                  <label>
                    <span>停车点名称</span>
                    <input
                      aria-label="停车点名称"
                      value={parkingPointNameDraft}
                      onChange={(event) => setParkingPointNameDraft(event.target.value)}
                      onBlur={commitParkingPointName}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  </label>
                  <div className="teaching-parking-detail__pose" aria-label="停车点地图位姿">
                    <span>X <b>{formatValue(activeParkingPoint.mapPose.position.x, 2)}</b> m</span>
                    <span>Y <b>{formatValue(activeParkingPoint.mapPose.position.y, 2)}</b> m</span>
                    <span>Z <b>{formatValue(activeParkingPoint.mapPose.position.z, 2)}</b> m</span>
                    <span>YAW <b>{formatValue(activeParkingPoint.mapPose.rpy.yaw, 1)}</b>°</span>
                  </div>
                  <div className="teaching-parking-detail__actions">
                    <button
                      type="button"
                      disabled={!contextMatches || !robotReady}
                      onClick={() => onApplyParkingPoint(activeTask.id, activeParkingPoint.id)}
                    >
                      <Play size={11} /> 定位到停车点
                    </button>
                    <button
                      type="button"
                      aria-label="删除当前停车点"
                      onClick={() => {
                        const poseNotice = activeParkingPoint.poses.length
                          ? `及其 ${activeParkingPoint.poses.length} 组机械臂姿态`
                          : '';
                        if (window.confirm(`删除 ${activeParkingPoint.name}${poseNotice}？`)) {
                          onDeleteParkingPoint(activeTask.id, activeParkingPoint.id);
                        }
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {!isDataView && <>
          <button
            type="button"
            className="teaching-capture-button"
            onClick={onCapturePoint}
            disabled={!canCapture || captureInProgress}
            aria-busy={captureInProgress}
            aria-label="记录当前机械臂姿态"
            title={canCapture
              ? `保存到 ${activeParkingPoint.name}：地图位姿、全部关节与左右 Zivid RGB/XYZ 快照`
              : activeParkingPoint ? '当前地图或机器人与任务不匹配' : '请先新增或选择停车点'}
          >
            <span><Save size={15} /></span>
            <div>
              <strong>{captureInProgress ? '正在冻结双目视觉…' : '记录当前机械臂姿态'}</strong>
              <small>
                {captureInProgress
                  ? 'CAM-L + CAM-R · RGB + XYZ CLOUD'
                  : `MAP 6DOF + ${currentJointCount} JOINTS + DUAL VISION`}
              </small>
            </div>
            <kbd>A{String(activePoses.length + 1).padStart(2, '0')}</kbd>
          </button>

          {captureState?.message && (
            <div
              className={`teaching-capture-state is-${captureState.status || 'idle'}`}
              role={captureState.status === 'error' ? 'alert' : 'status'}
            >
              {captureState.status === 'capturing' ? <Camera size={10} /> : <Database size={10} />}
              <span>{captureState.message}</span>
            </div>
          )}
          </>}

          {isDataView ? <>
          <div className="teaching-sequence-heading">
            <span>机械臂姿态</span>
            <i />
            <small>{activePoses.length} POSES · {activeParkingPoint?.name || 'NO STOP'}</small>
          </div>

          {activeParkingPoint && !activePoses.length && (
            <div className="teaching-points-empty">
              <ClipboardCheck size={18} strokeWidth={1.3} />
              <span>
                当前停车点还没有机械臂姿态，请返回主工作台完成采集。
              </span>
            </div>
          )}

          <div className="teaching-point-list">
            {activePoses.map((point, index) => (
              <div
                className={`teaching-point-row ${point.id === selectedPointId ? 'is-selected' : ''}`}
                key={point.id}
                data-teaching-point-id={point.id}
                data-joint-count={point.fullBodyJoints?.count || 0}
                data-camera-frame-count={Object.keys(point.cameraCapture?.frames || {}).length}
              >
                <button
                  type="button"
                  className="teaching-point-select"
                  aria-label={`查看机械臂姿态 ${point.name}`}
                  onClick={() => setSelectedPointId(point.id)}
                >
                  <i>{String(index + 1).padStart(2, '0')}</i>
                  <span>
                    <strong>{point.name}</strong>
                    <small>
                      X {formatValue(point.mapPose.position.x, 2)} · Y {formatValue(point.mapPose.position.y, 2)} · Z {formatValue(point.mapPose.position.z, 2)}
                    </small>
                  </span>
                  <em>
                    {point.fullBodyJoints?.count || 0} JTS
                    {point.cameraCapture ? ` · ${Object.keys(point.cameraCapture.frames || {}).length} CAM` : ''}
                  </em>
                  <ChevronRight size={12} />
                </button>
                <button
                  type="button"
                  className="teaching-point-quick-apply"
                  aria-label={`应用机械臂姿态 ${point.name}`}
                  title="恢复地图定位与全身关节"
                  disabled={!contextMatches || !robotReady}
                  onClick={() => onApplyPoint(activeTask.id, activeParkingPoint.id, point.id)}
                >
                  <Play size={11} />
                </button>
              </div>
            ))}
          </div>

          {selectedPoint && (
            <div
              className="teaching-point-detail"
              data-selected-teaching-point={selectedPoint.id}
              data-map-x={selectedPoint.mapPose.position.x}
              data-map-y={selectedPoint.mapPose.position.y}
              data-map-z={selectedPoint.mapPose.position.z}
              data-map-roll={selectedPoint.mapPose.rpy.roll}
              data-map-pitch={selectedPoint.mapPose.rpy.pitch}
              data-map-yaw={selectedPoint.mapPose.rpy.yaw}
            >
              <div className="teaching-point-detail__top">
                <label>
                  <span>姿态名称</span>
                  <input
                    aria-label="机械臂姿态名称"
                    value={pointNameDraft}
                    onChange={(event) => setPointNameDraft(event.target.value)}
                    onBlur={commitPointName}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </label>
                <small>{formatCapturedAt(selectedPoint.capturedAt)}</small>
              </div>

              <div className="teaching-pose-grid" aria-label="机械臂姿态记录位姿">
                {[
                  ['X', selectedPoint.mapPose.position.x, 'm'],
                  ['Y', selectedPoint.mapPose.position.y, 'm'],
                  ['Z', selectedPoint.mapPose.position.z, 'm'],
                  ['R', selectedPoint.mapPose.rpy.roll, '°'],
                  ['P', selectedPoint.mapPose.rpy.pitch, '°'],
                  ['YAW', selectedPoint.mapPose.rpy.yaw, '°'],
                ].map(([label, value, unit]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{formatValue(value)}</strong>
                    <small>{unit}</small>
                  </div>
                ))}
              </div>

              {selectedCameraFrames.length > 0 && (
                <section
                  className="teaching-vision-capture"
                  aria-label="机械臂姿态双目视觉快照"
                  data-camera-frame-count={selectedCameraFrames.length}
                  data-camera-model={selectedPoint.cameraCapture.cameraModel || ''}
                >
                  <header>
                    <span><Camera size={11} /></span>
                    <div>
                      <strong>双目视觉快照</strong>
                      <small>FROZEN RGB + OPTICAL XYZ</small>
                    </div>
                    <em>{formatBytes(selectedPoint.cameraCapture.storageByteLength)}</em>
                  </header>
                  <div className="teaching-vision-grid">
                    {selectedCameraFrames.map(({ side, frame }) => {
                      const sideLabel = side === 'left' ? '左臂' : '右臂';
                      const rgbImage = frame.rgb;
                      const cloudImage = frame.pointCloud?.preview;
                      return (
                        <article
                          key={side}
                          className="teaching-vision-frame"
                          data-camera-side={side}
                          data-point-count={frame.pointCloud?.pointCount || 0}
                        >
                          <div className="teaching-vision-frame__heading">
                            <strong>{sideLabel} M70</strong>
                            <small>{side === 'left' ? 'CAM-L' : 'CAM-R'}</small>
                          </div>
                          <div className="teaching-vision-thumbnails">
                            {[
                              { id: 'rgb', label: 'RGB', icon: Camera, image: rgbImage },
                              { id: 'pointcloud', label: 'XYZ', icon: Cloud, image: cloudImage },
                            ].map((item) => {
                              const PreviewIcon = item.icon;
                              return (
                                <button
                                  type="button"
                                  key={item.id}
                                  disabled={!item.image?.dataUrl}
                                  aria-label={`查看 ${selectedPoint.name} ${sideLabel}${item.label} 快照`}
                                  onClick={() => setVisionPreview({
                                    image: item.image,
                                    title: `${selectedPoint.name} · ${sideLabel} ${item.label}`,
                                    side,
                                    mode: item.id,
                                    pointCount: frame.pointCloud?.pointCount || 0,
                                    frameName: frame.opticalPose?.frameName || '',
                                  })}
                                >
                                  {item.image?.dataUrl
                                    ? <img src={item.image.dataUrl} alt="" />
                                    : <i><PreviewIcon size={13} /></i>}
                                  <span><PreviewIcon size={9} /> {item.label}</span>
                                  <Maximize2 size={8} />
                                </button>
                              );
                            })}
                          </div>
                          <footer>
                            <span>{Number(frame.pointCloud?.pointCount || 0).toLocaleString('zh-CN')} PTS</span>
                            <span>{frame.pointCloud?.sampleMethod === 'uniform-visible-lod' ? 'LOD' : 'FULL FOV'}</span>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              <div className="teaching-joint-heading">
                <span>全身关节快照</span>
                <small>{jointEntries.length} VALUES · DEG / M</small>
              </div>
              <div className="teaching-joint-list" aria-label="全身关节快照">
                {jointEntries.map(([name, value]) => (
                  <div key={name}>
                    <span title={name}>{name}</span>
                    <strong>{formatValue(value)}</strong>
                  </div>
                ))}
                {!jointEntries.length && <p>当前模型没有可动关节值</p>}
              </div>

              <div className="teaching-point-actions">
                <button
                  type="button"
                  className="teaching-apply-button"
                  disabled={!contextMatches || !robotReady}
                  onClick={() => onApplyPoint(
                    activeTask.id,
                    activeParkingPoint.id,
                    selectedPoint.id,
                  )}
                >
                  <Play size={12} /> 应用到机器人
                </button>
                <button
                  type="button"
                  className="teaching-delete-point"
                  aria-label="删除当前机械臂姿态"
                  onClick={() => {
                    if (window.confirm(`删除机械臂姿态 ${selectedPoint.name}？`)) {
                      onDeletePoint(activeTask.id, activeParkingPoint.id, selectedPoint.id);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          )}
          </> : (
            <div
              className="teaching-data-handoff"
              data-parking-point-count={parkingPoints.length}
              data-teaching-point-count={activeTaskPoseCount}
            >
              <span className="teaching-data-handoff__count">
                <b>{activeTaskPoseCount}</b>
                <small>POSES</small>
              </span>
              <div>
                <strong>当前已归档姿态</strong>
                <small>{parkingPoints.length} 个停车点 · 姿态与双目快照由示教数据页统一管理</small>
              </div>
              <button
                type="button"
                onClick={onOpenDataPage}
                disabled={captureState?.status === 'capturing'}
                title={captureState?.status === 'capturing' ? '当前姿态记录完成后可进入数据页' : ''}
              >
                打开数据页 <ChevronRight size={11} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
    {taskCreateOpen && createPortal(
      <div
        className="teaching-task-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="teaching-task-create-title"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setTaskCreateOpen(false);
        }}
      >
        <form
          className="teaching-task-create-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            submitTaskCreate();
          }}
        >
          <header>
            <div>
              <small>NEW TEACHING TASK</small>
              <h2 id="teaching-task-create-title">新建示教任务</h2>
              <p>任务将绑定当前地图与机器人，创建后可随时继续补充停车点。</p>
            </div>
            <button
              type="button"
              aria-label="关闭新建示教任务弹窗"
              onClick={() => setTaskCreateOpen(false)}
            >
              <X size={15} />
            </button>
          </header>

          <div className="teaching-task-create-dialog__body">
            <label className="teaching-task-create-name">
              <span>任务名称</span>
              <input
                autoFocus
                aria-label="新示教任务名称"
                value={taskCreateName}
                maxLength={80}
                onChange={(event) => setTaskCreateName(event.target.value)}
                placeholder="请输入示教任务名称"
              />
              <small>{taskCreateName.trim().length}/80 · 创建后仍可在示教数据中心修改</small>
            </label>

            <button
              type="button"
              className={`teaching-task-parking-option ${includeCurrentParkingPoint ? 'is-selected' : ''}`}
              aria-pressed={includeCurrentParkingPoint}
              aria-label="添加当前位置为停车点"
              onClick={() => setIncludeCurrentParkingPoint((current) => !current)}
            >
              <span className="teaching-task-parking-option__icon">
                <MapPin size={16} />
              </span>
              <span className="teaching-task-parking-option__copy">
                <strong>添加当前位置为停车点</strong>
                <small>记录机器人当前 MAP XYZ / RPY，建立停车点 P01</small>
              </span>
              <span className="teaching-task-parking-option__state" aria-hidden="true">
                {includeCurrentParkingPoint ? '已选择' : '可选'}
              </span>
            </button>

            <div className="teaching-task-current-pose" aria-label="机器人当前位置">
              <span><Navigation size={11} /> CURRENT MAP POSE</span>
              <dl>
                <div><dt>X</dt><dd>{formatValue(robotPose?.position?.x, 2)} m</dd></div>
                <div><dt>Y</dt><dd>{formatValue(robotPose?.position?.y, 2)} m</dd></div>
                <div><dt>Z</dt><dd>{formatValue(robotPose?.position?.z, 2)} m</dd></div>
                <div><dt>YAW</dt><dd>{formatValue(robotPose?.rpy?.yaw, 1)}°</dd></div>
              </dl>
            </div>
          </div>

          <footer>
            <span>
              {includeCurrentParkingPoint
                ? '创建任务并记录当前位置'
                : '仅创建任务，稍后手动添加停车点'}
            </span>
            <div>
              <button type="button" onClick={() => setTaskCreateOpen(false)}>取消</button>
              <button type="submit" disabled={!taskCreateName.trim()}>
                <CirclePlus size={12} /> 创建任务
              </button>
            </div>
          </footer>
        </form>
      </div>,
      document.body,
    )}
    {visionPreview && createPortal(
      <div
        className="teaching-vision-modal"
        role="dialog"
        aria-modal="true"
        aria-label="示教视觉快照大图"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setVisionPreview(null);
        }}
      >
        <section data-preview-mode={visionPreview.mode}>
          <header>
            <div>
              <small>TEACHING VISION ARCHIVE · {visionPreview.frameName}</small>
              <strong>{visionPreview.title}</strong>
            </div>
            <span>
              {visionPreview.mode === 'pointcloud'
                ? `${Number(visionPreview.pointCount).toLocaleString('zh-CN')} XYZ POINTS`
                : `${visionPreview.image.width} × ${visionPreview.image.height}`}
            </span>
            <button
              type="button"
              aria-label="关闭示教视觉快照"
              onClick={() => setVisionPreview(null)}
            >
              <X size={15} />
            </button>
          </header>
          <div>
            <img src={visionPreview.image.dataUrl} alt={visionPreview.title} />
            <i className="top-left" /><i className="top-right" />
            <i className="bottom-left" /><i className="bottom-right" />
          </div>
        </section>
      </div>,
      document.body,
    )}
    </>
  );
}
