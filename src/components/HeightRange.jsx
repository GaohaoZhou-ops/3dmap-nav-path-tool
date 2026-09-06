import { useMemo, useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function HeightRange({ bounds, value, onChange, disabled }) {
  const railRef = useRef(null);
  const dragPointerRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const min = bounds?.min?.z ?? 0;
  const max = bounds?.max?.z ?? 1;
  const span = Math.max(max - min, 0.001);
  const windowSize = useMemo(
    () => clamp(Math.abs(value[1] - value[0]), Math.min(0.01, span), span),
    [span, value],
  );
  const halfWindow = windowSize / 2;
  const centerMin = min + halfWindow;
  const centerMax = max - halfWindow;
  const center = clamp((value[0] + value[1]) / 2, centerMin, centerMax);
  const centerTravel = Math.max(centerMax - centerMin, 0);
  const percentage = centerTravel > 1e-9
    ? ((center - centerMin) / centerTravel) * 100
    : 50;

  const updateCenter = (rawValue) => {
    const next = Number(rawValue);
    if (!Number.isFinite(next)) return;
    const nextCenter = clamp(next, centerMin, centerMax);
    onChange([nextCenter - halfWindow, nextCenter + halfWindow]);
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
    <aside className={`height-range ${disabled ? 'is-disabled' : ''}`} aria-label="Z 轴单一高度条">
      <div className="height-range__title">
        <Layers3 size={14} />
        <span>Z 高度</span>
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
        >
          <div
            className="height-range__selection"
            style={{
              bottom: 0,
              height: `${percentage}%`,
            }}
          />
          <button
            type="button"
            role="slider"
            className={`height-range__handle ${dragging ? 'is-active' : ''} ${percentage <= 0.001 ? 'is-at-min' : ''} ${percentage >= 99.999 ? 'is-at-max' : ''}`}
            style={{ bottom: `${percentage}%` }}
            onKeyDown={(event) => {
              const step = Math.max(span / 160, 0.01);
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
            aria-valuetext={`${center.toFixed(2)} 米，截面 ${value[0].toFixed(2)} 至 ${value[1].toFixed(2)} 米`}
            data-track-percentage={percentage.toFixed(3)}
            data-slice-min={value[0]}
            data-slice-max={value[1]}
            disabled={disabled}
          />
        </div>
        <span className="height-range__bound">{min.toFixed(2)}</span>
      </div>

      <div className="height-range__inputs">
        <label>
          <span>高度</span>
          <input
            type="number"
            step="0.01"
            value={center.toFixed(2)}
            onChange={(event) => updateCenter(event.target.value)}
            disabled={disabled}
          />
        </label>
        <span className="height-range__window">窗宽 {windowSize.toFixed(2)}m</span>
      </div>
    </aside>
  );
}
