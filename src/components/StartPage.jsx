import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Box,
  CircleDot,
  Database,
  FolderOpen,
  FolderPlus,
  Map as MapIcon,
  Route,
  ScanLine,
  Server,
  ShieldCheck,
} from 'lucide-react';

const normalizeMode = (value) => value === 'independent' ? 'independent' : 'map';

export default function StartPage({
  initialMode = 'map',
  workspaces = {},
  sessionState,
  projectDirectoryState,
  busy = false,
  onNewProject,
  onLoadProject,
  onContinue,
  onOpenTeachingData,
}) {
  const [selectedMode, setSelectedMode] = useState(() => normalizeMode(initialMode));
  const modeTouchedRef = useRef(false);

  useEffect(() => {
    if (!modeTouchedRef.current) setSelectedMode(normalizeMode(initialMode));
  }, [initialMode]);

  const chooseMode = (mode) => {
    modeTouchedRef.current = true;
    setSelectedMode(normalizeMode(mode));
  };
  const independent = selectedMode === 'independent';
  const selectedWorkspace = workspaces?.[selectedMode] || null;
  const hasWorkspace = Boolean(selectedWorkspace?.available);
  const mapWorkspace = workspaces?.map || null;
  const independentWorkspace = workspaces?.independent || null;
  const sessionReady = sessionState?.status === 'ready';
  const controlsDisabled = busy || !sessionReady;

  return (
    <div
      className={`start-page ${independent ? 'is-independent-selected' : 'is-map-selected'}`}
      data-app-page="home"
      data-selected-teaching-mode={selectedMode}
      data-has-workspace={hasWorkspace ? 'true' : 'false'}
      data-map-workspace={mapWorkspace?.available ? 'cached' : 'empty'}
      data-independent-workspace={independentWorkspace?.available ? 'cached' : 'empty'}
      data-session-state={sessionState?.status || 'checking'}
    >
      <header className="start-page__topbar">
        <div className="start-page__brand">
          <span><Route size={20} strokeWidth={1.7} /></span>
          <div><small>ATLAS / TEACHING</small><strong>虚拟示教平台</strong></div>
        </div>
        <div className="start-page__system">
          <span className={`is-${sessionState?.status || 'checking'}`}>
            <ShieldCheck size={12} />
            {sessionReady ? '工作会话就绪' : '正在恢复工作会话'}
          </span>
          <span><Server size={12} /> LAN :21990</span>
        </div>
        {hasWorkspace && (
          <button
            type="button"
            className="start-page__continue-compact"
            onClick={() => onContinue?.(selectedMode)}
            disabled={busy}
            aria-label="继续工作"
          >
            <span>
              <small>{independent ? 'INDEPENDENT CACHE' : 'MAP CACHE'}</small>
              <strong>继续工作</strong>
            </span>
            <ArrowRight size={15} />
          </button>
        )}
      </header>

      <main className="start-page__main">
        <section className="start-page__intro" aria-labelledby="start-page-title">
          <div className="start-page__sequence"><span>00</span><i /><small>MISSION ENTRY</small></div>
          <p className="start-page__eyebrow">ROBOT DIGITAL TEACHING / LOCAL WORKSPACE</p>
          <h1 id="start-page-title"><strong>虚拟示教平台</strong></h1>
        </section>

        <section className="start-page__flow" aria-label="开始示教">
          <div className="start-page__step-heading">
            <span>01</span>
            <div><small>TEACHING MODE</small><strong>选择示教模式</strong></div>
          </div>

          <div className="start-page__mode-grid" role="radiogroup" aria-label="示教模式">
            <button
              type="button"
              role="radio"
              aria-checked={!independent}
              className={!independent ? 'is-selected' : ''}
              onClick={() => chooseMode('map')}
              disabled={busy}
            >
              <span className="start-page__mode-index">A</span>
              {mapWorkspace?.available && (
                <span className="start-page__mode-cache"><Database size={9} /> 已缓存</span>
              )}
              <span className="start-page__mode-icon"><MapIcon size={25} /></span>
              <span className="start-page__mode-copy">
                <small>MAP FRAME / GLOBAL</small>
                <strong>地图示教</strong>
                <p>加载完整场景地图，在全局 MAP 坐标系中规划停车点、路径与机械臂姿态。</p>
              </span>
              <span className="start-page__mode-state"><CircleDot size={10} /> {!independent ? '已选择' : '选择'}</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={independent}
              className={independent ? 'is-selected' : ''}
              onClick={() => chooseMode('independent')}
              disabled={busy}
            >
              <span className="start-page__mode-index">B</span>
              {independentWorkspace?.available && (
                <span className="start-page__mode-cache"><Database size={9} /> 已缓存</span>
              )}
              <span className="start-page__mode-icon"><ScanLine size={25} /></span>
              <span className="start-page__mode-copy">
                <small>VIRTUAL_ORIGIN / LOCAL</small>
                <strong>独立示教</strong>
                <p>加载局部点云，以点云原点建立隔离虚拟空间，适合工位、台面与局部扫描示教。</p>
              </span>
              <span className="start-page__mode-state"><CircleDot size={10} /> {independent ? '已选择' : '选择'}</span>
            </button>
          </div>

          <div className="start-page__step-heading start-page__step-heading--project">
            <span>02</span>
            <div><small>PROJECT</small><strong>选择工程入口</strong></div>
          </div>

          <div className="start-page__project-actions">
            <button
              type="button"
              className="start-page__new-project"
              onClick={() => onNewProject?.(selectedMode)}
              disabled={controlsDisabled}
              aria-label="新建工程"
            >
              <span><FolderPlus size={20} /></span>
              <span>
                <small>{independent ? 'VIRTUAL_ORIGIN PROJECT' : 'MAP FRAME PROJECT'}</small>
                <strong>新建工程</strong>
                <p>{independent ? '选择局部 PLY 点云并建立独立空间' : '选择完整 PLY 地图并进入地图示教'}</p>
              </span>
              <ArrowRight size={17} />
            </button>

            <button
              type="button"
              className="start-page__load-project"
              onClick={onLoadProject}
              disabled={controlsDisabled}
              aria-label="加载工程"
            >
              <span><FolderOpen size={20} /></span>
              <span>
                <small>ATLAS.PROJECT.JSON</small>
                <strong>加载工程</strong>
                <p>打开已有工程目录并恢复其模式、资源、视角与未完成任务</p>
              </span>
              <ArrowRight size={17} />
            </button>
          </div>

          {!sessionReady && (
            <div className="start-page__boot-status" role="status">
              <i /><span>正在检查服务会话与本地点云缓存，请稍候…</span>
            </div>
          )}
        </section>

        {hasWorkspace && (
          <section className="start-page__resume" aria-label="当前工作现场">
            <div className="start-page__resume-icon">
              {independent ? <ScanLine size={21} /> : <Box size={21} />}
            </div>
            <div className="start-page__resume-copy">
              <small>CACHED WORKSPACE / {independent ? 'VIRTUAL_ORIGIN' : 'MAP'}</small>
              <strong>{selectedWorkspace.mapName || '未命名工作现场'}</strong>
              <span>
                {(Number(selectedWorkspace.pointCount) || 0).toLocaleString('zh-CN')} 点
                <i />{Number(selectedWorkspace.waypointCount) || 0} 导航点
                <i />{Number(selectedWorkspace.taskCount) || 0} 示教任务
                {selectedWorkspace.robotName ? <><i />{selectedWorkspace.robotName}</> : null}
              </span>
            </div>
            {Number(selectedWorkspace.taskCount) > 0 && (
              <button type="button" onClick={() => onOpenTeachingData?.(selectedMode)} disabled={busy}>
                <Database size={13} /> 示教数据
              </button>
            )}
            <button
              type="button"
              className="start-page__resume-action"
              onClick={() => onContinue?.(selectedMode)}
              disabled={busy}
            >
              继续工作 <ArrowRight size={14} />
            </button>
          </section>
        )}
      </main>

      <footer className="start-page__footer">
        <span><CircleDot size={9} /> MODE / {independent ? 'INDEPENDENT TEACHING' : 'MAP TEACHING'}</span>
        <span>{projectDirectoryState?.status === 'synced'
          ? `${projectDirectoryState.name} · PROJECT SYNCED`
          : 'LOCAL SESSION AUTO-SAVE'}</span>
      </footer>
    </div>
  );
}
