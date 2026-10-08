import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RefreshCw, Tablet, Wifi, X } from 'lucide-react';
import { ipadRequest, packIPadModel, readIPadTickets, rememberIPadTicket } from '../lib/ipadTeaching.js';
import IPadPairingQRCode from './IPadPairingQRCode.jsx';
import './IPadTeaching.css';

const statusText = { preparing: '准备模型', ready: '等待设备配对', paired: '已配对 · 在设备本机示教', completed: '示教完成 · 可以接收', imported: '已保存到当前工程', cancelled: '任务已结束' };

export default function IPadTeachingDialog({ mapData, onClose, onImport }) {
  const [tickets, setTickets] = useState(readIPadTickets);
  const [ticket, setTicket] = useState(() => readIPadTickets().find((item) => item.manifest.sourceMapId === mapData.mapId) || null);
  const [addresses, setAddresses] = useState([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const legacyCode = ticket?.status === 'ready' && !/^[A-Z0-9]{4}$/.test(ticket.pairingCode || '');
  const dialog = useRef(null), operation = useRef(false);
  const update = (next) => { rememberIPadTicket(next); setTicket(next); setTickets(readIPadTickets()); setCopied(false); };
  useEffect(() => {
    const focus = document.activeElement; dialog.current?.focus();
    const controller = new AbortController();
    ipadRequest('/info', { signal: controller.signal }).then((info) => { setAddresses(info.addresses); setAddress(info.addresses[0] || ''); }).catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => { controller.abort(); focus?.focus?.(); };
  }, []);
  useEffect(() => {
    if (ticket?.status !== 'ready') return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (operation.current || checking) return;
      checking = true;
      try {
        const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken, signal: controller.signal });
        if (!controller.signal.aborted && !operation.current && next.status !== ticket.status) update({ ...ticket, ...next });
      } catch { /* The manual status check remains available after a network interruption. */ }
      finally { checking = false; }
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ticket]);
  const perform = async (message, run) => {
    if (operation.current) return;
    operation.current = true; setBusy(message); setError('');
    try { await run(); } catch (e) { setError(e.message); }
    finally { operation.current = false; setBusy(''); }
  };
  const create = () => perform('正在准备物体…', async () => {
    const { buffer, manifest } = await packIPadModel(mapData);
    const next = await ipadRequest('/sessions', { method: 'POST', body: { manifest } });
    update(next); setBusy('通过局域网服务准备模型…');
    const ready = await ipadRequest(`/sessions/${next.id}/model`, { token: next.ownerToken, method: 'PUT', body: buffer });
    update({ ...next, ...ready });
  });
  const refresh = () => perform('检查完成状态…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const receive = () => perform('保存设备示教结果…', async () => {
    const result = await ipadRequest(`/sessions/${ticket.id}/result`, { token: ticket.ownerToken });
    await onImport(result, ticket);
    const next = await ipadRequest(`/sessions/${ticket.id}/imported`, { method: 'POST', token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const renew = () => perform('更新配对码…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}/renew`, { token: ticket.ownerToken, method: 'POST' });
    update({ ...ticket, ...next });
  });
  const keyDown = (event) => {
    if (event.key === 'Escape' && !operation.current) { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input')];
    if (!elements.length) return;
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="ipad-modal" onKeyDown={keyDown}>
    <section className="ipad-dialog" role="dialog" aria-modal="true" aria-labelledby="ipad-title" ref={dialog} tabIndex={-1}>
      <header><span className="ipad-mark"><Tablet size={25} /></span><div><small>ATLAS / ON DEVICE</small><h2 id="ipad-title">移动到 iPad 或 Vision Pro 上运行</h2></div><button aria-label="关闭设备示教窗口" disabled={!!busy} onClick={onClose}><X size={18} /></button></header>
      <div className="ipad-dialog__body">
        {!ticket && <><p className="ipad-intro">携带物体，走到现场。<span>iPad Pro（LiDAR）· iPadOS 17+ / Vision Pro · visionOS 2+</span></p>
        <ol className="ipad-steps"><li><b>01</b><strong>局域网接收物体</strong><span>电脑与采集设备连接同一网络</span></li><li><b>02</b><strong>AR 空间中逐个示教</strong><span>移动设备，逐个记录 Pose</span></li><li><b>03</b><strong>完成后同步</strong><span>回到网络内，一次性回传结果</span></li></ol></>}
        <div className="ipad-model"><span>独立示教物体</span><strong>{mapData.name}</strong><small>原始坐标 · 米 · Z 轴向上</small></div>
        {ticket?.status === 'ready' && !legacyCode && <IPadPairingQRCode
          key={`${ticket.id}:${ticket.pairingCode}:${ticket.pairingExpiresAt}:${address}`}
          ticket={ticket} address={address} disabled={!!busy} copied={copied}
          onCopy={() => perform('复制配对码…', async () => { await navigator.clipboard.writeText(ticket.pairingCode); setCopied(true); })} />}
        <div className="ipad-connection"><Wifi size={17}/><div><label htmlFor="ipad-lan-address">电脑局域网地址 · 用于扫码或手动连接</label>{addresses.length ? <select id="ipad-lan-address" value={address} disabled={!!busy} onChange={(event) => setAddress(event.target.value)}>{addresses.map((item) => <option key={item}>{item}</option>)}</select> : <p>尚未发现局域网地址，请连接 Wi-Fi 或以太网后重新打开。</p>}</div></div>
        {!ticket && <p className="ipad-note">iPad 使用「Atlas 示教」，Vision Pro 使用「Atlas 空间示教」。接收物体后放入现场并逐个记录 Pose。下载后可以断网示教；点击「完成并同步」才会上传。</p>}
        {tickets.length > 0 && <label className="ipad-history">传输任务<select disabled={!!busy} value={ticket?.id || ''} onChange={(e) => { setTicket(tickets.find((item) => item.id === e.target.value)); setError(''); }}><option value="" disabled>选择任务</option>{tickets.map((item) => <option key={item.id} value={item.id}>{item.manifest.name} · {new Date(item.createdAt).toLocaleString()} · {statusText[item.status]}</option>)}</select></label>}
        {ticket && (ticket.status !== 'ready' || legacyCode) && <div className={`ipad-pairing is-${ticket.status}`} data-ipad-status={ticket.status}>
          <div><span>{statusText[ticket.status]}</span>{ticket.status === 'ready' && <p>此任务使用旧版配对码，请点击「更新配对码」生成 4 位码。</p>}
            {ticket.status === 'paired' && <p>{ticket.deviceName} 已配对，物体下载完成后可在本机离线示教。</p>}
            {['completed', 'imported'].includes(ticket.status) && <p>{ticket.sampleCount} 个 Pose · {ticket.status === 'imported' ? '已经加入示教数据，可在三维场景查看 Pose。' : '接收后保存为独立的设备示教任务。'}</p>}
            <small>{ticket.manifest.vertices.toLocaleString()} 个顶点{ticket.manifest.indices > 0 ? ` · ${(ticket.manifest.indices / 3).toLocaleString()} 个三角面` : ''} · {(ticket.manifest.byteLength / 1048576).toFixed(1)} MiB{ticket.manifest.sampled ? ' · 旧版抽样点云；新建传输可携带完整网格' : ' · 设备可在本机调节点云密度与 Mesh 质量'}</small>
          </div>
        </div>}
        {error && <p role="alert" className="ipad-error">{error}</p>}
      </div>
      <footer><span role="status">{busy || '本地运算 · 无需云服务'}</span><div>
        {ticket && <button disabled={!!busy} onClick={refresh}><RefreshCw size={14}/>检查完成状态</button>}
        {ticket?.status === 'ready' && <button disabled={!!busy} onClick={renew}>更新配对码</button>}
        {['completed', 'imported'].includes(ticket?.status) ? <button className="ipad-primary" disabled={!!busy} onClick={receive}><ArrowDownToLine size={15}/>{ticket.status === 'imported' ? '再次接收（去重）' : '接收示教结果'}</button> : null}
        <button className="ipad-primary" disabled={!!busy} onClick={create}><Tablet size={15}/>{ticket ? '新建传输' : '准备物体与配对码'}</button>
      </div></footer>
    </section>
  </div>;
}
