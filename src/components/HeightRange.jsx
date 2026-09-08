import { useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';
import { getSliceControlBounds } from '../lib/sliceRange.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function HeightRange({ bounds, value, onChange, disabled }) {
  const railRef = useRef(null);
  const dragPointerRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const controlBounds = getSliceControlBounds(bounds);
  const {
    min,
    max,
    cloudMin,
    cloudMax,
    margin,
    hasCloudBounds,
  } = controlBounds;
  const controlSpan = Math.max(max - min, 0);
  const minimumWindow = controlSpan > 0
    ? Math.min(Math.max(controlSpan / 1000, 0.01), controlSpan)
    : 0;
  const requestedLow = Number(value?.[0]);
  const requestedHigh = Number(value?.[1]);
  const rawLow = Number.isFinite(requestedLow) ? requestedLow : min;
  const rawHigh = Number.isFinite(requestedHigh) ? requestedHigh : max;
  const clampedLow = clamp(Math.min(rawLow, rawHigh), min, max);
  const clampedHigh = clamp(Math.max(rawLow, rawHigh), min, max);
  const windowSize = controlSpan > 0
    ? clamp(clampedHigh - clampedLow, minimumWindow, controlSpan)
    : 0;
  const halfWindow = windowSize / 2;
  const centerMin = min + halfWindow;
  const centerMax = max - halfWindow;
  const requestedCenter = (clampedLow + clampedHigh) / 2;
  const center = centerMax >= centerMin
    ? clamp(requestedCenter, centerMin, centerMax)
    : (min + max) / 2;
  const sliceMin = center - halfWindow;
  const sliceMax = center + halfWindow;
  const centerTravel = Math.max(centerMax - centerMin, 0);
  const percentage = centerTravel > 1e-9
    ? ((center - centerMin) / centerTravel) * 100
    : 50;
  const rangeBottom = controlSpan > 1e-9 ? ((sliceMin - min) / controlSpan) * 100 : 0;
  const rangePercentage = controlSpan > 1e-9 ? (windowSize / controlSpan) * 100 : 100;
  const spanPercentage = controlSpan > minimumWindow
    ? ((windowSize - minimumWindow) / (controlSpan - minimumWindow)) * 100
    : 100;
  const cloudMinPercentage = controlSpan > 1e-9
    ? ((cloudMin - min) / controlSpan) * 100
    : 0;
  const cloudMaxPercentage = controlSpan > 1e-9
    ? ((cloudMax - min) / controlSpan) * 100
    : 100;

  const rangeForCenterAndSize = (rawCenter, rawSize) => {
    if (controlSpan <= 1e-9) return [min, max];
    const nextSize = clamp(Number(rawSize), minimumWindow, controlSpan);
    const half = nextSize / 2;
    const nextCenter = clamp(Number(rawCenter), min + half, max - half);
    return [nextCenter - half, nextCenter + half];
  };

  const updateCenter = (rawValue) => {
    const next = Number(rawValue);
    if (!Number.isFinite(next)) return;
    onChange(rangeForCenterAndSize(next, windowSize));
  };

  const updateSpan = (rawValue) => {
    const next = Number(rawValue);
    if (!Number.isFinite(next)) return;
    onChange(rangeForCenterAndSize(center, next));
  };

  const updateFromPointer = (event) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = clamp((rect.bottom - event.clientY) / rect.height, 0, 1);
    updateCenter(centerMin + ratio * centerTravel);
  };

  const startDragging = (event) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    dragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.target.closest('button')?.focus({ preventScroll: true });
    updateFromPointer(event);
    setDragging(true);
  };

  const continueDragging = (event) => {
    if (!dragging || dragPointerRef.current !== event.pointerId) return;
    updateFromPointer(event);
  };

  const stopDragging = (event) => {
    if (dragPointerRef.current !== event.pointerId) return;
    updateFromPointer(event);
    dragPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  return (
    <aside
      className={`height-range ${disabled ? 'is-disabled' : ''}`}
      aria-label="Z 轴截面范围控制器"
      title={hasCloudBounds
        ? `控制范围 ${min.toFixed(2)} 至 ${max.toFixed(2)} m；琥珀刻线为点云边界`
        : undefined}
      data-slice-mode="range"
      data-slice-min={sliceMin}
      data-slice-max={sliceMax}
      data-slice-span={windowSize}
      data-cloud-min={cloudMin}
      data-cloud-max={cloudMax}
      data-control-min={min}
      data-control-max={max}
      data-control-margin={margin}
    >
      <div className="height-range__title">
        <Layers3 size={14} />
        <span>Z 截面</span>
      </div>

      <div className="height-range__meter">
        <span className="height-range__bound">{max.toFixed(2)}</span>
        <div
          className="height-range__rail"
          ref={railRef}
          onPointerDown={startDragging}
          onPointerMove={continueDragging}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          data-center-min={centerMin}
          data-center-max={centerMax}
          data-control-min={min}
          data-control-max={max}
        >
          <div
            className="height-range__selection"
            style={{
              bottom: `${rangeBottom}%`,
              height: `${rangePercentage}%`,
            }}
          />
          {hasCloudBounds && (
            <>
              <span
                className="height-range__cloud-limit is-min"
                style={{ bottom: `${cloudMinPercentage}%` }}
                title={`点云下限 ${cloudMin.toFixed(2)} m`}
              />
              <span
                className="height-range__cloud-limit is-max"
                style={{ bottom: `${cloudMaxPercentage}%` }}
                title={`点云上限 ${cloudMax.toFixed(2)} m`}
              />
            </>
          )}
          <button
            type="button"
            role="slider"
            className={`height-range__handle ${dragging ? 'is-active' : ''} ${percentage <= 0.001 ? 'is-at-min' : ''} ${percentage >= 99.999 ? 'is-at-max' : ''}`}
            style={{ bottom: `${percentage}%` }}
            onKeyDown={(event) => {
              const step = Math.max(controlSpan / 160, 0.01);
              if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                event.preventDefault();
                updateCenter(center + step);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                event.preventDefault();
                updateCenter(center - step);
              } else if (event.key === 'Home') {
                event.preventDefault();
                updateCenter(centerMin);
              } else if (event.key === 'End') {
                event.preventDefault();
                updateCenter(centerMax);
              }
            }}
            aria-label="截面中心高度"
            aria-valuemin={centerMin}
            aria-valuemax={centerMax}
            aria-valuenow={center}
            aria-valuetext={`${center.toFixed(2)} 米，截面 ${sliceMin.toFixed(2)} 至 ${sliceMax.toFixed(2)} 米`}
            data-track-percentage={percentage.toFixed(3)}
            data-slice-min={sliceMin}
            data-slice-max={sliceMax}
            data-slice-span={windowSize}
            disabled={disabled || controlSpan <= 1e-9}
          />
        </div>
        <span className="height-range__bound">{min.toFixed(2)}</span>
      </div>

      <div className="height-range__inputs">
        <label className="height-range__center-input">
          <span>中心</span>
          <input
            type="number"
            aria-label="截面中心高度数值"
            step="0.01"
            value={center.toFixed(2)}
            onChange={(event) => updateCenter(event.target.value)}
            disabled={disabled || controlSpan <= 1e-9}
          />
        </label>
        <label className="height-range__span-control">
          <span className="height-range__span-label">
            <b>跨度</b>
            <output>{windowSize.toFixed(2)}m</output>
          </span>
          <input
            type="range"
            aria-label="截面高度跨度"
            min={minimumWindow}
            max={controlSpan || 1}
            step={Math.min(Math.max(controlSpan / 10000, 0.001), 0.1)}
            value={windowSize}
            onChange={(event) => updateSpan(event.target.value)}
            onKeyDown={(event) => {
              const step = Math.max(controlSpan / 200, 0.01);
              if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault();
                updateSpan(windowSize + step);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault();
                updateSpan(windowSize - step);
              } else if (event.key === 'Home') {
                event.preventDefault();
                updateSpan(minimumWindow);
              } else if (event.key === 'End') {
                event.preventDefault();
                updateSpan(controlSpan);
              }
            }}
            style={{ '--span-progress': `${spanPercentage}%` }}
            disabled={disabled || controlSpan <= minimumWindow}
          />
        </label>
      </div>
    </aside>
  );
}
