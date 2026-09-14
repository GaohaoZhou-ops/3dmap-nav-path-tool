import { useId, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  CircleDot,
  Move3D,
  Rotate3D,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

const LINEAR_STEP_MIN_CM = 5;
const LINEAR_STEP_MAX_CM = 10;
const ANGULAR_STEP_MIN_DEG = 1;
const ANGULAR_STEP_MAX_DEG = 10;

const CAMERA_TRANSLATION_ROWS = [
  {
    id: 'depth',
    label: '远近 · Z',
    actions: [
      { id: 'far', label: '远离', Icon: ZoomOut },
      { id: 'near', label: '靠近', Icon: ZoomIn },
    ],
  },
  {
    id: 'horizontal',
    label: '左右 · X',
    actions: [
      { id: 'left', label: '向左', Icon: ArrowLeft },
      { id: 'right', label: '向右', Icon: ArrowRight },
    ],
  },
  {
    id: 'vertical',
    label: '上下 · Y',
    actions: [
      { id: 'up', label: '向上', Icon: ArrowUp },
      { id: 'down', label: '向下', Icon: ArrowDown },
    ],
  },
];

const CAMERA_ROTATION_ROWS = [
  {
    id: 'yaw',
    label: '旋转 · YAW',
    actions: [
      { id: 'yaw-left', label: '左转', Icon: ArrowLeft },
      { id: 'yaw-right', label: '右转', Icon: ArrowRight },
    ],
  },
  {
    id: 'pitch',
    label: '俯仰 · PITCH',
    actions: [
      { id: 'pitch-up', label: '上仰', Icon: ArrowUp },
      { id: 'pitch-down', label: '下俯', Icon: ArrowDown },
    ],
  },
  {
    id: 'roll',
    label: '翻滚 · ROLL',
    actions: [
      { id: 'roll-left', label: '左翻', Icon: RotateCcw },
      { id: 'roll-right', label: '右翻', Icon: RotateCw },
    ],
  },
];

const cameraResultMeta = {
  idle: { label: '等待指令', detail: '观察上方画面，选择方向执行相机位姿逆解' },
  solving: { label: 'IK 求解中', detail: '正在将 optical frame 目标反算为关节值' },
  tracking: { label: 'IK 已跟踪', detail: '关节值与上方相机画面已同步' },
  limited: { label: 'IK 接近极限', detail: '已移动到当前关节约束允许的最近位置' },
  error: { label: 'IK 不可用', detail: '请检查相机坐标系与机器人装配状态' },
};

const formatValue = (value, digits = 3) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '0.000';
};

export default function CameraTeachingControls({
  enabled,
  activeSide,
  cameraPoses,
  result,
  onMove,
}) {
  const linearStepSliderId = useId();
  const angularStepSliderId = useId();
  const [linearStepCm, setLinearStepCm] = useState(LINEAR_STEP_MIN_CM);
  const [angularStep, setAngularStep] = useState(3);
  const linearStep = linearStepCm / 100;
  const side = activeSide === 'right' ? 'right' : 'left';
  const sideLabel = side === 'left' ? '左臂' : '右臂';
  const activePose = cameraPoses?.[side] || null;
  const activeResult = result?.side === side ? result : { status: 'idle' };
  const status = cameraResultMeta[activeResult?.status] || cameraResultMeta.idle;
  const solving = result?.status === 'solving';
  const canMove = Boolean(enabled && activePose && !solving);
  const issue = (action) => onMove?.({
    side,
    action,
    linearStep,
    angularStep,
  });

  const renderRows = (rows, kind) => rows.map((row) => (
    <div className="camera-teach-axis-row" key={row.id}>
      <span>{row.label}</span>
      {row.actions.map(({ id, label, Icon }) => (
        <button
          type="button"
          key={id}
          disabled={!canMove}
          data-camera-teach-action={id}
          aria-label={`${sideLabel}相机${label}`}
          title={`${label} · ${kind === 'translate' ? `${Math.round(linearStep * 1000)} mm` : `${angularStep}°`}`}
          onClick={() => issue(id)}
        >
          <Icon size={11} /> {label}
        </button>
      ))}
    </div>
  ));

  return (
    <section
      className={`camera-teach-console is-${activeResult?.status || 'idle'}`}
      aria-label="相机视角反算示教"
      data-attached-to-camera="true"
      data-camera-side={side}
      data-camera-ready={activePose ? 'true' : 'false'}
      data-camera-teaching-status={activeResult?.status || 'idle'}
      data-camera-teaching-revision={activeResult?.revision || 0}
      data-linear-step={linearStep}
      data-linear-step-cm={linearStepCm}
      data-angular-step={angularStep}
    >
      <header className="camera-teach-console__header">
        <div>
          <span><Camera size={13} /></span>
          <div>
            <small>{side === 'left' ? 'CAM-L' : 'CAM-R'} · OPTICAL FRAME / IK</small>
            <strong>{sideLabel}相机位姿控制</strong>
          </div>
        </div>
        <em><CircleDot size={8} /> {solving ? 'SOLVING' : activePose ? 'LINKED' : 'WAIT'}</em>
      </header>

      <div className="camera-teach-frame-strip">
        <span><i className="axis-x">X</i> 画面左右</span>
        <span><i className="axis-y">Y</i> 画面上下</span>
        <span><i className="axis-z">Z</i> 光轴远近</span>
      </div>

      <div className="camera-teach-step-grid">
        <div className="camera-teach-step-slider is-linear">
          <div className="camera-teach-step-slider__header">
            <label htmlFor={linearStepSliderId}>位移步进</label>
            <output htmlFor={linearStepSliderId} aria-live="polite">
              <strong>{linearStepCm}</strong><small>cm</small>
            </output>
          </div>
          <div className="camera-teach-step-slider__rail">
            <input
              id={linearStepSliderId}
              type="range"
              min={LINEAR_STEP_MIN_CM}
              max={LINEAR_STEP_MAX_CM}
              step="1"
              value={linearStepCm}
              aria-label="相机位移步进"
              aria-valuetext={`${linearStepCm} 厘米`}
              style={{
                '--step-progress': `${((linearStepCm - LINEAR_STEP_MIN_CM) / (LINEAR_STEP_MAX_CM - LINEAR_STEP_MIN_CM)) * 100}%`,
              }}
              onChange={(event) => setLinearStepCm(Number(event.target.value))}
            />
            <div className="camera-teach-step-slider__scale" aria-hidden="true">
              <span>{LINEAR_STEP_MIN_CM}</span><i>每格 1 cm</i><span>{LINEAR_STEP_MAX_CM}</span>
            </div>
          </div>
        </div>
        <div className="camera-teach-step-slider is-angular">
          <div className="camera-teach-step-slider__header">
            <label htmlFor={angularStepSliderId}>旋转步进</label>
            <output htmlFor={angularStepSliderId} aria-live="polite">
              <strong>{angularStep}</strong><small>°</small>
            </output>
          </div>
          <div className="camera-teach-step-slider__rail">
            <input
              id={angularStepSliderId}
              type="range"
              min={ANGULAR_STEP_MIN_DEG}
              max={ANGULAR_STEP_MAX_DEG}
              step="1"
              value={angularStep}
              aria-label="相机旋转步进"
              aria-valuetext={`${angularStep} 度`}
              style={{
                '--step-progress': `${((angularStep - ANGULAR_STEP_MIN_DEG) / (ANGULAR_STEP_MAX_DEG - ANGULAR_STEP_MIN_DEG)) * 100}%`,
              }}
              onChange={(event) => setAngularStep(Number(event.target.value))}
            />
            <div className="camera-teach-step-slider__scale" aria-hidden="true">
              <span>{ANGULAR_STEP_MIN_DEG}</span><i>每格 1°</i><span>{ANGULAR_STEP_MAX_DEG}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="camera-teach-motion-block">
        <div className="camera-teach-motion-title">
          <span><Move3D size={11} /> 位置控制</span>
          <small>OPTICAL XYZ</small>
        </div>
        {renderRows(CAMERA_TRANSLATION_ROWS, 'translate')}
      </div>

      <div className="camera-teach-motion-block is-rotation">
        <div className="camera-teach-motion-title">
          <span><Rotate3D size={11} /> 姿态控制</span>
          <small>LOCAL RPY</small>
        </div>
        {renderRows(CAMERA_ROTATION_ROWS, 'rotate')}
      </div>

      <footer className="camera-teach-result">
        <div>
          <i />
          <span>
            <strong>{status.label}</strong>
            <small>{activeResult?.message || status.detail}</small>
          </span>
        </div>
        <div className="camera-teach-pose" aria-label="当前相机地图坐标">
          <span>X <b>{formatValue(activePose?.position?.x, 2)}</b></span>
          <span>Y <b>{formatValue(activePose?.position?.y, 2)}</b></span>
          <span>Z <b>{formatValue(activePose?.position?.z, 2)}</b></span>
        </div>
        {['tracking', 'limited'].includes(activeResult?.status) && (
          <small className="camera-teach-residual">
            ΔP {formatValue(activeResult.positionError * 1000, 2)} mm · ΔR {formatValue(activeResult.rotationError, 2)}° · {activeResult.chainJointCount || 0} JTS
          </small>
        )}
      </footer>
    </section>
  );
}
