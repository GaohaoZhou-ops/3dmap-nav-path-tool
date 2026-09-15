import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  FileText,
  Folder,
  FolderOpen,
  GitMerge,
  ListTree,
  LoaderCircle,
  MapPin,
  Maximize2,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_PARKING_CLUSTER_DISTANCE,
  DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
  DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
} from '../lib/parkingPointMerge.js';
import ParkingPointMergeDialog from './ParkingPointMergeDialog.jsx';
import TeachingParkingMap from './TeachingParkingMap.jsx';

const formatCapturedAt = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '当前会话';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
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
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '--';
};

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
};

const poseCountForTask = (task) => (task?.parkingPoints || []).reduce(
  (total, parkingPoint) => total + (parkingPoint.poses?.length || 0),
  0,
);

const getDefaultSelection = (tasks, activeTaskId, activeParkingPointId) => {
  const task = tasks.find((item) => item.id === activeTaskId) || tasks[0] || null;
  if (!task) return null;
  const parkingPoint = (task.parkingPoints || []).find(
    (item) => item.id === activeParkingPointId,
  ) || task.parkingPoints?.[0] || null;
  if (!parkingPoint) return { type: 'task', taskId: task.id };
  const pose = parkingPoint.poses?.at(-1) || null;
  return pose
    ? {
        type: 'pose',
        taskId: task.id,
        parkingPointId: parkingPoint.id,
        poseId: pose.id,
      }
    : { type: 'parking', taskId: task.id, parkingPointId: parkingPoint.id };
};

const selectionExists = (tasks, selection) => {
  if (!selection) return false;
  const task = tasks.find((item) => item.id === selection.taskId);
  if (!task) return false;
  if (selection.type === 'task') return true;
  const parkingPoint = task.parkingPoints?.find(
    (item) => item.id === selection.parkingPointId,
  );
  if (!parkingPoint) return false;
  if (selection.type === 'parking') return true;
  return parkingPoint.poses?.some((pose) => pose.id === selection.poseId) || false;
};

export default function TeachingArchiveTree({
  tasks = [],
  activeTaskId,
  activeParkingPointId,
  mapData,
  heightRange,
  colorMode,
  robot,
  robotLoadState,
  parkingMergePlannerReady = false,
  projectExportState = { status: 'idle' },
  onSelectTask,
  onRenameTask,
  onDeleteTask,
  onSelectParkingPoint,
  onRenameParkingPoint,
  onDeleteParkingPoint,
  onApplyParkingPoint,
  onRenamePoint,
  onDeletePoint,
  onApplyPoint,
  onPlayTask,
  onAnalyzeParkingPointMerge,
  onMergeParkingPoints,
  onExportProject,
  onOpenCapturePage,
  onSelectionChange,
}) {
  const initialTask = tasks.find((task) => task.id === activeTaskId) || tasks[0] || null;
  const initialParkingPoint = initialTask?.parkingPoints?.find(
    (parkingPoint) => parkingPoint.id === activeParkingPointId,
  ) || initialTask?.parkingPoints?.[0] || null;
  const [collapsedTaskIds, setCollapsedTaskIds] = useState(() => new Set(
    tasks.filter((task) => task.id !== initialTask?.id).map((task) => task.id),
  ));
  const [collapsedParkingPointIds, setCollapsedParkingPointIds] = useState(() => new Set(
    tasks.flatMap((task) => (task.parkingPoints || [])
      .filter((parkingPoint) => parkingPoint.id !== initialParkingPoint?.id)
      .map((parkingPoint) => parkingPoint.id)),
  ));
  const knownTaskIdsRef = useRef(new Set(tasks.map((task) => task.id)));
  const knownParkingPointIdsRef = useRef(new Set(
    tasks.flatMap((task) => (task.parkingPoints || []).map((parkingPoint) => parkingPoint.id)),
  ));
  const [selection, setSelection] = useState(() => getDefaultSelection(
    tasks,
    activeTaskId,
    activeParkingPointId,
  ));
  const [nameDraft, setNameDraft] = useState('');
  const [visionPreview, setVisionPreview] = useState(null);
  const [mergeDialog, setMergeDialog] = useState(null);
  const mergeAnalysisRevisionRef = useRef(0);

  const selectedTask = tasks.find((task) => task.id === selection?.taskId)
    || tasks.find((task) => task.id === activeTaskId)
    || tasks[0]
    || null;
  const selectedParkingPoint = selectedTask?.parkingPoints?.find(
    (parkingPoint) => parkingPoint.id === selection?.parkingPointId,
  ) || null;
  const selectedPoint = selectedParkingPoint?.poses?.find(
    (pose) => pose.id === selection?.poseId,
  ) || null;
  const selectedEntity = selectedPoint || selectedParkingPoint || selectedTask;
  const totalParkingPoints = tasks.reduce(
    (total, task) => total + (task.parkingPoints?.length || 0),
    0,
  );
  const totalPoses = tasks.reduce((total, task) => total + poseCountForTask(task), 0);
  const taskRobotKey = selectedTask?.robot?.id || selectedTask?.robot?.relativePath;
  const currentRobotKey = robot?.id || robot?.relativePath;
  const sameRobot = Boolean(taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey);
  const sameMap = selectedTask?.map?.sourceHash && mapData?.sourceHash
    ? selectedTask.map.sourceHash === mapData.sourceHash
    : Boolean(selectedTask?.map?.fileName && selectedTask.map.fileName === mapData?.name);
  const contextMatches = Boolean(selectedTask && sameRobot && sameMap);
  const robotReady = robotLoadState?.status === 'loaded' && Boolean(robot);
  const mergePlannerAvailable = Boolean(
    parkingMergePlannerReady
    && robotReady
    && Number(robotLoadState?.zividCount) > 0,
  );
  const exportPacking = projectExportState?.status === 'packing';

  const jointEntries = useMemo(
    () => Object.entries(selectedPoint?.fullBodyJoints?.values || {})
      .sort(([left], [right]) => left.localeCompare(right)),
    [selectedPoint],
  );
  const selectedCameraFrames = ['left', 'right'].flatMap((side) => {
    const frame = selectedPoint?.cameraCapture?.frames?.[side];
    return frame ? [{ side, frame }] : [];
  });

  useEffect(() => {
    setSelection((current) => (
      selectionExists(tasks, current)
        ? current
        : getDefaultSelection(tasks, activeTaskId, activeParkingPointId)
    ));
  }, [activeParkingPointId, activeTaskId, tasks]);

  useEffect(() => {
    const nextTaskIds = new Set(tasks.map((task) => task.id));
    const nextParkingPointIds = new Set(
      tasks.flatMap((task) => (task.parkingPoints || []).map((parkingPoint) => parkingPoint.id)),
    );
    setCollapsedTaskIds((current) => {
      const next = new Set([...current].filter((id) => nextTaskIds.has(id)));
      tasks.forEach((task) => {
        if (!knownTaskIdsRef.current.has(task.id) && task.id !== activeTaskId) next.add(task.id);
      });
      return next;
    });
    setCollapsedParkingPointIds((current) => {
      const next = new Set([...current].filter((id) => nextParkingPointIds.has(id)));
      tasks.forEach((task) => (task.parkingPoints || []).forEach((parkingPoint) => {
        if (
          !knownParkingPointIdsRef.current.has(parkingPoint.id)
          && parkingPoint.id !== activeParkingPointId
        ) next.add(parkingPoint.id);
      }));
      return next;
    });
    knownTaskIdsRef.current = nextTaskIds;
    knownParkingPointIdsRef.current = nextParkingPointIds;
  }, [activeParkingPointId, activeTaskId, tasks]);

  useEffect(() => {
    if (activeTaskId) {
      setCollapsedTaskIds((current) => {
        if (!current.has(activeTaskId)) return current;
        const next = new Set(current);
        next.delete(activeTaskId);
        return next;
      });
    }
    if (activeParkingPointId) {
      setCollapsedParkingPointIds((current) => {
        if (!current.has(activeParkingPointId)) return current;
        const next = new Set(current);
        next.delete(activeParkingPointId);
        return next;
      });
    }
  }, [activeParkingPointId, activeTaskId]);

  useEffect(() => {
    setNameDraft(selectedEntity?.name || '');
  }, [selectedEntity?.id, selectedEntity?.name]);

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
    if (!mergeDialog) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape' || mergeDialog.status === 'analyzing') return;
      mergeAnalysisRevisionRef.current += 1;
      setMergeDialog(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mergeDialog]);

  const toggleCollapsed = (setter, id) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectTask = (task) => {
    onSelectTask(task.id);
    setNameDraft(task.name);
    setSelection({ type: 'task', taskId: task.id });
    onSelectionChange?.({ type: 'task', task, parkingPoint: null, pose: null });
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
  };

  const selectParkingPoint = (task, parkingPoint) => {
    if (task.id !== activeTaskId) onSelectTask(task.id);
    onSelectParkingPoint(parkingPoint.id);
    setNameDraft(parkingPoint.name);
    setSelection({
      type: 'parking',
      taskId: task.id,
      parkingPointId: parkingPoint.id,
    });
    onSelectionChange?.({ type: 'parking', task, parkingPoint, pose: null });
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
    setCollapsedParkingPointIds((current) => {
      const next = new Set(current);
      next.delete(parkingPoint.id);
      return next;
    });
  };

  const selectPose = (task, parkingPoint, pose) => {
    if (task.id !== activeTaskId) onSelectTask(task.id);
    if (parkingPoint.id !== activeParkingPointId) onSelectParkingPoint(parkingPoint.id);
    setNameDraft(pose.name);
    setSelection({
      type: 'pose',
      taskId: task.id,
      parkingPointId: parkingPoint.id,
      poseId: pose.id,
    });
    onSelectionChange?.({ type: 'pose', task, parkingPoint, pose });
  };

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (!selection || !selectedEntity || !nextName) {
      setNameDraft(selectedEntity?.name || '');
      return;
    }
    if (nextName === selectedEntity.name) return;
    if (selection.type === 'task') onRenameTask(selectedTask.id, nextName);
    if (selection.type === 'parking') {
      onRenameParkingPoint(selectedTask.id, selectedParkingPoint.id, nextName);
    }
    if (selection.type === 'pose') {
      onRenamePoint(selectedTask.id, selectedParkingPoint.id, selectedPoint.id, nextName);
    }
  };

  const normalizeMergeParameters = (value = {}) => {
    const clamp = (rawValue, minimum, maximum, fallback) => {
      const parsed = Number(rawValue);
      return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
    };
    return {
      distanceThreshold: clamp(
        value.distanceThreshold,
        0.02,
        5,
        DEFAULT_PARKING_CLUSTER_DISTANCE,
      ),
      positionToleranceCm: clamp(
        value.positionToleranceCm,
        0.1,
        50,
        DEFAULT_PARKING_MERGE_XYZ_TOLERANCE * 100,
      ),
      rotationTolerance: clamp(
        value.rotationTolerance,
        0.1,
        45,
        DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
      ),
    };
  };

  const runParkingMergeAnalysis = (task, requestedParameters) => {
    if (!task || typeof onAnalyzeParkingPointMerge !== 'function') return;
    const parameters = normalizeMergeParameters(requestedParameters);
    const revision = ++mergeAnalysisRevisionRef.current;
    setMergeDialog((current) => ({
      ...(current || {}),
      taskId: task.id,
      status: 'analyzing',
      parameters,
      result: current?.taskId === task.id ? current.result : null,
      analyzedParameters: current?.taskId === task.id ? current.analyzedParameters : null,
      selectedClusterIds: new Set(),
      error: '',
    }));
    window.requestAnimationFrame(async () => {
      try {
        const result = await onAnalyzeParkingPointMerge(task.id, {
          distanceThreshold: parameters.distanceThreshold,
          positionTolerance: parameters.positionToleranceCm / 100,
          rotationTolerance: parameters.rotationTolerance,
        });
        if (revision !== mergeAnalysisRevisionRef.current) return;
        setMergeDialog((current) => (
          current?.taskId === task.id
            ? {
                ...current,
                status: 'ready',
                result,
                analyzedParameters: parameters,
                selectedClusterIds: new Set(
                  (result?.clusters || []).filter((cluster) => cluster.feasible)
                    .map((cluster) => cluster.id),
                ),
                error: '',
              }
            : current
        ));
      } catch (error) {
        if (revision !== mergeAnalysisRevisionRef.current) return;
        setMergeDialog((current) => (
          current?.taskId === task.id
            ? {
                ...current,
                status: 'error',
                result: null,
                analyzedParameters: null,
                selectedClusterIds: new Set(),
                error: error?.message || '停车点合并分析失败',
              }
            : current
        ));
      }
    });
  };

  const openParkingMergeDialog = () => {
    if (!selectedTask || selectedTask.parkingPoints?.length < 2) return;
    runParkingMergeAnalysis(selectedTask, {
      distanceThreshold: DEFAULT_PARKING_CLUSTER_DISTANCE,
      positionToleranceCm: DEFAULT_PARKING_MERGE_XYZ_TOLERANCE * 100,
      rotationTolerance: DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
    });
  };

  const closeParkingMergeDialog = () => {
    if (mergeDialog?.status === 'analyzing') return;
    mergeAnalysisRevisionRef.current += 1;
    setMergeDialog(null);
  };

  const updateParkingMergeParameter = (name, value) => {
    setMergeDialog((current) => current
      ? { ...current, parameters: { ...current.parameters, [name]: value } }
      : current);
  };

  const toggleParkingMergeCluster = (clusterId) => {
    setMergeDialog((current) => {
      if (!current) return current;
      const selectedClusterIds = new Set(current.selectedClusterIds || []);
      if (selectedClusterIds.has(clusterId)) selectedClusterIds.delete(clusterId);
      else selectedClusterIds.add(clusterId);
      return { ...current, selectedClusterIds };
    });
  };

  const confirmParkingPointMerge = (clusters) => {
    const task = tasks.find((item) => item.id === mergeDialog?.taskId);
    if (!task || typeof onMergeParkingPoints !== 'function') return;
    const outcome = onMergeParkingPoints(task.id, clusters, mergeDialog.result);
    if (!outcome?.success) return;
    mergeAnalysisRevisionRef.current += 1;
    setSelection({ type: 'task', taskId: task.id });
    setMergeDialog(null);
  };

  const renderTree = () => tasks.map((task) => {
    const taskCollapsed = collapsedTaskIds.has(task.id);
    const taskSelected = selection?.type === 'task' && selection.taskId === task.id;
    return (
      <div className="teaching-tree-branch teaching-tree-branch--task" key={task.id} role="treeitem" aria-expanded={!taskCollapsed}>
        <div className={`teaching-tree-node teaching-tree-node--task ${taskSelected ? 'is-selected' : ''}`}>
          <button
            type="button"
            className="teaching-tree-expander"
            aria-label={`${taskCollapsed ? '展开' : '折叠'}任务 ${task.name}`}
            onClick={() => toggleCollapsed(setCollapsedTaskIds, task.id)}
          >
            {taskCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <button
            type="button"
            className="teaching-tree-label"
            aria-label={`选择示教任务 ${task.name}`}
            onClick={() => selectTask(task)}
          >
            {taskCollapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
            <span>{task.name}</span>
            <small>{task.parkingPoints?.length || 0} / {poseCountForTask(task)}</small>
          </button>
        </div>

        {!taskCollapsed && (
          <div className="teaching-tree-group teaching-tree-group--parking" role="group">
            {(task.parkingPoints || []).map((parkingPoint) => {
              const parkingCollapsed = collapsedParkingPointIds.has(parkingPoint.id);
              const parkingSelected = selection?.type === 'parking'
                && selection.parkingPointId === parkingPoint.id;
              return (
                <div className="teaching-tree-branch teaching-tree-branch--parking" key={parkingPoint.id} role="treeitem" aria-expanded={!parkingCollapsed}>
                  <div className={`teaching-tree-node teaching-tree-node--parking ${parkingSelected ? 'is-selected' : ''}`}>
                    <button
                      type="button"
                      className="teaching-tree-expander"
                      aria-label={`${parkingCollapsed ? '展开' : '折叠'}停车点 ${parkingPoint.name}`}
                      onClick={() => toggleCollapsed(
                        setCollapsedParkingPointIds,
                        parkingPoint.id,
                      )}
                    >
                      {parkingCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                    <button
                      type="button"
                      className="teaching-tree-label"
                      aria-label={`选择停车点 ${parkingPoint.name}`}
                      onClick={() => selectParkingPoint(task, parkingPoint)}
                    >
                      <MapPin size={12} />
                      <span>{parkingPoint.name}</span>
                      <small>{parkingPoint.poses?.length || 0}</small>
                    </button>
                  </div>

                  {!parkingCollapsed && (
                    <div className="teaching-tree-group teaching-tree-group--poses" role="group">
                      {(parkingPoint.poses || []).map((pose) => {
                        const poseSelected = selection?.type === 'pose'
                          && selection.poseId === pose.id;
                        return (
                          <div
                            className={`teaching-tree-node teaching-tree-node--pose teaching-point-row ${poseSelected ? 'is-selected' : ''}`}
                            key={pose.id}
                            role="treeitem"
                            data-teaching-point-id={pose.id}
                            data-joint-count={pose.fullBodyJoints?.count || 0}
                            data-camera-frame-count={Object.keys(pose.cameraCapture?.frames || {}).length}
                          >
                            <span className="teaching-tree-leaf-line" />
                            <button
                              type="button"
                              className="teaching-tree-label"
                              aria-label={`查看机械臂姿态 ${pose.name}`}
                              onClick={() => selectPose(task, parkingPoint, pose)}
                            >
                              <FileText size={11} />
                              <span>{pose.name}</span>
                              <small>{pose.fullBodyJoints?.count || 0}J</small>
                            </button>
                          </div>
                        );
                      })}
                      {!parkingPoint.poses?.length && (
                        <div className="teaching-tree-empty-leaf">暂无机械臂姿态</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!task.parkingPoints?.length && (
              <div className="teaching-tree-empty-leaf">暂无停车点</div>
            )}
          </div>
        )}
      </div>
    );
  });

  return (
    <>
      <section
        className="teaching-archive-tree"
        aria-label="示教数据管理"
        data-teaching-view="data"
        data-teaching-task-count={tasks.length}
        data-parking-point-count={totalParkingPoints}
        data-teaching-point-count={totalPoses}
        data-active-teaching-task={selectedTask?.id || ''}
        data-active-parking-point={selectedParkingPoint?.id || ''}
        data-teaching-context-match={contextMatches ? 'true' : 'false'}
        data-parking-merge-planner-ready={mergePlannerAvailable ? 'true' : 'false'}
        data-project-export-state={projectExportState?.status || 'idle'}
      >
        <header className="teaching-tree-toolbar">
          <div>
            <ListTree size={15} />
            <span><strong>示教数据树</strong><small>TASK / STOP / POSE</small></span>
          </div>
          <span>{tasks.length} 任务 · {totalParkingPoints} 停车点 · {totalPoses} 姿态</span>
          <button type="button" onClick={onOpenCapturePage}>继续示教</button>
          <button
            type="button"
            aria-label={exportPacking ? '正在打包示教工程 ZIP' : '导出示教工程 ZIP'}
            onClick={onExportProject}
            disabled={!mapData?.bounds || exportPacking}
            title="ZIP 内按任务、停车点、姿态分层保存配置、RGB 与点云"
          >
            {exportPacking
              ? <LoaderCircle className="is-spinning" size={11} />
              : <Download size={11} />}
            {exportPacking ? '打包中' : '导出 ZIP'}
          </button>
        </header>

        <div className="teaching-tree-workspace">
          <aside className="teaching-tree-pane" aria-label="示教层级树">
            <header><span>数据结构</span><small>名称 · 子项</small></header>
            {tasks.length ? (
              <div className="teaching-tree" role="tree" aria-label="任务停车点与机械臂姿态">
                {renderTree()}
              </div>
            ) : (
              <div className="teaching-tree-empty">
                <ListTree size={21} />
                <strong>暂无示教任务</strong>
                <span>返回工作台创建任务后，数据会按层级显示在这里。</span>
              </div>
            )}
          </aside>

          <section className="teaching-tree-detail" aria-label="选中节点详情">
            {!selectedEntity && (
              <div className="teaching-tree-detail__empty">
                <FileText size={20} />
                <span>从左侧树中选择一个节点</span>
              </div>
            )}

            {selectedEntity && (
              <>
                <header className="teaching-tree-detail__header">
                  <div className="teaching-tree-breadcrumb">
                    <span>{selectedTask?.name}</span>
                    {selectedParkingPoint && <><ChevronRight size={10} /><span>{selectedParkingPoint.name}</span></>}
                    {selectedPoint && <><ChevronRight size={10} /><strong>{selectedPoint.name}</strong></>}
                  </div>
                  <small>{selection?.type === 'task' ? 'TASK' : selection?.type === 'parking' ? 'PARKING STOP' : 'ARM POSE'}</small>
                </header>

                <div className={`teaching-tree-detail__body is-${selection?.type || 'empty'}`}>
                  <label className="teaching-tree-name-field">
                    <span>{selection?.type === 'task' ? '任务名称' : selection?.type === 'parking' ? '停车点名称' : '姿态名称'}</span>
                    <input
                      aria-label={selection?.type === 'task' ? '示教任务名称' : selection?.type === 'parking' ? '停车点名称' : '机械臂姿态名称'}
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      onBlur={commitName}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  </label>

                  {selection?.type === 'task' && selectedTask && (
                    <div className="teaching-tree-task-detail">
                      <dl>
                        <div><dt>停车点</dt><dd>{selectedTask.parkingPoints?.length || 0}</dd></div>
                        <div><dt>机械臂姿态</dt><dd>{poseCountForTask(selectedTask)}</dd></div>
                        <div><dt>地图</dt><dd>{selectedTask.map?.fileName || '未绑定'}</dd></div>
                        <div><dt>机器人</dt><dd>{selectedTask.robot?.name || '未绑定'}</dd></div>
                        <div><dt>创建时间</dt><dd>{formatCapturedAt(selectedTask.createdAt)}</dd></div>
                        <div><dt>坐标系</dt><dd>{selectedTask.coordinateFrame || 'map'}</dd></div>
                      </dl>
                      <div className="teaching-tree-task-actions">
                        <button
                          type="button"
                          className="teaching-tree-play-action"
                          aria-label={`播放示教任务 ${selectedTask.name}`}
                          disabled={!poseCountForTask(selectedTask) || !contextMatches || !robotReady}
                          title={!poseCountForTask(selectedTask)
                            ? '请先在停车点下记录至少一个机械臂姿态'
                            : !contextMatches
                              ? '当前地图或机器人与任务不匹配'
                              : !robotReady
                                ? '机器人模型尚未装配完成'
                                : '切换到主工作台，按停车点与姿态顺序执行连续规划轨迹'}
                          onClick={() => onPlayTask?.(selectedTask.id)}
                        >
                          <Play size={12} fill="currentColor" /> 播放任务
                        </button>
                        <button
                          type="button"
                          className="teaching-tree-merge-action"
                          aria-label="分析并合并当前任务的近邻停车点"
                          disabled={
                            selectedTask.parkingPoints?.length < 2
                            || !contextMatches
                            || !mergePlannerAvailable
                          }
                          title={selectedTask.parkingPoints?.length < 2
                            ? '至少需要两个停车点'
                            : !contextMatches
                              ? '当前地图或机器人与任务不匹配'
                              : !mergePlannerAvailable
                                ? '正在等待带末端相机的机器人运动学模型'
                                : '聚类距离较近的停车点，并搜索末端姿态可达的公共停车位'}
                          onClick={openParkingMergeDialog}
                        >
                          <GitMerge size={12} /> 合并停车点
                        </button>
                        <button
                          type="button"
                          className="teaching-tree-danger"
                          aria-label="删除当前示教任务"
                          onClick={() => {
                            if (window.confirm(`删除 ${selectedTask.name} 及其全部停车点和机械臂姿态？`)) {
                              onDeleteTask(selectedTask.id);
                            }
                          }}
                        >
                          <Trash2 size={11} /> 删除任务
                        </button>
                      </div>
                    </div>
                  )}

                  {selection?.type === 'parking' && selectedParkingPoint && (
                    <div className="teaching-tree-parking-detail">
                      <div className="teaching-tree-pose-values" aria-label="停车点地图位姿">
                        {[
                          ['X', selectedParkingPoint.mapPose.position.x, 'm'],
                          ['Y', selectedParkingPoint.mapPose.position.y, 'm'],
                          ['Z', selectedParkingPoint.mapPose.position.z, 'm'],
                          ['ROLL', selectedParkingPoint.mapPose.rpy.roll, '°'],
                          ['PITCH', selectedParkingPoint.mapPose.rpy.pitch, '°'],
                          ['YAW', selectedParkingPoint.mapPose.rpy.yaw, '°'],
                        ].map(([label, value, unit]) => (
                          <div key={label}><span>{label}</span><strong>{formatValue(value)}</strong><small>{unit}</small></div>
                        ))}
                      </div>
                      <div className="teaching-tree-parking-toolbar">
                        <p>{selectedParkingPoint.poses?.length || 0} 组机械臂姿态 · MAP 绝对位姿</p>
                        <div className="teaching-tree-actions">
                          <button
                            type="button"
                            disabled={!contextMatches || !robotReady}
                            onClick={() => onApplyParkingPoint(selectedTask.id, selectedParkingPoint.id)}
                          >
                            <Play size={11} /> 定位到停车点
                          </button>
                          <button
                            type="button"
                            className="teaching-tree-danger"
                            aria-label="删除当前停车点"
                            onClick={() => {
                              if (window.confirm(`删除 ${selectedParkingPoint.name} 及其 ${selectedParkingPoint.poses?.length || 0} 组机械臂姿态？`)) {
                                onDeleteParkingPoint(selectedTask.id, selectedParkingPoint.id);
                              }
                            }}
                          >
                            <Trash2 size={11} /> 删除停车点
                          </button>
                        </div>
                      </div>
                      <TeachingParkingMap
                        mapData={mapData}
                        heightRange={heightRange}
                        colorMode={colorMode}
                        parkingPoint={selectedParkingPoint}
                      />
                    </div>
                  )}

                  {selection?.type === 'pose' && selectedPoint && (
                    <div
                      className="teaching-tree-pose-detail teaching-point-detail"
                      data-selected-teaching-point={selectedPoint.id}
                      data-map-x={selectedPoint.mapPose.position.x}
                      data-map-y={selectedPoint.mapPose.position.y}
                      data-map-z={selectedPoint.mapPose.position.z}
                      data-map-roll={selectedPoint.mapPose.rpy.roll}
                      data-map-pitch={selectedPoint.mapPose.rpy.pitch}
                      data-map-yaw={selectedPoint.mapPose.rpy.yaw}
                    >
                      <div className="teaching-tree-pose-meta">
                        <span>记录时间</span><strong>{formatCapturedAt(selectedPoint.capturedAt)}</strong>
                        <span>全身关节</span><strong>{selectedPoint.fullBodyJoints?.count || 0} VALUES</strong>
                      </div>
                      <div className="teaching-tree-pose-values" aria-label="机械臂姿态记录位姿">
                        {[
                          ['X', selectedPoint.mapPose.position.x, 'm'],
                          ['Y', selectedPoint.mapPose.position.y, 'm'],
                          ['Z', selectedPoint.mapPose.position.z, 'm'],
                          ['ROLL', selectedPoint.mapPose.rpy.roll, '°'],
                          ['PITCH', selectedPoint.mapPose.rpy.pitch, '°'],
                          ['YAW', selectedPoint.mapPose.rpy.yaw, '°'],
                        ].map(([label, value, unit]) => (
                          <div key={label}><span>{label}</span><strong>{formatValue(value)}</strong><small>{unit}</small></div>
                        ))}
                      </div>

                      {selectedCameraFrames.length > 0 && (
                        <section
                          className="teaching-vision-capture teaching-tree-vision"
                          aria-label="机械臂姿态双目视觉快照"
                          data-camera-frame-count={selectedCameraFrames.length}
                          data-camera-model={selectedPoint.cameraCapture.cameraModel || ''}
                        >
                          <header>
                            <span><Camera size={11} /></span>
                            <div><strong>双目视觉快照</strong><small>RGB / OPTICAL XYZ</small></div>
                            <em>{formatBytes(selectedPoint.cameraCapture.storageByteLength)}</em>
                          </header>
                          <div className="teaching-vision-grid">
                            {selectedCameraFrames.map(({ side, frame }) => {
                              const sideLabel = side === 'left' ? '左臂' : '右臂';
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
                                      { id: 'rgb', label: 'RGB', icon: Camera, image: frame.rgb },
                                      { id: 'pointcloud', label: 'XYZ', icon: Cloud, image: frame.pointCloud?.preview },
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
                          <div key={name}><span title={name}>{name}</span><strong>{formatValue(value)}</strong></div>
                        ))}
                        {!jointEntries.length && <p>当前模型没有可动关节值</p>}
                      </div>

                      <div className="teaching-tree-actions">
                        <button
                          type="button"
                          disabled={!contextMatches || !robotReady}
                          onClick={() => onApplyPoint(
                            selectedTask.id,
                            selectedParkingPoint.id,
                            selectedPoint.id,
                          )}
                        >
                          <Play size={11} /> 应用到机器人
                        </button>
                        <button
                          type="button"
                          className="teaching-tree-danger"
                          aria-label="删除当前机械臂姿态"
                          onClick={() => {
                            if (window.confirm(`删除机械臂姿态 ${selectedPoint.name}？`)) {
                              onDeletePoint(
                                selectedTask.id,
                                selectedParkingPoint.id,
                                selectedPoint.id,
                              );
                            }
                          }}
                        >
                          <Trash2 size={11} /> 删除姿态
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </section>

      {mergeDialog && (
        <ParkingPointMergeDialog
          task={tasks.find((task) => task.id === mergeDialog.taskId)}
          state={mergeDialog}
          onClose={closeParkingMergeDialog}
          onParameterChange={updateParkingMergeParameter}
          onAnalyze={() => {
            const task = tasks.find((item) => item.id === mergeDialog.taskId);
            runParkingMergeAnalysis(task, mergeDialog.parameters);
          }}
          onToggleCluster={toggleParkingMergeCluster}
          onConfirm={confirmParkingPointMerge}
        />
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
              <div><small>TEACHING VISION ARCHIVE · {visionPreview.frameName}</small><strong>{visionPreview.title}</strong></div>
              <span>{visionPreview.mode === 'pointcloud' ? `${Number(visionPreview.pointCount).toLocaleString('zh-CN')} XYZ POINTS` : `${visionPreview.image.width} × ${visionPreview.image.height}`}</span>
              <button type="button" aria-label="关闭示教视觉快照" onClick={() => setVisionPreview(null)}><X size={15} /></button>
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
