import { useId, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Gauge,
  Pause,
  Play,
  Repeat,
  Square,
} from 'lucide-react';
import { teachingPlaybackPhaseLabel } from '../lib/teachingPlayback.js';

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};

export default function TeachingPlaybackDock({
  playback,
  onPause,
  onResume,
  onStop,
  onSpeedChange,
  onFollowRobotChange,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  if (!playback || playback.status === 'idle') return null;
  const playing = playback.status === 'playing';
  const overallProgress = Math.max(0, Math.min(1, playback.overallProgress || 0));
  const statusLabel = playing ? '循环播放' : '已暂停';
  const remainingMilliseconds = Math.max(0, (playback.totalDurationMs - playback.elapsedDurationMs)
    / Math.max(0.1, playback.speed || 1));

  return (
    <section
      className={`teaching-playback-dock is-${playback.status}${collapsed ? ' is-collapsed' : ''}`}
      aria-label="示教任务轨迹播放控制"
      data-collapsed={collapsed}
      data-playback-status={playback.status}
      data-playback-task={playback.taskId || ''}
      data-playback-phase={playback.phase || ''}
      data-playback-pose={`${playback.poseOrdinal || 0}/${playback.poseCount || 0}`}
      data-playback-reached-pose={`${playback.reachedPoseCount || 0}/${playback.poseCount || 0}`}
      data-playback-progress={overallProgress.toFixed(4)}
      data-playback-segment-progress={Math.max(0, Math.min(1, playback.segmentProgress || 0)).toFixed(4)}
      data-playback-segment={`${(playback.segmentIndex || 0) + 1}/${playback.segmentCount || 0}`}
      data-playback-elapsed-ms={Math.round(playback.elapsedDurationMs || 0)}
      data-playback-total-ms={Math.round(playback.totalDurationMs || 0)}
      data-playback-speed={playback.speed || 1}
      data-playback-cycle={playback.cycle || 1}
      data-follow-robot={Boolean(playback.followRobot)}
    >
      <div id={contentId} className="teaching-playback-dock__content" hidden={collapsed}>
        <div className="teaching-playback-dock__identity">
          <span className="teaching-playback-dock__pulse"><Repeat size={13} /></span>
          <div>
            <small aria-live="polite">{statusLabel} · 第 {playback.cycle || 1} 轮</small>
            <strong title={playback.taskName}>{playback.taskName}</strong>
          </div>
        </div>

        <div className="teaching-playback-dock__controls">
          <button
            type="button"
            className="is-primary"
            onClick={playing ? onPause : onResume}
            aria-label={playing ? '暂停示教轨迹播放' : '继续示教轨迹播放'}
          >
            {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            {playing ? '暂停' : '继续'}
          </button>
          <label>
            <Gauge size={12} />
            <span className="visually-hidden">播放速度</span>
            <select
              aria-label="示教轨迹播放速度"
              value={String(playback.speed || 1)}
              onChange={(event) => onSpeedChange(Number(event.target.value))}
            >
              <option value="0.5">0.5×</option>
              <option value="1">1.0×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2.0×</option>
              <option value="5">5.0×</option>
            </select>
          </label>
          <button
            type="button"
            className="teaching-playback-dock__follow"
            role="switch"
            aria-label="跟随机器人"
            aria-checked={Boolean(playback.followRobot)}
            title={playback.followRobot ? '关闭跟随，保留当前视角' : '开启跟随，画面随机器人移动'}
            onClick={() => onFollowRobotChange(!playback.followRobot)}
          >
            <Crosshair size={13} /> 跟随
            <span className="teaching-playback-dock__switch" aria-hidden="true" />
          </button>
          <button type="button" className="is-stop" onClick={onStop} aria-label="停止示教轨迹播放">
            <Square size={11} fill="currentColor" /> 停止
          </button>
        </div>

        <div className="teaching-playback-dock__timeline">
          <div>
            <span title={playback.parkingPointName}>{playback.parkingPointName || '准备停车点'}</span>
            <i>/</i>
            <strong title={playback.poseName}>{playback.poseName || '准备姿态'}</strong>
            <em>{teachingPlaybackPhaseLabel(playback.phase)}</em>
          </div>
          <div
            className="teaching-playback-dock__track"
            role="progressbar"
            aria-label="示教任务播放进度"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(overallProgress * 100)}
          >
            <span style={{ width: `${overallProgress * 100}%` }} />
            <i style={{ left: `${overallProgress * 100}%` }} />
          </div>
          <small>
            姿态 {Math.min(playback.poseOrdinal || 0, playback.poseCount || 0)} / {playback.poseCount || 0}
            <b>本轮剩余 {formatDuration(remainingMilliseconds)}</b>
          </small>
        </div>
      </div>
      <button
        type="button"
        className="teaching-playback-dock__toggle"
        aria-label={collapsed ? '展开播放控制条' : '向左收起播放控制条'}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        title={collapsed ? `展开播放控制条 · ${statusLabel}` : '向左收起播放控制条'}
        onClick={() => setCollapsed((current) => !current)}
      >
        {collapsed && (playing ? <Repeat size={13} /> : <Pause size={13} />)}
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </section>
  );
}
