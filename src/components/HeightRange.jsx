import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function HeightRange({ bounds, value, onChange, disabled }) {
  const railRef = useRef(null);
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
  const percentage = ((center - min) / span) * 100;

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
    updateCenter(min + ratio * span);
  };

  useEffect(() => {
    if (!dragging) return undefined;

    const move = (event) => {
      updateFromPointer(event);
    };
    const stop = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [dragging, centerMax, centerMin, halfWindow, min, onChange, span]);

  const startDragging = (event) => {
    if (disabled) return;
    updateFromPointer(event);
    setDragging(true);
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
            className={`height-range__handle ${dragging ? 'is-active' : ''}`}
            style={{ bottom: `${percentage}%` }}
            onPointerDown={(event) => {
              event.stopPropagation();
              setDragging(true);
            }}
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
            aria-valuetext={`${center.toFixed(2)} 米，截面窗口 ${windowSize.toFixed(2)} 米`}
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
