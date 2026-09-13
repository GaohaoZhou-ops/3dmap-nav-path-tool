import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import {
  Camera,
  Cloud,
  Focus,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import CameraTeachingControls from './CameraTeachingControls.jsx';

export const ZIVID_M70_PROFILE = Object.freeze({
  model: 'Zivid 2 M70',
  nativeWidth: 1944,
  nativeHeight: 1200,
  near: 0.3,
  focus: 0.7,
  far: 1.3,
  horizontalFov: 56.6,
  verticalFov: 35.6,
  focusWidthMm: 754,
  focusHeightMm: 449,
});

const CAMERA_POINT_BUDGET = 360_000;
const MAX_DIGITAL_ZOOM = 24;
const ROS_OPTICAL_TO_THREE_CAMERA = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI,
);

const isM70Robot = (robot, loadState) => {
  if (loadState?.status !== 'loaded' || Number(loadState?.zividCount) < 1) return false;
  const identity = [
    robot?.id,
    robot?.name,
    robot?.fileName,
    robot?.relativePath,
    loadState?.name,
  ].filter(Boolean).join(' ');
  return /(?:zivid[\s_-]*)?(?:2[\s_-]*)?m70/i.test(identity);
};

const compactNumber = (value) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value || 0);
};

const createCameraGeometry = (sourceGeometry) => {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  if (!sourcePosition?.count) return null;
  const pointCount = sourcePosition.count;
  const renderCount = Math.min(pointCount, CAMERA_POINT_BUDGET);
  const sourceColor = sourceGeometry.getAttribute('color');
  const hasRgb = sourceColor?.count === pointCount;
  const positions = new Float32Array(renderCount * 3);
  const colors = hasRgb ? new Uint8Array(renderCount * 3) : null;
  const encodeColor = (value) => {
    const numeric = Number(value) || 0;
    return Math.round(THREE.MathUtils.clamp(numeric > 1 ? numeric : numeric * 255, 0, 255));
  };

  for (let index = 0; index < renderCount; index += 1) {
    const sourceIndex = renderCount === pointCount
      ? index
      : Math.min(
          pointCount - 1,
          Math.floor(((index + 0.5) * pointCount) / renderCount),
        );
    const targetOffset = index * 3;
    positions[targetOffset] = sourcePosition.getX(sourceIndex);
    positions[targetOffset + 1] = sourcePosition.getY(sourceIndex);
    positions[targetOffset + 2] = sourcePosition.getZ(sourceIndex);
    if (colors) {
      colors[targetOffset] = encodeColor(sourceColor.getX(sourceIndex));
      colors[targetOffset + 1] = encodeColor(sourceColor.getY(sourceIndex));
      colors[targetOffset + 2] = encodeColor(sourceColor.getZ(sourceIndex));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geometry.boundingBox = sourceGeometry.boundingBox?.clone() || null;
  geometry.boundingSphere = sourceGeometry.boundingSphere?.clone() || null;
  geometry.userData.bufferStrategy = 'dedicated-downsample';
  return {
    geometry,
    pointCount,
    renderCount,
    hasRgb,
    bufferByteLength: positions.byteLength + (colors?.byteLength || 0),
  };
};

const createDepthMaterial = () => new THREE.ShaderMaterial({
  uniforms: {
    uPointSize: { value: 2 },
    uNear: { value: ZIVID_M70_PROFILE.near },
    uFar: { value: ZIVID_M70_PROFILE.far },
  },
  vertexShader: `
    uniform float uPointSize;
    varying float vDepth;
    void main() {
      vec4 cameraPosition = modelViewMatrix * vec4(position, 1.0);
      vDepth = -cameraPosition.z;
      gl_Position = projectionMatrix * cameraPosition;
      gl_PointSize = uPointSize;
    }
  `,
  fragmentShader: `
    uniform float uNear;
    uniform float uFar;
    varying float vDepth;

    vec3 depthPalette(float t) {
      vec3 nearCoral = vec3(1.0, 0.31, 0.23);
      vec3 amber = vec3(1.0, 0.78, 0.24);
      vec3 cyan = vec3(0.16, 0.87, 0.90);
      vec3 farBlue = vec3(0.20, 0.39, 1.0);
      if (t < 0.34) return mix(nearCoral, amber, smoothstep(0.0, 0.34, t));
      if (t < 0.68) return mix(amber, cyan, smoothstep(0.34, 0.68, t));
      return mix(cyan, farBlue, smoothstep(0.68, 1.0, t));
    }

    void main() {
      if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
      float normalizedDepth = clamp((vDepth - uNear) / max(uFar - uNear, 0.0001), 0.0, 1.0);
      gl_FragColor = vec4(depthPalette(normalizedDepth), 1.0);
    }
  `,
  depthTest: true,
  depthWrite: true,
  transparent: false,
  toneMapped: false,
});

const estimateVisiblePoints = (geometry, pose) => {
  const attribute = geometry?.getAttribute('position');
  if (!attribute?.count || !pose?.position || !pose?.quaternion) {
    return { checked: 0, estimated: 0 };
  }
  const sampleTarget = 18_000;
  const stride = Math.max(1, Math.ceil(attribute.count / sampleTarget));
  const qx = -Number(pose.quaternion.x || 0);
  const qy = -Number(pose.quaternion.y || 0);
  const qz = -Number(pose.quaternion.z || 0);
  const qw = Number(pose.quaternion.w ?? 1);
  const px = Number(pose.position.x || 0);
  const py = Number(pose.position.y || 0);
  const pz = Number(pose.position.z || 0);
  const tangentX = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.horizontalFov / 2));
  const tangentY = Math.tan(THREE.MathUtils.degToRad(ZIVID_M70_PROFILE.verticalFov / 2));
  let checked = 0;
  let visible = 0;

  for (let index = 0; index < attribute.count; index += stride) {
    const vx = attribute.getX(index) - px;
    const vy = attribute.getY(index) - py;
    const vz = attribute.getZ(index) - pz;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    const localX = vx + qw * tx + (qy * tz - qz * ty);
    const localY = vy + qw * ty + (qz * tx - qx * tz);
    const localZ = vz + qw * tz + (qx * ty - qy * tx);
    checked += 1;
    if (
      localZ >= ZIVID_M70_PROFILE.near
      && localZ <= ZIVID_M70_PROFILE.far
      && Math.abs(localX) <= localZ * tangentX
      && Math.abs(localY) <= localZ * tangentY
    ) {
      visible += 1;
    }
  }
  return {
    checked,
    estimated: Math.min(attribute.count, Math.round((visible / Math.max(checked, 1)) * attribute.count)),
  };
};

const poseLabel = (pose) => {
  if (!pose?.position) return '等待 optical frame';
  const { x, y, z } = pose.position;
  return `X ${x.toFixed(2)} · Y ${y.toFixed(2)} · Z ${z.toFixed(2)}`;
};

export default function ZividCameraPanel({
  mapData,
  robot,
  robotLoadState,
  cameraPoses = {},
  activeSide: controlledActiveSide,
  onActiveSideChange,
  teachingMode = 'pose',
  cameraTeachingEnabled = false,
  cameraTeachingResult,
  onCameraTeachingMove,
}) {
  const enabled = isM70Robot(robot, robotLoadState);
  const [internalActiveSide, setInternalActiveSide] = useState('left');
  const activeSide = ['left', 'right'].includes(controlledActiveSide)
    ? controlledActiveSide
    : internalActiveSide;
  const [renderMode, setRenderMode] = useState('rgb');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rendererStatus, setRendererStatus] = useState('waiting');
  const mountRef = useRef(null);
  const poseRef = useRef(null);
  const renderModeRef = useRef(renderMode);
  const viewRef = useRef({ zoom, pan });
  const dragRef = useRef(null);
  const activePose = cameraPoses?.[activeSide] || null;
  const hasRgb = Boolean(mapData?.geometry?.getAttribute('color'));
  const frustumStats = useMemo(
    () => estimateVisiblePoints(mapData?.geometry, activePose),
    [activePose, mapData?.geometry],
  );

  poseRef.current = activePose;
  renderModeRef.current = renderMode;
  viewRef.current = { zoom, pan };

  useEffect(() => {
    if (!enabled && expanded) setExpanded(false);
  }, [enabled, expanded]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [activeSide]);

  useEffect(() => {
    if (zoom <= 1.0001 && (pan.x !== 0 || pan.y !== 0)) setPan({ x: 0, y: 0 });
  }, [pan.x, pan.y, zoom]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  useEffect(() => {
    const mount = mountRef.current;
    const sourceGeometry = mapData?.geometry;
    if (!enabled || !mount || !sourceGeometry) return undefined;

    const cameraGeometry = createCameraGeometry(sourceGeometry);
    if (!cameraGeometry) return undefined;
    const {
      geometry,
      pointCount,
      renderCount,
      bufferByteLength,
    } = cameraGeometry;
    setRendererStatus('waiting');
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.warn('Zivid 相机仿真视图初始化失败', error);
      setRendererStatus('error');
      geometry.dispose();
      return undefined;
    }

    renderer.setClearColor(0x02080b, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'zivid-camera-canvas';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'Zivid 2 M70 仿真相机画面');
    renderer.domElement.dataset.cameraReady = 'true';
    renderer.domElement.dataset.sourcePointCount = String(pointCount);
    renderer.domElement.dataset.renderPointCount = String(renderCount);
    renderer.domElement.dataset.downsampled = renderCount < pointCount ? 'true' : 'false';
    renderer.domElement.dataset.gpuBufferStrategy = geometry.userData.bufferStrategy;
    renderer.domElement.dataset.cameraBufferBytes = String(bufferByteLength);
    renderer.domElement.dataset.sourceBufferReused = 'false';
    mount.replaceChildren(renderer.domElement);

    let contextAvailable = true;
    let announcedReady = false;
    let lastRenderSignature = '';
    const handleContextLost = (event) => {
      event.preventDefault();
      contextAvailable = false;
      renderer.domElement.dataset.contextState = 'lost';
      setRendererStatus('context-lost');
    };
    const handleContextRestored = () => {
      contextAvailable = true;
      announcedReady = false;
      lastRenderSignature = '';
      renderer.domElement.dataset.contextState = 'restored';
      setRendererStatus('ready');
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02080b);
    const camera = new THREE.PerspectiveCamera(
      ZIVID_M70_PROFILE.verticalFov,
      1,
      ZIVID_M70_PROFILE.near,
      ZIVID_M70_PROFILE.far,
    );
    camera.matrixAutoUpdate = true;
    const rgbMaterial = new THREE.PointsMaterial({
      color: cameraGeometry.hasRgb ? 0xffffff : 0xb8c6c7,
      size: expanded ? 1.55 : 1.25,
      sizeAttenuation: false,
      vertexColors: cameraGeometry.hasRgb,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    const depthMaterial = createDepthMaterial();
    const points = new THREE.Points(geometry, rgbMaterial);
    points.frustumCulled = false;
    scene.add(points);

    let width = 1;
    let height = 1;
    const resize = () => {
      width = Math.max(1, mount.clientWidth);
      height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      depthMaterial.uniforms.uPointSize.value = (expanded ? 2.3 : 1.85)
        * Math.min(window.devicePixelRatio || 1, 1.75);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frameId = 0;
    const render = () => {
      const pose = poseRef.current;
      const currentView = viewRef.current;
      const renderSignature = [
        width,
        height,
        renderModeRef.current,
        Number(currentView.zoom) || 1,
        Number(currentView.pan.x) || 0,
        Number(currentView.pan.y) || 0,
        pose?.position?.x || 0,
        pose?.position?.y || 0,
        pose?.position?.z || 0,
        pose?.quaternion?.x || 0,
        pose?.quaternion?.y || 0,
        pose?.quaternion?.z || 0,
        pose?.quaternion?.w ?? 1,
      ].join('|');
      if (renderSignature === lastRenderSignature) {
        frameId = requestAnimationFrame(render);
        return;
      }
      lastRenderSignature = renderSignature;
      if (pose?.position && pose?.quaternion) {
        camera.position.set(pose.position.x, pose.position.y, pose.position.z);
        camera.quaternion
          .set(
            pose.quaternion.x,
            pose.quaternion.y,
            pose.quaternion.z,
            pose.quaternion.w,
          )
          .normalize()
          .multiply(ROS_OPTICAL_TO_THREE_CAMERA);
      }

      const currentZoom = THREE.MathUtils.clamp(
        Number(currentView.zoom) || 1,
        1,
        MAX_DIGITAL_ZOOM,
      );
      camera.clearViewOffset();
      camera.aspect = width / height;
      if (currentZoom > 1.0001) {
        const fullWidth = Math.max(width, Math.round(width * currentZoom));
        const fullHeight = Math.max(height, Math.round(height * currentZoom));
        const maxOffsetX = fullWidth - width;
        const maxOffsetY = fullHeight - height;
        const offsetX = Math.round(
          maxOffsetX * (0.5 + THREE.MathUtils.clamp(currentView.pan.x, -1, 1) * 0.5),
        );
        const offsetY = Math.round(
          maxOffsetY * (0.5 + THREE.MathUtils.clamp(currentView.pan.y, -1, 1) * 0.5),
        );
        camera.setViewOffset(fullWidth, fullHeight, offsetX, offsetY, width, height);
      } else {
        camera.updateProjectionMatrix();
      }

      points.material = renderModeRef.current === 'pointcloud' ? depthMaterial : rgbMaterial;
      renderer.domElement.dataset.renderMode = renderModeRef.current;
      renderer.domElement.dataset.cameraSide = activeSide;
      renderer.domElement.dataset.opticalFrame = pose?.frameName || '';
      renderer.domElement.dataset.digitalZoom = currentZoom.toFixed(2);
      renderer.domElement.dataset.panX = Number(currentView.pan.x || 0).toFixed(4);
      renderer.domElement.dataset.panY = Number(currentView.pan.y || 0).toFixed(4);
      if (contextAvailable) {
        try {
          renderer.render(scene, camera);
          if (!announcedReady) {
            announcedReady = true;
            renderer.domElement.dataset.contextState = 'ready';
            setRendererStatus('ready');
          }
        } catch (error) {
          console.warn('Zivid 相机仿真视图渲染失败', error);
          contextAvailable = false;
          renderer.domElement.dataset.contextState = 'error';
          setRendererStatus('error');
        }
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost, false);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored, false);
      points.material = null;
      geometry.dispose();
      rgbMaterial.dispose();
      depthMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [activeSide, enabled, expanded, mapData?.geometry]);

  if (!enabled) return null;

  const changeZoom = (nextValue) => {
    setZoom((current) => THREE.MathUtils.clamp(
      typeof nextValue === 'function' ? nextValue(current) : nextValue,
      1,
      MAX_DIGITAL_ZOOM,
    ));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const panel = (
    <section
      className={`zivid-camera-panel ${expanded ? 'is-expanded' : ''} ${teachingMode === 'camera' ? 'has-teaching-controls' : ''}`}
      aria-label="Zivid 2 M70 相机视图"
      data-zivid-model="zivid-2-m70"
      data-camera-side={activeSide}
      data-render-mode={renderMode}
      data-renderer-status={rendererStatus}
      data-horizontal-fov={ZIVID_M70_PROFILE.horizontalFov}
      data-vertical-fov={ZIVID_M70_PROFILE.verticalFov}
      data-working-near={ZIVID_M70_PROFILE.near}
      data-working-far={ZIVID_M70_PROFILE.far}
      data-native-resolution={`${ZIVID_M70_PROFILE.nativeWidth}x${ZIVID_M70_PROFILE.nativeHeight}`}
      data-optical-frame={activePose?.frameName || ''}
      data-visible-point-estimate={frustumStats.estimated}
      data-zoom={zoom.toFixed(2)}
      data-camera-teaching-mode={teachingMode === 'camera' ? 'active' : 'hidden'}
    >
      <header className="zivid-camera-panel__header">
        <div className="zivid-camera-panel__identity">
          <span><Camera size={13} /></span>
          <div>
            <small>END-EFFECTOR VISION · SIM</small>
            <strong>Zivid 2 M70</strong>
          </div>
        </div>
        <div className="zivid-camera-panel__live"><i /> OPTICAL LINK</div>
        <button
          type="button"
          className="zivid-camera-expand"
          aria-label={expanded ? '关闭 Zivid 相机大图' : '放大 Zivid 相机视图'}
          title={expanded ? '关闭大图' : '放大查看'}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <X size={14} /> : <Maximize2 size={13} />}
        </button>
      </header>

      <div className="zivid-camera-toolbar">
        <div className="zivid-camera-sides" role="group" aria-label="选择末端相机">
          {['left', 'right'].map((side) => (
            <button
              type="button"
              key={side}
              className={activeSide === side ? 'is-active' : ''}
              aria-pressed={activeSide === side}
              onClick={() => {
                setInternalActiveSide(side);
                onActiveSideChange?.(side);
                resetView();
              }}
            >
              {side === 'left' ? '左臂 M70' : '右臂 M70'}
            </button>
          ))}
        </div>
        <div className="zivid-camera-modes" role="group" aria-label="相机渲染模式">
          <button
            type="button"
            className={renderMode === 'rgb' ? 'is-active' : ''}
            aria-pressed={renderMode === 'rgb'}
            onClick={() => setRenderMode('rgb')}
          >
            <Camera size={11} /> RGB
          </button>
          <button
            type="button"
            className={renderMode === 'pointcloud' ? 'is-active' : ''}
            aria-pressed={renderMode === 'pointcloud'}
            onClick={() => setRenderMode('pointcloud')}
          >
            <Cloud size={11} /> 点云
          </button>
        </div>
      </div>

      <div
        className={`zivid-camera-viewport ${dragging ? 'is-dragging' : ''}`}
        aria-label="M70 相机画面交互区"
        onWheel={(event) => {
          event.preventDefault();
          changeZoom((current) => current * Math.exp(-event.deltaY * 0.0018));
        }}
        onDoubleClick={resetView}
        onPointerDown={(event) => {
          if (event.target.closest('button')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            pan,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || zoom <= 1) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setPan({
            x: THREE.MathUtils.clamp(
              drag.pan.x - ((event.clientX - drag.x) * 2) / Math.max(bounds.width, 1),
              -1,
              1,
            ),
            y: THREE.MathUtils.clamp(
              drag.pan.y - ((event.clientY - drag.y) * 2) / Math.max(bounds.height, 1),
              -1,
              1,
            ),
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div ref={mountRef} className="zivid-camera-render-mount" />
        <div className="zivid-camera-scan-grid" aria-hidden="true" />
        <div className="zivid-camera-reticle" aria-hidden="true"><span /><i /></div>
        <div className="zivid-camera-corner top-left" aria-hidden="true" />
        <div className="zivid-camera-corner top-right" aria-hidden="true" />
        <div className="zivid-camera-corner bottom-left" aria-hidden="true" />
        <div className="zivid-camera-corner bottom-right" aria-hidden="true" />
        <div className="zivid-camera-frame-meta top">
          <span>{renderMode === 'rgb' ? 'RGB MAP PROJECTION' : 'XYZ DEPTH CLOUD'}</span>
          <strong>{activeSide === 'left' ? 'CAM-L' : 'CAM-R'}</strong>
        </div>
        <div className="zivid-camera-frame-meta bottom">
          <span>{poseLabel(activePose)}</span>
          <strong>{zoom.toFixed(1)}×</strong>
        </div>
        {!activePose && (
          <div className="zivid-camera-empty"><Focus size={17} /> 正在同步光学坐标系</div>
        )}
        {rendererStatus === 'error' && (
          <div className="zivid-camera-empty"><Focus size={15} /> 相机渲染器不可用 · 主界面仍可操作</div>
        )}
        {rendererStatus === 'context-lost' && (
          <div className="zivid-camera-empty"><Focus size={15} /> 相机显存正在恢复 · 主界面仍可操作</div>
        )}
        {activePose && frustumStats.checked > 0 && frustumStats.estimated === 0 && (
          <div className="zivid-camera-empty is-quiet"><Focus size={15} /> 当前视锥内暂无地图回波</div>
        )}
        {renderMode === 'rgb' && !hasRgb && (
          <div className="zivid-camera-rgb-warning">地图无 RGB 通道 · 灰度显示</div>
        )}
        {renderMode === 'pointcloud' && (
          <div className="zivid-depth-legend" aria-label="点云深度色标">
            <span>0.30 m</span><i /><span>1.30 m</span>
          </div>
        )}
        <div className="zivid-camera-zoom-controls" role="group" aria-label="相机画面缩放">
          <button
            type="button"
            aria-label="缩小相机画面"
            title="缩小"
            disabled={zoom <= 1}
            onClick={() => changeZoom((current) => current / 1.55)}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            aria-label="重置相机缩放"
            title="重置缩放和拖拽偏移"
            disabled={zoom <= 1 && pan.x === 0 && pan.y === 0}
            onClick={resetView}
          >
            <RotateCcw size={12} />
          </button>
          <button
            type="button"
            aria-label="放大相机画面"
            title="放大"
            disabled={zoom >= MAX_DIGITAL_ZOOM}
            onClick={() => changeZoom((current) => current * 1.55)}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {teachingMode === 'camera' && (
        <CameraTeachingControls
          enabled={cameraTeachingEnabled}
          activeSide={activeSide}
          cameraPoses={cameraPoses}
          result={cameraTeachingResult}
          onMove={onCameraTeachingMove}
        />
      )}

      <div className="zivid-camera-specs">
        <span><small>NATIVE</small>{ZIVID_M70_PROFILE.nativeWidth} × {ZIVID_M70_PROFILE.nativeHeight}</span>
        <span><small>FOV @ 0.70 m</small>{ZIVID_M70_PROFILE.focusWidthMm} × {ZIVID_M70_PROFILE.focusHeightMm} mm</span>
        <span><small>WORKING DIST.</small>{ZIVID_M70_PROFILE.near.toFixed(2)}—{ZIVID_M70_PROFILE.far.toFixed(2)} m</span>
      </div>
      <footer className="zivid-camera-panel__footer">
        <span><i /> 仿真视图 · 地图点云投影</span>
        <span>FOV {ZIVID_M70_PROFILE.horizontalFov.toFixed(1)}° × {ZIVID_M70_PROFILE.verticalFov.toFixed(1)}°</span>
        <strong>≈ {compactNumber(frustumStats.estimated)} PTS</strong>
      </footer>
    </section>
  );

  if (!expanded) return panel;
  return createPortal(
    <div
      className="zivid-camera-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Zivid 2 M70 相机大图"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setExpanded(false);
      }}
    >
      {panel}
    </div>,
    document.body,
  );
}
