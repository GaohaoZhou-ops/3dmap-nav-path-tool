import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CircleDot,
  History,
  Route,
  ShieldCheck,
} from 'lucide-react';
import TeachingArchiveTree from './TeachingArchiveTree.jsx';
import TeachingPoseRobotPreview from './TeachingPoseRobotPreview.jsx';

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
};

export default function TeachingDataPage({
  tasks = [],
  activeTaskId,
  activeParkingPointId,
  mapData,
  heightRange,
  pointColorMode,
  robot,
  robotLoadState,
  robotJointValues,
  captureState,
  parkingMergePlannerReady,
  projectExportState,
  sessionState,
  recovery,
  onBack,
  onOpenLastProject,
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
}) {
  const [archiveSelection, setArchiveSelection] = useState(null);
  const activeTask = tasks.find((task) => task.id === activeTaskId) || tasks[0] || null;
  const parkingPointCount = tasks.reduce(
    (total, task) => total + (task.parkingPoints?.length || 0),
    0,
  );
  const pointCount = tasks.reduce(
    (total, task) => total + (task.parkingPoints || []).reduce(
      (parkingTotal, parkingPoint) => parkingTotal + (parkingPoint.poses?.length || 0),
      0,
    ),
    0,
  );
  const cameraFrameCount = tasks.reduce(
    (total, task) => total + (task.parkingPoints || []).reduce(
      (parkingTotal, parkingPoint) => parkingTotal + (parkingPoint.poses || []).reduce(
        (pointTotal, point) => pointTotal + Object.keys(point.cameraCapture?.frames || {}).length,
        0,
      ),
      0,
    ),
    0,
  );
  const archiveBytes = tasks.reduce(
    (total, task) => total + (task.parkingPoints || []).reduce(
      (parkingTotal, parkingPoint) => parkingTotal + (parkingPoint.poses || []).reduce(
        (pointTotal, point) => pointTotal + Number(point.cameraCapture?.storageByteLength || 0),
        0,
      ),
      0,
    ),
    0,
  );
  const handleArchiveSelection = useCallback((selection) => {
    setArchiveSelection((current) => (
      current?.type === selection?.type
      && current?.task === selection?.task
      && current?.parkingPoint === selection?.parkingPoint
      && current?.pose === selection?.pose
        ? current
        : selection
    ));
  }, []);
  const previewRobot = useMemo(() => {
    const taskRobot = archiveSelection?.task?.robot || activeTask?.robot || null;
    const taskRobotKey = taskRobot?.id || taskRobot?.relativePath || '';
    const currentRobotKey = robot?.id || robot?.relativePath || '';
    return taskRobotKey && taskRobotKey === currentRobotKey ? robot : taskRobot;
  }, [activeTask?.robot, archiveSelection?.task?.robot, robot]);

  useEffect(() => {
    setArchiveSelection((current) => {
      if (!current) return current;
      const taskId = current.task?.id;
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return null;
      if (current.type === 'task') {
        return current.task === task ? current : { type: 'task', task, parkingPoint: null, pose: null };
      }
      if (current.type === 'pose' && current.pose?.id) {
        const parkingPoint = (task.parkingPoints || []).find((item) => (
          (item.poses || []).some((pose) => pose.id === current.pose.id)
        ));
        const pose = parkingPoint?.poses?.find((item) => item.id === current.pose.id);
        if (parkingPoint && pose) {
          return current.task === task
            && current.parkingPoint === parkingPoint
            && current.pose === pose
            ? current
            : { type: 'pose', task, parkingPoint, pose };
        }
      }
      const parkingPoint = task.parkingPoints?.find(
        (item) => item.id === current.parkingPoint?.id,
      );
      return parkingPoint
        ? { type: 'parking', task, parkingPoint, pose: null }
        : { type: 'task', task, parkingPoint: null, pose: null };
    });
  }, [tasks]);

  return (
    <div
      className="teaching-data-page"
      aria-label="示教数据子网页"
      data-page="teaching-data"
      data-teaching-task-count={tasks.length}
      data-parking-point-count={parkingPointCount}
      data-teaching-point-count={pointCount}
      data-active-teaching-task={activeTask?.id || ''}
    >
      <header className="teaching-data-page__topbar">
        <div className="teaching-data-page__brand">
          <span><Route size={17} /></span>
          <div><small>ATLAS / ROUTE</small><strong>路径图谱工坊</strong></div>
        </div>
        <nav aria-label="应用页面">
          <button type="button" onClick={onBack}>主工作台</button>
          <i>/</i>
          <strong aria-current="page">示教数据</strong>
        </nav>
        {recovery?.available && (
          <button
            type="button"
            className="teaching-data-page__recovery"
            aria-label="恢复上一次工程"
            onClick={onOpenLastProject}
            title={`恢复 ${recovery.mapName || '上一次未完成工程'} · ${recovery.taskCount || 0} 个示教任务`}
          >
            <History size={13} />
            <span>
              <strong>恢复工程</strong>
              <small>{recovery.mapName || '未完成工程'}</small>
            </span>
          </button>
        )}
        <div className={`teaching-data-page__session is-${sessionState?.status || 'checking'}`}>
          <ShieldCheck size={12} />
          <span>{sessionState?.status === 'ready' ? 'SESSION SYNCED' : 'SESSION CHECK'}</span>
        </div>
        <button
          type="button"
          className="teaching-data-page__back"
          aria-label="返回主工作台继续示教"
          onClick={onBack}
        >
          <ArrowLeft size={14} />
          <span><strong>返回工作台</strong><small>继续姿态采集</small></span>
        </button>
      </header>

      <main className="teaching-data-page__scroll">
        <div className="teaching-data-page__content">
          <section className="teaching-data-page__hero">
            <div>
              <span className="eyebrow">TEACHING DATA / OPERATIONS ARCHIVE</span>
              <h1>示教数据中心</h1>
            </div>
            <dl aria-label="示教数据统计">
              <div><dt>TASKS</dt><dd>{String(tasks.length).padStart(2, '0')}</dd><span>示教任务</span></div>
              <div><dt>STOPS</dt><dd>{String(parkingPointCount).padStart(2, '0')}</dd><span>停车点</span></div>
              <div><dt>POSES</dt><dd>{String(pointCount).padStart(2, '0')}</dd><span>全身姿态</span></div>
              <div><dt>ARCHIVE</dt><dd>{formatBytes(archiveBytes)}</dd><span>视觉数据</span></div>
            </dl>
          </section>

          <div className="teaching-data-page__workspace">
            <section className="teaching-data-page__archive" aria-label="示教任务管理工作区">
              <TeachingArchiveTree
                tasks={tasks}
                activeTaskId={activeTaskId}
                activeParkingPointId={activeParkingPointId}
                mapData={mapData}
                heightRange={heightRange}
                colorMode={pointColorMode}
                robot={robot}
                robotLoadState={robotLoadState}
                parkingMergePlannerReady={parkingMergePlannerReady}
                projectExportState={projectExportState}
                onSelectTask={onSelectTask}
                onRenameTask={onRenameTask}
                onDeleteTask={onDeleteTask}
                onSelectParkingPoint={onSelectParkingPoint}
                onRenameParkingPoint={onRenameParkingPoint}
                onDeleteParkingPoint={onDeleteParkingPoint}
                onApplyParkingPoint={onApplyParkingPoint}
                onRenamePoint={onRenamePoint}
                onDeletePoint={onDeletePoint}
                onApplyPoint={onApplyPoint}
                onPlayTask={onPlayTask}
                onAnalyzeParkingPointMerge={onAnalyzeParkingPointMerge}
                onMergeParkingPoints={onMergeParkingPoints}
                onExportProject={onExportProject}
                onOpenCapturePage={onBack}
                onSelectionChange={handleArchiveSelection}
              />
            </section>

            <TeachingPoseRobotPreview
              task={archiveSelection?.task || activeTask}
              parkingPoint={archiveSelection?.parkingPoint || null}
              pose={archiveSelection?.pose || null}
              robot={previewRobot}
            />
          </div>
        </div>
      </main>

      <footer className="teaching-data-page__statusbar">
        <span><CircleDot size={9} /> TEACHING ARCHIVE</span>
        <span>{tasks.length} TASKS / {parkingPointCount} STOPS / {pointCount} POSES / {cameraFrameCount} CAMERA FRAMES</span>
        <strong>MAP FRAME · ABSOLUTE POSE</strong>
      </footer>
    </div>
  );
}
