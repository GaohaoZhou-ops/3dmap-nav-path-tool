import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';

export default function ViewerMenu({ children, label, title, icon: Icon, align = 'end', isActive = true }) {
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
        left: Math.max(padding, Math.min(
          align === 'start' ? trigger.left : trigger.right - menu.offsetWidth,
          window.innerWidth - menu.offsetWidth - padding,
        )),
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
  }, [open, align]);

  return (
    <div
      className="viewer-menu"
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
        className={`viewer-menu__trigger ${open ? 'is-open' : ''}`}
        aria-label={label}
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
        title={title}
      >
        <Icon size={13} />
        <span>{label}</span>
        <ChevronDown size={11} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="viewer-menu__panel"
          role="dialog"
          aria-label={`3D ${label}`}
          tabIndex={-1}
          style={position}
        >
          <header className="viewer-menu__heading">
            <strong><Icon size={13} /> {label}</strong>
            <button type="button" aria-label={`关闭${label}`} onClick={closeAndFocus}>
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
