import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  Crosshair,
  Download,
  FileJson,
  MapPin,
  Play,
  Save,
  Trash2,
} from 'lucide-react';

const formatValue = (value, digits = 3) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '0.000';
};

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

export default function VirtualTeachingPanel({
  tasks,
  activeTaskId,
  mapData,
  robot,
  robotLoadState,
  robotJointValues,
  onCreateTask,
  onSelectTask,
  onRenameTask,
  onDeleteTask,
  onCapturePoint,
  onRenamePoint,
  onDeletePoint,
  onApplyPoint,
  onExportProject,
}) {
  const activeTask = tasks.find((task) => task.id === activeTaskId) || tasks[0] || null;
  const [taskNameDraft, setTaskNameDraft] = useState(activeTask?.name || '');
  const [selectedPointId, setSelectedPointId] = useState(
    activeTask?.points.at(-1)?.id || null,
  );
  const selectedPoint = activeTask?.points.find((point) => point.id === selectedPointId) || null;
  const [pointNameDraft, setPointNameDraft] = useState(selectedPoint?.name || '');

  useEffect(() => {
    setTaskNameDraft(activeTask?.name || '');
  }, [activeTask?.id, activeTask?.name]);

  useEffect(() => {
    setSelectedPointId(activeTask?.points.at(-1)?.id || null);
  }, [activeTask?.id, activeTask?.points.length]);

  useEffect(() => {
    setPointNameDraft(selectedPoint?.name || '');
  }, [selectedPoint?.id, selectedPoint?.name]);

  const jointEntries = useMemo(
    () => Object.entries(selectedPoint?.fullBodyJoints?.values || {})
      .sort(([left], [right]) => left.localeCompare(right)),
    [selectedPoint],
  );
  const currentJointCount = Object.keys(robotJointValues || {}).length;
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
    <section
      className={`virtual-teaching ${activeTask ? 'has-task' : 'is-empty'}`}
      aria-label="虚拟示教"
      data-teaching-task-count={tasks.length}
      data-active-teaching-task={activeTask?.id || ''}
      data-teaching-context-match={contextMatches ? 'true' : 'false'}
      data-current-joint-count={currentJointCount}
    >
      <div className="virtual-teaching__header">
        <div className="virtual-teaching__identity">
          <span><Crosshair size={14} /></span>
          <div>
            <small>VIRTUAL TEACH / PROJECT CORE</small>
            <strong>虚拟示教</strong>
          </div>
        </div>
        <button
          type="button"
          className="teaching-new-task"
          onClick={onCreateTask}
          disabled={!canCreate}
          title={canCreate ? '以当前地图和机器人新建示教任务' : '请先加载地图与机器人'}
        >
          <CirclePlus size={12} /> 新建任务
        </button>
      </div>

      <div
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
      </div>

      {!activeTask && (
        <div className="teaching-empty-state">
          <div className="teaching-empty-state__reticle"><i /><span /></div>
          <strong>{canCreate ? '建立第一条示教任务' : '等待地图与机器人'}</strong>
          <span>
            {canCreate
              ? '任务将绑定当前地图和机器人；调整完成后逐点记录全身状态。'
              : '机器人装配完成后，可记录地图定位与所有可动关节。'}
          </span>
        </div>
      )}

      {activeTask && (
        <>
          <div className="teaching-task-bar">
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
          </div>

          <label className="teaching-name-field">
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
          </label>

          <div className={`teaching-context ${contextMatches ? 'is-matched' : 'is-mismatch'}`}>
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
          </div>

          <button
            type="button"
            className="teaching-capture-button"
            onClick={onCapturePoint}
            disabled={!canCapture}
            aria-label="记录当前机器人姿态"
            title={canCapture ? '保存当前地图位姿和全部可动关节' : '当前地图或机器人与任务不匹配'}
          >
            <span><Save size={15} /></span>
            <div>
              <strong>记录当前机器人姿态</strong>
              <small>MAP 6DOF + {currentJointCount} JOINT VALUES</small>
            </div>
            <kbd>T{String(activeTask.points.length + 1).padStart(2, '0')}</kbd>
          </button>

          <div className="teaching-sequence-heading">
            <span>示教序列</span>
            <i />
            <small>{activeTask.points.length} POINTS</small>
          </div>

          {!activeTask.points.length && (
            <div className="teaching-points-empty">
              <ClipboardCheck size={18} strokeWidth={1.3} />
              <span>调整机器人后，点击上方按钮采集第一个示教点。</span>
            </div>
          )}

          <div className="teaching-point-list">
            {activeTask.points.map((point, index) => (
              <div
                className={`teaching-point-row ${point.id === selectedPointId ? 'is-selected' : ''}`}
                key={point.id}
                data-teaching-point-id={point.id}
                data-joint-count={point.fullBodyJoints?.count || 0}
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
                  <em>{point.fullBodyJoints?.count || 0} JTS</em>
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
        </>
      )}
    </section>
  );
}
