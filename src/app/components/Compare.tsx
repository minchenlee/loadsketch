// The compare view (roadmap-next M2, Q6–Q8, Q11): up to 4 runs side by side. One is the baseline;
// the others show how much they differ from it, and what changed in their design. Desktop also
// overlays their failure share and p99 over time (from a run again; phones show the table only).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, GitCompareArrows, Link, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { METRICS, delta, overlay, rerunDiffers, type CompareItem, type RunSeries } from '../compare.ts';
import { describeChange, describeScenarioChange, diffDesigns, diffScenarios } from '../designDiff.ts';
import type { VersionSummary } from '../versions.ts';
import type { CompareReply, CompareRequest } from '../../worker/compare.worker.ts';
import { useExit, useModal } from '../modal.ts';
import { usePhone } from '../phone.ts';
import { PALETTE } from '../ui.ts';
import { Chart } from './Chart.tsx';
import { useCauseHidden } from './OnCall.tsx';
import { fmtWhen } from './Versions.tsx';
import { copyLink, encodeCompare, MAX_SHARE_COMPARE } from '../share.ts';
import { getLang, t } from '../../i18n/index.ts';

type Again = { summary: VersionSummary; series: RunSeries } | { error: string };

/** Runs every item again in a worker; the results arrive one by one. */
function useRunsAgain(items: CompareItem[]): (Again | undefined)[] {
  const [again, setAgain] = useState<(Again | undefined)[]>(() => items.map(() => undefined));
  useEffect(() => {
    const w = new Worker(new URL('../../worker/compare.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<CompareReply>) => {
      const r = ev.data;
      setAgain((a) => a.map((x, i) => (i === r.i ? ('error' in r ? { error: r.error } : { summary: r.summary, series: r.series }) : x)));
    };
    const req: CompareRequest = { lang: getLang(), runs: items.map((x) => ({ design: x.design, scenario: x.scenario })) };
    w.postMessage(req);
    return () => w.terminate();
  }, [items]);
  return again;
}

export function CompareHost() {
  const items = useApp((s) => s.compare);
  if (!items) return null;
  return <CompareDialog items={items} onClose={() => useApp.getState().closeCompare()} />;
}

function CompareDialog({ items, onClose }: { items: CompareItem[]; onClose: () => void }) {
  const [closing, close] = useExit(onClose);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, close);
  const phone = usePhone();
  const hidden = useCauseHidden();
  const [baseKey, setBase] = useState(items[0].key);
  const base = items.find((x) => x.key === baseKey) ?? items[0];
  const again = useRunsAgain(items);
  const summaryOf = (i: number): VersionSummary | undefined => {
    const a = again[i];
    return items[i].summary ?? (a && 'summary' in a ? a.summary : undefined);
  };
  const baseIndex = items.indexOf(base);
  const baseSummary = summaryOf(baseIndex);

  // other scenarios than the baseline's: the numbers are not like for like (Q8=A)
  const scenarioDiffs = useMemo(() => items.map((x) => (x === base ? [] : diffScenarios(base.scenario, x.scenario))), [items, base]);
  const mixed = scenarioDiffs.some((d) => d.length > 0);
  const designDiffs = useMemo(() => items.map((x) => (x === base ? [] : diffDesigns(base.design, x.design))), [items, base]);

  const series = again.map((a) => (a && 'series' in a ? a.series : undefined));
  const colors = items.map((_, i) => PALETTE[i % PALETTE.length]);
  // A, B, C, D: versions often share the design's name
  const letter = (i: number) => String.fromCharCode(65 + i);
  const title = (i: number) => `${letter(i)} · ${items[i].name}`;
  const chartSeries = items.map((x, i) => ({ label: x === base ? t('{name}（基準）', { name: letter(i) }) : letter(i), color: colors[i], dash: x === base }));
  const stale = items.some((x, i) => {
    const a = again[i];
    return x.summary && a && 'summary' in a && rerunDiffers(x.summary, a.summary);
  });
  const metrics = METRICS;

  // a link to this comparison: the baseline first (Q9=A: at most 2 runs)
  const [shared, setShared] = useState(false);
  const canShare = items.length <= MAX_SHARE_COMPARE;
  const share = async () => {
    const runs = [base, ...items.filter((x) => x !== base)].map((x) => ({ name: x.name, design: x.design, scenario: x.scenario }));
    const r = await copyLink(await encodeCompare(runs));
    if (r.long) useApp.setState({ error: t('分享連結很長（{n} 個字元），有些聊天軟體會截斷。大的設計建議用「存成 JSON」分享。', { n: r.url.length }) });
    if (!r.copied) useApp.setState({ error: t('不能寫入剪貼簿：連結已放在網址列，從那裡複製。') });
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  };

  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('比較版本')} className="panel sd-dialog flex max-h-[92vh] w-[min(1200px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="compare">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <GitCompareArrows size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('比較版本')}</div>
          <div className="muted sd-desk text-[13px]">{t('標著「基準」的那一欄是起點；其他欄顯示和它差多少。')}</div>
          <button
            className="btn ml-auto"
            onClick={() => void share()}
            disabled={!canShare}
            title={canShare ? t('複製一個連結，打開就是這組比較') : t('分享連結最多帶 {n} 個版本：只勾 {n} 個再比較，就能分享。', { n: MAX_SHARE_COMPARE })}
            data-testid="compare-share"
          >
            {shared ? <Check size={14} /> : <Link size={14} />} <span className="sd-desk">{shared ? t('已複製') : t('分享')}</span>
          </button>
          <button className="btn" onClick={close} aria-label={t('關閉')} autoFocus>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {mixed && (
            <div className="card mb-3 flex items-start gap-2 px-3 py-2 text-[14px]" style={{ borderColor: 'color-mix(in srgb, var(--warn) 55%, var(--line))' }} data-testid="compare-mixed">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warn-ink)' }} />
              <div>
                <span className="font-semibold">{t('情境不同，數字不能直接比。')}</span> {t('差異是設計和情境一起造成的；下面列出每個版本的情境改了什麼。')}
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]" data-testid="compare-table">
              <thead>
                <tr>
                  <th className="w-[96px]" />
                  {items.map((x, i) => (
                     <th key={x.key} className="min-w-[160px] border-b border-[var(--line)] px-2 pb-2 text-left align-bottom font-normal" data-testid="compare-col">
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors[i] }} />
                        <span className="truncate font-semibold" title={x.name}>{title(i)}</span>
                      </div>
                      <div className="faint mt-0.5 text-[12px]">
                        {x.at !== undefined ? <span className="num">{fmtWhen(x.at)} · </span> : null}
                        {x.scenario.name ? t(x.scenario.name) : t('自訂')}
                      </div>
                      <div className="mt-1">
                        {x === base ? (
                          <span className="sd-pill" style={{ '--pill': 'var(--accent)' } as React.CSSProperties} data-testid="compare-base">{t('基準')}</span>
                        ) : (
                          <button className="faint text-[12px] hover:underline" onClick={() => setBase(x.key)} data-testid="compare-set-base">{t('設為基準')}</button>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.key} data-testid={`compare-row-${m.key}`}>
                    <th className="muted whitespace-nowrap border-b border-[var(--line)] py-1.5 pr-3 text-left font-normal">{t(m.label)}</th>
                    {items.map((x, i) => {
                      const s = summaryOf(i);
                      const d = s && baseSummary && x !== base ? delta(m, baseSummary[m.key], s[m.key]) : null;
                      return (
                        <td key={x.key} className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                          <span className="num font-medium">{s ? m.fmt(s[m.key]) : t('計算中…')}</span>
                          {d && (
                            <span className="num ml-2 text-[13px]" style={{ color: d.tone === 'better' ? 'var(--ok-ink)' : d.tone === 'worse' ? 'var(--bad-ink)' : 'var(--ink-3)' }} data-tone={d.tone}>
                              {d.text}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!hidden && (
                  <tr data-testid="compare-row-bottleneck">
                    <th className="muted whitespace-nowrap py-1.5 pr-3 text-left align-top font-normal">{t('瓶頸')}</th>
                    {items.map((x, i) => {
                      const s = summaryOf(i);
                      return (
                        <td key={x.key} className="px-2 py-1.5 align-top text-[13px] leading-snug">
                          {s ? (s.bottleneck ? s.bottleneck.label : t('沒有')) : t('計算中…')}
                        </td>
                      );
                    })}
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!phone && (
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="compare-charts">
              <Chart testId="compare-chart-fail" title={t('失敗率（每秒）')} data={overlay(series, 'failShare')} series={chartSeries} height={180} yMax={1.05} unit="%" />
              <Chart testId="compare-chart-p99" title={t('p99（成功的請求）')} data={overlay(series, 'p99')} series={chartSeries} height={180} unit="ms" />
            </div>
          )}
          {!phone && again.some((a) => a === undefined) && <div className="faint mt-1 text-[13px]" data-testid="compare-running">{t('重跑每個版本來畫圖…')}</div>}
          {stale && <div className="faint mt-1 text-[13px]" data-testid="compare-stale">{t('有的版本是舊版模擬器跑的：圖是現在重跑的結果，可能和表上的數字略有不同。')}</div>}
          {again.map((a, i) => a && 'error' in a ? <div key={i} className="mt-1 text-[13px]" style={{ color: 'var(--bad-ink)' }}>{t('「{name}」重跑失敗：{why}', { name: title(i), why: a.error })}</div> : null)}

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="compare-diffs">
            {items.map((x, i) => {
              if (x === base) return null;
              const dd = designDiffs[i];
              const sd = scenarioDiffs[i];
              return (
                <section key={x.key} data-testid="compare-diff">
                  <h3 className="mb-1 flex items-center gap-1.5 text-[14px] font-semibold">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colors[i] }} />
                    {t('「{name}」和基準比，改了哪裡', { name: title(i) })}
                  </h3>
                  {!dd.length && !sd.length ? (
                    <div className="faint text-[13px]">{t('設計和情境都一樣。')}</div>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-5 text-[13px] leading-snug">
                      {dd.map((c, j) => (
                        <li key={`d${j}`}>{describeChange(c)}</li>
                      ))}
                      {sd.map((c, j) => (
                        <li key={`s${j}`} style={{ color: 'var(--warn-ink)' }}>{describeScenarioChange(c)}</li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
