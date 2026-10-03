import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Box, BoxSelect, Crosshair, Maximize2, MousePointer2, Move3D, Palette, PanelRightClose, PanelRightOpen, Rotate3D, Scaling } from 'lucide-react';
import { identityTransferPose, transferMatrix, transformTeachingPose } from '../lib/teachingTransfer.js';
import { MESH_RENDER_QUALITY_OPTIONS } from '../lib/mapGeometry.js';
import { createTransferPreviewLayer, disposeTransferPreview, TRANSFER_COLOR_MODES, transferBoundsBox } from '../lib/teachingTransferPreview.js';

const DIRECTIONS = { perspective: [1.2, -1.7, 1.2], top: [0, 0, 1], front: [0, -1, 0], side: [1, 0, 0] };
const objectPose = (object) => transformTeachingPose(identityTransferPose(), new THREE.Matrix4().compose(
  object.position, object.quaternion, new THREE.Vector3(1, 1, 1),
));

export default function TeachingTransferPreview({ map, overlay, transform, crop, pose, onPoseChange, onPick, onCrop, display, onDisplayChange, disabled = false, settingsVisible = true, onToggleSettings }) {
  const viewportRef = useRef(null), canvasRef = useRef(null), contextRef = useRef(null);
  const latestRef = useRef(null);
  const extraction = Boolean(onCrop), editable = Boolean(onPoseChange);
  const [tool, setTool] = useState(extraction ? 'crop-move' : editable ? 'pick' : 'view');
  const [view, setView] = useState('perspective');
  const [mapVisible, setMapVisible] = useState(true), [overlayVisible, setOverlayVisible] = useState(true);
  const [error, setError] = useState('');
  const hasMesh = [map, overlay].some((layer) => layer?.indexBuffer?.byteLength >= (layer?.indexComponentType === 'uint16' ? 6 : 12));
  const colorMode = display.colorMode, meshQuality = hasMesh ? display.meshQuality : 'off';
  latestRef.current = { transform, crop, pose, onPoseChange, onPick, onCrop, disabled, tool, mapVisible, overlayVisible, colorMode, meshQuality };

  useEffect(() => {
    const canvas = canvasRef.current, viewport = viewportRef.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (error) {
      console.warn('示教转换三维预览初始化失败', error);
      setError('三维预览暂不可用，请关闭后重试；仍可使用右侧数值调整。');
      return undefined;
    }
    setError('');
    renderer.setClearColor(0x050d11);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
    camera.up.set(0, 0, 1);
    // Gizmo handles receive pointerdown before TrackballControls so a handle
    // drag never also moves the camera.
    const gizmo = new TransformControls(camera, canvas);
    gizmo.setSize(0.86);
    const controls = new TrackballControls(camera, canvas);
    controls.keys = [];
    controls.staticMoving = true;
    controls.rotateSpeed = 3;
    controls.panSpeed = 0.8;
    controls.zoomSpeed = 1.1;
    const helper = gizmo.getHelper();
    scene.add(helper);
    const mapLayer = createTransferPreviewLayer(map, { color: 0x789b9f, highlight: true });
    mapLayer.name = 'transfer-map';
    scene.add(mapLayer);
    const component = new THREE.Group();
    component.name = 'transfer-independent-component';
    scene.add(component);
    const overlayLayer = overlay ? createTransferPreviewLayer(overlay, { color: 0xbda1ff, pointBudget: 100000 }) : null;
    if (overlayLayer) component.add(overlayLayer);
    const poseHandle = new THREE.Object3D();
    scene.add(poseHandle);
    const cropHandle = new THREE.Object3D();
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    cropHandle.add(new THREE.Mesh(boxGeometry, new THREE.MeshBasicMaterial({
      color: 0x59dbe8, transparent: true, opacity: 0.055, side: THREE.DoubleSide, depthWrite: false,
    })));
    cropHandle.add(new THREE.LineSegments(new THREE.EdgesGeometry(boxGeometry), new THREE.LineBasicMaterial({ color: 0x59dbe8, transparent: true, opacity: 0.9 })));
    scene.add(cropHandle);
    const componentOutline = new THREE.Box3Helper(new THREE.Box3(), 0xbda1ff);
    scene.add(componentOutline);
    const originAxes = new THREE.AxesHelper(1);
    scene.add(originAxes);
    const mapBox = transferBoundsBox(map.bounds);
    const mapSize = mapBox.getSize(new THREE.Vector3());
    const gridSize = Math.max(2, 10 ** Math.ceil(Math.log10(Math.max(mapSize.x, mapSize.y, 1))));
    const grid = new THREE.GridHelper(gridSize, 20, 0x24444c, 0x10272e);
    grid.rotation.x = Math.PI / 2;
    grid.position.copy(mapBox.getCenter(new THREE.Vector3()));
    grid.position.z = mapBox.min.z - Math.max(0.005, mapSize.z * 0.003);
    scene.add(grid);
    scene.add(new THREE.HemisphereLight(0xe6f5ff, 0x263039, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.3);
    light.position.set(3, -4, 8);
    scene.add(light);
    let frame = 0, disposed = false, hasRendered = false;
    const render = () => {
      frame = 0;
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      hasRendered = true;
      canvas.dataset.renderState = 'ready';
    };
    const invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(render); };
    const applyObjectPose = (object, value) => {
      if (!value) return;
      transferMatrix(value).decompose(object.position, object.quaternion, object.scale);
      object.updateMatrixWorld(true);
    };
    const componentBounds = () => overlay
      ? transferBoundsBox(overlay.bounds).applyMatrix4(transferMatrix(latestRef.current.transform))
      : latestRef.current.crop ? transferBoundsBox(latestRef.current.crop) : mapBox.clone();
    const fit = (focus = false, direction = null) => {
      const box = focus ? componentBounds() : mapBox.clone().union(componentBounds());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.3);
      const angle = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
      const distance = radius / Math.sin(angle) * 1.12;
      const offset = direction ? new THREE.Vector3(...DIRECTIONS[direction]) : camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 0.01) offset.set(...DIRECTIONS.perspective);
      if (direction) camera.up.set(0, direction === 'top' ? 1 : 0, direction === 'top' ? 0 : 1);
      camera.position.copy(center).addScaledVector(offset.normalize(), distance);
      controls.target.copy(center);
      camera.near = Math.max(radius / 2000, 0.001);
      camera.far = Math.max(mapSize.length() * 10, distance * 50, 100);
      controls.minDistance = Math.max(radius / 500, 0.01);
      controls.maxDistance = Math.max(mapSize.length() * 30, distance * 30, 100);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      controls.update();
      invalidate();
    };
    const sync = () => {
      const current = latestRef.current;
      mapLayer.visible = current.mapVisible;
      component.visible = current.overlayVisible;
      applyObjectPose(component, current.transform);
      if (!gizmo.dragging) {
        applyObjectPose(poseHandle, current.pose || current.transform);
        if (current.crop) {
          const bounds = transferBoundsBox(current.crop);
          cropHandle.position.copy(bounds.getCenter(new THREE.Vector3()));
          cropHandle.scale.copy(bounds.getSize(new THREE.Vector3())).max(new THREE.Vector3(0.001, 0.001, 0.001));
          cropHandle.updateMatrixWorld(true);
        }
      }
      cropHandle.visible = Boolean(current.crop);
      mapLayer.userData.setSelection(current.crop);
      componentOutline.box.copy(componentBounds());
      const displayOptions = { colorMode: current.colorMode, meshQuality: current.meshQuality,
        heightBounds: mapBox.clone().union(componentOutline.box) };
      mapLayer.userData.setDisplay(displayOptions);
      overlayLayer?.userData.setDisplay(displayOptions);
      componentOutline.visible = Boolean(overlay && current.overlayVisible);
      originAxes.visible = Boolean(current.pose);
      originAxes.position.copy(poseHandle.position);
      originAxes.quaternion.copy(poseHandle.quaternion);
      originAxes.scale.setScalar(THREE.MathUtils.clamp(componentBounds().getSize(new THREE.Vector3()).length() * 0.07, 0.15, 0.8));
      const isCrop = current.tool.startsWith('crop-');
      const attached = isCrop ? cropHandle : poseHandle;
      if (!current.disabled && (isCrop ? current.crop : current.onPoseChange && current.pose)
        && !['pick', 'box-select', 'view'].includes(current.tool)) {
        if (gizmo.object !== attached) gizmo.attach(attached);
        gizmo.setMode(current.tool === 'crop-resize' ? 'scale' : current.tool.endsWith('rotate') ? 'rotate' : 'translate');
        gizmo.setSpace('world');
        gizmo.enabled = true;
      } else { gizmo.detach(); gizmo.enabled = false; }
      controls.enabled = !current.disabled && !gizmo.dragging;
      canvas.dataset.gizmoMode = gizmo.object ? gizmo.mode : 'none';
      canvas.dataset.previewKind = current.onCrop ? 'crop' : current.onPoseChange ? 'placement' : 'writeback';
      canvas.dataset.colorMode = current.colorMode;
      canvas.dataset.meshQuality = current.meshQuality;
      canvas.dataset.mapPreviewFaces = String(mapLayer.userData.previewFaces);
      canvas.dataset.componentPreviewFaces = String(overlayLayer?.userData.previewFaces || 0);
      invalidate();
    };
    const changed = () => {
      const current = latestRef.current;
      if (gizmo.object === cropHandle) {
        cropHandle.scale.set(Math.max(0.001, cropHandle.scale.x), Math.max(0.001, cropHandle.scale.y), Math.max(0.001, cropHandle.scale.z));
        const half = cropHandle.scale.clone().multiplyScalar(0.5), min = cropHandle.position.clone().sub(half), max = cropHandle.position.clone().add(half);
        current.onCrop?.({ min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } });
      } else current.onPoseChange?.(objectPose(poseHandle));
      invalidate();
    };
    const dragging = (event) => { controls.enabled = !event.value && !latestRef.current.disabled; invalidate(); };
    const hovered = (event) => { canvas.dataset.gizmoAxis = event.value || ''; };
    gizmo.addEventListener('objectChange', changed);
    gizmo.addEventListener('dragging-changed', dragging);
    gizmo.addEventListener('axis-changed', hovered);
    gizmo.addEventListener('change', invalidate);
    controls.addEventListener('change', invalidate);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const rayAt = (event) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(ndc, camera);
    };
    const pick = (event) => {
      rayAt(event);
      const distance = camera.position.distanceTo(controls.target);
      raycaster.params.Points.threshold = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 10 / canvas.clientHeight;
      const hit = latestRef.current.mapVisible ? raycaster.intersectObjects(mapLayer.children.filter((object) => object.visible), false)[0] : null;
      if (hit) return hit.point;
      // Empty-space clicks keep the current height; mesh/point hits use real Z.
      const height = latestRef.current.pose?.position.z ?? map.bounds.min.z;
      return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -height), new THREE.Vector3());
    };
    let pointer = null;
    const pointerDown = (event) => {
      if (event.button !== 0 || latestRef.current.disabled) return;
      canvas.focus();
      pointer = { x: event.clientX, y: event.clientY, moved: false, box: latestRef.current.tool === 'box-select' && !event.shiftKey };
      gizmo.enabled = Boolean(gizmo.object) && !event.shiftKey;
      controls.mouseButtons.LEFT = event.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      if (pointer.box) {
        rayAt(event);
        pointer.start = latestRef.current.crop && raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -latestRef.current.crop.min.z), new THREE.Vector3());
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const pointerMove = (event) => {
      if (pointer) {
        pointer.moved ||= Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4;
        if (pointer.box && pointer.start && pointer.moved) {
          rayAt(event);
          const bounds = latestRef.current.crop;
          const end = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -bounds.min.z), new THREE.Vector3());
          if (end) latestRef.current.onCrop?.({ min: { x: Math.min(pointer.start.x, end.x), y: Math.min(pointer.start.y, end.y), z: bounds.min.z },
            max: { x: Math.max(pointer.start.x, end.x), y: Math.max(pointer.start.y, end.y), z: bounds.max.z } });
        }
      }
      invalidate();
    };
    const pointerUp = (event) => {
      if (pointer && !pointer.moved && latestRef.current.tool === 'pick') {
        const position = pick(event);
        if (position) { latestRef.current.onPick?.({ x: position.x, y: position.y, z: position.z }); setTool('translate'); }
      }
      pointer = null;
      gizmo.pointerUp({ button: 0 });
      controls.enabled = !latestRef.current.disabled;
      gizmo.enabled = Boolean(gizmo.object) && !latestRef.current.disabled;
      invalidate();
    };
    const cancelPointer = () => { pointer = null; gizmo.pointerUp({ button: 0 }); controls.enabled = !latestRef.current.disabled; invalidate(); };
    const lostContext = (event) => { event.preventDefault(); setError('三维预览已中断，请关闭转换窗口后重新打开。'); };
    canvas.addEventListener('pointerdown', pointerDown, true);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', cancelPointer);
    canvas.addEventListener('wheel', invalidate, { passive: true });
    canvas.addEventListener('webglcontextlost', lostContext);
    const resize = () => {
      const { width, height } = viewport.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.max(2, width), Math.max(2, height), false);
      camera.aspect = width / Math.max(2, height);
      camera.updateProjectionMatrix();
      controls.handleResize();
      // Resizing clears the drawing buffer. Redraw before paint when expanding
      // the viewport, so the scene stays visible between layout and the next RAF.
      if (hasRendered) renderer.render(scene, camera);
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    contextRef.current = { sync, fit };
    resize();
    sync();
    fit(false, 'perspective');
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', cancelPointer);
      canvas.removeEventListener('wheel', invalidate);
      canvas.removeEventListener('webglcontextlost', lostContext);
      gizmo.removeEventListener('change', invalidate);
      controls.removeEventListener('change', invalidate);
      gizmo.dispose();
      controls.dispose();
      scene.remove(helper);
      disposeTransferPreview(scene);
      renderer.dispose();
      // React may immediately reuse this canvas while replaying effects.
      // Lose only contexts whose canvas has actually left the document.
      window.setTimeout(() => { if (!canvas.isConnected) renderer.forceContextLoss(); }, 0);
      scene.clear();
      contextRef.current = null;
    };
  }, [map, overlay]);

  useEffect(() => { contextRef.current?.sync(); }, [transform, crop, pose, tool, disabled, mapVisible, overlayVisible, editable, colorMode, meshQuality]);
  const changeView = (direction) => { setView(direction); contextRef.current?.fit(false, direction); };
  const chooseTool = (value) => {
    setTool(value);
    if (value === 'box-select') changeView('top');
  };
  const tools = extraction ? [
    ['crop-move', Move3D, '移动裁剪盒'], ['crop-resize', Scaling, '调整范围'], ['box-select', BoxSelect, '俯视框选'],
    ['origin-translate', Crosshair, '移动原点'], ['origin-rotate', Rotate3D, '旋转原点'],
  ] : editable ? [['pick', MousePointer2, '点选位置'], ['translate', Move3D, '移动组件'], ['rotate', Rotate3D, '旋转组件']] : [];
  const hint = tool === 'pick' ? '单击地图定位 · 拖动空白处旋转视角'
    : tool === 'box-select' ? '拖动框选 XY 范围 · 高度在右侧调整'
      : tool === 'view' ? '保留来源坐标关系 · 拖动查看精调区域'
        : tool.endsWith('rotate') ? '拖动彩色旋转环调整朝向 · 拖动空白处旋转视角'
          : tool === 'crop-resize' ? '拖动轴端方块调整裁剪盒大小'
            : '拖动彩色坐标轴调整位置 · 拖动空白处旋转视角';

  return <div className="transfer-preview" data-preview-dimension="3d">
    <div className="transfer-preview__toolbar">
      {tools.length > 0 && <div className="transfer-preview__editing" role="group" aria-label="三维编辑工具">
        {tools.map(([value, Icon, label]) => <button key={value} type="button" aria-pressed={tool === value} onClick={() => chooseTool(value)}><Icon size={14} />{label}</button>)}
      </div>}
      <div className="transfer-preview__tools">
        <div className="transfer-view-buttons">
          {[['perspective', '3D'], ['top', '俯视'], ['front', '正视'], ['side', '侧视']].map(([direction, label]) => <button key={direction} type="button"
            aria-label={`转换预览${label}视角`} aria-pressed={view === direction} onClick={() => changeView(direction)}>{label}</button>)}
          <button type="button" title={extraction ? '聚焦裁剪区域' : '聚焦独立组件'} aria-label="聚焦转换组件" onClick={() => contextRef.current?.fit(true)}><Crosshair size={15} /></button>
          <button type="button" title="适配全部" aria-label="适配地图范围" onClick={() => contextRef.current?.fit()}><Maximize2 size={15} /></button>
          {onToggleSettings && <button type="button" className="transfer-preview__expand" aria-controls="transfer-settings" aria-expanded={settingsVisible}
            aria-label={settingsVisible ? '展开3D视口' : '显示转换参数'} title={settingsVisible ? '收起参数，扩大3D操作区域' : '显示参数（Esc）'} onClick={onToggleSettings}>
            {settingsVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}{settingsVisible ? '大视口' : '显示参数'}
          </button>}
        </div>
      </div>
    </div>
    <div className="transfer-preview__viewport" ref={viewportRef}>
      <canvas ref={canvasRef} tabIndex={0} aria-label="地图转换三维预览" />
      <div className="transfer-preview__orientation">Z ↑ <span>地图坐标</span></div>
      <div className="transfer-preview__hint">{hint}</div>
      {error && <div className="transfer-preview__error" role="alert">{error}</div>}
    </div>
    <div className="transfer-preview__legend">
      <label><input type="checkbox" checked={mapVisible} onChange={(event) => setMapVisible(event.target.checked)} /> <i /> 地图</label>
      {overlay && <label className="is-local"><input type="checkbox" checked={overlayVisible} onChange={(event) => setOverlayVisible(event.target.checked)} /> <i /> 独立组件</label>}
      {extraction && <span className="is-local"><i /> 选中区域</span>}
      <div className="transfer-preview__display" role="group" aria-label="转换预览显示设置">
        <label title="地图与独立组件同步切换颜色；没有原始颜色的图层使用分层色">
          <Palette size={13} /><span>颜色</span>
          <select aria-label="转换预览颜色" value={colorMode} onChange={(event) => onDisplayChange({ ...display, colorMode: event.target.value })}>
            {TRANSFER_COLOR_MODES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label title={hasMesh ? '关闭 Mesh 可查看点云；质量档位与主视图一致' : '当前数据没有三角面，以点云显示'}>
          <Box size={13} /><span>Mesh</span>
          <select aria-label="转换预览 Mesh" value={meshQuality} disabled={!hasMesh} onChange={(event) => onDisplayChange({ ...display, meshQuality: event.target.value })}>
            <option value="off">关闭 · 点云</option>
            {MESH_RENDER_QUALITY_OPTIONS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
      </div>
      <small>右键 / Shift 平移 · 滚轮缩放</small>
    </div>
  </div>;
}
