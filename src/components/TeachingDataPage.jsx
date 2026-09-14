import {
  ArrowLeft,
  Bot,
  Camera,
  CircleDot,
  Database,
  HardDrive,
  MapPin,
  Route,
  ShieldCheck,
} from 'lucide-react';
import VirtualTeachingPanel from './VirtualTeachingPanel.jsx';

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
  mapData,
  robot,
  robotLoadState,
  robotJointValues,
  captureState,
  sessionState,
  onBack,
  onSelectTask,
  onRenameTask,
  onDeleteTask,
  onRenamePoint,
  onDeletePoint,
  onApplyPoint,
  onExportProject,
}) {
  const activeTask = tasks.find((task) => task.id === activeTaskId) || tasks[0] || null;
  const pointCount = tasks.reduce((total, task) => total + (task.points?.length || 0), 0);
  const cameraFrameCount = tasks.reduce(
    (total, task) => total + (task.points || []).reduce(
      (pointTotal, point) => pointTotal + Object.keys(point.cameraCapture?.frames || {}).length,
      0,
    ),
    0,
  );
  const archiveBytes = tasks.reduce(
    (total, task) => total + (task.points || []).reduce(
      (pointTotal, point) => pointTotal + Number(point.cameraCapture?.storageByteLength || 0),
      0,
    ),
    0,
  );

  return (
    <div
      className="teaching-data-page"
      aria-label="示教数据子网页"
      data-page="teaching-data"
      data-teaching-task-count={tasks.length}
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
              <p>集中管理任务、点位、全身关节与双目视觉快照；实时姿态采集留在主工作台。</p>
            </div>
            <dl aria-label="示教数据统计">
              <div><dt>TASKS</dt><dd>{String(tasks.length).padStart(2, '0')}</dd><span>示教任务</span></div>
              <div><dt>POSES</dt><dd>{String(pointCount).padStart(2, '0')}</dd><span>全身姿态</span></div>
              <div><dt>FRAMES</dt><dd>{String(cameraFrameCount).padStart(2, '0')}</dd><span>相机帧</span></div>
              <div><dt>ARCHIVE</dt><dd>{formatBytes(archiveBytes)}</dd><span>视觉数据</span></div>
            </dl>
          </section>

          <div className="teaching-data-page__workspace">
            <aside className="teaching-data-page__ledger" aria-label="示教归档上下文">
              <header><Database size={13} /><span>归档上下文</span><small>READ / MANAGE</small></header>
              <section>
                <small>ACTIVE TASK</small>
                <strong>{activeTask?.name || '暂无示教任务'}</strong>
                <span>{activeTask ? `${activeTask.points?.length || 0} 个已记录姿态` : '请返回工作台建立第一项任务'}</span>
              </section>
              <dl>
                <div>
                  <dt><MapPin size={11} /> 当前地图</dt>
                  <dd title={mapData?.name}>{mapData?.name || '未加载'}</dd>
                </div>
                <div>
                  <dt><Bot size={11} /> 机器人</dt>
                  <dd title={robot?.name}>{robot?.name || '未选择'}</dd>
                </div>
                <div>
                  <dt><Camera size={11} /> 双目快照</dt>
                  <dd>{cameraFrameCount} FRAMES</dd>
                </div>
                <div>
                  <dt><HardDrive size={11} /> 数据体积</dt>
                  <dd>{formatBytes(archiveBytes)}</dd>
                </div>
              </dl>
              <div className="teaching-data-page__policy">
                <CircleDot size={11} />
                <p><strong>采集与管理分离</strong><span>新建示教任务、打开已有任务和记录机器人当前姿态仍位于主工作台的“示教 / 相机”页。</span></p>
              </div>
            </aside>

            <section className="teaching-data-page__archive" aria-label="示教任务管理工作区">
              <VirtualTeachingPanel
                tasks={tasks}
                activeTaskId={activeTaskId}
                mapData={mapData}
                robot={robot}
                robotLoadState={robotLoadState}
                robotJointValues={robotJointValues}
                view="data"
                captureState={captureState}
                onSelectTask={onSelectTask}
                onRenameTask={onRenameTask}
                onDeleteTask={onDeleteTask}
                onRenamePoint={onRenamePoint}
                onDeletePoint={onDeletePoint}
                onApplyPoint={onApplyPoint}
                onExportProject={onExportProject}
                onOpenCapturePage={onBack}
              />
            </section>
          </div>
        </div>
      </main>

      <footer className="teaching-data-page__statusbar">
        <span><CircleDot size={9} /> TEACHING ARCHIVE</span>
        <span>{tasks.length} TASKS / {pointCount} POSES / {cameraFrameCount} CAMERA FRAMES</span>
        <strong>MAP FRAME · ABSOLUTE POSE</strong>
      </footer>
    </div>
  );
}
