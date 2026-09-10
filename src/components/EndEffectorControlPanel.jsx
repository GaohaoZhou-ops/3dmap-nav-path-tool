import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Crosshair,
  Lock,
  Move3D,
  Orbit,
  Rotate3D,
  RotateCcw,
  Unlock,
  X,
} from 'lucide-react';

function PoseField({ axis, label, value, unit, step, tone, disabled, onCommit }) {
  const [draft, setDraft] = useState(Number(value).toFixed(unit === 'm' ? 3 : 1));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
    }
  }, [unit, value]);

  const commit = () => {
    focusedRef.current = false;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
  };

  return (
    <label className={`space-ball-field tone-${tone}`}>
      <span>{axis}</span>
      <input
        type="number"
        aria-label={`末端 ${label}`}
        value={draft}
        step={step}
        disabled={disabled}
        onFocus={() => { focusedRef.current = true; }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
            event.currentTarget.blur();
          }
        }}
      />
      <em>{unit}</em>
    </label>
  );
}

const sideLabel = { left: '左机械臂', right: '右机械臂' };
const sideShortLabel = { left: '左端', right: '右端' };

export default function EndEffectorControlPanel({
  control,
  lockedSides,
  onModeChange,
  onPoseChange,
  onReset,
  onToggleLock,
  onClose,
}) {
  if (!control) return null;
  const pose = control.pose;
  const locked = Boolean(control.locked);
  const locks = lockedSides || control.lockedSides || { left: false, right: false };
  const updatePosition = (axis, value) => {
    onPoseChange({
      ...pose,
      position: { ...pose.position, [axis]: value },
    });
  };
  const updateRotation = (axis, value) => {
    onPoseChange({
      ...pose,
      rpy: { ...pose.rpy, [axis]: value },
    });
  };

  return (
    <section
      className={`end-effector-panel is-${control.status || 'tracking'} ${locked ? 'is-locked' : ''}`}
      aria-label="机械臂末端空间球"
      data-end-effector-side={control.side}
      data-transform-mode={control.mode}
      data-ik-status={control.status}
      data-end-effector-locked={locked}
      data-left-end-effector-locked={Boolean(locks.left)}
      data-right-end-effector-locked={Boolean(locks.right)}
      data-position-error={control.positionError || 0}
      data-rotation-error={control.rotationError || 0}
    >
      <header className="end-effector-panel__header">
        <div className="space-ball-emblem" aria-hidden="true">
          <span /><i /><b />
          <Orbit size={17} />
        </div>
        <div>
          <small>6D SPACE BALL · MAP FRAME</small>
          <strong>{sideLabel[control.side]}末端</strong>
        </div>
        <button type="button" aria-label="退出机械臂末端控制" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <div className="end-effector-panel__status">
        <span>
          {locked ? <Lock size={12} /> : <CheckCircle2 size={12} />}
          {locked ? '姿态已锁定' : `IK ${control.status === 'limited' ? '受限' : '跟踪'}`}
        </span>
        {locked ? (
          <em className="end-effector-panel__hold-copy">ARM HOLD · JOINTS FROZEN</em>
        ) : (
          <>
            <em>ΔP {(control.positionError || 0).toFixed(4)} m</em>
            <em>ΔR {(control.rotationError || 0).toFixed(2)}°</em>
          </>
        )}
      </div>

      <div className="end-effector-lock-state" aria-label="双臂末端锁定状态">
        {['left', 'right'].map((side) => (
          <span
            key={side}
            className={`${locks[side] ? 'is-locked' : ''} ${control.side === side ? 'is-current' : ''}`}
            data-lock-side={side}
          >
            <i>{side === 'left' ? 'L' : 'R'}</i>
            {sideShortLabel[side]}
            <b>{locks[side] ? <><Lock size={9} /> LOCKED</> : 'FREE'}</b>
          </span>
        ))}
      </div>

      <div className="space-ball-mode" role="group" aria-label="空间球控制模式">
        <button
          type="button"
          className={control.mode === 'translate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'translate'}
          disabled={locked}
          onClick={() => onModeChange('translate')}
        >
          <Move3D size={13} /> XYZ 位移
        </button>
        <button
          type="button"
          className={control.mode === 'rotate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'rotate'}
          disabled={locked}
          onClick={() => onModeChange('rotate')}
        >
          <Rotate3D size={13} /> RPY 旋转
        </button>
      </div>

      <div className={`space-ball-fields ${control.mode === 'translate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Crosshair size={11} /> POSITION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="X" label="X (m)" value={pose.position.x} unit="m" step="0.005" tone="x" disabled={locked} onCommit={(value) => updatePosition('x', value)} />
          <PoseField axis="Y" label="Y (m)" value={pose.position.y} unit="m" step="0.005" tone="y" disabled={locked} onCommit={(value) => updatePosition('y', value)} />
          <PoseField axis="Z" label="Z (m)" value={pose.position.z} unit="m" step="0.005" tone="z" disabled={locked} onCommit={(value) => updatePosition('z', value)} />
        </div>
      </div>

      <div className={`space-ball-fields ${control.mode === 'rotate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Rotate3D size={11} /> ORIENTATION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="R" label="ROLL (°)" value={pose.rpy.roll} unit="°" step="0.5" tone="x" disabled={locked} onCommit={(value) => updateRotation('roll', value)} />
          <PoseField axis="P" label="PITCH (°)" value={pose.rpy.pitch} unit="°" step="0.5" tone="y" disabled={locked} onCommit={(value) => updateRotation('pitch', value)} />
          <PoseField axis="Y" label="YAW (°)" value={pose.rpy.yaw} unit="°" step="0.5" tone="z" disabled={locked} onCommit={(value) => updateRotation('yaw', value)} />
        </div>
      </div>

      <footer className="end-effector-panel__footer">
        <span>
          {locked
            ? '当前臂已冻结；双击另一末端可继续调整'
            : '拖拽空间球彩色轴环，完成后可锁定姿态'}
        </span>
        <div className="end-effector-panel__actions">
          <button type="button" disabled={locked || control.dragging} onClick={onReset}>
            <RotateCcw size={11} /> 关节归零
          </button>
          <button
            type="button"
            className={`end-effector-lock-button ${locked ? 'is-active' : ''}`}
            aria-label={`${locked ? '解除锁定' : '锁定'}${sideLabel[control.side]}末端`}
            aria-pressed={locked}
            disabled={control.dragging}
            title={
              locked
                ? '解除当前末端姿态锁定并恢复空间球控制'
                : '冻结当前臂与共享关节，再调整另一机械臂时保持本臂姿态'
            }
            onClick={onToggleLock}
          >
            {locked ? <Unlock size={11} /> : <Lock size={11} />}
            {locked ? '解除锁定' : '锁定末端'}
          </button>
        </div>
      </footer>
    </section>
  );
}
