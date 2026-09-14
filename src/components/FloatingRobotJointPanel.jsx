import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GripHorizontal,
  Minus,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import RobotJointPanel from './RobotJointPanel.jsx';

const WINDOW_WIDTH = 404;
const WINDOW_EDGE = 10;
const WINDOW_TOP = 82;
const WINDOW_TITLE_HEIGHT = 43;

const defaultWindowPosition = () => {
  if (typeof window === 'undefined') return { x: 24, y: WINDOW_TOP };
  return {
    x: 18,
    y: Math.min(WINDOW_TOP, Math.max(WINDOW_EDGE, window.innerHeight - WINDOW_TITLE_HEIGHT)),
  };
};

const jointCountFor = (robotLoadState, jointValues) => {
  const names = new Set();
  (robotLoadState?.movableJoints || []).forEach((joint) => {
    if (joint?.name) names.add(joint.name);
  });
  Object.keys(jointValues || {}).forEach((name) => names.add(name));
  return names.size;
};

export default function FloatingRobotJointPanel({
  open,
  onClose,
  robot,
  robotLoadState,
  jointValues,
  ...jointPanelProps
}) {
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState(defaultWindowPosition);
  const windowRef = useRef(null);
  const positionRef = useRef(position);
  const dragRef = useRef(null);
  const jointCount = useMemo(
    () => jointCountFor(robotLoadState, jointValues),
    [jointValues, robotLoadState],
  );
  const robotReady = Boolean(robot) && robotLoadState?.status === 'loaded';

  positionRef.current = position;

  const clampPosition = useCallback((candidate) => {
    const bounds = windowRef.current?.getBoundingClientRect();
    const width = Math.min(bounds?.width || WINDOW_WIDTH, window.innerWidth - WINDOW_EDGE * 2);
    const height = Math.min(
      bounds?.height || WINDOW_TITLE_HEIGHT,
      window.innerHeight - WINDOW_EDGE * 2,
    );
    const maxX = Math.max(WINDOW_EDGE, window.innerWidth - width - WINDOW_EDGE);
    const maxY = Math.max(WINDOW_EDGE, window.innerHeight - height - WINDOW_EDGE);
    return {
      x: Math.min(maxX, Math.max(WINDOW_EDGE, Number(candidate?.x) || 0)),
      y: Math.min(maxY, Math.max(WINDOW_EDGE, Number(candidate?.y) || 0)),
    };
  }, []);

  const resetPosition = useCallback(() => {
    const nextPosition = clampPosition(defaultWindowPosition());
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, [clampPosition]);

  useEffect(() => {
    if (!open) {
      dragRef.current = null;
      setDragging(false);
      setMinimized(false);
      return undefined;
    }
    const keepWindowVisible = () => {
      setPosition((current) => {
        const next = clampPosition(current);
        positionRef.current = next;
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    keepWindowVisible();
    const resizeObserver = new ResizeObserver(keepWindowVisible);
    if (windowRef.current) resizeObserver.observe(windowRef.current);
    window.addEventListener('resize', keepWindowVisible);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', keepWindowVisible);
    };
  }, [clampPosition, open]);

  if (!open) return null;

  const finishDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  return createPortal(
    <aside
      ref={windowRef}
      className={`joint-float-window ${robotReady ? 'is-ready' : 'is-waiting'} ${minimized ? 'is-minimized' : ''} ${dragging ? 'is-dragging' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="全关节控制浮动窗口"
      data-floating-window="robot-joints"
      data-window-state={minimized ? 'minimized' : 'open'}
      data-window-x={position.x.toFixed(1)}
      data-window-y={position.y.toFixed(1)}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
    >
      <header
        className="joint-float-window__titlebar"
        title="拖动移动浮窗 · 双击恢复默认位置"
        onDoubleClick={(event) => {
          if (!event.target.closest('button')) resetPosition();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target.closest('button')) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            origin: positionRef.current,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = clampPosition({
            x: drag.origin.x + event.clientX - drag.clientX,
            y: drag.origin.y + event.clientY - drag.clientY,
          });
          positionRef.current = next;
          setPosition(next);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div className="joint-float-window__grip" aria-hidden="true">
          <GripHorizontal size={15} />
        </div>
        <div className="joint-float-window__identity">
          <span><SlidersHorizontal size={13} /></span>
          <div>
            <small>FLOATING JOINT DIRECTOR</small>
            <strong>全关节控制</strong>
          </div>
        </div>
        <div className={`joint-float-window__status ${robotReady ? 'is-ready' : ''}`}>
          <i /> {robotReady ? `${jointCount} DOF` : 'WAIT'}
        </div>
        <div className="joint-float-window__actions">
          <button
            type="button"
            aria-label={minimized ? '展开全关节浮动窗口' : '最小化全关节浮动窗口'}
            title={minimized ? '展开浮窗' : '最小化浮窗'}
            onClick={() => setMinimized((current) => !current)}
          >
            {minimized ? <SlidersHorizontal size={12} /> : <Minus size={13} />}
          </button>
          <button
            type="button"
            aria-label="关闭全关节浮动窗口"
            title="关闭浮窗"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      </header>

      <div className="joint-float-window__body" hidden={minimized}>
        <RobotJointPanel
          robot={robot}
          robotLoadState={robotLoadState}
          jointValues={jointValues}
          {...jointPanelProps}
        />
      </div>
    </aside>,
    document.body,
  );
}
