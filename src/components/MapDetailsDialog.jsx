import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Axis3D,
  Box,
  Bot,
  Clock3,
  Compass,
  Database,
  Download,
  FileBox,
  Fingerprint,
  HardDrive,
  Ruler,
  X,
} from 'lucide-react';
import { resolveMeshRenderQuality } from '../lib/mapGeometry.js';

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatBytes = (value) => {
  const bytes = Math.max(0, finiteNumber(value));
  if (!bytes) return '未记录';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const amount = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
};

const formatInteger = (value) => Math.max(0, Math.floor(finiteNumber(value))).toLocaleString('zh-CN');

const formatCoordinate = (value) => finiteNumber(value).toLocaleString('zh-CN', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const formatTimestamp = (value) => {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
};

const sourceLabels = {
  'local-file': '本地文件选择器',
  'independent-teaching-file': '独立示教点云',
  'teaching-transfer': '示教坐标转换',
  'example-map': 'maps 示例地图',
  'project-metadata': '路径工程元数据',
  'project-archive': '工程文件',
  'session-cache': '浏览器会话缓存',
  unknown: '未记录来源',
};

const loadMethodLabels = {
  'ply-parse': 'PLY 实时解析',
  'session-cache': '会话几何缓存直载',
  'legacy-ply-cache': '旧版 PLY 缓存解析',
  'project-metadata': '仅恢复工程元数据',
};

export default function MapDetailsDialog({
  mapData,
  teachingSpaceMode = 'map',
  heightRange = [0, 0],
  robot,
  robotLoadState,
  robotPose,
  robotControlEnabled,
  robotHeightLocked,
  meshRenderQuality = 'auto',
  onClose,
  returnFocusRef,
}) {
  const bounds = mapData?.bounds;
  const axes = useMemo(() => ['x', 'y', 'z'].map((axis) => {
    const min = finiteNumber(bounds?.min?.[axis]);
    const max = finiteNumber(bounds?.max?.[axis]);
    return {
      axis,
      min,
      max,
      span: Math.max(0, max - min),
      center: (min + max) / 2,
    };
  }), [bounds]);
  const diagonal = Math.hypot(...axes.map((entry) => entry.span));
  const fileName = mapData?.name || '未命名地图';
  const extension = fileName.includes('.') ? fileName.split('.').at(-1).toUpperCase() : 'PLY';
  const sourceKind = mapData?.sourceKind || (mapData?.metadataOnly ? 'project-metadata' : 'unknown');
  const geometryLabel = mapData?.faceCount > 0 ? '点云 + 三角网格' : '点云';
  const hash = mapData?.sourceHash || null;
  const isIndependentTeachingSpace = teachingSpaceMode === 'independent';
  const coordinateFrame = isIndependentTeachingSpace ? 'VIRTUAL_ORIGIN' : 'MAP';
  const meshQualityPlan = resolveMeshRenderQuality(meshRenderQuality, mapData?.faceCount);
  const sourceBlob = mapData?.sourceBlob;
  const canDownloadOriginal = sourceBlob instanceof Blob && sourceBlob.size > 0;

  const downloadOriginal = () => {
    if (!canDownloadOriginal) return;
    const url = URL.createObjectURL(sourceBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  useEffect(() => {
    const previouslyFocused = returnFocusRef?.current || document.activeElement;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      previouslyFocused?.focus?.();
    };
  }, [onClose, returnFocusRef]);

  if (!mapData || !bounds) return null;

  return createPortal(
    <div
      className="map-details-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-details-title"
      data-map-name={fileName}
      data-map-byte-length={finiteNumber(mapData.byteLength)}
      data-map-point-count={finiteNumber(mapData.pointCount)}
      data-map-face-count={finiteNumber(mapData.faceCount)}
      data-map-modified-at={mapData.fileModifiedAt || ''}
      data-map-source-kind={sourceKind}
      data-teaching-space-mode={teachingSpaceMode}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="map-details-dialog">
        <header className="map-details-dialog__header">
          <span className="map-details-dialog__icon"><FileBox size={21} /></span>
          <div>
            <small>MAP / PROJECT CONFIGURATION</small>
            <h2 id="map-details-title">地图与工程配置</h2>
            <strong title={fileName}>{fileName}</strong>
          </div>
          <div className="map-details-dialog__badges" aria-label="地图类型">
            <span>{extension}</span>
            <span>{geometryLabel}</span>
            {isIndependentTeachingSpace && <span className="is-virtual">独立示教空间</span>}
            {mapData.metadataOnly && <span className="is-warning">仅元数据</span>}
          </div>
          <button
            type="button"
            autoFocus
            aria-label="关闭地图与工程配置"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="map-details-dialog__body">
          <section className="map-details-summary" aria-label="地图摘要">
            <article>
              <span><HardDrive size={13} /> FILE SIZE</span>
              <strong>{formatBytes(mapData.byteLength)}</strong>
              <small>
                {finiteNumber(mapData.byteLength) > 0
                  ? `${finiteNumber(mapData.byteLength).toLocaleString('zh-CN')} bytes`
                  : '源文件字节数不可用'}
              </small>
            </article>
            <article>
              <span><Database size={13} /> VERTICES</span>
              <strong>{formatInteger(mapData.pointCount)}</strong>
              <small>原始顶点 / 点</small>
            </article>
            <article>
              <span><Box size={13} /> FACES</span>
              <strong>{formatInteger(mapData.faceCount)}</strong>
              <small>{mapData.faceCount > 0 ? '三角面索引' : '无网格面'}</small>
            </article>
            <article>
              <span><Ruler size={13} /> DIAGONAL</span>
              <strong>{formatCoordinate(diagonal)} m</strong>
              <small>空间包围盒对角线</small>
            </article>
          </section>

          <section className="map-details-section map-details-project" aria-labelledby="map-details-project-title">
            <header>
              <Compass size={14} />
              <div><small>PROJECT CONFIGURATION</small><strong id="map-details-project-title">工程配置</strong></div>
            </header>
            <dl>
              <div><dt>示教环境</dt><dd>{isIndependentTeachingSpace ? '独立示教空间' : '完整地图'}</dd></div>
              <div>
                <dt>网格质量</dt>
                <dd>{mapData.faceCount ? `${meshQualityPlan.requestedLabel} · ${formatInteger(meshQualityPlan.renderedFaceCount)} 面` : '无网格面'}</dd>
              </div>
              <div className={`is-wide robot-config-row is-${robotLoadState?.status || 'pending'}`}>
                <dt><Bot size={11} />机器人模型</dt>
                <dd title={robot?.relativePath}>
                  {robot
                    ? `${robot.name} · ${robotLoadState?.status === 'loaded' ? '已加载' : robotLoadState?.status === 'error' ? '异常' : robotLoadState?.status === 'pending' ? '等待地图' : '装配中'}`
                    : '尚未加载'}
                </dd>
              </div>
              {robot && (
                <div
                  className="is-wide robot-pose-row"
                  data-robot-x={robotPose?.position?.x ?? 0}
                  data-robot-y={robotPose?.position?.y ?? 0}
                  data-robot-z={robotPose?.position?.z ?? 0}
                  data-robot-yaw={robotPose?.rpy?.yaw ?? 0}
                >
                  <dt>当前位姿</dt>
                  <dd>
                    X {finiteNumber(robotPose?.position?.x).toFixed(2)} / Y {finiteNumber(robotPose?.position?.y).toFixed(2)} / Z {finiteNumber(robotPose?.position?.z).toFixed(2)} · YAW {finiteNumber(robotPose?.rpy?.yaw).toFixed(1)}°
                  </dd>
                </div>
              )}
              {robot && (
                <div className={`is-wide robot-drive-row ${robotControlEnabled ? 'is-active' : ''} ${robotHeightLocked ? 'is-height-locked' : ''}`}>
                  <dt>麦轮控制</dt>
                  <dd>{robotControlEnabled
                    ? robotHeightLocked ? '键盘已接管 · Z 高度已锁' : '键盘已接管 · WASD / 方向键'
                    : robotHeightLocked ? '待机 · Z 高度已锁' : '待机 · 点击 3D“机器人”'}</dd>
                </div>
              )}
              {robotLoadState?.status === 'loaded' && robotLoadState.zividCount > 0 && (
                <div className="is-wide"><dt>末端相机</dt><dd>{robotLoadState.zividCount} × Zivid · {robotLoadState.opticalFrameCount || 0} optical frames</dd></div>
              )}
              <div><dt>坐标系</dt><dd>{coordinateFrame}</dd></div>
              <div><dt>投影平面</dt><dd>XY / Z 轴切片</dd></div>
              <div><dt>截面下限</dt><dd>{finiteNumber(heightRange[0]).toFixed(2)} m</dd></div>
              <div><dt>截面上限</dt><dd>{finiteNumber(heightRange[1]).toFixed(2)} m</dd></div>
              <div className="is-wide"><dt>截面跨度</dt><dd>{Math.max(0, finiteNumber(heightRange[1]) - finiteNumber(heightRange[0])).toFixed(2)} m</dd></div>
            </dl>
          </section>

          <section className="map-details-section map-details-file" aria-labelledby="map-details-file-title">
            <header>
              <Clock3 size={14} />
              <div><small>FILE METADATA</small><strong id="map-details-file-title">文件信息</strong></div>
            </header>
            <dl>
              <div><dt>修改时间</dt><dd>{formatTimestamp(mapData.fileModifiedAt)}</dd></div>
              <div><dt>载入时间</dt><dd>{formatTimestamp(mapData.loadedAt)}</dd></div>
              <div><dt>文件来源</dt><dd>{sourceLabels[sourceKind] || sourceLabels.unknown}</dd></div>
              <div><dt>载入方式</dt><dd>{loadMethodLabels[mapData.geometrySource] || mapData.geometrySource || '未记录'}</dd></div>
              <div><dt>MIME 类型</dt><dd>{mapData.mimeType || 'application/octet-stream'}</dd></div>
              <div className="map-details-file__hash">
                <dt><Fingerprint size={12} /> SHA-256</dt>
                <dd title={hash || '未计算'}>{hash || '未计算'}</dd>
              </div>
            </dl>
          </section>

          <section className="map-details-section map-details-bounds" aria-labelledby="map-details-bounds-title">
            <header>
              <Axis3D size={14} />
              <div><small>{coordinateFrame} FRAME / METERS</small><strong id="map-details-bounds-title">XYZ 空间范围</strong></div>
            </header>
            <div className="map-details-bounds__table" role="table" aria-label="XYZ坐标范围">
              <div className="map-details-bounds__row is-heading" role="row">
                <span role="columnheader">轴</span>
                <span role="columnheader">最小值</span>
                <span role="columnheader">最大值</span>
                <span role="columnheader">跨度</span>
                <span role="columnheader">中心</span>
              </div>
              {axes.map((entry) => (
                <div
                  className="map-details-bounds__row"
                  key={entry.axis}
                  role="row"
                  data-axis={entry.axis}
                  data-min={entry.min}
                  data-max={entry.max}
                  data-span={entry.span}
                  data-center={entry.center}
                >
                  <span role="cell"><i className={`axis ${entry.axis}`}>{entry.axis.toUpperCase()}</i></span>
                  <strong role="cell">{formatCoordinate(entry.min)} <small>m</small></strong>
                  <strong role="cell">{formatCoordinate(entry.max)} <small>m</small></strong>
                  <strong role="cell">{formatCoordinate(entry.span)} <small>m</small></strong>
                  <strong role="cell">{formatCoordinate(entry.center)} <small>m</small></strong>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer>
          <span><Axis3D size={12} /> {coordinateFrame} FRAME · ORIGIN (0, 0, 0) · Z-UP</span>
          <span>{canDownloadOriginal ? 'READ ONLY / SOURCE MANIFEST' : '此工程未保留原始文件'}</span>
          <div className="map-details-dialog__actions">
            <button
              type="button"
              disabled={!canDownloadOriginal}
              title={canDownloadOriginal ? `下载 ${fileName}` : '此工程未保留原始文件，无法下载'}
              onClick={downloadOriginal}
            >
              <Download size={13} />
              下载原始文件
            </button>
            <button type="button" onClick={onClose}>关闭</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
