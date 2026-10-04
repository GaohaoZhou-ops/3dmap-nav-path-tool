import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Download, LoaderCircle, X } from 'lucide-react';
import { buildAbxTeachingArchive, readAbxRobotPackage } from '../lib/abxTeachingExport.js';
import './AbxTeachingExportDialog.css';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AbxTeachingExportDialog({ snapshot, onClose }) {
  const panel = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const controller = new AbortController();
    (async () => {
      try {
        const robotPackage = await readAbxRobotPackage(snapshot.robot, snapshot.robotPackage, { signal: controller.signal });
        const archive = await buildAbxTeachingArchive(snapshot.payload, { robotPackage });
        const navigation = JSON.parse(new TextDecoder().decode(archive.files['free-navigation.json']));
        if (!controller.signal.aborted) setResult({ ...archive, navigation });
      } catch (reason) { if (!controller.signal.aborted) setError(reason.message); }
    })();
    return () => { controller.abort(); previous?.focus?.(); };
  }, [snapshot]);
  const keyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const targets = result ? [
    ...result.navigation.waypoints.map((point) => ({ name: point.name, target: point.target })),
    ...result.navigation.tasks.flatMap((task) => task.sequence.filter((step) => step.type === 'free_navigation')
      .map((step) => ({ name: `${task.name} / Pose ${step.beforePoseSeq}`, target: step.target }))),
  ] : [];
  const stamp = snapshot.payload.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
  return createPortal(<div className="abx-export-modal" onKeyDown={keyDown}>
    <section className="abx-export-dialog" role="dialog" aria-modal="true" aria-labelledby="abx-export-title" ref={panel} tabIndex={-1}>
      <header><Bot size={24} /><div><small>ROBOT TEACHING / FREE NAVIGATION</small><h2 id="abx-export-title">导出机器人示教</h2></div>
        <button type="button" aria-label="关闭机器人示教导出" onClick={onClose}><X size={18} /></button></header>
      <div className="abx-export-body">
        <p className="abx-export-map">当前地图 <strong>{snapshot.payload.map?.fileName || '未命名地图'}</strong><span>MAP · 米 / 弧度</span></p>
        <div className="abx-export-notice" role="note">
          <strong>Pose 可直接导入，自由导航目标单独保留</strong>
          <p>在大脑“示教任务 → 导入”选择此 ZIP 即可导入 Pose。当前大脑尚不支持导入自由导航步骤，导航目标及其与 Pose 的对应关系保存在包内清单中；执行导入任务不会自动移动底盘。</p>
        </div>
        {!result && !error && <p className="abx-export-loading" role="status"><LoaderCircle className="is-spinning" size={16} />正在校验机器人姿态与导航坐标…</p>}
        {error && <p className="abx-export-error" role="alert">{error}</p>}
        {result && <>
          <dl className="abx-export-counts"><div><dt>示教任务</dt><dd>{result.summary.taskCount}</dd></div><div><dt>机器人 Pose</dt><dd>{result.summary.poseCount}</dd></div><div><dt>原导航点</dt><dd>{result.summary.waypointCount}</dd></div><div><dt>Pose 导航目标</dt><dd>{result.summary.navigationCount}</dd></div></dl>
          <p className="abx-export-description">保留任务、停车点和 Pose 顺序，关节转换为弧度。自由导航使用 X / Y / Yaw，不依赖站点或路网连线。</p>
          {targets.length > 0 && <div className="abx-export-targets"><table aria-label="自由导航目标预览"><thead><tr><th>目标</th><th>X / m</th><th>Y / m</th><th>Yaw / rad</th></tr></thead><tbody>{targets.slice(0, 12).map((point, index) => <tr key={index}><td title={point.name}>{point.name}</td>{['x_m', 'y_m', 'yaw_rad'].map((key) => <td key={key}>{point.target[key].toFixed(6)}</td>)}</tr>)}</tbody></table>{targets.length > 12 && <p>其余 {targets.length - 12} 项保存在完整导航清单中。</p>}</div>}
        </>}
      </div>
      <footer><span role="status">{downloaded ? '已下载 · 在大脑示教任务页面导入 ZIP' : '导出本地文件'}</span><div>
        <button type="button" disabled={!result} onClick={() => download(new Blob([result.files['free-navigation.json']], { type: 'application/json' }), `robot-free-navigation-${stamp}.json`)}>下载导航清单</button>
        <button type="button" className="abx-export-primary" disabled={!result} onClick={() => { download(result.blob, `robot-teaching-${stamp}.zip`); setDownloaded(true); }}><Download size={14} />下载机器人导入包</button>
      </div></footer>
    </section>
  </div>, document.body);
}
