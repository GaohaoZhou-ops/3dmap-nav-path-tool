import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  Check,
  Cpu,
  Download,
  FileArchive,
  HardDrive,
  LoaderCircle,
  Server,
  ShieldCheck,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_PARKING_CLUSTER_DISTANCE,
  DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
  DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
} from '../lib/parkingPointMerge.js';

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
};

const shortHash = (value) => {
  const source = String(value || '');
  return source ? `${source.slice(0, 10)}…${source.slice(-8)}` : 'NO HASH';
};

const safeFileSegment = (value) => String(value || 'task')
  .replace(/[^a-z0-9._-]+/gi, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 56) || 'task';

const initialStatus = {
  state: 'idle',
  phase: '等待操作',
  detail: '导出集群任务，或导入已经完成的计算结果',
};

export default function ParkingPointServerDialog({
  task,
  mapData,
  robot,
  onClose,
  onImported,
}) {
  const inputRef = useRef(null);
  const [status, setStatus] = useState(initialStatus);
  const [lastPackage, setLastPackage] = useState(null);
  const [parameters, setParameters] = useState({
    distanceThreshold: DEFAULT_PARKING_CLUSTER_DISTANCE,
    positionTolerance: DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
    rotationTolerance: DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
    environmentCollisionEnabled: true,
  });
  const busy = status.state === 'exporting' || status.state === 'importing';
  const poseCount = useMemo(() => (
    (task?.parkingPoints || []).reduce(
      (total, parkingPoint) => total + (parkingPoint.poses?.length || 0),
      0,
    )
  ), [task]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  if (!task) return null;

  const updateStatus = (state, phase, detail) => setStatus({ state, phase, detail });
  const onProgress = ({ phase, detail }) => {
    setStatus((current) => ({ ...current, phase, detail }));
  };

  const handleExport = async () => {
    if (busy) return;
    updateStatus('exporting', '准备 Server 计算包', '正在冻结任务、地图与机器人资源');
    try {
      const { downloadParkingMergeServerArchive } = await import(
        '../lib/parkingMergeServerArchive.js'
      );
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `parking-merge-server-${safeFileSegment(task.id)}-${stamp}.zip`;
      const archive = await downloadParkingMergeServerArchive(
        { task, mapData, robot, parameters, onProgress },
        filename,
      );
      setLastPackage({
        filename,
        jobId: archive.manifest.jobId,
        inputDigest: archive.manifest.inputDigest,
        byteLength: archive.byteLength,
        fileCount: archive.manifest.files.length + 1,
      });
      updateStatus(
        'success',
        '计算包已导出',
        `${archive.manifest.jobId} · ${formatBytes(archive.byteLength)}`,
      );
    } catch (error) {
      updateStatus('error', '计算包导出失败', error?.message || '无法生成 Server 计算包');
    }
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    updateStatus('importing', '校验 Server 结果', file.name);
    try {
      const { readParkingMergeServerResult } = await import(
        '../lib/parkingMergeServerArchive.js'
      );
      const result = await readParkingMergeServerResult(
        file,
        { task, mapData, robot },
        onProgress,
      );
      updateStatus(
        'success',
        '结果校验通过',
        `${result.analysis.feasibleClusterCount || 0} 个近邻簇可融合`,
      );
      onImported(result);
    } catch (error) {
      updateStatus('error', '结果已拒绝', error?.message || 'Server 结果校验失败');
    }
  };

  return createPortal(
    <div
      className="parking-server-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="parking-server-title"
      data-transfer-state={status.state}
      data-task-id={task.id}
      data-map-hash={mapData?.sourceHash || ''}
      data-robot-id={robot?.id || robot?.relativePath || ''}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="parking-server-dialog">
        <header className="parking-server-dialog__header">
          <span className="parking-server-dialog__mark"><Server size={20} /></span>
          <div>
            <small>OFFLINE COMPUTE / MANIFEST LOCK</small>
            <h2 id="parking-server-title">合并停车点-Server</h2>
            <p>{task.name} · 将公共停车位搜索迁移到高性能计算集群</p>
          </div>
          <span className="parking-server-dialog__protocol">
            <ShieldCheck size={12} /> SHA-256 BOUND
          </span>
          <button
            type="button"
            aria-label="关闭 Server 合并弹窗"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="parking-server-dialog__body">
          <section className="parking-server-context" aria-label="Server 计算绑定清单">
            <header><FileArchive size={13} /><span><strong>计算绑定</strong><small>IMMUTABLE INPUT</small></span></header>
            <dl>
              <div><dt>任务</dt><dd>{task.name}</dd><small>{task.parkingPoints?.length || 0} STOPS / {poseCount} POSES</small></div>
              <div><dt>地图</dt><dd>{mapData?.name || '未绑定'}</dd><small title={mapData?.sourceHash || ''}>{shortHash(mapData?.sourceHash)}</small></div>
              <div><dt>机器人</dt><dd>{robot?.name || '未绑定'}</dd><small>{robot?.relativePath || robot?.id || 'NO MODEL'}</small></div>
              <div><dt>碰撞</dt><dd>{parameters.environmentCollisionEnabled ? '最终姿态校验' : '不校验'}</dd><small>BASE / WHEELS EXCLUDED</small></div>
            </dl>
            <div className="parking-server-parameters" aria-label="Server 合并计算参数">
              <label>
                <span>聚类半径</span>
                <div><input aria-label="Server 停车点聚类半径" type="number" min="0.02" max="5" step="0.05" value={parameters.distanceThreshold} disabled={busy} onChange={(event) => setParameters((current) => ({ ...current, distanceThreshold: event.target.value }))} /><b>m</b></div>
              </label>
              <label>
                <span>XYZ 容差</span>
                <div><input aria-label="Server 末端XYZ容差" type="number" min="0.001" max="0.5" step="0.005" value={parameters.positionTolerance} disabled={busy} onChange={(event) => setParameters((current) => ({ ...current, positionTolerance: event.target.value }))} /><b>m</b></div>
              </label>
              <label>
                <span>RPY 容差</span>
                <div><input aria-label="Server 末端RPY容差" type="number" min="0.1" max="45" step="0.5" value={parameters.rotationTolerance} disabled={busy} onChange={(event) => setParameters((current) => ({ ...current, rotationTolerance: event.target.value }))} /><b>deg</b></div>
              </label>
              <button
                type="button"
                role="switch"
                aria-label="Server 环境终态碰撞校验"
                aria-checked={parameters.environmentCollisionEnabled}
                className={parameters.environmentCollisionEnabled ? 'is-on' : ''}
                disabled={busy}
                onClick={() => setParameters((current) => ({
                  ...current,
                  environmentCollisionEnabled: !current.environmentCollisionEnabled,
                }))}
              >
                <span /><small>ENV COLLISION</small>
              </button>
            </div>
          </section>

          <section className="parking-server-transfer" aria-label="Server 计算包导入导出">
            <div className="parking-server-flow" aria-hidden="true">
              <span><Box size={16} /><b>01</b><small>FREEZE</small></span>
              <i />
              <span><Cpu size={16} /><b>02</b><small>CLUSTER</small></span>
              <i />
              <span><Check size={16} /><b>03</b><small>VERIFY</small></span>
            </div>

            <div className={`parking-server-status is-${status.state}`} role="status" aria-live="polite">
              <span>
                {busy
                  ? <LoaderCircle className="is-spinning" size={19} />
                  : status.state === 'error'
                    ? <TriangleAlert size={19} />
                    : status.state === 'success'
                      ? <Check size={19} />
                      : <HardDrive size={19} />}
              </span>
              <div><small>{status.state.toUpperCase()}</small><strong>{status.phase}</strong><p>{status.detail}</p></div>
            </div>

            {lastPackage && (
              <dl className="parking-server-package-receipt" aria-label="最近导出的 Server 计算包">
                <div><dt>JOB</dt><dd>{lastPackage.jobId}</dd></div>
                <div><dt>FILES</dt><dd>{lastPackage.fileCount}</dd></div>
                <div><dt>SIZE</dt><dd>{formatBytes(lastPackage.byteLength)}</dd></div>
                <div title={lastPackage.inputDigest}><dt>DIGEST</dt><dd>{shortHash(lastPackage.inputDigest)}</dd></div>
              </dl>
            )}

            <section className="parking-server-runbook" aria-label="导出后的集群操作">
              <header>
                <span>导出后的集群操作</span>
                <small>3 STEPS · TERMINAL</small>
              </header>
              <ol>
                <li>
                  <b>01</b>
                  <span><strong>解压计算包</strong><code>unzip {lastPackage?.filename || 'parking-merge-server-*.zip'} -d merge-job</code></span>
                </li>
                <li>
                  <b>02</b>
                  <span><strong>进入任务目录</strong><code>cd merge-job</code></span>
                </li>
                <li>
                  <b>03</b>
                  <span><strong>部署环境并开始计算</strong><code>bash run_cluster.sh --workers 8</code></span>
                </li>
              </ol>
            </section>

            <div className="parking-server-transfer__actions">
              <button
                type="button"
                className="is-export"
                aria-label="导出 Server 计算包"
                disabled={busy}
                onClick={handleExport}
              >
                {status.state === 'exporting' ? <LoaderCircle className="is-spinning" size={18} /> : <Download size={18} />}
                <span><strong>导出</strong><small>任务 ZIP · 脚本 / 算法 / 资源</small></span>
              </button>
              <button
                type="button"
                className="is-import"
                aria-label="导入 Server 计算结果"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {status.state === 'importing' ? <LoaderCircle className="is-spinning" size={18} /> : <Upload size={18} />}
                <span><strong>导入</strong><small>结果 ZIP / JSON · 强校验</small></span>
              </button>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept=".zip,.json,application/zip,application/x-zip-compressed,application/json"
                onChange={handleImportFile}
              />
            </div>
            <p className="parking-server-transfer__note">
              导入通过后不会立即改写任务，而是进入普通“合并停车点”结果页，由你选择近邻簇并最终确认。
            </p>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}
