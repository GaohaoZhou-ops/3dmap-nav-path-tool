import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Crosshair,
  Move3D,
  Orbit,
  Rotate3D,
  RotateCcw,
  X,
} from 'lucide-react';

function PoseField({ axis, label, value, unit, step, tone, onCommit }) {
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

export default function EndEffectorControlPanel({
  control,
  onModeChange,
  onPoseChange,
  onReset,
  onClose,
}) {
  if (!control) return null;
  const pose = control.pose;
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
      className={`end-effector-panel is-${control.status || 'tracking'}`}
      aria-label="机械臂末端空间球"
      data-end-effector-side={control.side}
      data-transform-mode={control.mode}
      data-ik-status={control.status}
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
        <span><CheckCircle2 size={12} /> IK {control.status === 'limited' ? '受限' : '跟踪'}</span>
        <em>ΔP {(control.positionError || 0).toFixed(4)} m</em>
        <em>ΔR {(control.rotationError || 0).toFixed(2)}°</em>
      </div>

      <div className="space-ball-mode" role="group" aria-label="空间球控制模式">
        <button
          type="button"
          className={control.mode === 'translate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'translate'}
          onClick={() => onModeChange('translate')}
        >
          <Move3D size={13} /> XYZ 位移
        </button>
        <button
          type="button"
          className={control.mode === 'rotate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'rotate'}
          onClick={() => onModeChange('rotate')}
        >
          <Rotate3D size={13} /> RPY 旋转
        </button>
      </div>

      <div className={`space-ball-fields ${control.mode === 'translate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Crosshair size={11} /> POSITION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="X" label="X (m)" value={pose.position.x} unit="m" step="0.005" tone="x" onCommit={(value) => updatePosition('x', value)} />
          <PoseField axis="Y" label="Y (m)" value={pose.position.y} unit="m" step="0.005" tone="y" onCommit={(value) => updatePosition('y', value)} />
          <PoseField axis="Z" label="Z (m)" value={pose.position.z} unit="m" step="0.005" tone="z" onCommit={(value) => updatePosition('z', value)} />
        </div>
      </div>

      <div className={`space-ball-fields ${control.mode === 'rotate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Rotate3D size={11} /> ORIENTATION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="R" label="ROLL (°)" value={pose.rpy.roll} unit="°" step="0.5" tone="x" onCommit={(value) => updateRotation('roll', value)} />
          <PoseField axis="P" label="PITCH (°)" value={pose.rpy.pitch} unit="°" step="0.5" tone="y" onCommit={(value) => updateRotation('pitch', value)} />
          <PoseField axis="Y" label="YAW (°)" value={pose.rpy.yaw} unit="°" step="0.5" tone="z" onCommit={(value) => updateRotation('yaw', value)} />
        </div>
      </div>

      <footer className="end-effector-panel__footer">
        <span>拖拽空间球彩色轴环，或输入精确目标值</span>
        <button type="button" onClick={onReset}>
          <RotateCcw size={11} /> 关节归零
        </button>
      </footer>
    </section>
  );
}
