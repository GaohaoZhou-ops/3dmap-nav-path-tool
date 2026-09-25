import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  Bot,
  Box,
  Crosshair,
  LoaderCircle,
  MousePointer2,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import {
  applyRobotJointValues,
  disposeRobotModel,
  getRobotEndEffector,
  loadRobotModel,
  normalizeRobotDescriptor,
  normalizeRobotPose,
} from '../lib/robotLoader.js';

const EMPTY_JOINT_VALUES = Object.freeze({});

const formatPoseValue = (value, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '--';
};

const normalizeDegrees = (value) => {
  const wrapped = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped) < 1e-10 ? 0 : wrapped;
};

const objectRelativeEndEffectorPose = (robot, side, robotPose) => {
  const endEffector = getRobotEndEffector(robot, side);
  if (!endEffector?.frame) return null;
  robot.updateMatrixWorld(true);

  // Remove the isolated preview transform first, then place the recorded
  // kinematic chain in the object's virtual_origin coordinate system.
  const toolInRobot = robot.matrixWorld.clone().invert()
    .multiply(endEffector.frame.matrixWorld.clone());
  const baseQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(robotPose.rpy.roll),
    THREE.MathUtils.degToRad(robotPose.rpy.pitch),
    THREE.MathUtils.degToRad(robotPose.rpy.yaw),
    'XYZ',
  ));
  const toolInObject = new THREE.Matrix4()
    .compose(
      new THREE.Vector3(
        robotPose.position.x,
        robotPose.position.y,
        robotPose.position.z,
      ),
      baseQuaternion,
      new THREE.Vector3(1, 1, 1),
    )
    .multiply(toolInRobot);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  toolInObject.decompose(position, quaternion, new THREE.Vector3());
  const euler = new THREE.Euler().setFromQuaternion(quaternion.normalize(), 'ZYX');
  return {
    side,
    frameId: 'virtual_origin',
    frameName: endEffector.frame.name || `tool_${side}`,
    source: 'recorded-joints-forward-kinematics',
    position: { x: position.x, y: position.y, z: position.z },
    rpy: {
      roll: normalizeDegrees(THREE.MathUtils.radToDeg(euler.x)),
      pitch: normalizeDegrees(THREE.MathUtils.radToDeg(euler.y)),
      yaw: normalizeDegrees(THREE.MathUtils.radToDeg(euler.z)),
    },
  };
};

const disposeHelper = (object) => {
  object?.geometry?.dispose?.();
  if (Array.isArray(object?.material)) {
    object.material.forEach((material) => material?.dispose?.());
  } else {
    object?.material?.dispose?.();
  }
};

export default function TeachingPoseRobotPreview({
  task,
  parkingPoint,
  pose,
  robot,
  teachingSpaceMode = 'map',
}) {
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneContextRef = useRef(null);
  const robotRef = useRef(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [loadState, setLoadState] = useState({ status: 'idle', detail: '' });
  const [relativeArmPoseSnapshot, setRelativeArmPoseSnapshot] = useState({
    poseId: '',
    poses: {},
  });

  const descriptor = useMemo(() => normalizeRobotDescriptor(robot), [robot]);
  const descriptorKey = descriptor?.id || descriptor?.relativePath || '';
  const recordedPose = useMemo(() => normalizeRobotPose(pose?.mapPose), [pose?.mapPose]);
  const jointValues = pose?.fullBodyJoints?.values || EMPTY_JOINT_VALUES;
  const jointCount = Object.keys(jointValues).length;
  const isIndependentTeachingSpace = teachingSpaceMode === 'independent'
    || task?.coordinateFrame === 'virtual_origin';
  const relativeArmPoses = relativeArmPoseSnapshot.poseId === pose?.id
    ? relativeArmPoseSnapshot.poses
    : {};
  const relativeArmPoseCount = Object.keys(relativeArmPoses).length;
  const relativeArmPoseState = !pose
    ? 'empty'
    : loadState.status === 'loading'
      ? 'calculating'
      : loadState.status === 'error'
        ? 'unavailable'
        : relativeArmPoseCount === 2 ? 'ready' : 'unavailable';

  const fitRobot = useCallback(() => {
    const context = sceneContextRef.current;
    const loadedRobot = robotRef.current;
    if (!context || !loadedRobot) return;
    loadedRobot.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(loadedRobot);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.35);
    const maximumDimension = Math.max(size.x, size.y, size.z, 0.5);
    const direction = new THREE.Vector3(1.35, -1.8, 1.05).normalize();

    context.camera.near = Math.max(radius / 120, 0.002);
    context.camera.far = Math.max(radius * 90, 120);
    context.camera.position.copy(center).addScaledVector(direction, radius * 2.65);
    context.controls.target.copy(center);
    context.controls.minDistance = Math.max(radius * 0.22, 0.05);
    context.controls.maxDistance = Math.max(radius * 16, 20);
    context.controls.update();
    context.camera.updateProjectionMatrix();

    const gridSize = Math.max(2, Math.ceil(maximumDimension * 2.8));
    context.grid.scale.setScalar(gridSize / 10);
    context.axes.scale.setScalar(Math.max(maximumDimension * 0.22, 0.25));
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      setLoadState({
        status: 'error',
        detail: error?.message || '浏览器无法创建机器人 3D 预览上下文',
      });
      return undefined;
    }
    renderer.setClearColor(0x050d11, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050d11, 0.032);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.002, 180);
    camera.up.set(0, 0, 1);
    camera.position.set(2.2, -3.2, 2.1);

    const controls = new TrackballControls(camera, canvas);
    controls.rotateSpeed = 3.1;
    controls.zoomSpeed = 1.1;
    controls.panSpeed = 0.72;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.16;
    controls.keys = [];

    const robotRoot = new THREE.Group();
    robotRoot.name = 'teaching-pose-robot-only-layer';
    scene.add(robotRoot);

    const grid = new THREE.GridHelper(10, 20, 0x285d62, 0x15363a);
    grid.name = 'teaching-pose-reference-grid';
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.52;
    grid.material.depthWrite = false;
    scene.add(grid);

    const axes = new THREE.AxesHelper(1);
    axes.name = 'teaching-pose-ros-origin';
    axes.position.z = 0.004;
    axes.renderOrder = 4;
    scene.add(axes);

    scene.add(new THREE.HemisphereLight(0xd8f7ff, 0x172024, 2.25));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(4, -5, 8);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x67dbea, 1.2);
    fillLight.position.set(-5, 2, 3);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xa78bfa, 0.9);
    rimLight.position.set(1, 5, 5);
    scene.add(rimLight);

    const resize = () => {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(2, Math.round(rect.width));
      const height = Math.max(2, Math.round(rect.height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      controls.handleResize?.();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();

    let animationFrame = 0;
    const render = () => {
      animationFrame = window.requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    sceneContextRef.current = {
      scene,
      camera,
      controls,
      renderer,
      robotRoot,
      grid,
      axes,
    };

    const preventContextMenu = (event) => event.preventDefault();
    canvas.addEventListener('contextmenu', preventContextMenu);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.dispose();
      canvas.removeEventListener('contextmenu', preventContextMenu);
      if (robotRef.current) disposeRobotModel(robotRef.current);
      robotRef.current = null;
      disposeHelper(grid);
      disposeHelper(axes);
      renderer.dispose();
      scene.clear();
      sceneContextRef.current = null;
    };
  }, []);

  useEffect(() => {
    const context = sceneContextRef.current;
    if (!context) return undefined;
    [...context.robotRoot.children].forEach((child) => disposeRobotModel(child));
    robotRef.current = null;
    setModelRevision((current) => current + 1);

    if (!descriptor) {
      setLoadState({
        status: descriptorKey ? 'error' : 'idle',
        detail: descriptorKey ? '机器人描述文件不可用' : '',
      });
      return undefined;
    }

    const controller = new AbortController();
    let loadedRobot = null;
    setLoadState({ status: 'loading', detail: '正在装配机器人模型' });
    loadRobotModel(descriptor, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!controller.signal.aborted) {
          setLoadState({ status: 'loading', detail: progress.phase || '正在装配机器人模型' });
        }
      },
    })
      .then((model) => {
        if (controller.signal.aborted || sceneContextRef.current !== context) {
          disposeRobotModel(model);
          return;
        }
        loadedRobot = model;
        robotRef.current = model;
        context.robotRoot.add(model);
        setLoadState({ status: 'ready', detail: '机器人模型已就绪' });
        setModelRevision((current) => current + 1);
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        setLoadState({ status: 'error', detail: error.message || '机器人模型加载失败' });
      });

    return () => {
      controller.abort();
      if (loadedRobot) disposeRobotModel(loadedRobot);
      if (robotRef.current === loadedRobot) robotRef.current = null;
    };
  }, [descriptorKey]);

  useEffect(() => {
    const loadedRobot = robotRef.current;
    const canvas = canvasRef.current;
    if (!loadedRobot || !canvas) return;
    loadedRobot.visible = Boolean(pose);
    if (!pose) {
      canvas.dataset.appliedJointValues = '{}';
      canvas.dataset.appliedJointCount = '0';
      setRelativeArmPoseSnapshot((current) => (
        current.poseId || Object.keys(current.poses).length
          ? { poseId: '', poses: {} }
          : current
      ));
      return;
    }

    loadedRobot.position.set(0, 0, 0);
    loadedRobot.rotation.set(
      THREE.MathUtils.degToRad(recordedPose.rpy.roll),
      THREE.MathUtils.degToRad(recordedPose.rpy.pitch),
      THREE.MathUtils.degToRad(recordedPose.rpy.yaw),
      'XYZ',
    );
    const appliedValues = applyRobotJointValues(loadedRobot, jointValues);
    loadedRobot.updateMatrixWorld(true);
    canvas.dataset.appliedJointValues = JSON.stringify(appliedValues);
    canvas.dataset.appliedJointCount = String(Object.keys(appliedValues).length);
    canvas.dataset.poseId = pose.id || '';
    canvas.dataset.mapX = String(recordedPose.position.x);
    canvas.dataset.mapY = String(recordedPose.position.y);
    canvas.dataset.mapZ = String(recordedPose.position.z);
    canvas.dataset.mapRoll = String(recordedPose.rpy.roll);
    canvas.dataset.mapPitch = String(recordedPose.rpy.pitch);
    canvas.dataset.mapYaw = String(recordedPose.rpy.yaw);
    if (isIndependentTeachingSpace) {
      const poses = Object.fromEntries(
        ['left', 'right'].flatMap((side) => {
          const relativePose = objectRelativeEndEffectorPose(
            loadedRobot,
            side,
            recordedPose,
          );
          return relativePose ? [[side, relativePose]] : [];
        }),
      );
      setRelativeArmPoseSnapshot({ poseId: pose.id || '', poses });
      canvas.dataset.relativeArmPoseFrame = 'virtual_origin';
      canvas.dataset.relativeArmPoseSource = 'recorded-joints-forward-kinematics';
      canvas.dataset.relativeArmPoseCount = String(Object.keys(poses).length);
    } else {
      setRelativeArmPoseSnapshot((current) => (
        current.poseId || Object.keys(current.poses).length
          ? { poseId: '', poses: {} }
          : current
      ));
      delete canvas.dataset.relativeArmPoseFrame;
      delete canvas.dataset.relativeArmPoseSource;
      canvas.dataset.relativeArmPoseCount = '0';
    }
    window.requestAnimationFrame(fitRobot);
  }, [
    fitRobot,
    isIndependentTeachingSpace,
    jointValues,
    modelRevision,
    pose,
    recordedPose,
  ]);

  const ready = loadState.status === 'ready';
  const hasPose = Boolean(pose);

  return (
    <section
      className={`teaching-pose-robot-preview is-${loadState.status} ${hasPose ? 'has-pose' : 'is-empty'} ${isIndependentTeachingSpace && hasPose ? 'shows-object-relative-poses' : ''}`}
      aria-label="机器人示教姿态三维预览"
      data-preview-state={loadState.status}
      data-pose-id={pose?.id || ''}
      data-robot-id={descriptorKey}
      data-scene-content="robot-only"
      data-environment-point-cloud="false"
      data-environment-mesh="false"
      data-relative-arm-pose-state={isIndependentTeachingSpace
        ? relativeArmPoseState
        : 'disabled'}
      data-relative-arm-pose-count={isIndependentTeachingSpace ? relativeArmPoseCount : 0}
      data-relative-arm-pose-frame={isIndependentTeachingSpace ? 'virtual_origin' : ''}
    >
      <header className="teaching-pose-robot-preview__header">
        <div>
          <span><Bot size={15} /></span>
          <div>
            <small>ROBOT POSE / ISOLATED VIEW</small>
            <strong>机器人 3D 姿态</strong>
          </div>
        </div>
        <span className={`teaching-pose-robot-preview__state is-${loadState.status}`}>
          {loadState.status === 'loading' && <LoaderCircle className="is-spinning" size={10} />}
          {loadState.status === 'error' && <TriangleAlert size={10} />}
          {ready ? 'MODEL READY' : loadState.status === 'loading' ? 'LOADING' : loadState.status === 'error' ? 'MODEL ERROR' : 'WAITING'}
        </span>
        <button
          type="button"
          aria-label="重置机器人姿态预览视角"
          title="重新将所选机器人姿态完整置于画面中央"
          disabled={!ready || !hasPose}
          onClick={fitRobot}
        >
          <RotateCcw size={11} /> 重置视角
        </button>
      </header>

      <div className="teaching-pose-robot-preview__viewport" ref={viewportRef}>
        <canvas
          ref={canvasRef}
          className="teaching-pose-robot-canvas"
          aria-label="所选示教姿态机器人三维模型"
          tabIndex={0}
        />
        {!hasPose && (
          <div className="teaching-pose-robot-preview__empty">
            <span><Bot size={34} strokeWidth={1.2} /></span>
            <strong>选择一组机械臂姿态</strong>
            <small>点击左侧树中的姿态节点后，将在这里还原机器人全身关节。</small>
          </div>
        )}
        {hasPose && loadState.status === 'loading' && (
          <div className="teaching-pose-robot-preview__loading" role="status">
            <LoaderCircle className="is-spinning" size={20} />
            <strong>正在还原机器人</strong>
            <small>{loadState.detail}</small>
          </div>
        )}
        {hasPose && loadState.status === 'error' && (
          <div className="teaching-pose-robot-preview__loading is-error" role="alert">
            <TriangleAlert size={20} />
            <strong>姿态预览不可用</strong>
            <small>{loadState.detail}</small>
          </div>
        )}
        {hasPose && ready && (
          <>
            <div className="teaching-pose-robot-preview__identity">
              <small>{task?.name || '示教任务'}</small>
              <strong>{parkingPoint?.name || '停车点'} / {pose.name}</strong>
              <span>{jointCount} JOINT VALUES</span>
            </div>
            <div className="teaching-pose-robot-preview__axis" aria-label="ROS 坐标轴图例">
              <span className="is-x">X</span><span className="is-y">Y</span><span className="is-z">Z</span>
            </div>
            <div className="teaching-pose-robot-preview__hint">
              <MousePointer2 size={10} /> 左键旋转 · 右键平移 · 滚轮缩放
            </div>
          </>
        )}
      </div>

      {isIndependentTeachingSpace && hasPose && (
        <section
          className={`teaching-object-arm-poses is-${relativeArmPoseState}`}
          aria-label="物体坐标系下双臂相对姿态"
          data-relative-pose-state={relativeArmPoseState}
          data-coordinate-frame="virtual_origin"
          data-calculation-source="recorded-joints-forward-kinematics"
        >
          <header>
            <span><Crosshair size={12} /></span>
            <div>
              <strong>物体坐标系相对姿态</strong>
              <small>VIRTUAL_ORIGIN · XYZ m / RPY °</small>
            </div>
            <em>{relativeArmPoseState === 'ready'
              ? 'FK READY'
              : relativeArmPoseState === 'calculating' ? 'CALCULATING' : 'NO TOOL FRAME'}</em>
          </header>
          <div className="teaching-object-arm-poses__grid">
            {['left', 'right'].map((side) => {
              const armPose = relativeArmPoses[side];
              const sideLabel = side === 'left' ? '左臂末端' : '右臂末端';
              return (
                <article
                  key={side}
                  className={`teaching-object-arm-pose is-${side}`}
                  aria-label={`${sideLabel}物体坐标系相对姿态`}
                  data-arm-side={side}
                  data-frame-id={armPose?.frameId || 'virtual_origin'}
                  data-frame-name={armPose?.frameName || `tool_${side}`}
                  data-position-x={armPose?.position.x ?? ''}
                  data-position-y={armPose?.position.y ?? ''}
                  data-position-z={armPose?.position.z ?? ''}
                  data-roll={armPose?.rpy.roll ?? ''}
                  data-pitch={armPose?.rpy.pitch ?? ''}
                  data-yaw={armPose?.rpy.yaw ?? ''}
                >
                  <header>
                    <span>{side === 'left' ? 'L' : 'R'}</span>
                    <div><strong>{sideLabel}</strong><small>{armPose?.frameName || `tool_${side}`}</small></div>
                  </header>
                  <dl>
                    {[
                      ['X', armPose?.position.x, 'm', 3],
                      ['Y', armPose?.position.y, 'm', 3],
                      ['Z', armPose?.position.z, 'm', 3],
                      ['R', armPose?.rpy.roll, '°', 2],
                      ['P', armPose?.rpy.pitch, '°', 2],
                      ['Y', armPose?.rpy.yaw, '°', 2],
                    ].map(([label, value, unit, digits], index) => (
                      <div key={`${label}-${index}`}>
                        <dt>{label}</dt>
                        <dd>{formatPoseValue(value, digits)}</dd>
                        <small>{unit}</small>
                      </div>
                    ))}
                  </dl>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <footer className="teaching-pose-robot-preview__footer">
        <div>
          <span>{isIndependentTeachingSpace ? 'OBJECT BASE XYZ' : 'MAP XYZ'}</span>
          <strong>
            {hasPose
              ? `${formatPoseValue(recordedPose.position.x)} / ${formatPoseValue(recordedPose.position.y)} / ${formatPoseValue(recordedPose.position.z)} m`
              : '-- / -- / --'}
          </strong>
        </div>
        <div>
          <span>{isIndependentTeachingSpace ? 'OBJECT BASE RPY' : 'MAP RPY'}</span>
          <strong>
            {hasPose
              ? `${formatPoseValue(recordedPose.rpy.roll, 1)} / ${formatPoseValue(recordedPose.rpy.pitch, 1)} / ${formatPoseValue(recordedPose.rpy.yaw, 1)}°`
              : '-- / -- / --'}
          </strong>
        </div>
        <div>
          <span>SCENE</span>
          <strong><Box size={9} /> ROBOT ONLY</strong>
        </div>
      </footer>
    </section>
  );
}
