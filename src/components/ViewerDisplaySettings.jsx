import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';

export default function ViewerDisplaySettings({ children, isActive = true }) {
  const menuId = useId();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({});

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!isActive) setOpen(false);
  }, [isActive]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    menuRef.current?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const viewport = triggerRef.current?.closest('.point-cloud-view');
    const updatePosition = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      if (viewport && viewport.getBoundingClientRect().height < 1) {
        setOpen(false);
        return;
      }
      const gap = 8;
      const padding = 12;
      const below = window.innerHeight - trigger.bottom - gap - padding;
      const above = trigger.top - gap - padding;
      const placeAbove = below < menu.scrollHeight && above > below;
      const maxHeight = Math.max(0, placeAbove ? above : below);
      setPosition({
        left: Math.max(padding, Math.min(trigger.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - padding)),
        top: placeAbove ? trigger.top - gap - Math.min(menu.offsetHeight, maxHeight) : trigger.bottom + gap,
        maxHeight,
      });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(triggerRef.current);
    if (viewport) observer.observe(viewport);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <div
      className="viewer-display-settings"
      onBlur={(event) => {
        if (!triggerRef.current?.contains(event.relatedTarget) && !menuRef.current?.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open) return;
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAndFocus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`viewer-display-settings__trigger ${open ? 'is-open' : ''}`}
        aria-label="显示设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
        title="点云颜色、显示密度与网格质量"
      >
        <SlidersHorizontal size={13} />
        <span>显示设置</span>
        <ChevronDown size={11} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="viewer-display-settings__menu"
          role="dialog"
          aria-label="3D 显示设置"
          tabIndex={-1}
          style={position}
        >
          <header className="viewer-display-settings__heading">
            <strong><SlidersHorizontal size={13} /> 显示设置</strong>
            <button type="button" aria-label="关闭显示设置" onClick={closeAndFocus}>
              <X size={13} />
            </button>
          </header>
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
