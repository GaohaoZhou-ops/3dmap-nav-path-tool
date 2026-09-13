import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bluetooth,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Move3D,
  Pause,
  Radio,
  RefreshCw,
  Rotate3D,
  TriangleAlert,
  Unplug,
  Usb,
  X,
} from 'lucide-react';
import {
  SPACEMOUSE_AXIS_GROUPS,
  SPACEMOUSE_BUTTON_CALIBRATION,
  SPACEMOUSE_CALIBRATION_STEPS,
  SPACEMOUSE_CAPTURE_STRATEGY,
  SPACEMOUSE_CONTROL_AXES,
  SPACEMOUSE_DEFAULT_SELECTED_AXES,
  SPACEMOUSE_RAW_AXES,
  SPACEMOUSE_SUPPORTED_PRODUCT_IDS,
  SPACEMOUSE_VENDOR_ID,
  applySpaceMouseProfile,
  createSpaceMouseProfile,
  isSpaceMouseProfileReady,
  isSupportedSpaceMouseDevice,
  loadSpaceMouseProfile,
  parseSpaceMouseInputReport,
  saveSpaceMouseProfile,
  spaceMouseConnectionLabel,
  validateSpaceMouseCalibration,
  validateSpaceMouseButtons,
  zeroSpaceMouseAxes,
  zeroSpaceMouseControlAxes,
} from '../lib/spaceMouse.js';

const CENTER_THRESHOLD = 28;
const MOTION_THRESHOLD = 62;
const AUTO_ADVANCE_DELAY_MS = 500;
const CAPTURE_SAMPLE_LIMIT = 480;
const PEAK_ENVELOPE_RATIO = 0.7;
const PEAK_DIRECTION_COSINE = 0.72;
const RETURN_FREEZE_RATIO = 0.62;
const RETURN_DIRECTION_COSINE = 0.28;
const CENTER_SETTLE_MS = 160;
const CONTROL_BUTTON_DOUBLE_PRESS_MIN_MS = 70;
const CONTROL_BUTTON_DOUBLE_PRESS_MAX_MS = 460;
const SPACEMOUSE_POINTER_ACTIVITY_THRESHOLD = 8;
const SPACEMOUSE_POINTER_MOTION_GUARD_MS = 320;
const SPACEMOUSE_POINTER_BUTTON_GUARD_MS = 560;
const SPACEMOUSE_GUARDED_POINTER_EVENTS = Object.freeze([
  'pointerdown',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'wheel',
  'dragstart',
]);

const hexId = (value) => `0x${Number(value || 0).toString(16).padStart(4, '0')}`;
const rawAxisLabel = {
  x: 'TX',
  y: 'TY',
  z: 'TZ',
  rx: 'RX',
  ry: 'RY',
  rz: 'RZ',
};
const controlAxisMeta = {
  x: { code: 'X', label: '前进 / 后退' },
  y: { code: 'Y', label: '向左 / 向右' },
  z: { code: 'Z', label: '向上 / 向下' },
  roll: { code: 'ROLL', label: '左翻滚 / 右翻滚' },
  pitch: { code: 'PITCH', label: '前倾 / 后仰' },
  yaw: { code: 'YAW', label: '左偏航 / 右偏航' },
};

const statusCopy = {
  unsupported: '浏览器不支持',
  idle: '等待检测',
  requesting: '选择设备',
  connecting: '正在连接',
  connected: '已连接',
  disconnected: '连接已断开',
  error: '连接异常',
};

const initialCalibration = () => ({
  open: false,
  stage: 'intro',
  stepIndex: 0,
  draft: {},
  buttonDraft: { xyz: null, rpy: null },
  captured: null,
  captureMeta: null,
  issues: [],
});

const copySelectedAxes = (value) => ({
  xyz: SPACEMOUSE_AXIS_GROUPS.xyz.includes(value?.xyz)
    ? value.xyz
    : SPACEMOUSE_DEFAULT_SELECTED_AXES.xyz,
  rpy: SPACEMOUSE_AXIS_GROUPS.rpy.includes(value?.rpy)
    ? value.rpy
    : SPACEMOUSE_DEFAULT_SELECTED_AXES.rpy,
});

const selectedAxisOutput = (axes, selectedAxis) => Object.fromEntries(
  SPACEMOUSE_CONTROL_AXES.map((axis) => [
    axis,
    axis === selectedAxis ? Number(axes?.[axis]) || 0 : 0,
  ]),
);

const formatButtonMask = (value) => `0x${(Number(value) >>> 0).toString(16).padStart(2, '0')}`;

const maxRawMagnitude = (axes) => Math.max(
  ...SPACEMOUSE_RAW_AXES.map((axis) => Math.abs(Number(axes?.[axis]) || 0)),
);

const rawVectorMagnitude = (axes) => Math.sqrt(
  SPACEMOUSE_RAW_AXES.reduce(
    (total, axis) => total + (Number(axes?.[axis]) || 0) ** 2,
    0,
  ),
);

const copyAxes = (axes) => Object.fromEntries(
  SPACEMOUSE_RAW_AXES.map((axis) => [axis, Number(axes?.[axis]) || 0]),
);

const rawVectorCosineSimilarity = (left, right) => {
  const leftMagnitude = rawVectorMagnitude(left);
  const rightMagnitude = rawVectorMagnitude(right);
  if (leftMagnitude < 1e-9 || rightMagnitude < 1e-9) return 1;
  const dot = SPACEMOUSE_RAW_AXES.reduce(
    (total, axis) => total
      + (Number(left?.[axis]) || 0) * (Number(right?.[axis]) || 0),
    0,
  );
  return dot / (leftMagnitude * rightMagnitude);
};

const summarizeCoupledCapture = (samples, metadata = {}) => {
  if (!samples?.length) return null;
  const measured = samples.map((axes) => ({
    axes,
    magnitude: rawVectorMagnitude(axes),
  }));
  const peak = Math.max(...measured.map(({ magnitude }) => magnitude), 0);
  const peakSample = measured.reduce((strongest, sample) => (
    !strongest || sample.magnitude > strongest.magnitude ? sample : strongest
  ), null);
  const representativeSamples = measured.filter(({ magnitude }) => (
    magnitude >= Math.max(MOTION_THRESHOLD, peak * PEAK_ENVELOPE_RATIO)
  )).filter(({ axes }) => (
    rawVectorCosineSimilarity(axes, peakSample?.axes) >= PEAK_DIRECTION_COSINE
  ));
  if (!representativeSamples.length || peak < MOTION_THRESHOLD) return null;
  const weightTotal = representativeSamples.reduce(
    (total, { magnitude }) => total + (magnitude / peak) ** 2,
    0,
  );
  const vector = Object.fromEntries(SPACEMOUSE_RAW_AXES.map((axis) => {
    const weighted = representativeSamples.reduce(
      (total, sample) => total
        + (Number(sample.axes[axis]) || 0) * (sample.magnitude / peak) ** 2,
      0,
    );
    return [axis, Number((weighted / Math.max(weightTotal, 1e-9)).toFixed(4))];
  }));
  const maximumComponent = Math.max(
    ...SPACEMOUSE_RAW_AXES.map((axis) => Math.abs(vector[axis])),
    0,
  );
  const activeAxes = SPACEMOUSE_RAW_AXES.filter((axis) => (
    Math.abs(vector[axis]) >= Math.max(12, maximumComponent * 0.12)
  ));
  const dominantAxis = SPACEMOUSE_RAW_AXES.reduce((strongest, axis) => (
    Math.abs(vector[axis]) > Math.abs(vector[strongest]) ? axis : strongest
  ), SPACEMOUSE_RAW_AXES[0]);
  return {
    vector,
    magnitude: Number(rawVectorMagnitude(vector).toFixed(4)),
    peak: Number(peak.toFixed(4)),
    dominantAxis,
    activeAxes: activeAxes.length ? activeAxes : [dominantAxis],
    sampleCount: representativeSamples.length,
    captureStrategy: SPACEMOUSE_CAPTURE_STRATEGY,
    ignoredReleaseSamples: Number(metadata.ignoredReleaseSamples || 0),
    centerSettleMs: CENTER_SETTLE_MS,
    capturedAt: new Date().toISOString(),
  };
};

export default function SpaceMouseControl({ inputRef, onNotify }) {
  const rootRef = useRef(null);
  const deviceRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const profileRef = useRef(null);
  const modeRef = useRef('xyz');
  const selectedAxesRef = useRef(copySelectedAxes(SPACEMOUSE_DEFAULT_SELECTED_AXES));
  const controlEnabledRef = useRef(true);
  const rawAxesRef = useRef(zeroSpaceMouseAxes());
  const buttonMaskRef = useRef(0);
  const lastControlButtonPressRef = useRef({ button: 0, timestamp: -Infinity, before: null });
  const displayFrameRef = useRef(null);
  const captureRef = useRef(null);
  const calibrationFrameRef = useRef(null);
  const pendingCalibrationAxesRef = useRef(zeroSpaceMouseAxes());
  const captureSettleTimerRef = useRef(null);
  const pointerGuardUntilRef = useRef(0);
  const pointerGuardTimerRef = useRef(null);
  const pointerGuardActiveRef = useRef(false);
  const pointerGuardReasonRef = useRef('');
  const suppressedPointerEventsRef = useRef(0);
  const pointerLockOwnedRef = useRef(false);
  const pointerLockPrimedRef = useRef(false);
  const pointerLockRequestPendingRef = useRef(false);
  const pointerLockRetryAfterRef = useRef(0);
  const calibrationRef = useRef(initialCalibration());
  const mountedRef = useRef(true);

  const [status, setStatus] = useState(() => (
    typeof navigator !== 'undefined' && navigator.hid ? 'idle' : 'unsupported'
  ));
  const [open, setOpen] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [profile, setProfile] = useState(() => loadSpaceMouseProfile());
  const [mode, setMode] = useState('xyz');
  const [selectedAxes, setSelectedAxes] = useState(() => (
    copySelectedAxes(SPACEMOUSE_DEFAULT_SELECTED_AXES)
  ));
  const [controlEnabled, setControlEnabled] = useState(true);
  const [rawDisplay, setRawDisplay] = useState(() => zeroSpaceMouseAxes());
  const [signalActive, setSignalActive] = useState(false);
  const [lastError, setLastError] = useState('');
  const [calibration, setCalibration] = useState(initialCalibration);

  profileRef.current = profile;
  modeRef.current = mode;
  selectedAxesRef.current = copySelectedAxes(selectedAxes);
  calibrationRef.current = calibration;

  const publishInput = useCallback((patch = {}) => {
    if (!inputRef) return;
    const current = inputRef.current || {};
    const patchTimestamp = Number(patch.timestamp) || performance.now();
    const rawMagnitude = patch.rawAxes ? maxRawMagnitude(patch.rawAxes) : 0;
    const rawMotionActive = Boolean(patch.rawAxes && rawMagnitude > CENTER_THRESHOLD);
    const physicalMotionActive = Boolean(
      patch.rawAxes && rawMagnitude > SPACEMOUSE_POINTER_ACTIVITY_THRESHOLD,
    );
    inputRef.current = {
      ...current,
      ...patch,
      motionActive: patch.rawAxes ? rawMotionActive : Boolean(patch.motionActive),
      physicalMotionActive: patch.rawAxes
        ? physicalMotionActive
        : Boolean(patch.physicalMotionActive ?? current.physicalMotionActive),
      lastMotionTimestamp: rawMotionActive
        ? patchTimestamp
        : Number(current.lastMotionTimestamp || 0),
      lastPhysicalMotionTimestamp: physicalMotionActive
        ? patchTimestamp
        : Number(current.lastPhysicalMotionTimestamp || 0),
      revision: Number(current.revision || 0) + 1,
    };
  }, [inputRef]);

  const requestTransientPointerLock = useCallback(() => {
    const lockTarget = document.documentElement;
    if (
      !lockTarget?.requestPointerLock
      || document.pointerLockElement
      || pointerLockRequestPendingRef.current
      || performance.now() < pointerLockRetryAfterRef.current
    ) return;
    pointerLockRequestPendingRef.current = true;
    if (rootRef.current) rootRef.current.dataset.spacemousePointerLock = 'requesting';
    try {
      const request = lockTarget.requestPointerLock();
      if (request && typeof request.then === 'function') {
        Promise.resolve(request).then(() => {
          if (
            !pointerGuardActiveRef.current
            && document.pointerLockElement === document.documentElement
          ) document.exitPointerLock?.();
        }).catch(() => {
          pointerLockRequestPendingRef.current = false;
          pointerLockRetryAfterRef.current = performance.now() + 2000;
          if (rootRef.current) rootRef.current.dataset.spacemousePointerLock = 'unavailable';
        });
      }
    } catch {
      pointerLockRequestPendingRef.current = false;
      pointerLockRetryAfterRef.current = performance.now() + 2000;
      if (rootRef.current) rootRef.current.dataset.spacemousePointerLock = 'unavailable';
    }
  }, []);

  const clearPointerGuard = useCallback((force = false) => {
    if (pointerGuardTimerRef.current) {
      window.clearTimeout(pointerGuardTimerRef.current);
      pointerGuardTimerRef.current = null;
    }
    const remaining = pointerGuardUntilRef.current - performance.now();
    if (!force && remaining > 0) {
      pointerGuardTimerRef.current = window.setTimeout(
        () => clearPointerGuard(),
        remaining + 20,
      );
      return;
    }
    pointerGuardUntilRef.current = 0;
    pointerGuardActiveRef.current = false;
    pointerGuardReasonRef.current = '';
    document.documentElement.classList.remove('is-spacemouse-pointer-guarded');
    if (pointerLockOwnedRef.current && document.pointerLockElement === document.documentElement) {
      document.exitPointerLock?.();
    }
    pointerLockOwnedRef.current = false;
    if (rootRef.current) {
      rootRef.current.dataset.spacemousePointerGuard = 'idle';
      rootRef.current.dataset.spacemousePointerGuardReason = '';
      rootRef.current.dataset.spacemousePointerLock = pointerLockPrimedRef.current
        ? 'primed'
        : 'idle';
    }
    if (inputRef) {
      const current = inputRef.current || {};
      inputRef.current = {
        ...current,
        pointerGuardActive: false,
        pointerGuardUntil: 0,
        revision: Number(current.revision || 0) + 1,
      };
    }
  }, [inputRef]);

  const armPointerGuard = useCallback((reason, duration) => {
    const now = performance.now();
    const wasActive = pointerGuardActiveRef.current && now <= pointerGuardUntilRef.current;
    pointerGuardUntilRef.current = Math.max(pointerGuardUntilRef.current, now + duration);
    if (!wasActive || reason === 'physical-button') pointerGuardReasonRef.current = reason;

    if (!wasActive) {
      pointerGuardActiveRef.current = true;
      document.documentElement.classList.add('is-spacemouse-pointer-guarded');
      if (rootRef.current) rootRef.current.dataset.spacemousePointerGuard = 'active';
      if (inputRef) {
        const current = inputRef.current || {};
        inputRef.current = {
          ...current,
          pointerGuardActive: true,
          pointerGuardUntil: pointerGuardUntilRef.current,
          pointerGuardReason: reason,
          revision: Number(current.revision || 0) + 1,
        };
      }
    }
    if (rootRef.current && (!wasActive || reason === 'physical-button')) {
      rootRef.current.dataset.spacemousePointerGuardReason = pointerGuardReasonRef.current;
    }
    // After the first trusted mapped click has granted Pointer Lock once, the
    // specification permits reacquiring it after our own exitPointerLock().
    if (pointerLockPrimedRef.current) requestTransientPointerLock();
    if (!pointerGuardTimerRef.current) {
      pointerGuardTimerRef.current = window.setTimeout(
        () => clearPointerGuard(),
        duration + 20,
      );
    }
  }, [clearPointerGuard, inputRef, requestTransientPointerLock]);

  useEffect(() => {
    if (rootRef.current) {
      rootRef.current.dataset.spacemousePointerGuard = 'idle';
      rootRef.current.dataset.spacemousePointerGuardReason = '';
      rootRef.current.dataset.spacemousePointerLock = document.documentElement.requestPointerLock
        ? 'idle'
        : 'unsupported';
      rootRef.current.dataset.spacemouseSuppressedPointerEvents = String(
        suppressedPointerEventsRef.current,
      );
    }
    const onPointerLockChange = () => {
      const requested = pointerLockRequestPendingRef.current;
      pointerLockRequestPendingRef.current = false;
      if (requested && document.pointerLockElement === document.documentElement) {
        pointerLockOwnedRef.current = true;
        pointerLockPrimedRef.current = true;
        if (!pointerGuardActiveRef.current) document.exitPointerLock?.();
      } else if (!document.pointerLockElement) {
        pointerLockOwnedRef.current = false;
      }
      if (rootRef.current) {
        rootRef.current.dataset.spacemousePointerLock = pointerLockOwnedRef.current
          ? 'locked'
          : pointerLockPrimedRef.current ? 'primed' : 'idle';
      }
    };
    const onPointerLockError = () => {
      pointerLockRequestPendingRef.current = false;
      pointerLockRetryAfterRef.current = performance.now() + 2000;
      if (rootRef.current) rootRef.current.dataset.spacemousePointerLock = 'unavailable';
    };
    const suppressMappedPointerEvent = (event) => {
      if (performance.now() > pointerGuardUntilRef.current) return;
      if ((event.type === 'pointerdown' || event.type === 'mousedown') && event.isTrusted) {
        requestTransientPointerLock();
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      suppressedPointerEventsRef.current += 1;
      if (rootRef.current) {
        rootRef.current.dataset.spacemouseSuppressedPointerEvents = String(
          suppressedPointerEventsRef.current,
        );
        rootRef.current.dataset.spacemouseLastSuppressedEvent = event.type;
      }
      if (inputRef) {
        const current = inputRef.current || {};
        inputRef.current = {
          ...current,
          suppressedPointerEvents: suppressedPointerEventsRef.current,
          lastSuppressedPointerEvent: event.type,
          revision: Number(current.revision || 0) + 1,
        };
      }
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);
    SPACEMOUSE_GUARDED_POINTER_EVENTS.forEach((type) => {
      window.addEventListener(type, suppressMappedPointerEvent, { capture: true, passive: false });
    });
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      SPACEMOUSE_GUARDED_POINTER_EVENTS.forEach((type) => {
        window.removeEventListener(type, suppressMappedPointerEvent, true);
      });
      clearPointerGuard(true);
    };
  }, [clearPointerGuard, inputRef, requestTransientPointerLock]);

  useEffect(() => {
    publishInput({ calibrating: calibration.open });
  }, [calibration.open, publishInput]);

  const publishStopped = useCallback((connected = false) => {
    const profileReady = isSpaceMouseProfileReady(profileRef.current);
    publishInput({
      connected,
      calibrated: profileReady,
      controlEnabled: controlEnabledRef.current,
      mode: modeRef.current,
      selectedAxis: selectedAxesRef.current[modeRef.current],
      selectedAxes: copySelectedAxes(selectedAxesRef.current),
      motionActive: false,
      axes: zeroSpaceMouseControlAxes(),
      rawAxes: copyAxes(rawAxesRef.current),
      timestamp: performance.now(),
    });
  }, [publishInput]);

  const activateControlAxis = useCallback((nextMode, requestedAxis, source = 'ui') => {
    const normalized = nextMode === 'rpy' ? 'rpy' : 'xyz';
    const groupAxes = SPACEMOUSE_AXIS_GROUPS[normalized];
    const axis = groupAxes.includes(requestedAxis)
      ? requestedAxis
      : selectedAxesRef.current[normalized];
    const nextSelectedAxes = {
      ...selectedAxesRef.current,
      [normalized]: axis,
    };
    const wasPaused = !controlEnabledRef.current;
    controlEnabledRef.current = true;
    modeRef.current = normalized;
    selectedAxesRef.current = nextSelectedAxes;
    setControlEnabled(true);
    setMode(normalized);
    setSelectedAxes(nextSelectedAxes);
    const profileReady = isSpaceMouseProfileReady(profileRef.current);
    const decodedAxes = profileReady
      ? applySpaceMouseProfile(rawAxesRef.current, profileRef.current)
      : zeroSpaceMouseControlAxes();
    publishInput({
      connected: Boolean(deviceRef.current?.opened),
      calibrated: profileReady,
      controlEnabled: true,
      mode: normalized,
      selectedAxis: axis,
      selectedAxes: nextSelectedAxes,
      modeSource: source,
      axes: selectedAxisOutput(decodedAxes, axis),
      rawAxes: copyAxes(rawAxesRef.current),
      timestamp: performance.now(),
    });
    if (wasPaused && source !== 'calibration') {
      onNotify?.(
        `SpaceMouse 控制已恢复 · ${controlAxisMeta[axis].code} 单轴`,
        'success',
      );
    }
  }, [onNotify, publishInput]);

  const cycleControlAxis = useCallback((nextMode, source = 'ui') => {
    const normalized = nextMode === 'rpy' ? 'rpy' : 'xyz';
    const groupAxes = SPACEMOUSE_AXIS_GROUPS[normalized];
    const currentAxis = selectedAxesRef.current[normalized];
    const shouldAdvance = controlEnabledRef.current && modeRef.current === normalized;
    const currentIndex = Math.max(0, groupAxes.indexOf(currentAxis));
    const nextAxis = shouldAdvance
      ? groupAxes[(currentIndex + 1) % groupAxes.length]
      : currentAxis;
    activateControlAxis(normalized, nextAxis, source);
  }, [activateControlAxis]);

  const pauseControl = useCallback((source = 'physical-button-double-press') => {
    if (!controlEnabledRef.current) return;
    controlEnabledRef.current = false;
    setControlEnabled(false);
    publishInput({
      connected: Boolean(deviceRef.current?.opened),
      calibrated: isSpaceMouseProfileReady(profileRef.current),
      controlEnabled: false,
      mode: modeRef.current,
      selectedAxis: selectedAxesRef.current[modeRef.current],
      selectedAxes: copySelectedAxes(selectedAxesRef.current),
      modeSource: source,
      axes: zeroSpaceMouseControlAxes(),
      rawAxes: copyAxes(rawAxesRef.current),
      timestamp: performance.now(),
    });
    onNotify?.('SpaceMouse 控制已暂停，单击左键或右键即可恢复', 'warning');
  }, [onNotify, publishInput]);

  const handleControlButtonPress = useCallback((button, nextMode, source) => {
    const now = performance.now();
    const previous = lastControlButtonPressRef.current;
    const elapsed = now - previous.timestamp;
    const isDoublePress = (
      previous.button === button
      && elapsed >= CONTROL_BUTTON_DOUBLE_PRESS_MIN_MS
      && elapsed <= CONTROL_BUTTON_DOUBLE_PRESS_MAX_MS
    );
    if (isDoublePress) {
      if (previous.before) {
        modeRef.current = previous.before.mode;
        selectedAxesRef.current = copySelectedAxes(previous.before.selectedAxes);
        setMode(previous.before.mode);
        setSelectedAxes(selectedAxesRef.current);
      }
      lastControlButtonPressRef.current = { button: 0, timestamp: -Infinity, before: null };
      pauseControl(`${source}-double-press`);
      return;
    }
    lastControlButtonPressRef.current = {
      button,
      timestamp: now,
      before: {
        mode: modeRef.current,
        selectedAxes: copySelectedAxes(selectedAxesRef.current),
      },
    };
    cycleControlAxis(nextMode, source);
  }, [cycleControlAxis, pauseControl]);

  const clearScheduledDisplay = useCallback(() => {
    if (displayFrameRef.current !== null) {
      cancelAnimationFrame(displayFrameRef.current);
      displayFrameRef.current = null;
    }
  }, []);

  const scheduleDisplay = useCallback(() => {
    if (displayFrameRef.current !== null) return;
    displayFrameRef.current = requestAnimationFrame(() => {
      displayFrameRef.current = null;
      if (!mountedRef.current) return;
      // Wireless/USB devices commonly emit translation and rotation as two
      // reports inside the same render frame. Read the shared accumulator at
      // paint time so the panel receives the complete T + R snapshot.
      const nextAxes = copyAxes(rawAxesRef.current);
      setRawDisplay(nextAxes);
      setSignalActive(maxRawMagnitude(nextAxes) > CENTER_THRESHOLD);
    });
  }, []);

  const updateDraftRecord = useCallback((step, captured) => {
    setCalibration((current) => {
      const draft = {
        ...current.draft,
        [step.axis]: {
          ...(current.draft[step.axis] || {}),
          [step.direction]: captured,
        },
      };
      return {
        ...current,
        stage: 'captured',
        draft,
        captured,
        captureMeta: {
          peak: captured.peak,
          peakSampleCount: captured.sampleCount,
          ignoredReleaseSamples: captured.ignoredReleaseSamples,
        },
        issues: [],
      };
    });
  }, []);

  const clearCaptureSettleTimer = useCallback(() => {
    if (captureSettleTimerRef.current) {
      window.clearTimeout(captureSettleTimerRef.current);
      captureSettleTimerRef.current = null;
    }
  }, []);

  const clearScheduledCalibrationInput = useCallback(() => {
    if (calibrationFrameRef.current) {
      cancelAnimationFrame(calibrationFrameRef.current);
      calibrationFrameRef.current = null;
    }
    pendingCalibrationAxesRef.current = zeroSpaceMouseAxes();
  }, []);

  const captureProgressMeta = useCallback((capture) => ({
    peak: Number(capture?.peakMagnitude || 0),
    peakSampleCount: Number(capture?.samples?.length || 0),
    ignoredReleaseSamples: Number(capture?.ignoredReleaseSamples || 0),
  }), []);

  const finalizeCalibrationCapture = useCallback((capture) => {
    if (!capture || captureRef.current !== capture) return;
    clearCaptureSettleTimer();
    const captured = summarizeCoupledCapture(capture.samples, {
      ignoredReleaseSamples: capture.ignoredReleaseSamples,
    });
    captureRef.current = null;
    if (!captured) {
      setCalibration((current) => ({
        ...current,
        stage: 'capture-error',
        captured: null,
        captureMeta: captureProgressMeta(capture),
        issues: ['没有锁定到稳定的外推动作峰值，请重新执行当前动作'],
      }));
      return;
    }

    const step = SPACEMOUSE_CALIBRATION_STEPS[capture.stepIndex];
    updateDraftRecord(step, captured);
  }, [captureProgressMeta, clearCaptureSettleTimer, updateDraftRecord]);

  const beginStableCenterCheck = useCallback((capture) => {
    if (!capture || captureRef.current !== capture) return;
    clearCaptureSettleTimer();
    capture.phase = 'settling';
    capture.centeredAt = performance.now();
    setCalibration((current) => ({
      ...current,
      stage: 'settling',
      captureMeta: captureProgressMeta(capture),
      issues: [],
    }));
    captureSettleTimerRef.current = window.setTimeout(() => {
      captureSettleTimerRef.current = null;
      if (captureRef.current !== capture) return;
      if (maxRawMagnitude(rawAxesRef.current) > CENTER_THRESHOLD) {
        capture.phase = 'returning';
        capture.ignoredReleaseSamples += 1;
        setCalibration((current) => ({
          ...current,
          stage: 'returning',
          captureMeta: captureProgressMeta(capture),
        }));
        return;
      }
      finalizeCalibrationCapture(capture);
    }, CENTER_SETTLE_MS);
  }, [captureProgressMeta, clearCaptureSettleTimer, finalizeCalibrationCapture]);

  const processCalibrationInput = useCallback((rawAxes) => {
    const capture = captureRef.current;
    if (!capture || capture.kind === 'button') return;
    const magnitude = maxRawMagnitude(rawAxes);

    if (capture.phase === 'centering') {
      if (magnitude <= CENTER_THRESHOLD) {
        capture.phase = 'armed';
        setCalibration((current) => ({ ...current, stage: 'armed' }));
      }
      return;
    }

    if (capture.phase === 'armed') {
      if (magnitude < MOTION_THRESHOLD) return;
      capture.phase = 'sampling';
      capture.startedAt = performance.now();
      setCalibration((current) => ({ ...current, stage: 'sampling' }));
    }

    if (capture.phase === 'sampling') {
      if (magnitude <= CENTER_THRESHOLD) {
        beginStableCenterCheck(capture);
        return;
      }

      const sample = copyAxes(rawAxes);
      const sampleMagnitude = rawVectorMagnitude(sample);
      const hasStableOutboundTrace = capture.outboundSampleCount >= 2;
      const hasOutboundDirection = capture.outboundSampleCount >= 1;
      const directionSimilarity = capture.peakVector
        ? rawVectorCosineSimilarity(sample, capture.peakVector)
        : 1;
      const returningByMagnitude = hasStableOutboundTrace
        && sampleMagnitude < capture.peakMagnitude * RETURN_FREEZE_RATIO;
      const returningByDirection = hasOutboundDirection
        && directionSimilarity < RETURN_DIRECTION_COSINE;

      if (returningByMagnitude || returningByDirection) {
        // Freeze the outbound peak window before the cap crosses center. Any
        // spring-back reports from this point on are deliberately excluded.
        capture.phase = 'returning';
        capture.frozenAt = performance.now();
        capture.ignoredReleaseSamples += 1;
        setCalibration((current) => ({
          ...current,
          stage: 'returning',
          captureMeta: captureProgressMeta(capture),
          issues: [],
        }));
        return;
      }

      capture.outboundSampleCount += 1;
      if (!capture.peakVector || sampleMagnitude > capture.peakMagnitude) {
        capture.peakMagnitude = sampleMagnitude;
        capture.peakVector = sample;
        capture.samples = capture.samples.filter((candidate) => (
          rawVectorMagnitude(candidate) >= sampleMagnitude * PEAK_ENVELOPE_RATIO
          && rawVectorCosineSimilarity(candidate, sample) >= PEAK_DIRECTION_COSINE
        ));
      }
      if (
        sampleMagnitude >= capture.peakMagnitude * PEAK_ENVELOPE_RATIO
        && rawVectorCosineSimilarity(sample, capture.peakVector) >= PEAK_DIRECTION_COSINE
      ) {
        capture.samples.push(sample);
        if (capture.samples.length > CAPTURE_SAMPLE_LIMIT) capture.samples.shift();
      }
      return;
    }

    if (capture.phase === 'returning') {
      if (magnitude <= CENTER_THRESHOLD) beginStableCenterCheck(capture);
      else capture.ignoredReleaseSamples += 1;
      return;
    }

    if (capture.phase === 'settling' && magnitude > CENTER_THRESHOLD) {
      clearCaptureSettleTimer();
      capture.phase = 'returning';
      capture.ignoredReleaseSamples += 1;
      setCalibration((current) => ({
        ...current,
        stage: 'returning',
        captureMeta: captureProgressMeta(capture),
        issues: [],
      }));
    }
  }, [
    beginStableCenterCheck,
    captureProgressMeta,
    clearCaptureSettleTimer,
  ]);

  const scheduleCalibrationInput = useCallback((rawAxes) => {
    pendingCalibrationAxesRef.current = copyAxes(rawAxes);
    if (calibrationFrameRef.current) return;
    calibrationFrameRef.current = requestAnimationFrame(() => {
      calibrationFrameRef.current = null;
      if (!mountedRef.current) return;
      processCalibrationInput(pendingCalibrationAxesRef.current);
    });
  }, [processCalibrationInput]);

  const captureCalibrationButton = useCallback((pressedMask) => {
    const capture = captureRef.current;
    const current = calibrationRef.current;
    const step = SPACEMOUSE_CALIBRATION_STEPS[capture?.stepIndex];
    if (!current.open || !capture || step?.type !== 'button') return false;

    const mask = Number(pressedMask) >>> 0;
    const singleButton = mask > 0 && (mask & (mask - 1)) === 0;
    const otherRole = step.role === 'xyz' ? 'rpy' : 'xyz';
    const duplicate = Number(current.buttonDraft?.[otherRole]) === mask;
    if (!singleButton || duplicate) {
      captureRef.current = null;
      setCalibration((value) => ({
        ...value,
        stage: 'capture-error',
        captured: null,
        issues: [duplicate
          ? '这个实体键已分配给另一组，请按下另一侧按钮'
          : '检测到多个按键同时触发，请仅单击一个实体键'],
      }));
      return true;
    }

    captureRef.current = null;
    const captured = {
      kind: 'button',
      role: step.role,
      mask,
      capturedAt: new Date().toISOString(),
    };
    setCalibration((value) => ({
      ...value,
      stage: 'captured',
      buttonDraft: { ...value.buttonDraft, [step.role]: mask },
      captured,
      captureMeta: null,
      issues: [],
    }));
    return true;
  }, []);

  const handleInputReport = useCallback((event) => {
    const report = parseSpaceMouseInputReport(event.reportId, event.data);
    if (report.translation) Object.assign(rawAxesRef.current, report.translation);
    if (report.rotation) Object.assign(rawAxesRef.current, report.rotation);

    if (report.buttons !== null) {
      const previous = buttonMaskRef.current;
      const pressed = report.buttons & ~previous;
      buttonMaskRef.current = report.buttons;
      if (pressed) {
        armPointerGuard('physical-button', SPACEMOUSE_POINTER_BUTTON_GUARD_MS);
        if (calibrationRef.current.open) {
          captureCalibrationButton(pressed);
        } else if (isSpaceMouseProfileReady(profileRef.current)) {
          const buttons = validateSpaceMouseButtons(profileRef.current.buttons).buttons;
          if (pressed & buttons.xyz) {
            handleControlButtonPress(buttons.xyz, 'xyz', 'xyz-button');
          } else if (pressed & buttons.rpy) {
            handleControlButtonPress(buttons.rpy, 'rpy', 'rpy-button');
          }
        }
      }
    }

    if (!report.translation && !report.rotation) return;
    const rawAxes = copyAxes(rawAxesRef.current);
    // Keep the pointer firewall alive through the spring return. The viewport
    // uses a wider dead zone, but tiny physical cap values may still be mapped
    // to the operating-system cursor by 3DxWare.
    if (maxRawMagnitude(rawAxes) > SPACEMOUSE_POINTER_ACTIVITY_THRESHOLD) {
      armPointerGuard('cap-motion', SPACEMOUSE_POINTER_MOTION_GUARD_MS);
    }
    scheduleDisplay();
    scheduleCalibrationInput(rawAxes);
    const currentProfile = profileRef.current;
    const profileReady = isSpaceMouseProfileReady(currentProfile);
    const selectedAxis = selectedAxesRef.current[modeRef.current];
    const decodedAxes = profileReady && controlEnabledRef.current
      ? applySpaceMouseProfile(rawAxes, currentProfile)
      : zeroSpaceMouseControlAxes();
    publishInput({
      connected: true,
      calibrated: profileReady,
      controlEnabled: controlEnabledRef.current,
      mode: modeRef.current,
      selectedAxis,
      selectedAxes: copySelectedAxes(selectedAxesRef.current),
      axes: selectedAxisOutput(decodedAxes, selectedAxis),
      rawAxes,
      timestamp: performance.now(),
    });
  }, [
    armPointerGuard,
    captureCalibrationButton,
    handleControlButtonPress,
    publishInput,
    scheduleCalibrationInput,
    scheduleDisplay,
  ]);

  const detachDevice = useCallback(async ({ close = false, disconnected = false } = {}) => {
    const device = deviceRef.current;
    if (device && inputHandlerRef.current) {
      device.removeEventListener('inputreport', inputHandlerRef.current);
    }
    inputHandlerRef.current = null;
    deviceRef.current = null;
    rawAxesRef.current = zeroSpaceMouseAxes();
    buttonMaskRef.current = 0;
    lastControlButtonPressRef.current = { button: 0, timestamp: -Infinity, before: null };
    controlEnabledRef.current = true;
    clearScheduledDisplay();
    clearPointerGuard(true);
    clearScheduledCalibrationInput();
    clearCaptureSettleTimer();
    captureRef.current = null;
    setRawDisplay(zeroSpaceMouseAxes());
    setSignalActive(false);
    setControlEnabled(true);
    publishStopped(false);
    if (close && device?.opened) {
      try {
        await device.close();
      } catch {
        // A transport disconnect can close the HID handle before this cleanup.
      }
    }
    if (mountedRef.current) setStatus(disconnected ? 'disconnected' : 'idle');
  }, [
    clearCaptureSettleTimer,
    clearPointerGuard,
    clearScheduledDisplay,
    clearScheduledCalibrationInput,
    publishStopped,
  ]);

  const attachDevice = useCallback(async (device, { announce = true } = {}) => {
    if (!isSupportedSpaceMouseDevice(device)) {
      throw new Error('当前仅支持 SpaceMouse Wireless Bluetooth Edition');
    }
    if (deviceRef.current && deviceRef.current !== device) {
      await detachDevice({ close: true });
    }
    setStatus('connecting');
    if (!device.opened) await device.open();
    deviceRef.current = device;
    controlEnabledRef.current = true;
    lastControlButtonPressRef.current = { button: 0, timestamp: -Infinity, before: null };
    setControlEnabled(true);
    inputHandlerRef.current = handleInputReport;
    device.addEventListener('inputreport', handleInputReport);
    const info = {
      vendorId: Number(device.vendorId),
      productId: Number(device.productId),
      productName: device.productName || 'SpaceMouse Wireless BT',
      transport: spaceMouseConnectionLabel(device),
    };
    setDeviceInfo(info);
    setStatus('connected');
    setLastError('');
    publishInput({
      connected: true,
      calibrated: isSpaceMouseProfileReady(profileRef.current),
      controlEnabled: true,
      mode: modeRef.current,
      selectedAxis: selectedAxesRef.current[modeRef.current],
      selectedAxes: copySelectedAxes(selectedAxesRef.current),
      axes: zeroSpaceMouseControlAxes(),
      rawAxes: zeroSpaceMouseAxes(),
      timestamp: performance.now(),
      device: info,
    });
    const needsCalibration = !isSpaceMouseProfileReady(profileRef.current);
    if (needsCalibration) {
      setCalibration({ ...initialCalibration(), open: true });
    }
    if (announce) {
      onNotify?.(
        needsCalibration
          ? 'SpaceMouse 控制已升级，请标定左右切换键与六轴动作'
          : 'SpaceMouse 已连接，普通鼠标与键盘仍可同时使用',
        needsCalibration ? 'warning' : 'success',
      );
    }
  }, [detachDevice, handleInputReport, onNotify, publishInput]);

  const requestDevice = useCallback(async () => {
    if (!navigator.hid) {
      setStatus('unsupported');
      setOpen(true);
      return;
    }
    setStatus('requesting');
    setLastError('');
    try {
      const devices = await navigator.hid.requestDevice({
        filters: SPACEMOUSE_SUPPORTED_PRODUCT_IDS.map((productId) => ({
          vendorId: SPACEMOUSE_VENDOR_ID,
          productId,
        })),
      });
      const device = devices.find(isSupportedSpaceMouseDevice);
      if (!device) {
        setStatus('idle');
        setLastError('未选择受支持的 SpaceMouse');
        setOpen(true);
        return;
      }
      await attachDevice(device);
      setOpen(true);
    } catch (error) {
      const cancelled = error?.name === 'NotFoundError';
      setStatus(cancelled ? 'idle' : 'error');
      setLastError(cancelled ? '已取消设备选择' : error?.message || '无法打开 HID 设备');
      setOpen(true);
    }
  }, [attachDevice]);

  useEffect(() => {
    mountedRef.current = true;
    // Fast Refresh can run the cleanup from an older module version whose
    // cancelled RAF id was not cleared. Always re-arm live telemetry here.
    displayFrameRef.current = null;
    if (!navigator.hid) return () => { mountedRef.current = false; };
    let cancelled = false;
    navigator.hid.getDevices()
      .then((devices) => {
        const remembered = devices.find(isSupportedSpaceMouseDevice);
        if (!cancelled && remembered) return attachDevice(remembered, { announce: false });
        return undefined;
      })
      .catch((error) => {
        if (!cancelled) setLastError(error?.message || '无法恢复 HID 权限');
      });

    const onConnect = (event) => {
      if (!deviceRef.current && isSupportedSpaceMouseDevice(event.device)) {
        attachDevice(event.device, { announce: true }).catch((error) => {
          setStatus('error');
          setLastError(error?.message || '设备重连失败');
        });
      }
    };
    const onDisconnect = (event) => {
      if (event.device === deviceRef.current) {
        detachDevice({ disconnected: true });
        onNotify?.('SpaceMouse 连接已断开，当前鼠标与键盘控制不受影响', 'warning');
      }
    };
    navigator.hid.addEventListener('connect', onConnect);
    navigator.hid.addEventListener('disconnect', onDisconnect);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      navigator.hid.removeEventListener('connect', onConnect);
      navigator.hid.removeEventListener('disconnect', onDisconnect);
      clearScheduledDisplay();
      clearScheduledCalibrationInput();
      clearCaptureSettleTimer();
      const device = deviceRef.current;
      if (device && inputHandlerRef.current) {
        device.removeEventListener('inputreport', inputHandlerRef.current);
      }
    };
  }, [
    attachDevice,
    clearCaptureSettleTimer,
    clearScheduledDisplay,
    clearScheduledCalibrationInput,
    detachDevice,
    onNotify,
  ]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!calibrationRef.current.open && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !calibrationRef.current.open) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const armCalibrationStep = useCallback((stepIndex, { reset = false } = {}) => {
    clearScheduledCalibrationInput();
    clearCaptureSettleTimer();
    const step = SPACEMOUSE_CALIBRATION_STEPS[stepIndex];
    const buttonStep = step?.type === 'button';
    const centered = maxRawMagnitude(rawAxesRef.current) <= CENTER_THRESHOLD;
    captureRef.current = {
      stepIndex,
      kind: buttonStep ? 'button' : 'motion',
      phase: buttonStep || centered ? 'armed' : 'centering',
      samples: [],
      peakMagnitude: 0,
      peakVector: null,
      outboundSampleCount: 0,
      ignoredReleaseSamples: 0,
    };
    setCalibration((current) => ({
      ...(reset ? initialCalibration() : current),
      open: true,
      stepIndex,
      stage: buttonStep || centered ? 'armed' : 'centering',
      draft: reset ? {} : current.draft,
      buttonDraft: reset
        ? { xyz: null, rpy: null }
        : { ...current.buttonDraft },
      captured: null,
      captureMeta: null,
      issues: [],
    }));
  }, [clearCaptureSettleTimer, clearScheduledCalibrationInput]);

  const startCalibration = useCallback(() => {
    armCalibrationStep(0, { reset: true });
  }, [armCalibrationStep]);

  const armCurrentStep = () => {
    armCalibrationStep(calibrationRef.current.stepIndex);
  };

  const returnToPreviousStep = useCallback(() => {
    const previousStep = calibrationRef.current.stepIndex - 1;
    if (previousStep < 0) return;
    armCalibrationStep(previousStep);
  }, [armCalibrationStep]);

  const finishCalibration = useCallback((current) => {
    const motionValidation = validateSpaceMouseCalibration(current.draft);
    const buttonValidation = validateSpaceMouseButtons(current.buttonDraft);
    const issues = [...buttonValidation.issues, ...motionValidation.issues];
    if (issues.length) {
      setCalibration({ ...current, stage: 'review-error', issues });
      return;
    }
    try {
      const nextProfile = createSpaceMouseProfile(
        current.draft,
        deviceInfo,
        buttonValidation.buttons,
      );
      const persisted = saveSpaceMouseProfile(nextProfile);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      activateControlAxis('xyz', SPACEMOUSE_DEFAULT_SELECTED_AXES.xyz, 'calibration');
      setCalibration({ ...current, stage: 'complete', issues: [] });
      onNotify?.(
        persisted ? 'SpaceMouse 用户习惯已保存到本地' : '校准已生效，但浏览器阻止了本地保存',
        persisted ? 'success' : 'warning',
      );
    } catch (error) {
      setCalibration({
        ...current,
        stage: 'review-error',
        issues: [error?.message || '校准数据验证失败'],
      });
    }
  }, [activateControlAxis, deviceInfo, onNotify]);

  useEffect(() => {
    if (!calibration.open || calibration.stage !== 'captured') return undefined;
    const completedStep = calibration.stepIndex;
    const timer = window.setTimeout(() => {
      const current = calibrationRef.current;
      if (
        !current.open
        || current.stage !== 'captured'
        || current.stepIndex !== completedStep
        || captureRef.current
      ) return;
      if (completedStep === SPACEMOUSE_CALIBRATION_STEPS.length - 1) {
        finishCalibration(current);
      } else {
        armCalibrationStep(completedStep + 1);
      }
    }, AUTO_ADVANCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [armCalibrationStep, calibration.open, calibration.stage, calibration.stepIndex, finishCalibration]);

  const closeCalibration = useCallback(() => {
    clearScheduledCalibrationInput();
    clearCaptureSettleTimer();
    captureRef.current = null;
    setCalibration((current) => ({ ...current, open: false }));
  }, [clearCaptureSettleTimer, clearScheduledCalibrationInput]);

  useEffect(() => {
    if (!calibration.open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeCalibration();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [calibration.open, closeCalibration]);

  const currentStep = SPACEMOUSE_CALIBRATION_STEPS[calibration.stepIndex];
  const liveRawMaximum = maxRawMagnitude(rawDisplay);
  const liveAxisThreshold = Math.max(12, liveRawMaximum * 0.12);
  const connected = status === 'connected';
  const hasProfile = Boolean(profile);
  const calibrated = isSpaceMouseProfileReady(profile);
  const peakCaptureReady = calibrated;
  const selectedAxis = selectedAxes[mode] || SPACEMOUSE_DEFAULT_SELECTED_AXES[mode];
  const selectedAxisMeta = controlAxisMeta[selectedAxis];
  const StatusIcon = status === 'requesting' || status === 'connecting'
    ? LoaderCircle
    : status === 'error' || status === 'unsupported'
      ? TriangleAlert
      : connected ? Radio : Usb;

  return (
    <div
      className={`spacemouse-control is-${status} is-control-${controlEnabled ? 'active' : 'paused'} ${signalActive && controlEnabled ? 'has-signal' : ''}`}
      ref={rootRef}
      data-spacemouse-state={status}
      data-spacemouse-calibrated={calibrated ? 'true' : 'false'}
      data-spacemouse-mode={mode}
      data-spacemouse-selected-axis={selectedAxis}
      data-spacemouse-selected-xyz={selectedAxes.xyz}
      data-spacemouse-selected-rpy={selectedAxes.rpy}
      data-spacemouse-control-enabled={controlEnabled ? 'true' : 'false'}
      data-spacemouse-button-gesture="left-cycle-xyz,right-cycle-rpy,same-button-double-pause"
      data-spacemouse-double-press-window={`${CONTROL_BUTTON_DOUBLE_PRESS_MIN_MS}-${CONTROL_BUTTON_DOUBLE_PRESS_MAX_MS}ms`}
      data-spacemouse-signal={signalActive ? 'active' : 'idle'}
      data-spacemouse-product-id={deviceInfo ? hexId(deviceInfo.productId) : ''}
      data-spacemouse-calibration-model={profile?.calibrationModel || ''}
      data-spacemouse-capture-strategy={profile?.captureStrategy || ''}
      data-spacemouse-button-calibration-model={SPACEMOUSE_BUTTON_CALIBRATION}
      data-spacemouse-button-calibration={profile?.buttonCalibration || ''}
      data-spacemouse-xyz-button={profile?.buttons?.xyz ? formatButtonMask(profile.buttons.xyz) : ''}
      data-spacemouse-rpy-button={profile?.buttons?.rpy ? formatButtonMask(profile.buttons.rpy) : ''}
      data-spacemouse-pointer-motion-guard-ms={SPACEMOUSE_POINTER_MOTION_GUARD_MS}
      data-spacemouse-pointer-button-guard-ms={SPACEMOUSE_POINTER_BUTTON_GUARD_MS}
      data-spacemouse-pointer-activity-threshold={SPACEMOUSE_POINTER_ACTIVITY_THRESHOLD}
      data-spacemouse-pointer-move-policy="native-unintercepted"
      data-spacemouse-pointer-guard-timer="deadline-coalesced"
      data-spacemouse-pointer-lock-strategy="gesture-primed-transient"
    >
      <button
        type="button"
        className={`action-button spacemouse-trigger ${connected ? 'is-connected' : ''}`}
        aria-label="检测3D鼠标"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="检测或配置 3DConnexion SpaceMouse Wireless Bluetooth Edition"
        disabled={status === 'requesting' || status === 'connecting'}
        onClick={() => {
          if (connected) {
            // Prime Pointer Lock from an explicit browser gesture, then release
            // it immediately. Later cap motion can reacquire it without making
            // ordinary mouse use permanently locked.
            requestTransientPointerLock();
            setOpen((current) => !current);
          }
          else requestDevice();
        }}
      >
        <StatusIcon
          className={status === 'requesting' || status === 'connecting' ? 'is-spinning' : ''}
          size={15}
        />
        <span>3D 鼠标</span>
        {connected && <i>{controlEnabled ? selectedAxisMeta.code : 'PAUSE'}</i>}
      </button>

      {open && (
        <div className="spacemouse-menu" role="dialog" aria-label="3D鼠标控制器">
          <div className="spacemouse-menu__heading">
            <span className={`spacemouse-device-orbit ${signalActive && controlEnabled ? 'is-live' : ''}`}>
              <i /><b /><em />
            </span>
            <div>
              <small>6DOF INPUT / WEBHID</small>
              <strong>{connected ? 'SpaceMouse Wireless BT' : '3D 鼠标检测'}</strong>
              <span>{connected && !controlEnabled ? '已连接 · 控制暂停' : statusCopy[status]}</span>
            </div>
            <button type="button" aria-label="关闭3D鼠标面板" onClick={() => setOpen(false)}>
              <X size={13} />
            </button>
          </div>

          {connected ? (
            <>
              <div className="spacemouse-device-meta">
                <span><Bluetooth size={12} />{deviceInfo?.transport}</span>
                <code>{hexId(deviceInfo?.vendorId)}:{hexId(deviceInfo?.productId)}</code>
              </div>

              <div className="spacemouse-mode-switch" role="group" aria-label="SpaceMouse 控制模式">
                <button
                  type="button"
                  className={mode === 'xyz' ? (controlEnabled ? 'is-active' : 'is-standby') : ''}
                  aria-pressed={mode === 'xyz'}
                  onClick={() => cycleControlAxis('xyz', 'panel')}
                >
                  <Move3D size={14} />
                  <span>
                    <b>左键 · XYZ <em>{controlAxisMeta[selectedAxes.xyz].code}</em></b>
                    <small>X → Y → Z 单轴循环</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={mode === 'rpy' ? (controlEnabled ? 'is-active' : 'is-standby') : ''}
                  aria-pressed={mode === 'rpy'}
                  onClick={() => cycleControlAxis('rpy', 'panel')}
                >
                  <Rotate3D size={14} />
                  <span>
                    <b>右键 · RPY <em>{controlAxisMeta[selectedAxes.rpy].code}</em></b>
                    <small>YAW → PITCH → ROLL 单轴循环</small>
                  </span>
                </button>
              </div>

              <div className="spacemouse-live-axes" aria-label="SpaceMouse 实时轴信号">
                {SPACEMOUSE_RAW_AXES.map((axis) => {
                  const value = rawDisplay[axis] || 0;
                  return (
                    <div key={axis} data-axis={axis} data-value={value}>
                      <span>{rawAxisLabel[axis]}</span>
                      <i><b style={{ width: `${Math.min(50, Math.abs(value) / 7)}%` }} className={value < 0 ? 'is-negative' : 'is-positive'} /></i>
                      <em>{Math.round(value)}</em>
                    </div>
                  );
                })}
              </div>

              <div className={`spacemouse-profile-status ${peakCaptureReady && controlEnabled ? 'is-ready' : ''} ${!controlEnabled ? 'is-paused' : ''}`}>
                {!controlEnabled
                  ? <Pause size={13} />
                  : peakCaptureReady ? <Check size={13} /> : <TriangleAlert size={13} />}
                <div>
                  <strong>{!controlEnabled
                    ? 'SpaceMouse 控制已暂停'
                    : peakCaptureReady
                      ? `${selectedAxisMeta.code} 单轴通道已启用`
                      : hasProfile ? '控制逻辑已升级，请重新标定' : '首次使用需要校准'}</strong>
                  <span>{!controlEnabled
                    ? '设备与校准保持在线 · 单击任意实体键立即恢复'
                    : peakCaptureReady
                      ? `${selectedAxisMeta.label} · 仅该语义轴可输出 · 左 ${formatButtonMask(profile.buttons.xyz)} / 右 ${formatButtonMask(profile.buttons.rpy)}`
                      : hasProfile
                        ? '旧配置没有实体键映射，完成一次 14 项标定即可替换'
                        : '先记录左右实体键，再采集完整六维动作指纹'}</span>
                </div>
              </div>

              <div className="spacemouse-menu__actions">
                <button type="button" onClick={() => setCalibration({ ...initialCalibration(), open: true })}>
                  <RefreshCw size={12} />{hasProfile ? '重新标定' : '开始标定'}
                </button>
                <button type="button" onClick={() => detachDevice({ close: true })}>
                  <Unplug size={12} />断开
                </button>
              </div>
              <p className="spacemouse-coexist-note">左键循环 X / Y / Z，右键循环 YAW / PITCH / ROLL；推动空间球时只执行当前轴，双击同一实体键暂停。输入期间会低开销屏蔽驱动映射出的点击，并在浏览器允许时临时锁住光标；普通鼠标随后自动恢复，缩放始终由鼠标滚轮控制。</p>
            </>
          ) : (
            <div className="spacemouse-empty-state">
              <TriangleAlert size={18} />
              <strong>{status === 'unsupported' ? '需要 Chromium WebHID' : '尚未连接设备'}</strong>
              <span>
                {status === 'unsupported'
                  ? '请使用最新版 Chrome 或 Edge，并通过本机 21990 服务打开页面。'
                  : lastError || '点击下方按钮后，在浏览器设备列表中选择 SpaceMouse Wireless BT。'}
              </span>
              {status !== 'unsupported' && (
                <button type="button" onClick={requestDevice}><Usb size={13} />重新检测</button>
              )}
            </div>
          )}
        </div>
      )}

      {calibration.open && createPortal(
        <div className="spacemouse-calibration-backdrop" role="presentation">
          <section
            className="spacemouse-calibration"
            role="dialog"
            aria-modal="true"
            aria-label="SpaceMouse 首次校准"
            data-calibration-stage={calibration.stage}
            data-calibration-step={calibration.stepIndex + 1}
            data-auto-advance-ms={AUTO_ADVANCE_DELAY_MS}
          >
            <header>
              <div>
                <small>PERSONAL MOTION PROFILE</small>
                <strong>SpaceMouse 控制逻辑校准</strong>
              </div>
              <button type="button" aria-label="关闭SpaceMouse校准" onClick={closeCalibration}>
                <X size={15} />
              </button>
            </header>

            {calibration.stage === 'intro' && (
              <div className="spacemouse-calibration__intro">
                <div className="spacemouse-calibration__hero" aria-hidden="true">
                  <span><i /><b /><em /></span>
                  <div><Move3D size={16} /><Rotate3D size={16} /></div>
                </div>
                <small>14-STEP CONTROL CALIBRATION</small>
                <h2>先认按键，再定义每个方向</h2>
                <p>前两项分别记录用于循环 X / Y / Z 与 YAW / PITCH / ROLL 的左右实体键，随后按 +X 前进、+Y 向左、+Z 向上的语义采集 12 个动作。运行时只放行由按键选中的一个轴；标定仍会读取完整六维指纹，以消除手部耦合与松手回弹。</p>
                <div className="spacemouse-calibration__rules">
                  <span><b>01</b>左右键分别单击一次</span>
                  <span><b>02</b>空间球推至舒适峰值</span>
                  <span><b>03</b>每项确认 0.5 秒后继续</span>
                </div>
                <button type="button" className="spacemouse-calibration__primary" onClick={startCalibration}>
                  开始 14 项标定 <ChevronRight size={15} />
                </button>
              </div>
            )}

            {!['intro', 'complete', 'review-error'].includes(calibration.stage) && currentStep && (
              <div className="spacemouse-calibration__workbench">
                <div className="spacemouse-calibration__progress">
                  <span>{String(calibration.stepIndex + 1).padStart(2, '0')} / {SPACEMOUSE_CALIBRATION_STEPS.length}</span>
                  <i><b style={{ width: `${((calibration.stepIndex + 1) / SPACEMOUSE_CALIBRATION_STEPS.length) * 100}%` }} /></i>
                  <em>{currentStep.group}</em>
                </div>
                <div className="spacemouse-calibration__target">
                  <span>{currentStep.code}</span>
                  <div><small>当前目标</small><strong>{currentStep.title}</strong></div>
                </div>
                <p>{currentStep.action}</p>

                <div
                  className={`spacemouse-capture-state is-${calibration.stage}`}
                  aria-live="polite"
                  data-active-axis-count={calibration.captured?.activeAxes?.length || 0}
                  data-capture-strategy={SPACEMOUSE_CAPTURE_STRATEGY}
                  data-calibration-kind={currentStep.type}
                  data-capture-phase={captureRef.current?.phase || calibration.stage}
                  data-peak-sample-count={
                    calibration.captureMeta?.peakSampleCount
                    || captureRef.current?.samples?.length
                    || 0
                  }
                  data-release-samples-ignored={
                    calibration.captured?.ignoredReleaseSamples
                    || calibration.captureMeta?.ignoredReleaseSamples
                    || captureRef.current?.ignoredReleaseSamples
                    || 0
                  }
                  data-center-settle-ms={CENTER_SETTLE_MS}
                >
                  <span className="spacemouse-capture-state__orb"><i /><b /></span>
                  <div>
                    <small>CAPTURE STATE</small>
                    <strong>
                      {calibration.stage === 'ready' && '准备采集'}
                      {calibration.stage === 'centering' && '请先松手，让空间球回中'}
                      {calibration.stage === 'armed' && (
                        currentStep.type === 'button'
                          ? '已就绪，请单击指定实体键'
                          : '已就绪，请执行上方动作'
                      )}
                      {calibration.stage === 'sampling' && '正在锁定外推动作峰值'}
                      {calibration.stage === 'returning' && '峰值已冻结，请松手回中'}
                      {calibration.stage === 'settling' && '正在过滤回弹，请保持松手'}
                      {calibration.stage === 'captured' && (
                        calibration.stepIndex === SPACEMOUSE_CALIBRATION_STEPS.length - 1
                          ? '全部配置已捕获 · 即将校验保存'
                          : currentStep.type === 'button'
                            ? '实体键已捕获 · 即将标定下一项'
                            : '方向已捕获 · 即将采集下一项'
                      )}
                      {calibration.stage === 'capture-error' && '有效动作信号不足'}
                    </strong>
                    {calibration.captured?.kind === 'button' && (
                      <span>
                        {calibration.captured.role.toUpperCase()} SWITCH · {formatButtonMask(calibration.captured.mask)}
                      </span>
                    )}
                    {calibration.captured && calibration.captured.kind !== 'button' && (
                      <span>
                        融合 {calibration.captured.activeAxes
                          .map((axis) => rawAxisLabel[axis])
                          .join(' + ')} · {calibration.captured.sampleCount} SAMPLES
                      </span>
                    )}
                    {['returning', 'settling'].includes(calibration.stage) && (
                      <span>
                        PEAK LOCKED · 已忽略 {calibration.captureMeta?.ignoredReleaseSamples || 0} 个回程/回弹样本
                      </span>
                    )}
                    {calibration.stage === 'captured' && (
                      <span className="is-auto-advance">
                        0.5 SEC · {calibration.stepIndex === SPACEMOUSE_CALIBRATION_STEPS.length - 1
                          ? 'AUTO SAVE'
                          : 'AUTO NEXT CAPTURE'}
                      </span>
                    )}
                    {calibration.issues.map((issue) => <span className="is-error" key={issue}>{issue}</span>)}
                  </div>
                </div>

                {currentStep.type === 'button' ? (
                  <div className="spacemouse-calibration__button-grid" aria-label="实体键标定状态">
                    {['xyz', 'rpy'].map((group) => (
                      <div
                        key={group}
                        className={calibration.buttonDraft[group] ? 'is-captured' : ''}
                        data-button-role={group}
                      >
                        <span>{group === 'xyz' ? 'LEFT / XYZ' : 'RIGHT / RPY'}</span>
                        <strong>{calibration.buttonDraft[group]
                          ? formatButtonMask(calibration.buttonDraft[group])
                          : 'WAITING'}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="spacemouse-calibration__axis-grid" aria-label="校准实时轴信号">
                    {SPACEMOUSE_RAW_AXES.map((axis) => (
                      <div
                        key={axis}
                        className={
                          liveRawMaximum > CENTER_THRESHOLD
                          && Math.abs(rawDisplay[axis] || 0) >= liveAxisThreshold
                            ? 'is-live'
                            : ''
                        }
                      >
                        <span>{rawAxisLabel[axis]}</span>
                        <strong>{Math.round(rawDisplay[axis] || 0)}</strong>
                      </div>
                    ))}
                  </div>
                )}

                <footer>
                  <div className="spacemouse-calibration__manual-actions">
                    <button
                      type="button"
                      className="is-secondary is-back"
                      disabled={calibration.stepIndex === 0}
                      onClick={returnToPreviousStep}
                    >
                      <ChevronLeft size={13} />返回上一步
                    </button>
                    <button type="button" className="is-secondary" onClick={armCurrentStep}>
                      <RefreshCw size={13} />
                      {calibration.stage === 'ready' ? '开始采集' : '重新采集'}
                    </button>
                  </div>
                  {calibration.stage === 'captured' && (
                    <div className="spacemouse-auto-advance" aria-hidden="true">
                      <i><b /></i>
                      <span>{calibration.stepIndex === SPACEMOUSE_CALIBRATION_STEPS.length - 1
                        ? '自动校验保存'
                        : '自动进入下一项'}</span>
                    </div>
                  )}
                </footer>
              </div>
            )}

            {calibration.stage === 'review-error' && (
              <div className="spacemouse-calibration__result is-error">
                <TriangleAlert size={28} />
                <small>PROFILE CHECK FAILED</small>
                <h2>有几项方向需要重录</h2>
                {calibration.issues.map((issue) => <p key={issue}>{issue}</p>)}
                <button type="button" className="spacemouse-calibration__primary" onClick={startCalibration}>
                  <RefreshCw size={13} />从头重新标定
                </button>
              </div>
            )}

            {calibration.stage === 'complete' && (
              <div className="spacemouse-calibration__result">
                <Check size={30} />
                <small>PROFILE READY</small>
                <h2>你的 SpaceMouse 已就绪</h2>
                <p>左右实体键映射、12 个外推峰值动作指纹及解耦矩阵已保存到浏览器本地。左键循环 X / Y / Z，右键循环 YAW / PITCH / ROLL；空间球永远只驱动当前选中轴，双击同一实体键可暂停。</p>
                <div><span>XYZ</span><i /><span>RPY</span></div>
                <button
                  type="button"
                  className="spacemouse-calibration__primary"
                  onClick={() => {
                    requestTransientPointerLock();
                    closeCalibration();
                  }}
                >
                  进入 3D 场景 <ChevronRight size={14} />
                </button>
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
