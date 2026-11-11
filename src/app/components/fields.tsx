// Form fields shared by the settings panel and the scenario editor.
import { useId, useState } from 'react';
import { splitHelp } from '../paramLayout.ts';
import { t } from '../../i18n/index.ts';

/** Shown with up to 4 decimals and no float noise (0.1 × 100 = 10.000000000000002). */
export const show = (v: number) => String(Number(v.toFixed(4)));

/**
 * A number field. A value out of range or not a number is not taken: the field turns red, says
 * the range and keeps what was typed, until it is fixed or Escape restores the value.
 */
export function NumberInput({ value, onChange, min, max, step, labelledBy, unit, label, scale = 1, integer = false }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; labelledBy?: string; unit?: string; label?: string; scale?: number; integer?: boolean }) {
  const [text, setText] = useState(show(value * scale));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(show(value * scale));
  }
  const n = Number(text);
  const lo = min === undefined ? undefined : min * scale;
  const hi = max === undefined ? undefined : max * scale;
  // an integer field does not take a fraction: rounding it would show one value and store another
  const ok = (v: number, raw: string) => raw.trim() !== '' && Number.isFinite(v) && (lo === undefined || v >= lo) && (hi === undefined || v <= hi) && (!integer || Number.isInteger(v / scale));
  const bad = !ok(n, text);
  const errId = useId();
  return (
    <div>
      <div className="relative">
        <input
          className="field num w-full"
          style={{ paddingRight: unit ? `${unit.length * 0.6 + 1}em` : undefined, borderColor: bad ? 'var(--bad)' : undefined }}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (ok(v, e.target.value)) onChange(v / scale);
          }}
          onKeyDown={(e) => e.key === 'Escape' && setText(show(value * scale))}
          step={step}
          aria-labelledby={labelledBy}
          aria-label={label}
          aria-invalid={bad}
          aria-describedby={bad ? errId : undefined}
        />
        {unit && <span className="faint pointer-events-none absolute top-1 right-2 text-[13px]">{unit}</span>}
      </div>
      {bad && (
        <div id={errId} className="mt-0.5 text-[12px]" style={{ color: 'var(--bad-ink)' }} data-testid="range-error">
          {integer && Number.isFinite(n) && text.trim() !== '' && !Number.isInteger(n / scale)
            ? t('請輸入整數')
            : lo !== undefined && hi !== undefined
              ? t('請輸入 {min}–{max}', { min: show(lo), max: show(hi) })
              : t('請輸入數字')}
        </div>
      )}
    </div>
  );
}

/** An on/off switch (role="switch"). */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="sd-switch" onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** Help: the first sentence; the rest behind "more". */
export function Help({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [first, rest] = splitHelp(text);
  return (
    <div className="faint mt-1 text-[13px] leading-snug">
      {first}
      {rest && !open && (
        <>
          {' '}
          <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-[var(--ink)]" onClick={() => setOpen(true)} aria-expanded={false}>
            {t('更多')}
          </button>
        </>
      )}
      {rest && open && <> {rest}</>}
    </div>
  );
}
