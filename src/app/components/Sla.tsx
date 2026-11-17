// Service level of a run: availability against the SLO, the error budget and how fast it burned.
// A short card under the numbers at the bottom; the full explanation in the Learn tab.
import { useMemo } from 'react';
import { useApp } from '../store.ts';
import { downtimeParts, fmtAvail, sla, SLO_TARGETS, type Sla, type Slo } from '../../learn/sla.ts';
import type { RunData } from '../../learn/metrics.ts';
import type { SimResult, WindowStat } from '../../engine/index.ts';
import { NumberField, Select } from './Select.tsx';
import { t } from '../../i18n/index.ts';

const fmtTarget = (x: number) => `${Number((x * 100).toFixed(2))}%`;

function ninesText(s: Sla): string {
  return s.nines === Infinity ? t('no failures') : t('{n} nines', { n: s.nines.toFixed(1) });
}

function downtimeText(min: number): string {
  const { n, unit } = downtimeParts(min);
  return unit === 's' ? t('{n} s', { n }) : unit === 'min' ? t('{n} min', { n }) : unit === 'h' ? t('{n} h', { n }) : t('{n} days', { n });
}

/** Budget used: a percentage, or "806 倍" when it is far over (80589% is hard to read). */
const usedText = (s: Sla) =>
  s.budgetUsed >= 10 ? t('{x}×', { x: Math.round(s.budgetUsed) }) : `${s.budgetUsed < 0.1 && s.budgetUsed > 0 ? (s.budgetUsed * 100).toFixed(1) : Math.round(s.budgetUsed * 100)}%`;

function useLiveSla(): Sla | null {
  const windows = useApp((s) => s.windows);
  const result = useApp((s) => s.result);
  const status = useApp((s) => s.status);
  const slo = useApp((s) => s.slo);
  return useMemo(() => {
    const ws = windows.filter((w) => w.measured);
    const out = sla(ws, slo, status === 'done' ? result : null);
    return out.availability === null ? null : out;
  }, [windows, result, status, slo]);
}

/** "達到 99.9%", or which objective was missed. */
function verdict(s: Sla, slo: Slo): string {
  if (!s.availabilityMet) return t('Missed {target}', { target: fmtTarget(slo.target) });
  if (s.latencyMet === false) return t('p99 over {ms} ms', { ms: slo.p99Ms });
  return t('Met {target}', { target: fmtTarget(slo.target) });
}

/** One card under the numbers at the bottom: availability, nines, target and budget. */
export function SlaSummary() {
  const s = useLiveSla();
  const slo = useApp((st) => st.slo);
  if (!s) return null;
  const color = s.met ? 'var(--ok-ink)' : 'var(--bad-ink)';
  return (
    <div className="card mt-2 px-2 py-1.5 text-[14px] leading-snug" data-testid="sla-summary">
      <div className="flex items-baseline gap-1.5">
        <span className="muted text-[13px]">{t('Availability')}</span>
        <span className="num text-[16px] font-semibold" style={{ color }}>
          {fmtAvail(s.availability!)}
        </span>
        <span className="faint num text-[13px]">{ninesText(s)}</span>
        <span className="ml-auto text-[13px]" style={{ color }}>
          {verdict(s, slo)}
        </span>
      </div>
      <div className="faint text-[13px]">
        {t('Error budget used: {used}, same as {down} of downtime a month', { used: usedText(s), down: downtimeText(s.downtimeMinPerMonth) })}
      </div>
    </div>
  );
}

const SECTION = 'border-t border-[var(--line)] pt-3 mt-4 first:mt-0 first:border-t-0 first:pt-0';

/** The Learn tab: the SLO setting and every number, each with what it means. */
export function SlaSection({ run }: { run: RunData }) {
  const slo = useApp((st) => st.slo);
  const setSlo = useApp((st) => st.setSlo);
  const s = useMemo(() => sla(run.windows.filter((w: WindowStat) => w.measured), slo, run.result as SimResult), [run, slo]);
  if (s.availability === null) return null;
  const color = s.met ? 'var(--ok-ink)' : 'var(--bad-ink)';
  const set = (patch: Partial<Slo>) => setSlo({ ...slo, ...patch });
  const allowed = Math.round(1 / s.budget);
  return (
    <section className={SECTION} data-testid="sla">
      <div className="text-[15px] font-semibold">{t('Service level (SLO)')}</div>
      <div className="mt-1.5 grid grid-cols-2 gap-2 text-[13px]">
        <label className="muted">
          {t('Availability target')}
          <Select
            className="mt-0.5 w-full"
            value={slo.target}
            options={SLO_TARGETS.map((x) => ({ value: x, label: fmtTarget(x) }))}
            onChange={(v) => set({ target: v })}
            aria-label={t('Availability target')}
          />
        </label>
        <label className="muted">
          {t('p99 target (0: none)')}
          <NumberField className="mt-0.5 w-full" value={slo.p99Ms} min={0} max={60000} step={10} suffix="ms" onChange={(v) => set({ p99Ms: v })} aria-label={t('p99 target')} />
        </label>
      </div>
      <ul className="mt-2 space-y-1.5 text-[14px] leading-snug">
        <li>
          <span className="font-medium" style={{ color }}>
            {t('Availability {a} ({nines})', { a: fmtAvail(s.availability), nines: ninesText(s) })}
          </span>
          <span className="muted block">{t('Successful requests ÷ all requests (without the warm-up). 99% is 2 nines, 99.9% is 3 nines.')}</span>
        </li>
        <li>
          <span className="font-medium">{t('Error budget used: {used}', { used: usedText(s) })}</span>
          <span className="muted block">
            {t('A target of {target} allows 1 failed request in every {n}: that is the error budget. Over 100% means the target was missed.', { target: fmtTarget(slo.target), n: allowed.toLocaleString() })}
          </span>
        </li>
        <li>
          <span className="font-medium">{t('Same as {down} of downtime a month', { down: downtimeText(s.downtimeMinPerMonth) })}</span>
          <span className="muted block">{t('The failed share as full downtime in a month (30 days). 99.9% is about 43 minutes a month.')}</span>
        </li>
        {s.latencyMet !== null && (
          <li data-testid="sla-latency">
            <span className="font-medium" style={{ color: s.latencyMet ? 'var(--ok-ink)' : 'var(--bad-ink)' }}>
              {s.latencyMet
                ? t('Latency objective met: p99 ≤ {ms} ms', { ms: slo.p99Ms })
                : s.windows
                  ? t('Latency objective missed: in {slow} / {n} seconds the p99 was over {ms} ms', { slow: s.slowWindows, n: s.windows, ms: slo.p99Ms })
                  : t('Latency objective missed: the p99 of the run was over {ms} ms', { ms: slo.p99Ms })}
            </span>
            <span className="muted block">{t('Slow seconds may be at most the error budget (a {target} target allows {share} of the seconds). The SLO is met only when availability and latency are both met.', { target: fmtTarget(slo.target), share: fmtTarget(1 - slo.target) })}</span>
          </li>
        )}
        <li data-testid="sla-windows">
          <span className="font-medium">{t('{g} of {n} seconds met the target', { g: s.goodWindows, n: s.windows })}</span>
          <span className="muted block">
            {slo.p99Ms > 0
              ? t('Each second is judged on its own: its failed share is within the budget and its p99 is at most {ms} ms ({slow} seconds were too slow).', { ms: slo.p99Ms, slow: s.slowWindows })
              : t('Each second is judged on its own: its failed share is within the budget. A run can meet the target on average and still have a few bad seconds.')}
          </span>
        </li>
        {s.worstBurn && (
          <li>
            <span className="font-medium">{t('Fastest burn: second {t}, {r}×', { t: Math.round(s.worstBurn.t), r: s.worstBurn.rate < 10 ? s.worstBurn.rate.toFixed(1) : Math.round(s.worstBurn.rate) })}</span>
            <span className="muted block">{t('How fast the error budget burns (burn rate): at 1× the budget lasts exactly the whole period. Google SRE pages someone when the burn rate averages over 14.4× for an hour.')}</span>
          </li>
        )}
      </ul>
      <div className="faint mt-2 text-[13px] leading-relaxed">
        {t('The SLI is what is measured (here: availability). The SLO is the target the team sets. The SLA is a promise to customers, with a penalty when it is missed; it is usually looser than the SLO.')}
      </div>
    </section>
  );
}
