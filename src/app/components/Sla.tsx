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
  return s.nines === Infinity ? t('沒有失敗') : t('{n} 個 9', { n: s.nines.toFixed(1) });
}

function downtimeText(min: number): string {
  const { n, unit } = downtimeParts(min);
  return unit === 's' ? t('{n} 秒', { n }) : unit === 'min' ? t('{n} 分鐘', { n }) : unit === 'h' ? t('{n} 小時', { n }) : t('{n} 天', { n });
}

/** Budget used: a percentage, or "806 倍" when it is far over (80589% is hard to read). */
const usedText = (s: Sla) =>
  s.budgetUsed >= 10 ? t('{x} 倍', { x: Math.round(s.budgetUsed) }) : `${s.budgetUsed < 0.1 && s.budgetUsed > 0 ? (s.budgetUsed * 100).toFixed(1) : Math.round(s.budgetUsed * 100)}%`;

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
  if (!s.availabilityMet) return t('未達 {target}', { target: fmtTarget(slo.target) });
  if (s.latencyMet === false) return t('p99 未達 {ms} ms', { ms: slo.p99Ms });
  return t('達到 {target}', { target: fmtTarget(slo.target) });
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
        <span className="muted text-[13px]">{t('可用性')}</span>
        <span className="num text-[16px] font-semibold" style={{ color }}>
          {fmtAvail(s.availability!)}
        </span>
        <span className="faint num text-[13px]">{ninesText(s)}</span>
        <span className="ml-auto text-[13px]" style={{ color }}>
          {verdict(s, slo)}
        </span>
      </div>
      <div className="faint text-[13px]">
        {t('錯誤預算用掉 {used}，相當於每月停機 {down}', { used: usedText(s), down: downtimeText(s.downtimeMinPerMonth) })}
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
      <div className="text-[15px] font-semibold">{t('服務水準（SLO）')}</div>
      <div className="mt-1.5 grid grid-cols-2 gap-2 text-[13px]">
        <label className="muted">
          {t('可用性目標')}
          <Select
            className="mt-0.5 w-full"
            value={slo.target}
            options={SLO_TARGETS.map((x) => ({ value: x, label: fmtTarget(x) }))}
            onChange={(v) => set({ target: v })}
            aria-label={t('可用性目標')}
          />
        </label>
        <label className="muted">
          {t('p99 目標（0 表示不設）')}
          <NumberField className="mt-0.5 w-full" value={slo.p99Ms} min={0} max={60000} step={10} suffix="ms" onChange={(v) => set({ p99Ms: v })} aria-label={t('p99 目標')} />
        </label>
      </div>
      <ul className="mt-2 space-y-1.5 text-[14px] leading-snug">
        <li>
          <span className="font-medium" style={{ color }}>
            {t('可用性 {a}（{nines}）', { a: fmtAvail(s.availability), nines: ninesText(s) })}
          </span>
          <span className="muted block">{t('成功的請求 ÷ 全部請求（不算暖機）。99% 是 2 個 9，99.9% 是 3 個 9。')}</span>
        </li>
        <li>
          <span className="font-medium">{t('錯誤預算用掉 {used}', { used: usedText(s) })}</span>
          <span className="muted block">
            {t('目標 {target} 代表每 {n} 個請求可以失敗 1 個，這就是錯誤預算。超過 100% 就是沒達到目標。', { target: fmtTarget(slo.target), n: allowed.toLocaleString() })}
          </span>
        </li>
        <li>
          <span className="font-medium">{t('相當於每月停機 {down}', { down: downtimeText(s.downtimeMinPerMonth) })}</span>
          <span className="muted block">{t('把失敗的比例換算成一個月（30 天）完全停機的時間。99.9% 約是每月 43 分鐘。')}</span>
        </li>
        {s.latencyMet !== null && (
          <li data-testid="sla-latency">
            <span className="font-medium" style={{ color: s.latencyMet ? 'var(--ok-ink)' : 'var(--bad-ink)' }}>
              {s.latencyMet
                ? t('延遲目標達到：p99 ≤ {ms} ms', { ms: slo.p99Ms })
                : s.windows
                  ? t('延遲目標未達：{slow} / {n} 秒的 p99 超過 {ms} ms', { slow: s.slowWindows, n: s.windows, ms: slo.p99Ms })
                  : t('延遲目標未達：整場的 p99 超過 {ms} ms', { ms: slo.p99Ms })}
            </span>
            <span className="muted block">{t('太慢的秒數，最多只能和錯誤預算一樣多（目標 {target}，就是最多 {share} 的秒數）。可用性和延遲都達到，才算達到 SLO。', { target: fmtTarget(slo.target), share: fmtTarget(1 - slo.target) })}</span>
          </li>
        )}
        <li data-testid="sla-windows">
          <span className="font-medium">{t('{g} / {n} 秒達到目標', { g: s.goodWindows, n: s.windows })}</span>
          <span className="muted block">
            {slo.p99Ms > 0
              ? t('每一秒各算一次：失敗比例不超過預算，而且 p99 不超過 {ms} ms（有 {slow} 秒太慢）。', { ms: slo.p99Ms, slow: s.slowWindows })
              : t('每一秒各算一次：失敗比例不超過預算。整場平均達標，也可能有幾秒很糟。')}
          </span>
        </li>
        {s.worstBurn && (
          <li>
            <span className="font-medium">{t('燒最快的一秒：第 {t} 秒，{r} 倍速', { t: Math.round(s.worstBurn.t), r: s.worstBurn.rate < 10 ? s.worstBurn.rate.toFixed(1) : Math.round(s.worstBurn.rate) })}</span>
            <span className="muted block">{t('燒錯誤預算的速度（burn rate）：1 倍速剛好在期限內用完預算。照 Google SRE 的做法，1 小時內平均超過 14.4 倍速就該叫人起床處理。')}</span>
          </li>
        )}
      </ul>
      <div className="faint mt-2 text-[13px] leading-relaxed">
        {t('SLI 是量到的數字（這裡是可用性）；SLO 是團隊自己訂的目標；SLA 是對客戶的承諾，沒做到要賠償，通常比 SLO 寬鬆。')}
      </div>
    </section>
  );
}
