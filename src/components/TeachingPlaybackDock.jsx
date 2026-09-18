import {
  Gauge,
  Pause,
  Play,
  RotateCcw,
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
  onReplay,
  onSpeedChange,
}) {
  if (!playback || playback.status === 'idle') return null;
  const completed = playback.status === 'completed';
  const playing = playback.status === 'playing';
  const overallProgress = completed ? 1 : Math.max(0, Math.min(1, playback.overallProgress || 0));
  const statusLabel = completed ? '轨迹完成' : playing ? '规划执行中' : '已暂停';
  const remainingMilliseconds = completed
    ? 0
    : Math.max(0, (playback.totalDurationMs - playback.elapsedDurationMs)
      / Math.max(0.1, playback.speed || 1));

  return (
    <section
      className={`teaching-playback-dock is-${playback.status}`}
      aria-label="示教任务轨迹播放控制"
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
    >
      <div className="teaching-playback-dock__identity">
        <span className="teaching-playback-dock__pulse"><Play size={13} fill="currentColor" /></span>
        <div>
          <small aria-live="polite">TEACHING TRAJECTORY · {statusLabel}</small>
          <strong title={playback.taskName}>{playback.taskName}</strong>
        </div>
      </div>

      <div className="teaching-playback-dock__timeline">
        <div>
          <span>{playback.parkingPointName || '准备停车点'}</span>
          <i>/</i>
          <strong>{playback.poseName || '准备姿态'}</strong>
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
          <b>剩余 {formatDuration(remainingMilliseconds)}</b>
        </small>
      </div>

      <div className="teaching-playback-dock__controls">
        {completed ? (
          <button type="button" onClick={onReplay} aria-label="重新播放当前示教任务">
            <RotateCcw size={13} /> 重播
          </button>
        ) : (
          <button
            type="button"
            className="is-primary"
            onClick={playing ? onPause : onResume}
            aria-label={playing ? '暂停示教轨迹播放' : '继续示教轨迹播放'}
          >
            {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            {playing ? '暂停' : '继续'}
          </button>
        )}
        <label>
          <Gauge size={12} />
          <span className="visually-hidden">播放速度</span>
          <select
            aria-label="示教轨迹播放速度"
            value={String(playback.speed || 1)}
            disabled={completed}
            onChange={(event) => onSpeedChange(Number(event.target.value))}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1.0×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2.0×</option>
          </select>
        </label>
        <button type="button" className="is-stop" onClick={onStop} aria-label={completed ? '关闭示教轨迹播放控制' : '停止示教轨迹播放'}>
          <Square size={11} fill="currentColor" /> {completed ? '关闭' : '停止'}
        </button>
      </div>
    </section>
  );
}
