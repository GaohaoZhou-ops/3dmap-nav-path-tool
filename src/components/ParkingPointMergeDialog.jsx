import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  GitMerge,
  LoaderCircle,
  MapPin,
  Network,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';

const formatValue = (value, digits = 2, fallback = '--') => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : fallback;
};

const parameterSignature = (parameters) => [
  Number(parameters?.distanceThreshold),
  Number(parameters?.positionToleranceCm),
  Number(parameters?.rotationTolerance),
].map((value) => (Number.isFinite(value) ? value.toFixed(5) : '')).join('|');

export default function ParkingPointMergeDialog({
  task,
  state,
  onClose,
  onParameterChange,
  onAnalyze,
  onToggleCluster,
  onConfirm,
}) {
  if (!task || !state) return null;
  const result = state.result;
  const clusters = result?.clusters || [];
  const selectedIds = state.selectedClusterIds || new Set();
  const selectedClusters = clusters.filter(
    (cluster) => cluster.feasible && selectedIds.has(cluster.id),
  );
  const parametersChanged = Boolean(
    state.analyzedParameters
    && parameterSignature(state.parameters) !== parameterSignature(state.analyzedParameters),
  );
  const analyzing = state.status === 'analyzing';
  const serverResult = state.source === 'server';

  return createPortal(
    <div
      className="parking-merge-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="parking-merge-title"
      data-analysis-status={state.status}
      data-cluster-count={clusters.length}
      data-feasible-cluster-count={result?.feasibleClusterCount || 0}
      data-selected-cluster-count={selectedClusters.length}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !analyzing) onClose();
      }}
    >
      <section className="parking-merge-dialog">
        <header className="parking-merge-dialog__header">
          <span className="parking-merge-dialog__mark"><GitMerge size={19} /></span>
          <div>
            <small>{serverResult ? 'SERVER RESULT / MANIFEST VERIFIED' : 'COMMON PARKING / IK REPLAN'}</small>
            <h2 id="parking-merge-title">合并停车点</h2>
            <p>{task.name} · {serverResult
              ? '集群结果已通过任务、地图与机器人指纹校验，请选择要落库的近邻簇'
              : '先聚类近邻停车点，再搜索可保持末端拍照姿态的公共位置'}</p>
          </div>
          <div className="parking-merge-dialog__status">
            <i className={analyzing ? 'is-active' : ''} />
            <span>{analyzing ? 'PLANNING' : serverResult ? 'SERVER VERIFIED' : state.status === 'ready' ? 'ANALYZED' : 'STANDBY'}</span>
          </div>
          <button
            type="button"
            aria-label="关闭停车点合并弹窗"
            disabled={analyzing}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="parking-merge-dialog__body">
          <aside className="parking-merge-parameters" aria-label="停车点合并参数">
            <header>
              <SlidersHorizontal size={12} />
              <span><strong>分析参数</strong><small>CLUSTER / TOLERANCE</small></span>
            </header>
            <label>
              <span>近邻聚类半径</span>
              <div>
                <input
                  type="number"
                  min="0.02"
                  max="5"
                  step="0.05"
                  value={state.parameters.distanceThreshold}
                  disabled={analyzing}
                  aria-label="停车点近邻聚类半径"
                  onChange={(event) => onParameterChange(
                    'distanceThreshold',
                    event.target.value,
                  )}
                />
                <b>m</b>
              </div>
              <small>XY 单链聚类；相邻节点小于该距离即进入同一簇</small>
            </label>
            <label>
              <span>末端 XYZ 容差</span>
              <div>
                <input
                  type="number"
                  min="0.1"
                  max="50"
                  step="0.5"
                  value={state.parameters.positionToleranceCm}
                  disabled={analyzing}
                  aria-label="融合后末端XYZ容差"
                  onChange={(event) => onParameterChange(
                    'positionToleranceCm',
                    event.target.value,
                  )}
                />
                <b>cm</b>
              </div>
              <small>重规划后相机光学中心允许的三维位置误差</small>
            </label>
            <label>
              <span>末端 RPY 容差</span>
              <div>
                <input
                  type="number"
                  min="0.1"
                  max="45"
                  step="0.5"
                  value={state.parameters.rotationTolerance}
                  disabled={analyzing}
                  aria-label="融合后末端RPY容差"
                  onChange={(event) => onParameterChange(
                    'rotationTolerance',
                    event.target.value,
                  )}
                />
                <b>deg</b>
              </div>
              <small>按光学坐标系四元数夹角校验，避免欧拉角跳变</small>
            </label>
            <button
              type="button"
              className={parametersChanged ? 'is-dirty' : ''}
              disabled={analyzing}
              aria-label={result ? '使用当前容差重新分析' : '开始分析停车点'}
              onClick={onAnalyze}
            >
              {analyzing
                ? <LoaderCircle className="is-spinning" size={13} />
                : <RefreshCw size={13} />}
              {analyzing ? '正在搜索公共位置' : result ? '重新分析' : '开始分析'}
            </button>
            <p>
              规划器使用当前 URDF 的克隆模型，不会改变主 3D 窗口中的机器人姿态。
            </p>
          </aside>

          <main className="parking-merge-results" aria-label="停车点合并分析结果">
            {analyzing && (
              <div className="parking-merge-analyzing" role="status">
                <span><i /><i /><i /></span>
                <LoaderCircle className="is-spinning" size={23} />
                <strong>正在执行近邻聚类与双臂 IK 搜索</strong>
                <small>比较几何中心与每个现有停车位候选，并逐一校验左右 Zivid 光学位姿</small>
              </div>
            )}

            {!analyzing && state.status === 'error' && (
              <div className="parking-merge-empty is-error" role="alert">
                <AlertTriangle size={22} />
                <strong>合并分析未完成</strong>
                <span>{state.error || '机器人运动学规划器返回错误'}</span>
                <button type="button" onClick={onAnalyze}><RefreshCw size={11} /> 重试分析</button>
              </div>
            )}

            {!analyzing && state.status === 'ready' && clusters.length === 0 && (
              <div className="parking-merge-empty">
                <Network size={22} />
                <strong>当前半径内没有近邻停车点</strong>
                <span>
                  已检查 {task.parkingPoints?.length || 0} 个停车点；可增大左侧聚类半径后重新分析。
                </span>
              </div>
            )}

            {!analyzing && state.status === 'ready' && clusters.length > 0 && (
              <>
                <header className="parking-merge-results__summary">
                  <div>
                    <Network size={13} />
                    <span><strong>{clusters.length} 个近邻簇</strong><small>{result.nearbyPairs?.length || 0} 条邻接关系</small></span>
                  </div>
                  <dl>
                    <div><dt>可融合</dt><dd>{result.feasibleClusterCount || 0}</dd></div>
                    <div><dt>独立点</dt><dd>{result.isolatedParkingPointIds?.length || 0}</dd></div>
                    <div><dt>已选择</dt><dd>{selectedClusters.length}</dd></div>
                  </dl>
                </header>

                {parametersChanged && (
                  <div className="parking-merge-stale" role="status">
                    <AlertTriangle size={11} /> 容差参数已经修改，请重新分析后再执行合并。
                  </div>
                )}

                <div className="parking-merge-cluster-list">
                  {clusters.map((cluster, index) => {
                    const candidate = cluster.candidate;
                    const selected = selectedIds.has(cluster.id);
                    const failedPoses = (cluster.plannedPoses || []).filter(
                      (pose) => !pose.feasible,
                    );
                    return (
                      <article
                        key={cluster.id}
                        className={`${cluster.feasible ? 'is-feasible' : 'is-blocked'} ${selected ? 'is-selected' : ''}`}
                        data-merge-cluster-id={cluster.id}
                        data-merge-feasible={cluster.feasible ? 'true' : 'false'}
                        data-merge-member-count={cluster.memberIds.length}
                        data-merge-pose-count={cluster.poseCount}
                      >
                        <header>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={selected}
                            aria-label={`${selected ? '取消选择' : '选择'}近邻簇 ${index + 1}`}
                            disabled={!cluster.feasible || parametersChanged}
                            onClick={() => onToggleCluster(cluster.id)}
                          >
                            {selected && <Check size={11} />}
                          </button>
                          <span>
                            <small>CLUSTER {String(index + 1).padStart(2, '0')}</small>
                            <strong>{cluster.memberNames.join(' + ')}</strong>
                          </span>
                          <em className={cluster.feasible ? 'is-pass' : 'is-fail'}>
                            {cluster.feasible ? 'IK 可融合' : '超出容差'}
                          </em>
                        </header>

                        <div className="parking-merge-cluster-flow">
                          <div>
                            <small>来源停车点</small>
                            <strong>{cluster.memberIds.length} STOPS</strong>
                            <span>最大跨度 {formatValue(cluster.maximumPairDistance * 100, 1)} cm</span>
                          </div>
                          <i><GitMerge size={14} /></i>
                          <div>
                            <small>公共停车点</small>
                            <strong>{candidate?.anchorParkingPointName || '未找到'}</strong>
                            <span>{candidate?.sourceLabel || cluster.reason}</span>
                          </div>
                        </div>

                        {candidate && (
                          <div
                            className="parking-merge-candidate-pose"
                            aria-label={`近邻簇 ${index + 1} 公共停车点位姿`}
                          >
                            <span>X <b>{formatValue(candidate.mapPose.position.x, 3)}</b></span>
                            <span>Y <b>{formatValue(candidate.mapPose.position.y, 3)}</b></span>
                            <span>Z <b>{formatValue(candidate.mapPose.position.z, 3)}</b></span>
                            <span>YAW <b>{formatValue(candidate.mapPose.rpy.yaw, 1)}°</b></span>
                          </div>
                        )}

                        <dl className="parking-merge-cluster-metrics">
                          <div>
                            <dt>姿态重规划</dt>
                            <dd>{candidate?.feasiblePoseCount || 0} / {cluster.poseCount}</dd>
                          </div>
                          <div>
                            <dt>末端 XYZ 最大误差</dt>
                            <dd>{formatValue((candidate?.maximumPositionError || 0) * 1000, 2)} mm</dd>
                          </div>
                          <div>
                            <dt>末端 RPY 最大误差</dt>
                            <dd>{formatValue(candidate?.maximumRotationError, 2)}°</dd>
                          </div>
                          <div>
                            <dt>候选搜索</dt>
                            <dd>{cluster.candidateCount} POSITIONS</dd>
                          </div>
                        </dl>

                        {!cluster.feasible && (
                          <p className="parking-merge-cluster-error">
                            <AlertTriangle size={10} />
                            <span>
                              {cluster.reason}
                              {failedPoses.length
                                ? ` · 未通过：${failedPoses.slice(0, 3).map((pose) => pose.poseName).join('、')}`
                                : ''}
                            </span>
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </main>
        </div>

        <footer className="parking-merge-dialog__footer">
          <div>
            <MapPin size={11} />
            <span>
              合并后保留公共 MAP 位姿、重新计算的全身关节值及原始双目快照；规划来源写入审计记录。
            </span>
          </div>
          <button type="button" disabled={analyzing} onClick={onClose}>取消</button>
          <button
            type="button"
            className="is-primary"
            aria-label="确认合并选中的停车点"
            disabled={analyzing || parametersChanged || selectedClusters.length === 0}
            onClick={() => onConfirm(selectedClusters)}
          >
            <GitMerge size={12} />
            合并 {selectedClusters.length || 0} 个近邻簇
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
