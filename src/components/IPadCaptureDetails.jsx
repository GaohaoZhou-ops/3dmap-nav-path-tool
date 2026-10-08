import { useState } from 'react';
import { mobileDeviceLabel } from '../lib/ipadProtocol.js';
import { mobileSamplePosition } from '../lib/ipadCaptureDisplay.js';
import './IPadTeaching.css';

export default function IPadCaptureDetails({ task }) {
  const [page, setPage] = useState(0);
  const capture = task.mobileCapture, samples = capture.samples;
  const device = mobileDeviceLabel(capture), vision = capture.device.platform === 'visionOS';
  const currentPage = Math.min(page, Math.floor((samples.length - 1) / 100));
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...capture, workspaceCoordinateFrame: task.coordinateFrame, mobileTransform: task.mobileTransform || null }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${vision ? 'visionpro' : 'ipad'}-teaching-${capture.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="ipad-capture" aria-label={`${device} 示教结果`}>
    <span className="eyebrow">{vision ? 'VISION PRO / HEAD REFERENCE' : 'IPAD PRO / LOCAL CAPTURE'}</span><h3>{task.name}</h3>
    <p>{samples.length.toLocaleString()} 个 Pose · {capture.calibrations.length} 段校准</p>
    <p>{vision ? '黄色为头显参考 Pose，青色连线表示记录顺序。保存的是头显相对物体的位置与朝向，采用虚拟光学轴；未包含眼球视线或实际相机外参标定。' : '黄色为逐个记录的 Pose，青色连线表示记录顺序，绿色为 LiDAR 表面参考点。保存的是 iPad 相机相对物体的位置与朝向。'}坐标以米表示，使用 {task.coordinateFrame}。</p>
    <button onClick={download}>导出 {device} 示教 JSON</button>
    <div className="ipad-samples"><table><thead><tr><th>序号</th><th>名称</th><th>X / m</th><th>Y / m</th><th>Z / m</th></tr></thead><tbody>{samples.slice(currentPage * 100, (currentPage + 1) * 100).map((sample, index) => {
      const position = mobileSamplePosition(sample, task);
      return <tr key={sample.id}><td>{currentPage * 100 + index + 1}</td><td>{sample.name || 'Pose'}</td><td>{position.x.toFixed(4)}</td><td>{position.y.toFixed(4)}</td><td>{position.z.toFixed(4)}</td></tr>;
    })}</tbody></table></div>
    <footer><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {Math.ceil(samples.length / 100)}</span><button disabled={(currentPage + 1) * 100 >= samples.length} onClick={() => setPage(currentPage + 1)}>下一页</button></footer>
  </section>;
}
