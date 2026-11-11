// A button that opens a menu of actions (the file menu and the "more" menu of the top bar).
// The menu is rendered in a portal with fixed coordinates, as the Select menu is.
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
  title?: string;
  'data-testid'?: string;
  /** A rule above this item. */
  sep?: boolean;
}

interface MenuProps {
  items: MenuItem[];
  children: React.ReactNode;
  className?: string;
  /** The menu's right edge is on the button's right edge. */
  align?: 'end';
  'aria-label': string;
  'data-testid'?: string;
  title?: string;
}

export function Menu({ items, children, className = 'btn', align, title, ...aria }: MenuProps) {
  const [pos, setPos] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = pos !== null;

  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    setPos(align === 'end' ? { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 } : { left: Math.max(8, r.left), top: r.bottom + 4 });
  };
  const hide = (focus = true) => {
    setPos(null);
    if (focus) btn.current?.focus();
  };
  const entries = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const away = (e: Event) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || btn.current?.contains(t)) return;
      setPos(null);
    };
    const shut = () => setPos(null);
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', shut);
    window.addEventListener('blur', shut);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('blur', shut);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return hide();
    }
    if (e.key === 'Tab') return hide(false);
    const all = entries();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i <= 0 ? all.length - 1 : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    all[to]?.focus();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={aria['aria-label']}
        data-testid={aria['data-testid']}
        title={title}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') {
            e.preventDefault();
            show();
          }
        }}
      >
        {children}
      </button>
      {pos &&
        createPortal(
          <div ref={menu} id={id} role="menu" aria-label={aria['aria-label']} className="sd-menu" data-end={align === 'end' || undefined} style={{ ...pos, minWidth: 190 }} onKeyDown={onKey}>
            {items.map((it, i) => [
              it.sep && <div key={`s${i}`} role="separator" className="sd-menu-sep" />,
              <button
                key={i}
                type="button"
                role="menuitem"
                className="sd-option"
                title={it.title}
                data-testid={it['data-testid']}
                onPointerEnter={(e) => e.currentTarget.focus()}
                onClick={() => {
                  hide();
                  it.onSelect();
                }}
              >
                {it.icon}
                <span className="min-w-0 flex-1">{it.label}</span>
              </button>,
            ])}
          </div>,
          document.body,
        )}
    </>
  );
}
