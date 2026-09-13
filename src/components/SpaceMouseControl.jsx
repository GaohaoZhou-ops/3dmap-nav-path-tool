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
  SPACEMOUSE_CALIBRATION_STEPS,
  SPACEMOUSE_CAPTURE_STRATEGY,
  SPACEMOUSE_RAW_AXES,
  SPACEMOUSE_SUPPORTED_PRODUCT_IDS,
  SPACEMOUSE_VENDOR_ID,
  applySpaceMouseProfile,
  createSpaceMouseProfile,
  isSupportedSpaceMouseDevice,
  loadSpaceMouseProfile,
  parseSpaceMouseInputReport,
  saveSpaceMouseProfile,
  spaceMouseConnectionLabel,
  validateSpaceMouseCalibration,
  zeroSpaceMouseAxes,
  zeroSpaceMouseControlAxes,
} from '../lib/spaceMouse.js';

const CENTER_THRESHOLD = 28;
const MOTION_THRESHOLD = 62;
const AUTO_ADVANCE_DELAY_MS = 1000;
const CAPTURE_SAMPLE_LIMIT = 480;
const PEAK_ENVELOPE_RATIO = 0.7;
const PEAK_DIRECTION_COSINE = 0.72;
const RETURN_FREEZE_RATIO = 0.62;
const RETURN_DIRECTION_COSINE = 0.28;
const CENTER_SETTLE_MS = 160;
const CONTROL_BUTTON_DOUBLE_PRESS_MIN_MS = 70;
const CONTROL_BUTTON_DOUBLE_PRESS_MAX_MS = 460;

const hexId = (value) => `0x${Number(value || 0).toString(16).padStart(4, '0')}`;
const rawAxisLabel = {
  x: 'TX',
  y: 'TY',
  z: 'TZ',
  rx: 'RX',
  ry: 'RY',
  rz: 'RZ',
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
  captured: null,
  captureMeta: null,
  issues: [],
});

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
  const controlEnabledRef = useRef(true);
  const rawAxesRef = useRef(zeroSpaceMouseAxes());
  const buttonMaskRef = useRef(0);
  const lastControlButtonPressRef = useRef({ button: 0, timestamp: -Infinity });
  const displayFrameRef = useRef(null);
  const captureRef = useRef(null);
  const calibrationFrameRef = useRef(null);
  const pendingCalibrationAxesRef = useRef(zeroSpaceMouseAxes());
  const captureSettleTimerRef = useRef(null);
  const calibrationRef = useRef(initialCalibration());
  const mountedRef = useRef(true);

  const [status, setStatus] = useState(() => (
    typeof navigator !== 'undefined' && navigator.hid ? 'idle' : 'unsupported'
  ));
  const [open, setOpen] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [profile, setProfile] = useState(() => loadSpaceMouseProfile());
  const [mode, setMode] = useState('xyz');
  const [controlEnabled, setControlEnabled] = useState(true);
  const [rawDisplay, setRawDisplay] = useState(() => zeroSpaceMouseAxes());
  const [signalActive, setSignalActive] = useState(false);
  const [lastError, setLastError] = useState('');
  const [calibration, setCalibration] = useState(initialCalibration);

  profileRef.current = profile;
  modeRef.current = mode;
  calibrationRef.current = calibration;

  const publishInput = useCallback((patch = {}) => {
    if (!inputRef) return;
    const current = inputRef.current || {};
    const patchTimestamp = Number(patch.timestamp) || performance.now();
    const rawMotionActive = patch.rawAxes
      && maxRawMagnitude(patch.rawAxes) > CENTER_THRESHOLD;
    inputRef.current = {
      ...current,
      ...patch,
      lastMotionTimestamp: rawMotionActive
        ? patchTimestamp
        : Number(current.lastMotionTimestamp || 0),
      revision: Number(current.revision || 0) + 1,
    };
  }, [inputRef]);

  useEffect(() => {
    publishInput({ calibrating: calibration.open });
  }, [calibration.open, publishInput]);

  const publishStopped = useCallback((connected = false) => {
    publishInput({
      connected,
      calibrated: Boolean(profileRef.current),
      controlEnabled: controlEnabledRef.current,
      mode: modeRef.current,
      axes: zeroSpaceMouseControlAxes(),
      rawAxes: copyAxes(rawAxesRef.current),
      timestamp: performance.now(),
    });
  }, [publishInput]);

  const setControlMode = useCallback((nextMode, source = 'ui') => {
    const normalized = nextMode === 'rpy' ? 'rpy' : 'xyz';
    const wasPaused = !controlEnabledRef.current;
    controlEnabledRef.current = true;
    modeRef.current = normalized;
    setControlEnabled(true);
    setMode(normalized);
    const axes = profileRef.current
      ? applySpaceMouseProfile(rawAxesRef.current, profileRef.current)
      : zeroSpaceMouseControlAxes();
    publishInput({
      connected: Boolean(deviceRef.current?.opened),
      calibrated: Boolean(profileRef.current),
      controlEnabled: true,
      mode: normalized,
      modeSource: source,
      axes,
      rawAxes: copyAxes(rawAxesRef.current),
      timestamp: performance.now(),
    });
    if (wasPaused && source !== 'calibration') {
      onNotify?.(
        `SpaceMouse 控制已恢复 · ${normalized === 'rpy' ? 'RPY' : 'XYZ'}`,
        'success',
      );
    }
  }, [onNotify, publishInput]);

  const pauseControl = useCallback((source = 'physical-button-double-press') => {
    if (!controlEnabledRef.current) return;
    controlEnabledRef.current = false;
    setControlEnabled(false);
    publishInput({
      connected: Boolean(deviceRef.current?.opened),
      calibrated: Boolean(profileRef.current),
      controlEnabled: false,
      mode: modeRef.current,
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
    lastControlButtonPressRef.current = isDoublePress
      ? { button: 0, timestamp: -Infinity }
      : { button, timestamp: now };
    if (isDoublePress) {
      pauseControl(`${source}-double-press`);
      return;
    }
    setControlMode(nextMode, source);
  }, [pauseControl, setControlMode]);

  const scheduleDisplay = useCallback((axes) => {
    if (displayFrameRef.current) return;
    displayFrameRef.current = requestAnimationFrame(() => {
      displayFrameRef.current = null;
      if (!mountedRef.current) return;
      const nextAxes = copyAxes(axes);
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
    if (!capture) return;
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

  const handleInputReport = useCallback((event) => {
    const report = parseSpaceMouseInputReport(event.reportId, event.data);
    if (report.translation) Object.assign(rawAxesRef.current, report.translation);
    if (report.rotation) Object.assign(rawAxesRef.current, report.rotation);

    if (report.buttons !== null) {
      const previous = buttonMaskRef.current;
      const pressed = report.buttons & ~previous;
      buttonMaskRef.current = report.buttons;
      if (pressed & 0x1) handleControlButtonPress(0x1, 'xyz', 'left-button');
      else if (pressed & 0x2) handleControlButtonPress(0x2, 'rpy', 'right-button');
    }

    if (!report.translation && !report.rotation) return;
    const rawAxes = copyAxes(rawAxesRef.current);
    scheduleDisplay(rawAxes);
    scheduleCalibrationInput(rawAxes);
    const currentProfile = profileRef.current;
    publishInput({
      connected: true,
      calibrated: Boolean(currentProfile),
      controlEnabled: controlEnabledRef.current,
      mode: modeRef.current,
      axes: currentProfile && controlEnabledRef.current
        ? applySpaceMouseProfile(rawAxes, currentProfile)
        : zeroSpaceMouseControlAxes(),
      rawAxes,
      timestamp: performance.now(),
    });
  }, [handleControlButtonPress, publishInput, scheduleCalibrationInput, scheduleDisplay]);

  const detachDevice = useCallback(async ({ close = false, disconnected = false } = {}) => {
    const device = deviceRef.current;
    if (device && inputHandlerRef.current) {
      device.removeEventListener('inputreport', inputHandlerRef.current);
    }
    inputHandlerRef.current = null;
    deviceRef.current = null;
    rawAxesRef.current = zeroSpaceMouseAxes();
    buttonMaskRef.current = 0;
    lastControlButtonPressRef.current = { button: 0, timestamp: -Infinity };
    controlEnabledRef.current = true;
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
  }, [clearCaptureSettleTimer, clearScheduledCalibrationInput, publishStopped]);

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
    lastControlButtonPressRef.current = { button: 0, timestamp: -Infinity };
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
      calibrated: Boolean(profileRef.current),
      controlEnabled: true,
      mode: modeRef.current,
      axes: zeroSpaceMouseControlAxes(),
      rawAxes: zeroSpaceMouseAxes(),
      timestamp: performance.now(),
      device: info,
    });
    const needsPeakCaptureRefresh = profileRef.current
      && profileRef.current.captureStrategy !== SPACEMOUSE_CAPTURE_STRATEGY;
    if (!profileRef.current || needsPeakCaptureRefresh) {
      setCalibration({ ...initialCalibration(), open: true });
    }
    if (announce) {
      onNotify?.(
        needsPeakCaptureRefresh
          ? 'SpaceMouse 采集策略已升级，请重新标定以过滤松手回弹'
          : 'SpaceMouse 已连接，普通鼠标与键盘仍可同时使用',
        needsPeakCaptureRefresh ? 'warning' : 'success',
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
      if (displayFrameRef.current) cancelAnimationFrame(displayFrameRef.current);
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
    const centered = maxRawMagnitude(rawAxesRef.current) <= CENTER_THRESHOLD;
    captureRef.current = {
      stepIndex,
      phase: centered ? 'armed' : 'centering',
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
      stage: centered ? 'armed' : 'centering',
      draft: reset ? {} : current.draft,
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
    const validation = validateSpaceMouseCalibration(current.draft);
    if (!validation.valid) {
      setCalibration({ ...current, stage: 'review-error', issues: validation.issues });
      return;
    }
    try {
      const nextProfile = createSpaceMouseProfile(current.draft, deviceInfo);
      const persisted = saveSpaceMouseProfile(nextProfile);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      setControlMode('xyz', 'calibration');
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
  }, [deviceInfo, onNotify, setControlMode]);

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
  const calibrated = Boolean(profile);
  const peakCaptureReady = profile?.captureStrategy === SPACEMOUSE_CAPTURE_STRATEGY;
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
      data-spacemouse-control-enabled={controlEnabled ? 'true' : 'false'}
      data-spacemouse-button-gesture="single-enable,same-button-double-pause"
      data-spacemouse-double-press-window={`${CONTROL_BUTTON_DOUBLE_PRESS_MIN_MS}-${CONTROL_BUTTON_DOUBLE_PRESS_MAX_MS}ms`}
      data-spacemouse-signal={signalActive ? 'active' : 'idle'}
      data-spacemouse-product-id={deviceInfo ? hexId(deviceInfo.productId) : ''}
      data-spacemouse-calibration-model={profile?.calibrationModel || ''}
      data-spacemouse-capture-strategy={profile?.captureStrategy || ''}
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
          if (connected) setOpen((current) => !current);
          else requestDevice();
        }}
      >
        <StatusIcon
          className={status === 'requesting' || status === 'connecting' ? 'is-spinning' : ''}
          size={15}
        />
        <span>3D 鼠标</span>
        {connected && <i>{controlEnabled ? mode.toUpperCase() : 'PAUSE'}</i>}
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
                  onClick={() => setControlMode('xyz', 'panel')}
                >
                  <Move3D size={14} />
                  <span><b>左键 · XYZ</b><small>前后穿行 / 左右 / 上下</small></span>
                </button>
                <button
                  type="button"
                  className={mode === 'rpy' ? (controlEnabled ? 'is-active' : 'is-standby') : ''}
                  aria-pressed={mode === 'rpy'}
                  onClick={() => setControlMode('rpy', 'panel')}
                >
                  <Rotate3D size={14} />
                  <span><b>右键 · RPY</b><small>翻滚 / 俯仰 / 偏航</small></span>
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
                      ? '用户习惯已加载'
                      : calibrated ? '采集策略已升级，请重新标定' : '首次使用需要校准'}</strong>
                  <span>{!controlEnabled
                    ? '设备与校准保持在线 · 单击任意实体键立即恢复'
                    : peakCaptureReady
                      ? `峰值锁定 · 单主轴输出 · 六维解算 · 平均 ${Number(profile?.activeAxisAverage || 1).toFixed(1)} 轴/动作`
                      : calibrated
                        ? '旧配置可能包含松手回弹，完成一次标定即可替换'
                        : '采集完整六维动作指纹后即可驱动 3D 视角'}</span>
                </div>
              </div>

              <div className="spacemouse-menu__actions">
                <button type="button" onClick={() => setCalibration({ ...initialCalibration(), open: true })}>
                  <RefreshCw size={12} />{calibrated ? '重新标定' : '开始标定'}
                </button>
                <button type="button" onClick={() => detachDevice({ close: true })}>
                  <Unplug size={12} />断开
                </button>
              </div>
              <p className="spacemouse-coexist-note">实体键单击立即启用对应模式，双击同一实体键暂停；SpaceMouse 只执行最强语义轴，缩放始终由鼠标滚轮控制。</p>
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
                <small>12-DIRECTION CALIBRATION</small>
                <h2>按你的手感定义每个方向</h2>
                <p>采用 +X 前进、+Y 向左、+Z 向上的坐标语义，分别记录 XYZ 与 RPY 六个方向。每次只表达当前目标意图，系统只锁定外推动作的峰值平台；一旦检测到回程便冻结记录，松手回弹不会参与语义计算。空间球联动多个原始传感轴是正常现象，整个标定期间 3D 视角会保持静止。</p>
                <div className="spacemouse-calibration__rules">
                  <span><b>01</b>平稳推至舒适峰值</span>
                  <span><b>02</b>完成动作后自然松手</span>
                  <span><b>03</b>回弹信号自动丢弃</span>
                </div>
                <button type="button" className="spacemouse-calibration__primary" onClick={startCalibration}>
                  开始 12 项标定 <ChevronRight size={15} />
                </button>
              </div>
            )}

            {!['intro', 'complete', 'review-error'].includes(calibration.stage) && currentStep && (
              <div className="spacemouse-calibration__workbench">
                <div className="spacemouse-calibration__progress">
                  <span>{String(calibration.stepIndex + 1).padStart(2, '0')} / 12</span>
                  <i><b style={{ width: `${((calibration.stepIndex + 1) / 12) * 100}%` }} /></i>
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
                      {calibration.stage === 'armed' && '已就绪，请执行上方动作'}
                      {calibration.stage === 'sampling' && '正在锁定外推动作峰值'}
                      {calibration.stage === 'returning' && '峰值已冻结，请松手回中'}
                      {calibration.stage === 'settling' && '正在过滤回弹，请保持松手'}
                      {calibration.stage === 'captured' && (
                        calibration.stepIndex === SPACEMOUSE_CALIBRATION_STEPS.length - 1
                          ? '全部方向已捕获 · 即将校验保存'
                          : '方向已捕获 · 即将采集下一项'
                      )}
                      {calibration.stage === 'capture-error' && '有效动作信号不足'}
                    </strong>
                    {calibration.captured && (
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
                        1.0 SEC · {calibration.stepIndex === SPACEMOUSE_CALIBRATION_STEPS.length - 1
                          ? 'AUTO SAVE'
                          : 'AUTO NEXT CAPTURE'}
                      </span>
                    )}
                    {calibration.issues.map((issue) => <span className="is-error" key={issue}>{issue}</span>)}
                  </div>
                </div>

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
                        : '自动进入下一方向'}</span>
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
                <p>12 个外推峰值动作指纹及解耦矩阵已保存到浏览器本地，松手回程与回弹信号已排除。左键选择 XYZ，右键选择 RPY；双击同一实体键可暂停，暂停后单击任意实体键立即恢复。</p>
                <div><span>XYZ</span><i /><span>RPY</span></div>
                <button type="button" className="spacemouse-calibration__primary" onClick={closeCalibration}>
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
