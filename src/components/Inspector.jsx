import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Compass,
  GitBranch,
  Route,
  ScanSearch,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

function NumericField({ label, value, unit, step = '0.01', onCommit }) {
  const [draft, setDraft] = useState(String(Number(value).toFixed(2)));

  useEffect(() => {
    setDraft(String(Number(value).toFixed(2)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(Number(value).toFixed(2)));
  };

  return (
    <label className="numeric-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}

const statusMeta = {
  connected: { label: '可互达', className: 'connected' },
  unreachable: { label: '未互达', className: 'unreachable' },
  unchecked: { label: '待检测', className: 'unchecked' },
};

export default function Inspector({
  mapData,
  heightRange,
  waypoints,
  edges,
  selectedWaypointId,
  selectedEdgeId,
  validation,
  onRunConnectivity,
  onSelectWaypoint,
  onSelectEdge,
  onClearSelection,
  onUpdateWaypoint,
  onUpdateEdge,
  onDeleteWaypoint,
  onDeleteEdge,
}) {
  const selectedWaypoint = waypoints.find((point) => point.id === selectedWaypointId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const pointById = useMemo(() => new Map(waypoints.map((point) => [point.id, point])), [waypoints]);

  const validationCopy =
    validation.status === 'connected'
      ? { title: '全图强连通', detail: '所有导航点均可往返到达', icon: CheckCircle2 }
      : validation.status === 'partial'
        ? { title: '存在单向断路', detail: `${validation.unreachableCount} 条路径尚未形成回路`, icon: TriangleAlert }
        : { title: '等待连通性检测', detail: '按有向图检查任意两点能否互达', icon: ScanSearch };
  const ValidationIcon = validationCopy.icon;

  const updatePose = (key, value) => {
    onUpdateWaypoint(selectedWaypoint.id, {
      pose: { ...selectedWaypoint.pose, [key]: value },
    });
  };

  const updateLimit = (key, value) => {
    onUpdateEdge(selectedEdge.id, {
      limits: { ...selectedEdge.limits, [key]: value },
    });
  };

  const invalidLimits = selectedEdge
    ? selectedEdge.limits.minSpeed > selectedEdge.limits.maxSpeed ||
      selectedEdge.limits.minAcceleration > selectedEdge.limits.maxAcceleration
    : false;

  return (
    <aside className="inspector-panel">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">ROUTE LOGIC</span>
          <h2>图谱控制台</h2>
        </div>
        <div className="graph-count"><GitBranch size={14} /> {waypoints.length} / {edges.length}</div>
      </div>

      <section className={`connectivity-card ${validation.status}`}>
        <div className="connectivity-card__icon"><ValidationIcon size={18} /></div>
        <div className="connectivity-card__copy">
          <strong>{validationCopy.title}</strong>
          <span>{validationCopy.detail}</span>
        </div>
        <button
          type="button"
          onClick={onRunConnectivity}
          disabled={!edges.length}
          title="运行有向图强连通检测"
        >
          检测
        </button>
      </section>

      <div className="inspector-scroll">
        {(selectedWaypoint || selectedEdge) && (
          <button type="button" className="back-link" onClick={onClearSelection}>
            <ArrowLeft size={13} /> 返回工程总览
          </button>
        )}

        {selectedWaypoint && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="point-glyph"><span /></div>
              <div>
                <span className="eyebrow">WAYPOINT / 3D POSE</span>
                <h3>{selectedWaypoint.name}</h3>
              </div>
            </div>

            <label className="text-field">
              <span>导航点名称</span>
              <input
                value={selectedWaypoint.name}
                onChange={(event) => onUpdateWaypoint(selectedWaypoint.id, { name: event.target.value })}
              />
            </label>

            <div className="field-section-heading">
              <span>原始三维坐标</span>
              <small>XYZ · meter</small>
            </div>
            <div className="field-grid three">
              <NumericField label="X" value={selectedWaypoint.pose.x} unit="m" onCommit={(value) => updatePose('x', value)} />
              <NumericField label="Y" value={selectedWaypoint.pose.y} unit="m" onCommit={(value) => updatePose('y', value)} />
              <NumericField label="Z" value={selectedWaypoint.pose.z} unit="m" onCommit={(value) => updatePose('z', value)} />
            </div>

            <div className="field-section-heading">
              <span>姿态角</span>
              <small>RPY · degree</small>
            </div>
            <div className="field-grid three">
              <NumericField label="ROLL" value={selectedWaypoint.pose.roll} unit="°" onCommit={(value) => updatePose('roll', value)} />
              <NumericField label="PITCH" value={selectedWaypoint.pose.pitch} unit="°" onCommit={(value) => updatePose('pitch', value)} />
              <NumericField label="YAW" value={selectedWaypoint.pose.yaw} unit="°" onCommit={(value) => updatePose('yaw', value)} />
            </div>

            <div className="capture-note">
              <CrosshairMark />
              <span>Z 值取自点击位置附近的原始点云；导出时同时写入 <code>pose</code>、<code>xzy</code> 与 <code>rpy</code>。</span>
            </div>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (window.confirm(`删除 ${selectedWaypoint.name} 及其关联路径？`)) {
                  onDeleteWaypoint(selectedWaypoint.id);
                }
              }}
            >
              <Trash2 size={14} /> 删除导航点
            </button>
          </section>
        )}

        {selectedEdge && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="route-glyph"><Route size={17} /></div>
              <div>
                <span className="eyebrow">DIRECTED PATH</span>
                <h3>路径参数</h3>
              </div>
            </div>

            <div className="direction-card">
              <div>
                <small>FROM</small>
                <strong>{pointById.get(selectedEdge.from)?.name || selectedEdge.from}</strong>
              </div>
              <div className="direction-arrow"><ArrowRight size={18} /></div>
              <div>
                <small>TO</small>
                <strong>{pointById.get(selectedEdge.to)?.name || selectedEdge.to}</strong>
              </div>
            </div>

            <div className="field-section-heading">
              <span>速度约束</span>
              <small>meter / second</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小速度" value={selectedEdge.limits.minSpeed} unit="m/s" onCommit={(value) => updateLimit('minSpeed', value)} />
              <NumericField label="最大速度" value={selectedEdge.limits.maxSpeed} unit="m/s" onCommit={(value) => updateLimit('maxSpeed', value)} />
            </div>

            <div className="field-section-heading">
              <span>加速度约束</span>
              <small>meter / second²</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小加速度" value={selectedEdge.limits.minAcceleration} unit="m/s²" onCommit={(value) => updateLimit('minAcceleration', value)} />
              <NumericField label="最大加速度" value={selectedEdge.limits.maxAcceleration} unit="m/s²" onCommit={(value) => updateLimit('maxAcceleration', value)} />
            </div>

            {invalidLimits && (
              <div className="inline-warning"><TriangleAlert size={14} /> 最小值不能大于最大值</div>
            )}

            <div className={`path-status ${selectedEdge.status}`}>
              <span />
              {statusMeta[selectedEdge.status]?.label || '待检测'}
              <small>有向 {pointById.get(selectedEdge.from)?.name} → {pointById.get(selectedEdge.to)?.name}</small>
            </div>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (window.confirm('删除这条有向路径？')) onDeleteEdge(selectedEdge.id);
              }}
            >
              <Trash2 size={14} /> 删除路径
            </button>
          </section>
        )}

        {!selectedWaypoint && !selectedEdge && (
          <>
            <section className="project-overview">
              <div className="section-title"><Compass size={14} /><span>工程配置</span></div>
              <dl className="config-list">
                <div><dt>地图文件</dt><dd title={mapData?.name}>{mapData?.name || '尚未加载'}</dd></div>
                <div><dt>点云数量</dt><dd>{mapData?.pointCount ? mapData.pointCount.toLocaleString('zh-CN') : '—'}</dd></div>
                <div><dt>投影平面</dt><dd>XY / Z 轴切片</dd></div>
                <div><dt>截面下限</dt><dd>{heightRange[0].toFixed(2)} m</dd></div>
                <div><dt>截面上限</dt><dd>{heightRange[1].toFixed(2)} m</dd></div>
              </dl>
            </section>

            <section className="route-index">
              <div className="section-title">
                <Route size={14} />
                <span>有向路径</span>
                <small>{edges.length}</small>
              </div>
              {!edges.length && (
                <div className="empty-list">
                  <CircleGauge size={24} strokeWidth={1.3} />
                  <span>切换到“连接路径”，依次选择起点与终点</span>
                </div>
              )}
              {edges.map((edge, index) => {
                const meta = statusMeta[edge.status] || statusMeta.unchecked;
                return (
                  <button type="button" className="route-index__item" key={edge.id} onClick={() => onSelectEdge(edge.id)}>
                    <span className={`status-dot ${meta.className}`} />
                    <span className="route-index__number">E{String(index + 1).padStart(2, '0')}</span>
                    <strong>{pointById.get(edge.from)?.name || '?'} <ArrowRight size={12} /> {pointById.get(edge.to)?.name || '?'}</strong>
                    <small>{edge.limits.maxSpeed.toFixed(1)} m/s</small>
                    <ChevronRight size={14} />
                  </button>
                );
              })}
            </section>

            <section className="waypoint-index">
              <div className="section-title"><span>导航点</span><small>{waypoints.length}</small></div>
              <div className="waypoint-chips">
                {waypoints.map((point, index) => (
                  <button type="button" key={point.id} onClick={() => onSelectWaypoint(point.id)}>
                    <i>{String(index + 1).padStart(2, '0')}</i>{point.name}
                  </button>
                ))}
                {!waypoints.length && <span className="muted-copy">暂无导航点</span>}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function CrosshairMark() {
  return (
    <span className="crosshair-mark" aria-hidden="true">
      <i /><i />
    </span>
  );
}
