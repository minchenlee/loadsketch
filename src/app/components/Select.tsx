// Our own dropdown and number field, so they look the same in every browser and theme.
// The menu is rendered in a portal with fixed coordinates, so no panel can clip it.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface Option<T> {
  value: T;
  label: React.ReactNode;
  /** Shorter text for the closed button. Default: label. */
  short?: React.ReactNode;
  hint?: React.ReactNode;
  /** A heading shown above the first option of each group (options of a group are next to each other). */
  group?: string;
}

interface SelectProps<T> {
  value: T | undefined;
  options: Option<T>[];
  onChange: (v: T) => void;
  /** Shown when no option matches `value`. */
  placeholder?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Width of the menu, when it should be wider than the button. */
  menuWidth?: number;
  icon?: React.ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
  title?: string;
}

export function Select<T>({ value, options, onChange, placeholder, disabled, className = '', menuWidth, icon, title, ...aria }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const id = useId();
  const cur = options.findIndex((o) => Object.is(o.value, value));

  const place = () => {
    const r = btn.current!.getBoundingClientRect();
    const width = Math.max(r.width, menuWidth ?? 0);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    // open towards the side with more room (the run bar sits near the bottom of the window)
    if (below >= Math.min(260, options.length * 30 + 10) || below >= above) setPos({ left, top: r.bottom + 4, width, maxH: below - 4 });
    else setPos({ left, bottom: window.innerHeight - r.top + 4, width, maxH: above - 4 });
  };

  const show = () => {
    if (disabled) return;
    place();
    setActive(Math.max(0, cur));
    setOpen(true);
  };
  const pick = (i: number) => {
    setOpen(false);
    btn.current?.focus();
    if (options[i]) onChange(options[i].value);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const reflow = () => setOpen(false);
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('resize', reflow);
    window.addEventListener('blur', reflow);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('blur', reflow);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) (menu.current?.querySelectorAll('[role="option"]')[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    }
  };

  const shown = cur >= 0 ? (options[cur].short ?? options[cur].label) : placeholder;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`field sd-select ${className}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={aria['aria-label']}
        data-testid={aria['data-testid']}
        title={title}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {icon}
        <span className={`min-w-0 flex-1 truncate text-left ${cur < 0 ? 'faint' : ''}`}>{shown}</span>
        <ChevronDown size={13} className="faint shrink-0" />
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={menu}
            id={id}
            role="listbox"
            aria-label={aria['aria-label']}
            className="sd-menu"
            data-up={pos.bottom !== undefined || undefined}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxH }}
            onKeyDown={onKey}
          >
            {options.map((o, i) => [
              o.group && o.group !== options[i - 1]?.group && (
                <li key={`g:${o.group}`} role="presentation" className="sd-menu-group">
                  {o.group}
                </li>
              ),
              <li
                key={String(o.value)}
                role="option"
                aria-selected={i === cur}
                className={`sd-option ${i === active ? 'is-active' : ''}`}
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                <Check size={13} className="shrink-0" style={{ visibility: i === cur ? 'visible' : 'hidden', color: 'var(--accent)' }} />
                <span className="min-w-0 flex-1">
                  {o.label}
                  {o.hint && <span className="faint block text-[13px] leading-snug">{o.hint}</span>}
                </span>
              </li>,
            ])}
          </ul>,
          document.body,
        )}
    </>
  );
}

/**
 * A number field without the browser's spin buttons. Up/Down arrows step by `step`
 * (Shift: ×10). The value is applied while typing when it is a valid number in range.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className = '',
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(String(value));
  }
  const ok = (v: number) => Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <span className={`field sd-number ${disabled ? 'is-disabled' : ''} ${className}`}>
      <input
        id={id}
        aria-label={ariaLabel}
        className="num min-w-0 flex-1 bg-transparent outline-none"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && ok(v)) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          const v = clamp(Math.round((value + d) * 1e6) / 1e6);
          onChange(v);
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="faint pointer-events-none shrink-0 text-[13px]">{suffix}</span>}
    </span>
  );
}
