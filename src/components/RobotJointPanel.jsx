import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Gauge,
  Lock,
  Play,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
  Unlock,
} from 'lucide-react';
import {
  isRobotBodyJoint,
  normalizeRobotJointLocks,
} from '../lib/robotJointLocks.js';

const GROUPS = [
  { id: 'chassis', label: '底盘轮组', test: (name) => /wheel/i.test(name) },
  { id: 'body', label: '躯干与升降', test: isRobotBodyJoint },
  { id: 'head', label: '头部', test: (name) => /head/i.test(name) },
  { id: 'left', label: '左机械臂', test: (name) => /^left[_-]/i.test(name) },
  { id: 'right', label: '右机械臂', test: (name) => /^right[_-]/i.test(name) },
  { id: 'other', label: '其他关节', test: () => true },
];

const finiteValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

const formatValue = (value, prismatic) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(prismatic ? 3 : 2);
};

function JointValueRow({ joint, value, locked, onChange, onToggleLock }) {
  const prismatic = joint.type === 'prismatic';
  const explicitLower = finiteValue(joint.lower);
  const explicitUpper = finiteValue(joint.upper);
  const fallbackLower = prismatic ? -1 : -180;
  const fallbackUpper = prismatic ? 1 : 180;
  const currentValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const lower = Math.min(explicitLower ?? fallbackLower, currentValue);
  const upper = Math.max(explicitUpper ?? fallbackUpper, currentValue);
  const step = prismatic ? 0.001 : 0.1;
  const unit = prismatic ? 'm' : '°';
  const [draft, setDraft] = useState(formatValue(currentValue, prismatic));
  const lastRangeValueRef = useRef(currentValue);

  useEffect(() => {
    setDraft(formatValue(currentValue, prismatic));
    lastRangeValueRef.current = currentValue;
  }, [currentValue, prismatic]);

  const emitRangeValue = (event) => {
    const nextValue = Number(event.currentTarget.value);
    if (!Number.isFinite(nextValue) || nextValue === lastRangeValueRef.current) return;
    lastRangeValueRef.current = nextValue;
    onChange(joint.name, nextValue);
  };

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatValue(currentValue, prismatic));
      return;
    }
    const nextValue = Math.max(
      explicitLower ?? Number.NEGATIVE_INFINITY,
      Math.min(explicitUpper ?? Number.POSITIVE_INFINITY, parsed),
    );
    setDraft(formatValue(nextValue, prismatic));
    onChange(joint.name, nextValue);
  };

  return (
    <div
      className={`joint-value-row ${locked ? 'is-ik-locked' : ''}`}
      data-joint-name={joint.name}
      data-joint-type={joint.type}
      data-joint-value={currentValue}
      data-joint-locked={locked ? 'true' : 'false'}
    >
      <div className="joint-value-row__name">
        <strong title={joint.name}>{joint.name}</strong>
        <small>{String(joint.type || 'joint').toUpperCase()}</small>
      </div>
      <input
        type="range"
        aria-label={`${joint.name} 关节滑块`}
        min={lower}
        max={upper}
        step={step}
        value={clamp(currentValue, lower, upper)}
        onInput={emitRangeValue}
        onChange={emitRangeValue}
      />
      <label className="joint-value-row__number">
        <span className="visually-hidden">{joint.name} 关节值</span>
        <input
          type="number"
          aria-label={`${joint.name} 关节值`}
          min={explicitLower ?? undefined}
          max={explicitUpper ?? undefined}
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(formatValue(currentValue, prismatic));
              event.currentTarget.blur();
            }
          }}
        />
        <small>{unit}</small>
      </label>
      <button
        type="button"
        className="joint-value-row__lock"
        aria-label={`${locked ? '解除' : '锁定'} ${joint.name} 关节`}
        aria-pressed={locked}
        title={locked
          ? '解除 IK 锁定，允许末端拖拽和相机反算调整此关节'
          : 'IK 锁定此关节；仍可使用当前滑块手动精调'}
        onClick={() => onToggleLock?.(joint.name)}
      >
        {locked ? <Lock size={11} /> : <Unlock size={11} />}
        <span className="visually-hidden">{locked ? 'IK 已锁定' : 'IK 未锁定'}</span>
      </button>
    </div>
  );
}

function JointPoseName({ pose, index, onRename }) {
  const [draft, setDraft] = useState(pose.name);

  useEffect(() => {
    setDraft(pose.name);
  }, [pose.name]);

  const commit = () => {
    const nextName = draft.trim();
    if (!nextName) {
      setDraft(pose.name);
      return;
    }
    if (nextName !== pose.name) onRename(pose.id, nextName);
  };

  return (
    <input
      aria-label={`关节姿态 ${index + 1} 名称`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(pose.name);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export default function RobotJointPanel({
  robot,
  robotLoadState,
  jointValues,
  lockedJointNames = [],
  poses = [],
  onChangeJoint,
  onToggleJointLock,
  onUnlockAllJoints,
  onZeroJoints,
  onCapturePose,
  onRenamePose,
  onDeletePose,
  onApplyPose,
}) {
  const [poseName, setPoseName] = useState('');
  const robotReady = Boolean(robot) && robotLoadState?.status === 'loaded';
  const robotKey = robot?.id || robot?.relativePath || '';
  const lockedJointSet = useMemo(
    () => new Set(normalizeRobotJointLocks(lockedJointNames)),
    [lockedJointNames],
  );

  const joints = useMemo(() => {
    const definitions = Array.isArray(robotLoadState?.movableJoints)
      ? robotLoadState.movableJoints
      : [];
    const seen = new Set();
    const rows = definitions.flatMap((joint) => {
      if (!joint?.name || seen.has(joint.name)) return [];
      seen.add(joint.name);
      return [{ ...joint }];
    });
    Object.keys(jointValues || {}).forEach((name) => {
      if (seen.has(name)) return;
      rows.push({ name, type: 'continuous', unit: 'degree', lower: null, upper: null });
    });
    return rows;
  }, [jointValues, robotLoadState?.movableJoints]);

  const jointGroups = useMemo(() => {
    const grouped = new Map(GROUPS.map((group) => [group.id, []]));
    joints.forEach((joint) => {
      const group = GROUPS.find((candidate) => candidate.test(joint.name)) || GROUPS.at(-1);
      grouped.get(group.id).push(joint);
    });
    return GROUPS.flatMap((group) => {
      const entries = grouped.get(group.id);
      return entries.length ? [{ ...group, entries }] : [];
    });
  }, [joints]);
  const visibleLockedJointCount = useMemo(
    () => joints.reduce((count, joint) => count + Number(lockedJointSet.has(joint.name)), 0),
    [joints, lockedJointSet],
  );

  const capturePose = () => {
    onCapturePose(poseName);
    setPoseName('');
  };

  return (
    <section
      className={`robot-joint-console ${robotReady ? 'is-ready' : 'is-waiting'}`}
      aria-label="机器人全关节控制"
      data-joint-count={joints.length}
      data-locked-joint-count={visibleLockedJointCount}
      data-locked-joint-names={JSON.stringify(
        joints.flatMap((joint) => lockedJointSet.has(joint.name) ? [joint.name] : []),
      )}
      data-joint-pose-count={poses.length}
      data-robot-ready={robotReady ? 'true' : 'false'}
    >
      <div className="robot-joint-console__header">
        <div className="robot-joint-console__identity">
          <span><SlidersHorizontal size={14} /></span>
          <div>
            <small>JOINT DIRECTOR / FULL BODY</small>
            <strong>全关节控制</strong>
          </div>
        </div>
        <div className="robot-joint-console__count">
          <Gauge size={11} /> {joints.length} DOF
        </div>
      </div>

      {!robotReady && (
        <div className="robot-joint-console__empty">
          <Bot size={21} strokeWidth={1.25} />
          <strong>{robot ? '机器人模型装配中' : '等待机器人模型'}</strong>
          <span>模型加载完成后，将读取 URDF 中全部可动关节及其运动范围。</span>
        </div>
      )}

      {robotReady && !joints.length && (
        <div className="robot-joint-console__empty">
          <SlidersHorizontal size={21} strokeWidth={1.25} />
          <strong>当前模型没有可动关节</strong>
          <span>GLB / STL 等纯几何模型不包含可控制的 URDF 关节定义。</span>
        </div>
      )}

      {robotReady && Boolean(joints.length) && (
        <>
          <div className="joint-console-toolbar">
            <div>
              <span>CURRENT JOINT STATE</span>
              <strong>
                {joints.length} VALUES · {visibleLockedJointCount
                  ? `${visibleLockedJointCount} IK LOCKED`
                  : 'ALL IK ACTIVE'}
              </strong>
            </div>
            <div className="joint-console-toolbar__actions">
              {Boolean(visibleLockedJointCount) && (
                <button
                  type="button"
                  className="is-unlock"
                  onClick={() => onUnlockAllJoints?.()}
                  aria-label="解除全部关节 IK 锁定"
                >
                  <Unlock size={11} /> 解锁 {visibleLockedJointCount}
                </button>
              )}
              <button
                type="button"
                onClick={onZeroJoints}
                disabled={!joints.length}
                aria-label="全部关节归零"
              >
                <RotateCcw size={11} /> 全部归零
              </button>
            </div>
          </div>

          <div className="joint-group-list" aria-label="全部机器人关节值">
            {jointGroups.map((group) => (
              <details className="joint-group" key={group.id} open>
                <summary>
                  <span>{group.label}</span>
                  <i />
                  <small>{group.entries.length}</small>
                </summary>
                <div>
                  {group.entries.map((joint) => (
                    <JointValueRow
                      key={joint.name}
                      joint={joint}
                      value={jointValues?.[joint.name] ?? 0}
                      locked={lockedJointSet.has(joint.name)}
                      onChange={onChangeJoint}
                      onToggleLock={onToggleJointLock}
                    />
                  ))}
                </div>
              </details>
            ))}
          </div>

          <div className="joint-pose-recorder">
            <label>
              <span>关节姿态名称</span>
              <input
                aria-label="新关节姿态名称"
                value={poseName}
                placeholder={`例如：姿态 ${String(poses.length + 1).padStart(2, '0')}`}
                onChange={(event) => setPoseName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && joints.length) capturePose();
                }}
              />
            </label>
            <button
              type="button"
              onClick={capturePose}
              disabled={!joints.length}
              aria-label="记录当前关节姿态"
            >
              <Save size={12} /> 记录姿态
            </button>
          </div>

          <div className="joint-pose-heading">
            <span>已记录姿态</span>
            <i />
            <small>{poses.length} POSES</small>
          </div>

          {!poses.length && (
            <div className="joint-pose-empty">调整关节后输入名称，将当前全身关节值保存为可复用姿态。</div>
          )}

          <div className="joint-pose-list">
            {poses.map((pose, index) => {
              const poseRobotKey = pose.robot?.id || pose.robot?.relativePath;
              const matchesRobot = Boolean(poseRobotKey && poseRobotKey === robotKey);
              return (
                <div
                  className={`joint-pose-row ${matchesRobot ? '' : 'is-mismatch'}`}
                  key={pose.id}
                  data-joint-pose-id={pose.id}
                  data-joint-pose-match={matchesRobot ? 'true' : 'false'}
                >
                  <i>{String(index + 1).padStart(2, '0')}</i>
                  <div>
                    <JointPoseName pose={pose} index={index} onRename={onRenamePose} />
                    <small>{pose.joints?.count || Object.keys(pose.joints?.values || {}).length} VALUES</small>
                  </div>
                  <button
                    type="button"
                    className="joint-pose-apply"
                    aria-label={`执行关节姿态 ${pose.name}`}
                    title={matchesRobot ? '将记录的全部关节值应用到当前机器人' : '机器人模型不匹配'}
                    disabled={!matchesRobot}
                    onClick={() => onApplyPose(pose.id)}
                  >
                    <Play size={10} /> 执行
                  </button>
                  <button
                    type="button"
                    className="joint-pose-delete"
                    aria-label={`删除关节姿态 ${pose.name}`}
                    title="删除这条关节姿态"
                    onClick={() => {
                      if (window.confirm(`删除关节姿态 ${pose.name}？`)) onDeletePose(pose.id);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
