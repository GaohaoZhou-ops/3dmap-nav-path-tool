import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, ArrowRight, Check, Crosshair, FolderOpen, LoaderCircle, Scissors, X } from 'lucide-react';
import { normalizeProject } from '../lib/io.js';
import { identityTransferPose, insideTransferBounds, placementTransform, transferMatrix, transformTeachingPose } from '../lib/teachingTransfer.js';
import TeachingTransferPreview from './TeachingTransferPreview.jsx';
import './TeachingTransferDialog.css';

const number = (value) => value === '' ? NaN : Number(value);
const display = (value) => Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : '';
const projectOf = (snapshot) => snapshot?.config?.config?.project ? normalizeProject(snapshot.config.config.project) : null;

export default function TeachingTransferDialog({ state, onClose, onApply, onLoadMap }) {
  const panelRef = useRef(null);
  const [settingsVisible, setSettingsVisible] = useState(true);
  useEffect(() => {
    const previousFocus = document.activeElement;
    panelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);
  const ready = !state.loading && state.source;
  return createPortal(<div className="teaching-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
    <section className="teaching-transfer-dialog" ref={panelRef} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !state.busy) {
          event.preventDefault(); event.stopPropagation();
          if (!settingsVisible) setSettingsVisible(true);
          else onClose();
        }
        if (event.key === 'Tab') {
          const items = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
            .filter((item) => item.getClientRects().length > 0);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="transfer-header">
        <span className="transfer-header__icon"><ArrowLeftRight size={23} /></span>
        <div><small>LOCAL ↔ MAP</small><h2 id="transfer-title">示教转换</h2></div>
        <span className="transfer-header__hint">两种坐标 · 同一份示教</span>
        <button type="button" aria-label="关闭示教转换" onClick={onClose} disabled={state.busy}><X size={19} /></button>
      </header>
      {ready ? <TransferForm source={state.source} target={state.target} initialOperation={state.operation}
        settingsVisible={settingsVisible} setSettingsVisible={setSettingsVisible}
        busy={state.busy} error={state.error} onApply={onApply} onClose={onClose} onLoadMap={onLoadMap} />
        : <div className="transfer-loading" role="status">
          {state.loading && <LoaderCircle className="transfer-spinner" size={25} />}
          <span>{state.error || '正在保存当前工程并读取目标工作区…'}</span>
        </div>}
    </section>
  </div>, document.body);
}

function TransferForm({ source, target, initialOperation, settingsVisible, setSettingsVisible, busy, error, onApply, onClose, onLoadMap }) {
  const sourceProject = useMemo(() => projectOf(source), [source]);
  const targetProject = useMemo(() => projectOf(target), [target]);
  const link = sourceProject.workspace.transfer;
  const [operation, setOperation] = useState(initialOperation);
  const [previewDisplay, setPreviewDisplay] = useState({ colorMode: 'layer', meshQuality: 'performance' });
  const extraction = operation === 'extract';
  const writeback = operation === 'writeback';
  const map = extraction ? source.map : target?.map;
  const hasMap = map?.positionBuffer instanceof ArrayBuffer;
  const hasRobot = Boolean(sourceProject.robot);
  const [anchor, setAnchor] = useState('center');
  const anchorPose = (value) => value === 'robot' && hasRobot ? sourceProject.robot.origin
    : value === 'center' ? { ...identityTransferPose(), position: {
      x: (source.map.bounds.min.x + source.map.bounds.max.x) / 2,
      y: (source.map.bounds.min.y + source.map.bounds.max.y) / 2,
      z: (source.map.bounds.min.z + source.map.bounds.max.z) / 2,
    } } : identityTransferPose();
  const [pose, setPose] = useState(() => {
    if (initialOperation === 'writeback') return link.localToMap;
    const reference = initialOperation === 'extract' ? sourceProject.robot?.origin : targetProject?.robot?.origin;
    if (reference) return structuredClone(reference);
    const bounds = map?.bounds;
    return { ...identityTransferPose(), position: bounds ? {
      x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: bounds.min.z,
    } : { x: 0, y: 0, z: 0 } };
  });
  const [bounds, setBounds] = useState(() => structuredClone(source.map.bounds));
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [name, setName] = useState(`${source.map.name.replace(/\.ply$/i, '')}-local.ply`);
  const validPose = ['x', 'y', 'z'].every((axis) => Number.isFinite(pose.position[axis]))
    && ['roll', 'pitch', 'yaw'].every((axis) => Number.isFinite(pose.rpy[axis]));
  const validBounds = ['x', 'y', 'z'].every((axis) => Number.isFinite(bounds.min[axis]) && Number.isFinite(bounds.max[axis]) && bounds.min[axis] <= bounds.max[axis])
    && bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y;
  const localToMap = useMemo(() => writeback ? link.localToMap : !validPose ? identityTransferPose()
    : extraction ? pose : placementTransform(pose, anchorPose(anchor)),
  [writeback, link, validPose, extraction, pose, anchor, hasRobot, sourceProject]);
  const stops = sourceProject.teachingTasks.flatMap((task) => task.parkingPoints);
  const selectedStops = extraction && validBounds ? stops.filter((point) => insideTransferBounds(point.mapPose.position, bounds)) : stops;
  const selectedPoseCount = selectedStops.reduce((count, point) => count + point.poses.length, 0);
  const needsReplace = extraction && Boolean(target?.map || targetProject);
  const title = extraction ? '提取局部，进入独立示教' : writeback ? '将精调结果回写原地图' : '将独立组件对齐到地图';
  const presets = (extraction ? sourceProject : targetProject)?.teachingTasks.flatMap((task) => task.parkingPoints.map((point) => ({ ...point, taskName: task.name }))) || [];
  const updatePose = (group, axis, value) => setPose((current) => ({ ...current, [group]: { ...current[group], [axis]: number(value) } }));

  return <form className={`transfer-form${settingsVisible ? '' : ' is-preview-expanded'}`}
    onSubmit={(event) => { event.preventDefault(); onApply({ operation, localToMap, bounds, name }); }}>
    <fieldset disabled={busy} className="transfer-fieldset">
      <div className="transfer-route">
        <div><small>{extraction ? '地图示教 / 来源' : '独立示教 / 来源'}</small><strong>{source.map.name}</strong></div>
        <ArrowRight size={20} />
        <div><small>{extraction ? '独立示教 / 局部工程' : '地图示教 / 目标'}</small><strong>{extraction ? name || '局部工程' : map?.name || '尚未打开地图工程'}</strong></div>
      </div>
      {!hasMap ? <div className="transfer-empty"><FolderOpen size={32} /><h3>先打开目标地图工程</h3>
        <p>当前独立工程已保存。打开地图后，切换回独立示教即可整体放置。</p>
        <button type="button" onClick={onLoadMap}>前往主页面加载地图 <ArrowRight size={16} /></button></div>
        : <div className="transfer-body">
          <div className="transfer-visual">
            <TeachingTransferPreview key={operation} map={map} overlay={!extraction ? source.map : null}
              transform={localToMap} crop={extraction && validBounds ? bounds : null}
              display={previewDisplay} onDisplayChange={setPreviewDisplay}
              pose={validPose ? writeback ? link.localToMap : pose : null}
              settingsVisible={settingsVisible} onToggleSettings={() => setSettingsVisible((visible) => !visible)}
              onPoseChange={!writeback ? setPose : undefined} disabled={busy}
              onPick={!extraction && !writeback ? (point) => setPose((current) => ({ ...current, position: { ...current.position, ...point } })) : undefined}
              onCrop={extraction ? setBounds : undefined} />
          </div>
          <aside className="transfer-settings" id="transfer-settings" hidden={!settingsVisible} aria-label="转换参数">
            <div className="transfer-heading"><div><h3>{title}</h3><p>{extraction
              ? '调整裁剪盒和局部原点；范围内的停车点及其全部姿态会一起复制。'
              : writeback ? '按保存的转换关系回到原位置，更新关联内容。'
                : '点选地图位置，再拖动坐标轴或旋转环对齐组件。'}</p></div>
              {link?.kind === 'extraction' && !extraction && <div className="transfer-operation" role="group" aria-label="转换方式">
                <button type="button" className={writeback ? 'is-selected' : ''} onClick={() => { setOperation('writeback'); setPose(link.localToMap); }}>回写原地图</button>
                <button type="button" className={!writeback ? 'is-selected' : ''} onClick={() => { setOperation('place'); setPose(transformTeachingPose(anchorPose(anchor), transferMatrix(localToMap))); }}>作为新工位放置</button>
              </div>}
            </div>
            {extraction && <section><h4><Scissors size={14} /> 裁剪范围 <small>地图坐标 / m</small></h4>
              <div className="transfer-range-grid"><span>轴</span><span>最小值</span><span>最大值</span>
                {['x', 'y', 'z'].map((axis) => <div className="transfer-range-row" key={axis}><b>{axis.toUpperCase()}</b>
                  {['min', 'max'].map((side) => <input key={side} type="number" step="any" required aria-label={`裁剪 ${axis.toUpperCase()} ${side === 'min' ? '最小值' : '最大值'}`}
                    value={display(bounds[side][axis])} onChange={(event) => setBounds((current) => ({ ...current, [side]: { ...current[side], [axis]: number(event.target.value) } }))} />)}</div>)}
              </div>
              <button className="transfer-text-button" type="button" onClick={() => setBounds(structuredClone(source.map.bounds))}>恢复完整范围</button>
            </section>}
            <section><h4><Crosshair size={14} /> {extraction ? '局部原点在地图中的姿态' : writeback ? '保存的局部坐标关系' : '放置位置与朝向'}</h4>
              {!extraction && !writeback && <label className="transfer-select">定位基准<select aria-label="放置定位基准" value={anchor} onChange={(event) => {
                const value = event.target.value;
                setPose(transformTeachingPose(anchorPose(value), transferMatrix(localToMap)));
                setAnchor(value);
              }}>
                <option value="center">组件中心</option>
                {hasRobot && <option value="robot">机器人基座</option>}<option value="origin">独立空间原点</option></select></label>}
              {!writeback && <label className="transfer-select">快速对齐<select aria-label="对齐到已有位置" value="" onChange={(event) => {
                const value = event.target.value;
                if (value === 'robot') setPose(structuredClone((extraction ? sourceProject : targetProject).robot.origin));
                else if (value === 'center') setPose({ ...identityTransferPose(), position: { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: bounds.min.z } });
                else { const selected = presets.find((point) => point.id === value); if (selected) setPose(structuredClone(selected.mapPose)); }
              }}><option value="">选择参考位置…</option>{(extraction ? sourceProject : targetProject)?.robot && <option value="robot">当前机器人位置</option>}
                {extraction && <option value="center">裁剪区域中心</option>}{presets.map((point) => <option key={point.id} value={point.id}>{point.taskName} / {point.name}</option>)}</select></label>}
              <div className="transfer-pose-grid">{[['position', 'x', 'X', 'm'], ['position', 'y', 'Y', 'm'], ['position', 'z', 'Z', 'm'],
                ['rpy', 'roll', 'Roll', '°'], ['rpy', 'pitch', 'Pitch', '°'], ['rpy', 'yaw', 'Yaw', '°']].map(([group, axis, label, unit]) => <label key={axis}>
                  <span>{label} <small>{unit}</small></span><input type="number" step="any" required readOnly={writeback}
                    aria-label={`${extraction ? '局部原点' : '放置'} ${label}`} value={display((writeback ? link.localToMap : pose)[group][axis])}
                    onChange={(event) => updatePose(group, axis, event.target.value)} /></label>)}</div>
              {extraction && <label className="transfer-name">局部工程名称<input value={name} required aria-label="局部工程名称" onChange={(event) => setName(event.target.value)} /></label>}
            </section>
            <div className="transfer-note"><Check size={15} /><p>{extraction ? '原地图保留。局部工程会记住来源，完成精调后可回写。'
              : writeback ? '仅更新关联的局部内容。原地图若有冲突修改，会保留现场并提示处理。'
                : '独立工程保留。地图中加入一份新的工位副本，已有示教任务继续保留。'}</p></div>
            {needsReplace && <label className="transfer-replace"><input type="checkbox" checked={replaceAccepted} onChange={(event) => setReplaceAccepted(event.target.checked)} />
              用本次提取结果替换已打开的独立工程“{target.map?.name || '未命名工程'}”</label>}
          </aside>
        </div>}
    </fieldset>
    <footer className="transfer-footer">
      <div role={error ? 'alert' : 'status'} className={error ? 'is-error' : ''}>{error || (busy ? '正在转换并保存，请稍候…'
        : extraction && !validBounds ? '请设置有效裁剪范围'
          : !settingsVisible && needsReplace && !replaceAccepted ? '点击“显示参数”确认替换已打开的独立工程'
            : `${selectedStops.length} 停车点 · ${selectedPoseCount} 示教姿态 · 米 / 度`)}</div>
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button className="transfer-submit" type="submit" disabled={busy || !hasMap || !validPose || (extraction && (!validBounds || !name.trim() || (needsReplace && !replaceAccepted)))}>
        {busy ? <LoaderCircle className="transfer-spinner" size={16} /> : <ArrowRight size={16} />}
        {extraction ? '提取并进入独立示教' : writeback ? '回写并进入地图' : '放置并进入地图'}
      </button>
    </footer>
  </form>;
}
