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
  mapData,
  robot,
  robotLoadState,
  robotJointValues,
  view = 'capture',
  captureState = { status: 'idle', message: '' },
  onCreateTask,
  onSelectTask,
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
  const [taskNameDraft, setTaskNameDraft] = useState(activeTask?.name || '');
  const [selectedPointId, setSelectedPointId] = useState(
    activeTask?.points.at(-1)?.id || null,
  );
  const selectedPoint = activeTask?.points.find((point) => point.id === selectedPointId) || null;
  const [pointNameDraft, setPointNameDraft] = useState(selectedPoint?.name || '');
  const [visionPreview, setVisionPreview] = useState(null);

  useEffect(() => {
    setTaskNameDraft(activeTask?.name || '');
  }, [activeTask?.id, activeTask?.name]);

  useEffect(() => {
    setSelectedPointId(activeTask?.points.at(-1)?.id || null);
  }, [activeTask?.id, activeTask?.points.length]);

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
  const canCapture = Boolean(activeTask && robotReady && contextMatches);
  const captureInProgress = captureState?.status === 'capturing';
  const canExport = Boolean(mapData?.bounds);
  const teachingPointCount = tasks.reduce(
    (count, task) => count + (task.points?.length || 0),
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
    if (!activeTask || !selectedPoint) return;
    const nextName = pointNameDraft.trim();
    if (!nextName) {
      setPointNameDraft(selectedPoint.name);
      return;
    }
    if (nextName !== selectedPoint.name) {
      onRenamePoint(activeTask.id, selectedPoint.id, nextName);
    }
  };

  return (
    <>
    <section
      className={`virtual-teaching ${isDataView ? 'is-data-view' : 'is-capture-view'} ${activeTask ? 'has-task' : 'is-empty'}`}
      aria-label={isDataView ? '示教数据管理' : '虚拟示教'}
      data-teaching-view={isDataView ? 'data' : 'capture'}
      data-teaching-task-count={tasks.length}
      data-active-teaching-task={activeTask?.id || ''}
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
            onClick={onCreateTask}
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
        data-export-point-count={teachingPointCount}
      >
        <div className="teaching-project-export__identity">
          <span><FileJson size={14} /></span>
          <div>
            <strong>示教工程包</strong>
            <small>{tasks.length} TASKS · {teachingPointCount} POSES · JSON</small>
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
                  {String(index + 1).padStart(2, '0')} · {task.name} · {task.points.length} 姿态
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
                    {String(index + 1).padStart(2, '0')} · {task.name} · {task.points.length} 点
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="删除当前示教任务"
              title="删除当前示教任务"
              onClick={() => {
                if (window.confirm(`删除 ${activeTask.name} 及全部示教点？`)) {
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

          {!isDataView && <>
          <button
            type="button"
            className="teaching-capture-button"
            onClick={onCapturePoint}
            disabled={!canCapture || captureInProgress}
            aria-busy={captureInProgress}
            aria-label="记录当前机器人姿态"
            title={canCapture
              ? '保存地图位姿、全部关节与左右 Zivid RGB/XYZ 快照'
              : '当前地图或机器人与任务不匹配'}
          >
            <span><Save size={15} /></span>
            <div>
              <strong>{captureInProgress ? '正在冻结双目视觉…' : '记录当前机器人姿态'}</strong>
              <small>
                {captureInProgress
                  ? 'CAM-L + CAM-R · RGB + XYZ CLOUD'
                  : `MAP 6DOF + ${currentJointCount} JOINTS + DUAL VISION`}
              </small>
            </div>
            <kbd>T{String(activeTask.points.length + 1).padStart(2, '0')}</kbd>
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
            <span>示教序列</span>
            <i />
            <small>{activeTask.points.length} POINTS</small>
          </div>

          {!activeTask.points.length && (
            <div className="teaching-points-empty">
              <ClipboardCheck size={18} strokeWidth={1.3} />
              <span>
                {isDataView
                  ? '当前任务还没有点位，请返回主工作台完成采集。'
                  : '调整机器人后，点击上方按钮采集第一个示教点。'}
              </span>
            </div>
          )}

          <div className="teaching-point-list">
            {activeTask.points.map((point, index) => (
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
                  aria-label={`查看示教点 ${point.name}`}
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
                  aria-label={`应用示教点 ${point.name}`}
                  title="恢复地图定位与全身关节"
                  disabled={!contextMatches || !robotReady}
                  onClick={() => onApplyPoint(activeTask.id, point.id)}
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
                  <span>点位名称</span>
                  <input
                    aria-label="示教点名称"
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

              <div className="teaching-pose-grid" aria-label="示教点地图位姿">
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
                  aria-label="示教点双目视觉快照"
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
                  onClick={() => onApplyPoint(activeTask.id, selectedPoint.id)}
                >
                  <Play size={12} /> 应用到机器人
                </button>
                <button
                  type="button"
                  className="teaching-delete-point"
                  aria-label="删除当前示教点"
                  onClick={() => {
                    if (window.confirm(`删除示教点 ${selectedPoint.name}？`)) {
                      onDeletePoint(activeTask.id, selectedPoint.id);
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
              data-teaching-point-count={activeTask.points.length}
            >
              <span className="teaching-data-handoff__count">
                <b>{activeTask.points.length}</b>
                <small>POSES</small>
              </span>
              <div>
                <strong>当前已归档姿态</strong>
                <small>姿态查看、双目快照与工程导出由示教数据页统一管理</small>
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
