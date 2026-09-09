import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  FileBox,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { fetchRobotCatalog } from '../lib/robotLoader.js';

const statusLabel = {
  idle: '选择模型',
  pending: '等待地图',
  loading: '正在装配',
  loaded: '原点就绪',
  error: '加载失败',
};

export default function RobotPicker({ selectedRobot, loadState, onSelect }) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState('idle');
  const [catalogError, setCatalogError] = useState('');
  const requestRevisionRef = useRef(0);

  const refreshCatalog = () => {
    const revision = ++requestRevisionRef.current;
    const controller = new AbortController();
    setCatalogState('loading');
    setCatalogError('');
    fetchRobotCatalog(controller.signal)
      .then((robots) => {
        if (requestRevisionRef.current !== revision) return;
        setCatalog(robots);
        setCatalogState('ready');
      })
      .catch((error) => {
        if (requestRevisionRef.current !== revision || error.name === 'AbortError') return;
        setCatalogError(error.message || '无法读取 robots 目录');
        setCatalogState('error');
      });
    return () => controller.abort();
  };

  useEffect(() => {
    if (!open || catalogState !== 'idle') return undefined;
    return refreshCatalog();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const currentStatus = loadState?.status || (selectedRobot ? 'pending' : 'idle');
  const StatusIcon = currentStatus === 'loading'
    ? LoaderCircle
    : currentStatus === 'error'
      ? TriangleAlert
      : selectedRobot ? Check : Bot;

  return (
    <div
      className={`robot-picker is-${currentStatus}`}
      ref={rootRef}
      data-robot-picker-state={currentStatus}
      data-selected-robot={selectedRobot?.id || ''}
    >
      <button
        type="button"
        className={`action-button robot-picker__trigger ${selectedRobot ? 'has-model' : ''}`}
        aria-label="加载机器人"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedRobot ? `${selectedRobot.name} · 位于地图原点` : '从 robots 目录选择机器人模型'}
        onClick={() => setOpen((current) => !current)}
      >
        <StatusIcon className={currentStatus === 'loading' ? 'is-spinning' : ''} size={15} />
        <span>{selectedRobot ? selectedRobot.name : '加载机器人'}</span>
        <i>{statusLabel[currentStatus] || statusLabel.idle}</i>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="robot-picker__menu" role="dialog" aria-label="robots 目录模型">
          <div className="robot-picker__heading">
            <div>
              <small>ROBOT LIBRARY</small>
              <strong>选择机器人模型</strong>
            </div>
            <button type="button" aria-label="刷新机器人列表" onClick={refreshCatalog}>
              <RefreshCw className={catalogState === 'loading' ? 'is-spinning' : ''} size={13} />
            </button>
          </div>

          <div className="robot-picker__list" role="listbox" aria-label="可用机器人模型">
            {catalogState === 'loading' && !catalog.length && (
              <div className="robot-picker__message">
                <LoaderCircle className="is-spinning" size={17} />
                <span>正在扫描 robots 目录…</span>
              </div>
            )}
            {catalogState === 'error' && (
              <div className="robot-picker__message is-error">
                <TriangleAlert size={17} />
                <span>{catalogError}</span>
              </div>
            )}
            {catalogState === 'ready' && !catalog.length && (
              <div className="robot-picker__message">
                <FileBox size={17} />
                <span>robots 目录中没有可加载的 URDF / GLB / STL</span>
              </div>
            )}
            {catalog.map((robot) => {
              const selected = selectedRobot?.id === robot.id;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`加载机器人 ${robot.name}`}
                  className={`robot-picker__option ${selected ? 'is-selected' : ''}`}
                  key={robot.id}
                  onClick={() => {
                    onSelect(robot);
                    setOpen(false);
                  }}
                >
                  <span className="robot-picker__model-icon"><Bot size={16} /></span>
                  <span className="robot-picker__model-copy">
                    <strong>{robot.name}</strong>
                    <small title={robot.relativePath}>{robot.relativePath}</small>
                  </span>
                  <em>{robot.format.toUpperCase()}</em>
                  {selected && <Check size={13} />}
                </button>
              );
            })}
          </div>

          <div className="robot-picker__footer">
            <span>初始位姿</span>
            <strong>XYZ 0 / 0 / 0 · RPY 0 / 0 / 0</strong>
          </div>
        </div>
      )}
    </div>
  );
}
