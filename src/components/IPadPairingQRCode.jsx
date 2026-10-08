import { useEffect, useState } from 'react';
import { Check, Copy, QrCode, RefreshCw } from 'lucide-react';
import { ipadRequest } from '../lib/ipadTeaching.js';

// The parent keys this component by task, address and code so stale QR images
// disappear immediately when any pairing detail changes.
export default function IPadPairingQRCode({ ticket, address, disabled, copied, onCopy }) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expired, setExpired] = useState(() => Date.now() >= ticket.pairingExpiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, ticket.pairingExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [ticket.pairingExpiresAt]);
  useEffect(() => {
    if (expired || !address) return;
    const controller = new AbortController();
    setImage(''); setError('');
    ipadRequest(`/sessions/${ticket.id}/pairing-qr`, { method: 'POST', token: ticket.ownerToken,
      body: { address, code: ticket.pairingCode }, signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setImage(result.image); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [ticket.id, ticket.ownerToken, ticket.pairingCode, address, retry, expired]);
  return <div className="ipad-qr" data-ipad-status="ready">
    <div className="ipad-qr__image" aria-busy={!image && !error && !expired && !!address}>
      {image && !expired && !disabled ? <img src={image} alt="iPad 扫码配对二维码" width="248" height="248" />
        : <QrCode size={64} strokeWidth={1} aria-hidden="true" />}
    </div>
    <div className="ipad-qr__instructions">
      <span className="ipad-qr__eyebrow">SCAN TO CONNECT</span>
      <h3>打开 iPad App，扫码配对</h3>
      <p>在「Atlas 示教」欢迎页点击「扫码配对」，对准左侧二维码，即可连接电脑并接收当前物体。</p>
      <small>Vision Pro 请搜索电脑或输入下方地址与 4 位码。两台设备需在同一局域网。</small>
      <div className="ipad-qr__manual"><div><small>也可手动输入 4 位配对码</small><strong className="ipad-code">{ticket.pairingCode}</strong></div>
        <button aria-label="复制 iPad 配对码" disabled={disabled || expired} onClick={onCopy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      </div>
      <small>有效期至 {new Date(ticket.pairingExpiresAt).toLocaleTimeString()} · 仅限一台采集设备</small>
      <div role="status">{expired ? '二维码已过期，请点击下方「更新配对码」。'
        : !address ? '连接局域网后即可生成二维码。' : disabled ? '正在更新配对信息…' : !image && !error ? '正在生成二维码…' : ''}</div>
      {error && <><p className="ipad-error" role="alert">{error}</p><button disabled={disabled} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新生成二维码</button></>}
    </div>
  </div>;
}
