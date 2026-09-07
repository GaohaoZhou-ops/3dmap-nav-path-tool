import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Crosshair,
  Focus,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
} from 'lucide-react';
import VectorPointLayer from './VectorPointLayer.jsx';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MAX_ZOOM_MULTIPLIER = 2500;

const niceStep = (raw) => {
  const exponent = Math.floor(Math.log10(Math.max(raw, 0.0001)));
  const fraction = raw / 10 ** exponent;
  const nice = fraction < 2 ? 2 : fraction < 5 ? 5 : 10;
  return nice * 10 ** exponent;
};

const precisionForStep = (step) => clamp(Math.ceil(-Math.log10(step)), 0, 6);

const precisionForScale = (scale) =>
  clamp(Math.ceil(-Math.log10(1 / Math.max(scale, 0.001))) + 1, 2, 6);

const pointOnCurve = (start, control, end, t) => {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
};

export default function Map2DView({
  mapData,
  initialView,
  heightRange,
  waypoints,
  edges,
  mode,
  connectionSourceId,
  selectedWaypointId,
  selectedEdgeId,
  colorMode,
  onAddWaypoint,
  onSelectWaypoint,
  onSelectEdge,
  onConnectTarget,
  onClearSelection,
  onProjectionStats,
  onViewChange,
  focusRequest,
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const workerRef = useRef(null);
  const revisionRef = useRef(0);
  const pointerRef = useRef(null);
  const initializedBoundsRef = useRef('');
  const appliedInitialViewRef = useRef('');
  const focusAnimationRef = useRef(null);
  const viewRef = useRef(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [view, setView] = useState({ centerX: 0, centerY: 0, scale: 1 });
  const [workerReady, setWorkerReady] = useState(false);
  const [projecting, setProjecting] = useState(false);
  const [projection, setProjection] = useState(null);
  const [cursor, setCursor] = useState(null);
  viewRef.current = view;

  const bounds = mapData?.bounds || null;
  const hasCloud = Boolean(mapData?.positions?.length);

  const fitView = useCallback(
    (detail = false) => {
      if (!bounds || size.width < 2 || size.height < 2) return;
      const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
      const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
      const fullScale = Math.min(
        Math.max(size.width - 72, 1) / rangeX,
        Math.max(size.height - 72, 1) / rangeY,
      );
      const scale = detail
        ? Math.min(
            Math.max(size.height - 82, 1) / rangeY,
            fullScale * 4,
          )
        : fullScale;
      setView({
        centerX: (bounds.min.x + bounds.max.x) / 2,
        centerY: (bounds.min.y + bounds.max.y) / 2,
        scale: Math.max(scale, 0.001),
      });
    },
    [bounds, size.height, size.width],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const resize = () => {
      setSize({ width: Math.max(host.clientWidth, 1), height: Math.max(host.clientHeight, 1) });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!bounds || size.width < 2 || size.height < 2) return;
    const key = [
      mapData?.mapId || mapData?.name || '',
      bounds.min.x,
      bounds.min.y,
      bounds.max.x,
      bounds.max.y,
    ].join(':');
    const restoredCenterX = Number(initialView?.centerX);
    const restoredCenterY = Number(initialView?.centerY);
    const restoredScale = Number(initialView?.scale);
    const hasRestoredView =
      Number.isFinite(restoredCenterX)
      && Number.isFinite(restoredCenterY)
      && Number.isFinite(restoredScale)
      && restoredScale > 0;

    if (hasRestoredView) {
      const signature = `${key}:${restoredCenterX}:${restoredCenterY}:${restoredScale}`;
      if (appliedInitialViewRef.current !== signature) {
        const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
        const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
        const fullScale = Math.min(
          Math.max(size.width - 72, 1) / rangeX,
          Math.max(size.height - 72, 1) / rangeY,
        );
        appliedInitialViewRef.current = signature;
        initializedBoundsRef.current = key;
        setView({
          centerX: restoredCenterX,
          centerY: restoredCenterY,
          scale: clamp(restoredScale, fullScale * 0.4, fullScale * MAX_ZOOM_MULTIPLIER),
        });
      }
      return;
    }

    if (initializedBoundsRef.current !== key) {
      initializedBoundsRef.current = key;
      fitView(true);
    }
  }, [bounds, fitView, initialView, mapData?.mapId, mapData?.name, size.height, size.width]);

  useEffect(() => {
    onViewChange?.(view);
  }, [onViewChange, view]);

  const cancelFocusAnimation = useCallback(() => {
    if (!focusAnimationRef.current) return;
    cancelAnimationFrame(focusAnimationRef.current);
    focusAnimationRef.current = null;
    if (hostRef.current) hostRef.current.dataset.synchronizedFocusState = 'interrupted';
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!focusRequest || !bounds || !host || size.width < 2 || size.height < 2) {
      return undefined;
    }
    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    let centerX = null;
    let centerY = null;
    let spanX = 0;
    let spanY = 0;
    if (focusRequest.type === 'waypoint') {
      const point = pointById.get(focusRequest.id);
      if (point) {
        centerX = point.pose.x;
        centerY = point.pose.y;
      }
    } else if (focusRequest.type === 'edge') {
      const edge = edges.find((item) => item.id === focusRequest.id);
      const source = edge ? pointById.get(edge.from) : null;
      const target = edge ? pointById.get(edge.to) : null;
      if (source && target) {
        centerX = (source.pose.x + target.pose.x) / 2;
        centerY = (source.pose.y + target.pose.y) / 2;
        spanX = Math.abs(source.pose.x - target.pose.x);
        spanY = Math.abs(source.pose.y - target.pose.y);
      }
    }
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return undefined;

    cancelFocusAnimation();
    const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
    const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
    const fullScale = Math.min(
      Math.max(size.width - 72, 1) / rangeX,
      Math.max(size.height - 72, 1) / rangeY,
    );
    const pathScale = Math.min(
      spanX > 1e-9 ? Math.max(size.width - 150, 1) / spanX : Number.POSITIVE_INFINITY,
      spanY > 1e-9 ? Math.max(size.height - 130, 1) / spanY : Number.POSITIVE_INFINITY,
    );
    const targetScale = focusRequest.type === 'waypoint'
      ? fullScale * 5
      : Number.isFinite(pathScale) ? pathScale : fullScale * 5;
    const targetView = {
      centerX,
      centerY,
      scale: clamp(targetScale, fullScale * 1.1, fullScale * 8),
    };
    const startView = { ...(viewRef.current || view) };
    const startedAt = performance.now();
    const duration = 520;
    host.dataset.synchronizedFocusType = focusRequest.type;
    host.dataset.synchronizedFocusId = focusRequest.id;
    host.dataset.synchronizedFocusRevision = String(focusRequest.revision);
    host.dataset.synchronizedFocusState = 'animating';

    const animateFocus = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const nextView = {
        centerX: startView.centerX + (targetView.centerX - startView.centerX) * eased,
        centerY: startView.centerY + (targetView.centerY - startView.centerY) * eased,
        scale: startView.scale + (targetView.scale - startView.scale) * eased,
      };
      viewRef.current = nextView;
      setView(nextView);
      host.dataset.synchronizedFocusProgress = progress.toFixed(3);
      if (progress < 1) {
        focusAnimationRef.current = requestAnimationFrame(animateFocus);
      } else {
        focusAnimationRef.current = null;
        host.dataset.synchronizedFocusState = 'settled';
      }
    };
    focusAnimationRef.current = requestAnimationFrame(animateFocus);

    return () => {
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
      }
    };
  }, [bounds, cancelFocusAnimation, focusRequest, size.height, size.width]);

  useEffect(() => {
    setProjection(null);
    setWorkerReady(false);
    const positions = mapData?.positions;
    if (!positions?.length || !bounds) return undefined;

    const worker = new Worker(new URL('../workers/projection.worker.js', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') {
        setWorkerReady(true);
        return;
      }
      if (message.type !== 'projection' || message.revision !== revisionRef.current) return;
      const nextProjection = {
        width: message.width,
        height: message.height,
        zGrid: new Float32Array(message.zGrid),
        selectedCount: message.selectedCount,
      };
      setProjection(nextProjection);
      setProjecting(false);
      onProjectionStats?.({ selectedCount: message.selectedCount });
    };

    const positionCopy = positions.slice();
    const transfers = [positionCopy.buffer];
    worker.postMessage(
      { type: 'init', positions: positionCopy, bounds },
      transfers,
    );

    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [bounds, mapData?.positions, onProjectionStats]);

  useEffect(() => {
    if (!workerReady || !workerRef.current) return undefined;
    setProjecting(true);
    const revision = ++revisionRef.current;
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({
        type: 'project',
        minHeight: heightRange[0],
        maxHeight: heightRange[1],
        revision,
      });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [heightRange, workerReady]);

  const worldToScreen = useCallback(
    (x, y) => ({
      x: (x - view.centerX) * view.scale + size.width / 2,
      y: (view.centerY - y) * view.scale + size.height / 2,
    }),
    [size.height, size.width, view.centerX, view.centerY, view.scale],
  );

  const screenToWorld = useCallback(
    (x, y) => ({
      x: (x - size.width / 2) / view.scale + view.centerX,
      y: view.centerY - (y - size.height / 2) / view.scale,
    }),
    [size.height, size.width, view.centerX, view.centerY, view.scale],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = '#081216';
    context.fillRect(0, 0, size.width, size.height);

    const glow = context.createRadialGradient(
      size.width * 0.52,
      size.height * 0.45,
      10,
      size.width * 0.52,
      size.height * 0.45,
      Math.max(size.width, size.height) * 0.72,
    );
    glow.addColorStop(0, 'rgba(29, 71, 76, .18)');
    glow.addColorStop(1, 'rgba(5, 12, 15, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, size.width, size.height);

    if (!bounds) return;
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(size.width, size.height);
    const step = niceStep(88 / Math.max(view.scale, 0.0001));
    const gridPrecision = precisionForStep(step);
    const firstX = Math.floor(topLeft.x / step) * step;
    const firstY = Math.floor(bottomRight.y / step) * step;

    context.lineWidth = 1;
    context.font = '10px "SFMono-Regular", Menlo, monospace';
    context.textBaseline = 'top';
    for (let x = firstX; x <= bottomRight.x + step; x += step) {
      const screen = worldToScreen(x, 0).x;
      context.strokeStyle = Math.abs(x) < step * 0.01
        ? 'rgba(56, 199, 90, .22)'
        : 'rgba(112,151,154,.09)';
      context.beginPath();
      context.moveTo(screen, 0);
      context.lineTo(screen, size.height);
      context.stroke();
      context.fillStyle = 'rgba(148,178,180,.46)';
      context.fillText(`${x.toFixed(gridPrecision)}m`, screen + 4, 8);
    }
    for (let y = firstY; y <= topLeft.y + step; y += step) {
      const screen = worldToScreen(0, y).y;
      context.strokeStyle = Math.abs(y) < step * 0.01
        ? 'rgba(240, 68, 62, .22)'
        : 'rgba(112,151,154,.09)';
      context.beginPath();
      context.moveTo(0, screen);
      context.lineTo(size.width, screen);
      context.stroke();
    }

    const min = worldToScreen(bounds.min.x, bounds.min.y);
    const max = worldToScreen(bounds.max.x, bounds.max.y);
    const mapLeft = min.x;
    const mapTop = max.y;
    const mapWidth = max.x - min.x;
    const mapHeight = min.y - max.y;

    context.save();
    context.strokeStyle = 'rgba(89, 219, 232, .23)';
    context.setLineDash([5, 6]);
    context.strokeRect(mapLeft, mapTop, mapWidth, mapHeight);
    context.setLineDash([]);
    context.restore();

    const origin = worldToScreen(0, 0);
    context.save();
    const axisPixels = clamp(niceStep(48 / Math.max(view.scale, 0.001)) * view.scale, 42, 76);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.font = '700 10px "SFMono-Regular", Menlo, monospace';
    context.textBaseline = 'middle';

    if (
      origin.x >= 0 &&
      origin.x <= size.width &&
      origin.y >= 0 &&
      origin.y <= size.height
    ) {
      const xEnd = Math.min(origin.x + axisPixels, size.width - 12);
      const yEnd = Math.max(origin.y - axisPixels, 12);

      context.lineWidth = 3;
      context.strokeStyle = '#f0443e';
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      context.lineTo(xEnd, origin.y);
      context.stroke();
      context.fillStyle = '#f0443e';
      context.beginPath();
      context.moveTo(xEnd + 1, origin.y);
      context.lineTo(xEnd - 9, origin.y - 6);
      context.lineTo(xEnd - 9, origin.y + 6);
      context.closePath();
      context.fill();
      context.fillText('X', xEnd - 2, origin.y - 12);

      context.strokeStyle = '#38c75a';
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      context.lineTo(origin.x, yEnd);
      context.stroke();
      context.fillStyle = '#38c75a';
      context.beginPath();
      context.moveTo(origin.x, yEnd - 1);
      context.lineTo(origin.x - 6, yEnd + 9);
      context.lineTo(origin.x + 6, yEnd + 9);
      context.closePath();
      context.fill();
      context.fillText('Y', origin.x + 12, yEnd + 2);

      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(origin.x, origin.y, 4.5, 0, Math.PI * 2);
      context.fillStyle = '#0a1114';
      context.fill();
      context.strokeStyle = '#eef2f4';
      context.stroke();
    }
    context.restore();
  }, [bounds, screenToWorld, size.height, size.width, view.scale, worldToScreen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const wheel = (event) => {
      if (!bounds) return;
      cancelFocusAnimation();
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const before = screenToWorld(cursorX, cursorY);
      const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
      const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
      const fullScale = Math.min((size.width - 50) / rangeX, (size.height - 50) / rangeY);
      const nextScale = clamp(
        view.scale * Math.exp(-event.deltaY * 0.00135),
        fullScale * 0.4,
        fullScale * MAX_ZOOM_MULTIPLIER,
      );
      setView({
        centerX: before.x - (cursorX - size.width / 2) / nextScale,
        centerY: before.y + (cursorY - size.height / 2) / nextScale,
        scale: nextScale,
      });
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [bounds, cancelFocusAnimation, screenToWorld, size.height, size.width, view.scale]);

  const localPointer = (event) => {
    const rect = hostRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event) => {
    if (!bounds) return;
    cancelFocusAnimation();
    const local = localPointer(event);
    pointerRef.current = {
      id: event.pointerId,
      button: event.button,
      startX: local.x,
      startY: local.y,
      centerX: view.centerX,
      centerY: view.centerY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!bounds) return;
    const local = localPointer(event);
    setCursor(screenToWorld(local.x, local.y));
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = local.x - pointer.startX;
    const dy = local.y - pointer.startY;
    if (Math.hypot(dx, dy) > 3) pointer.moved = true;
    const canPan = pointer.button !== 0 || mode === 'select' || mode === 'pan';
    if (pointer.moved && canPan) {
      setView((current) => ({
        ...current,
        centerX: pointer.centerX - dx / current.scale,
        centerY: pointer.centerY + dy / current.scale,
      }));
    }
  };

  const heightAtWorld = (point) => {
    if (!bounds) return (heightRange[0] + heightRange[1]) / 2;
    const positions = mapData?.positions;
    if (positions?.length) {
      const pickRadius = Math.max(8 / Math.max(view.scale, 0.001), 0.001);
      let nearestDistance = pickRadius * pickRadius;
      let nearestHeight = Number.NaN;
      for (let index = 0; index < positions.length; index += 3) {
        const z = positions[index + 2];
        if (z < heightRange[0] || z > heightRange[1]) continue;
        const dx = positions[index] - point.x;
        const dy = positions[index + 1] - point.y;
        const distance = dx * dx + dy * dy;
        if (
          distance <= nearestDistance
          && (
            !Number.isFinite(nearestHeight)
            || distance < nearestDistance
            || z > nearestHeight
          )
        ) {
          nearestDistance = distance;
          nearestHeight = z;
        }
      }
      if (Number.isFinite(nearestHeight)) return nearestHeight;
    }
    if (!projection) return (heightRange[0] + heightRange[1]) / 2;
    const nx = (point.x - bounds.min.x) / Math.max(bounds.max.x - bounds.min.x, 0.001);
    const ny = (bounds.max.y - point.y) / Math.max(bounds.max.y - bounds.min.y, 0.001);
    const originX = clamp(Math.round(nx * (projection.width - 1)), 0, projection.width - 1);
    const originY = clamp(Math.round(ny * (projection.height - 1)), 0, projection.height - 1);
    const sample = (x, y) => projection.zGrid[y * projection.width + x];
    const direct = sample(originX, originY);
    if (Number.isFinite(direct)) return direct;
    for (let radius = 1; radius <= 14; radius += 1) {
      for (let y = Math.max(0, originY - radius); y <= Math.min(projection.height - 1, originY + radius); y += 1) {
        for (let x = Math.max(0, originX - radius); x <= Math.min(projection.width - 1, originX + radius); x += 1) {
          if (Math.abs(x - originX) !== radius && Math.abs(y - originY) !== radius) continue;
          const value = sample(x, y);
          if (Number.isFinite(value)) return value;
        }
      }
    }
    return (heightRange[0] + heightRange[1]) / 2;
  };

  const onPointerUp = (event) => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    if (!pointer || pointer.id !== event.pointerId || pointer.moved || pointer.button !== 0) return;
    const local = localPointer(event);
    const world = screenToWorld(local.x, local.y);
    const inside =
      bounds &&
      world.x >= bounds.min.x &&
      world.x <= bounds.max.x &&
      world.y >= bounds.min.y &&
      world.y <= bounds.max.y;
    if (mode === 'add' && inside) {
      onAddWaypoint({ x: world.x, y: world.y, z: heightAtWorld(world) });
    } else if (mode === 'select') {
      onClearSelection();
    }
  };

  const zoomBy = (factor) => setView((current) => {
    if (!bounds) return current;
    const rangeX = Math.max(bounds.max.x - bounds.min.x, 0.001);
    const rangeY = Math.max(bounds.max.y - bounds.min.y, 0.001);
    const fullScale = Math.min((size.width - 50) / rangeX, (size.height - 50) / rangeY);
    return {
      ...current,
      scale: clamp(
        current.scale * factor,
        fullScale * 0.4,
        fullScale * MAX_ZOOM_MULTIPLIER,
      ),
    };
  });
  const pointById = useMemo(() => new Map(waypoints.map((point) => [point.id, point])), [waypoints]);

  const edgeVisuals = useMemo(() => {
    const edgeKeys = new Set(edges.map((edge) => `${edge.from}:${edge.to}`));
    return edges
      .map((edge) => {
        const source = pointById.get(edge.from);
        const target = pointById.get(edge.to);
        if (!source || !target) return null;
        const startRaw = worldToScreen(source.pose.x, source.pose.y);
        const endRaw = worldToScreen(target.pose.x, target.pose.y);
        const dx = endRaw.x - startRaw.x;
        const dy = endRaw.y - startRaw.y;
        const length = Math.max(Math.hypot(dx, dy), 0.001);
        const ux = dx / length;
        const uy = dy / length;
        const start = { x: startRaw.x + ux * 14, y: startRaw.y + uy * 14 };
        const end = { x: endRaw.x - ux * 17, y: endRaw.y - uy * 17 };
        const hasReverse = edgeKeys.has(`${edge.to}:${edge.from}`);
        // Reversing the edge also flips this normal, so reciprocal routes land
        // on opposite sides and both directed paths remain independently clickable.
        const offset = hasReverse ? 14 : 0;
        const control = {
          x: (start.x + end.x) / 2 - uy * offset,
          y: (start.y + end.y) / 2 + ux * offset,
        };
        const label = pointOnCurve(start, control, end, 0.5);
        return {
          edge,
          path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
          label,
          accessibleLabel: `配置路径 ${source.name || edge.from} 到 ${target.name || edge.to}`,
        };
      })
      .filter(Boolean);
  }, [edges, pointById, worldToScreen]);

  const markerClass = (edge) => {
    if (edge.status === 'connected') return 'connected';
    if (edge.status === 'unreachable') return 'unreachable';
    return 'unchecked';
  };

  const rawOrigin = worldToScreen(0, 0);
  const originMargin = 28;
  const originVisible =
    rawOrigin.x >= originMargin &&
    rawOrigin.x <= size.width - originMargin &&
    rawOrigin.y >= originMargin &&
    rawOrigin.y <= size.height - originMargin;
  const displayedOrigin = originVisible
    ? rawOrigin
    : {
        x: clamp(rawOrigin.x, originMargin, Math.max(originMargin, size.width - originMargin)),
        y: clamp(rawOrigin.y, originMargin, Math.max(originMargin, size.height - originMargin)),
      };
  const originDirection =
    (Math.atan2(rawOrigin.y - size.height / 2, rawOrigin.x - size.width / 2) * 180) /
    Math.PI;
  const centerOrigin = () =>
    setView((current) => ({ ...current, centerX: 0, centerY: 0 }));
  const coordinatePrecision = precisionForScale(view.scale);

  return (
    <div
      ref={hostRef}
      className={`map2d-view mode-${mode}`}
      data-coordinate-origin-style="ros-rviz"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="map2d-canvas" data-layer="coordinate-grid" />
      {mapData?.geometry && (
        <VectorPointLayer
          geometry={mapData.geometry}
          bounds={bounds}
          width={size.width}
          height={size.height}
          view={view}
          heightRange={heightRange}
          colorMode={colorMode}
        />
      )}

      {bounds && (
        <svg className="route-layer" width={size.width} height={size.height} aria-label="有向路径图层">
          <defs>
            {['unchecked', 'connected', 'unreachable', 'selected'].map((kind) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={`arrow-fill ${kind}`} />
              </marker>
            ))}
          </defs>
          {edgeVisuals.map(({ edge, path, label, accessibleLabel }) => {
            const kind = markerClass(edge);
            const selected = edge.id === selectedEdgeId;
            return (
              <g key={edge.id} className={`route-edge ${kind} ${selected ? 'is-selected' : ''}`}>
                <path className="route-edge__visible" d={path} markerEnd={`url(#arrow-${kind})`} />
                <path
                  className="route-edge__hit"
                  d={path}
                  role="button"
                  tabIndex="0"
                  focusable="true"
                  aria-label={accessibleLabel}
                  aria-pressed={selected}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (event.button === 0) onSelectEdge(edge.id);
                  }}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectEdge(edge.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onSelectEdge(edge.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectEdge(edge.id);
                  }}
                />
                <text x={label.x} y={label.y - 8} className="route-edge__label">
                  {edge.limits.maxSpeed.toFixed(1)} m/s
                </text>
              </g>
            );
          })}
        </svg>
      )}

      <div className="waypoint-layer">
        {waypoints.map((point, index) => {
          const screen = worldToScreen(point.pose.x, point.pose.y);
          if (screen.x < -30 || screen.x > size.width + 30 || screen.y < -30 || screen.y > size.height + 30) return null;
          const selected = point.id === selectedWaypointId;
          const source = point.id === connectionSourceId;
          return (
            <button
              type="button"
              key={point.id}
              data-waypoint-id={point.id}
              className={`waypoint-marker ${selected ? 'is-selected' : ''} ${source ? 'is-source' : ''}`}
              style={{ left: screen.x, top: screen.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (mode === 'connect') onConnectTarget(point.id);
                else onSelectWaypoint(point.id);
              }}
              title={`${point.name} · X ${point.pose.x.toFixed(2)} / Y ${point.pose.y.toFixed(2)} / Z ${point.pose.z.toFixed(2)}`}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
            </button>
          );
        })}
      </div>

      {bounds && (
        <button
          type="button"
          className={`map-origin-marker ${originVisible ? '' : 'is-offscreen'}`}
          style={{ left: displayedOrigin.x, top: displayedOrigin.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            centerOrigin();
          }}
          aria-label="二维坐标原点"
          title={originVisible ? '坐标原点 O (0, 0)' : '坐标原点在当前视野外，点击定位'}
        >
          {originVisible ? (
            <span className="ros-origin-core" aria-hidden="true" />
          ) : (
            <>
              <ArrowRight size={13} style={{ transform: `rotate(${originDirection}deg)` }} />
              <span>O</span>
            </>
          )}
        </button>
      )}

      {!bounds && (
        <div className="viewer-placeholder map-placeholder">
          <div className="placeholder-radar"><Crosshair size={34} strokeWidth={1.2} /></div>
          <strong>二维截面尚未生成</strong>
          <span>载入点云后，通过右上方的 Z 截面控制器提取地图</span>
        </div>
      )}

      {hasCloud && (projecting || !projection) && (
        <div className="projection-status">
          <LoaderCircle className="spin" size={14} /> 正在重建截面
        </div>
      )}

      {bounds && (
        <div className="map-zoom-controls" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => zoomBy(1.35)} title="放大" aria-label="放大"><Plus size={15} /></button>
          <button type="button" onClick={() => zoomBy(0.74)} title="缩小" aria-label="缩小"><Minus size={15} /></button>
          <button type="button" onClick={centerOrigin} title="定位坐标原点" aria-label="定位坐标原点"><Crosshair size={15} /></button>
          <button type="button" onClick={() => fitView(true)} title="聚焦地图" aria-label="聚焦地图"><Focus size={15} /></button>
          <button type="button" onClick={() => fitView(false)} title="适配全图" aria-label="适配全图"><Maximize2 size={15} /></button>
        </div>
      )}

      <div className="map2d-readout" data-coordinate-precision={coordinatePrecision}>
        {mapData?.geometry && <span className="map2d-vector-state">LIVE VECTOR</span>}
        <span>
          {cursor
            ? `X ${cursor.x.toFixed(coordinatePrecision)}  Y ${cursor.y.toFixed(coordinatePrecision)}`
            : 'XY PLANE'}
        </span>
        <span className="map2d-scale-readout">{Math.round(view.scale * 100) / 100} px/m</span>
        {projection && <span>{projection.selectedCount.toLocaleString('zh-CN')} POINTS</span>}
      </div>
    </div>
  );
}
