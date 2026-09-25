import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Clock3,
  Database,
  FileJson,
  FolderOpen,
  HardDrive,
  History,
  LoaderCircle,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';

const formatTimestamp = (value) => {
  if (!value) return '尚无保存时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '保存时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
};

const workspaceFacts = (workspace) => {
  if (!workspace?.available) return [];
  return [
    `${Number(workspace.waypointCount) || 0} 导航点`,
    `${Number(workspace.taskCount) || 0} 示教任务`,
    workspace.robotName || '未加载机器人',
  ];
};

export default function ProjectLoadDialog({
  open,
  teachingSpaceMode = 'map',
  directory,
  workspace,
  recovery,
  busy = false,
  onClose,
  onLoadDefaultDirectory,
  onLoadWorkspace,
  onLoadRecovery,
  onChooseDirectory,
  onChooseGuideFile,
}) {
  const primaryButtonRef = useRef(null);
  const isIndependent = teachingSpaceMode === 'independent';
  const isChecking = directory?.status === 'checking';
  const hasDirectory = directory?.status === 'available' && Boolean(directory.handle);
  const hasWorkspace = Boolean(workspace?.available);
  const hasRecovery = Boolean(recovery?.available && recovery.teachingSpaceMode === teachingSpaceMode);
  const defaultSource = hasDirectory
    ? 'directory'
    : hasWorkspace
      ? 'workspace'
      : hasRecovery
        ? 'recovery'
        : 'none';

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !busy) onClose?.();
    };
    window.addEventListener('keydown', closeOnEscape);
    const focusTimer = window.setTimeout(() => primaryButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', closeOnEscape);
      previouslyFocused?.focus?.();
    };
  }, [busy, onClose, open]);

  if (!open) return null;

  const modeLabel = isIndependent ? '独立示教' : '地图示教';
  const primary = hasDirectory
    ? {
        icon: <HardDrive size={21} />,
        eyebrow: directory.permission === 'granted' ? 'DEFAULT SAVE PATH / READY' : 'DEFAULT SAVE PATH / AUTH REQUIRED',
        title: directory.name || '已记住的工程目录',
        description: directory.permission === 'granted'
          ? '从自动保存目录重新读取完整工程，并继续把后续修改增量写回该目录。'
          : '浏览器已记住该目录；点击加载后会请求一次读写授权。',
        savedAt: directory.savedAt,
        facts: ['完整工程资源', '恢复后继续自动保存'],
        actionLabel: directory.permission === 'granted' ? '从默认保存路径加载' : '授权并从默认路径加载',
        action: onLoadDefaultDirectory,
      }
    : hasWorkspace
      ? {
          icon: <Database size={21} />,
          eyebrow: 'LOCAL AUTO-SAVE / READY',
          title: workspace.mapName || '本地自动保存工程',
          description: '当前模式的工作现场已由浏览器自动保护，可直接恢复地图、机器人、示教数据与视角。',
          savedAt: workspace.savedAt,
          facts: workspaceFacts(workspace),
          actionLabel: '加载自动保存工程',
          action: onLoadWorkspace,
        }
      : hasRecovery
        ? {
            icon: <History size={21} />,
            eyebrow: 'RECOVERY SNAPSHOT / READY',
            title: recovery.mapName || '上一次未完成工程',
            description: '检测到服务重启前保存的工程副本，可恢复当时的工作现场与示教数据。',
            savedAt: recovery.savedAt,
            facts: [
              `${Number(recovery.waypointCount) || 0} 导航点`,
              `${Number(recovery.taskCount) || 0} 示教任务`,
              recovery.robotName || '未加载机器人',
            ],
            actionLabel: '恢复上一次自动保存工程',
            action: onLoadRecovery,
          }
        : null;

  return createPortal(
    <div
      className={`project-load-modal ${isIndependent ? 'is-independent' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-load-title"
      data-default-source={isChecking ? 'checking' : defaultSource}
      data-default-path-state={directory?.status || 'idle'}
      data-teaching-space-mode={teachingSpaceMode}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <section className="project-load-dialog">
        <header className="project-load-dialog__header">
          <span className="project-load-dialog__mark"><FolderOpen size={22} /></span>
          <div>
            <small>PROJECT RESTORE / {isIndependent ? 'VIRTUAL_ORIGIN' : 'MAP FRAME'}</small>
            <h2 id="project-load-title">加载工程</h2>
            <p>仅加载{modeLabel}工程，默认目录、工作缓存和恢复副本按示教类型分别查找。</p>
          </div>
          <span className="project-load-dialog__mode">
            <ScanLine size={12} /> {modeLabel}
          </span>
          <button
            type="button"
            aria-label="关闭加载工程窗口"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </header>

        <div className="project-load-dialog__body">
          <section className="project-load-default" aria-labelledby="project-load-default-title">
            <header>
              <span>01</span>
              <div>
                <small>PRIORITY SOURCE</small>
                <strong id="project-load-default-title">{modeLabel} · 默认保存来源</strong>
              </div>
              <i>{isChecking ? '正在检查' : primary ? '可以加载' : '尚未绑定'}</i>
            </header>

            {isChecking ? (
              <div className="project-load-default__checking" role="status">
                <LoaderCircle size={24} />
                <div>
                  <strong>正在检查默认保存路径</strong>
                  <span>确认浏览器记住的工程目录与本地自动保存工作区…</span>
                </div>
              </div>
            ) : primary ? (
              <article className={`project-load-default__card is-${defaultSource}`}>
                <span className="project-load-default__icon">{primary.icon}</span>
                <div className="project-load-default__copy">
                  <small>{primary.eyebrow}</small>
                  <h3 title={primary.title}>{primary.title}</h3>
                  <p>{primary.description}</p>
                  <div className="project-load-default__meta">
                    <span><Clock3 size={11} /> {formatTimestamp(primary.savedAt)}</span>
                    {primary.facts.map((fact) => <span key={fact}>{fact}</span>)}
                  </div>
                </div>
                <button
                  ref={primaryButtonRef}
                  type="button"
                  className="project-load-default__action"
                  onClick={primary.action}
                  disabled={busy}
                  aria-label={primary.actionLabel}
                >
                  <span>{primary.actionLabel}</span>
                  <ArrowRight size={16} />
                </button>
              </article>
            ) : (
              <div className="project-load-default__empty">
                <HardDrive size={23} />
                <div>
                  <strong>未检测到{modeLabel}的默认保存路径</strong>
                  <span>首次选择{modeLabel}工程目录后，系统会记住该类型的默认自动保存位置。</span>
                  {directory?.error && <em>{directory.error}</em>}
                </div>
              </div>
            )}
          </section>

          <section className="project-load-alternatives" aria-labelledby="project-load-alternatives-title">
            <header>
              <span>02</span>
              <div>
                <small>OTHER SOURCES</small>
                <strong id="project-load-alternatives-title">其他加载方式</strong>
              </div>
            </header>
            <div>
              <button
                ref={!primary && !isChecking ? primaryButtonRef : undefined}
                type="button"
                onClick={onChooseDirectory}
                disabled={busy || isChecking}
                aria-label="选择其他工程目录"
              >
                <span className="project-load-alternatives__icon"><FolderOpen size={19} /></span>
                <span>
                  <small>FULL PROJECT DIRECTORY</small>
                  <strong>选择其他工程目录</strong>
                  <p>选择{modeLabel}工程，并记为该类型的默认自动保存目录。</p>
                </span>
                <ArrowRight size={15} />
              </button>
              <button
                type="button"
                onClick={onChooseGuideFile}
                disabled={busy}
                aria-label="加载工程引导文件"
                data-project-guide-action="true"
              >
                <span className="project-load-alternatives__icon"><FileJson size={19} /></span>
                <span>
                  <small>GUIDE JSON / PORTABLE ZIP</small>
                  <strong>加载工程引导文件</strong>
                  <p>选择{modeLabel}的 JSON 配置或 ZIP 工程包，加载前会校验类型。</p>
                </span>
                <ArrowRight size={15} />
              </button>
            </div>
          </section>
        </div>

        <footer className="project-load-dialog__footer">
          <span><ShieldCheck size={12} /> 文件仅在本机读取；目录授权由浏览器管理</span>
          <span>AUTO-SAVE / MODE-SCOPED</span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
