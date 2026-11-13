// Find the limit of the canvas design (roadmap-next M18): steady traffic, raised step by step until the
// design stops meeting the limits (src/engine/limit.ts, in src/worker/limit.worker.ts). Each step shows
// as it ends; cancel ends the worker. The answer is "under these assumptions it holds up to about X",
// with the limits and the assumptions it rests on, said the way the CLI says it (limitConclusion()).
// The result is not kept as a version.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, CircleX, Hourglass, TrendingUp, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { useExit, useModal } from '../modal.ts';
import { assumptionsOf, sloOf, type Design, type Scenario } from '../../core/index.ts';
import { limitConclusion } from '../../i18n/importReport.ts';
import { limitProblems, limitReply, NO_WORK, type LimitState } from '../findLimit.ts';
import { importMessage } from '../../i18n/importMessages.ts';
import { getLang, t, tx } from '../../i18n/index.ts';
import type { LimitReply, LimitRequest } from '../../worker/limit.worker.ts';

const VERDICT = { pass: tx('撐得住'), fail: tx('撐不住'), insufficient: tx('結果不足') } as const;

type State = LimitState;

export function FindLimit({ onClose }: { onClose: () => void }) {
  const [closing, exit] = useExit(onClose);
  // closing ends the search at once, not after the exit animation
  const close = () => {
    if (worker.current) stop(worker.current);
    exit();
  };
  const box = useRef<HTMLDivElement>(null);
  useModal(box, close);
  // the canvas as it was when the dialog opened
  const [{ design, scenario }] = useState<{ design: Design; scenario: Scenario }>(() => {
    const st = useApp.getState();
    return { design: st.design(), scenario: structuredClone(st.scenario) };
  });
  // a design that does not run has no limit to find (the only check before a run); a search where no
  // step failed and nothing did work says so at the end (searchCanvas())
  const [problems] = useState(() => limitProblems(design, scenario));
  const [s, setS] = useState<State>(() => (problems.length ? { phase: 'invalid', steps: [], problems } : { phase: 'running', steps: [] }));
  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    if (problems.length) return;
    const w = new Worker(new URL('../../worker/limit.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    // a reply already queued when the search was cancelled or closed changes nothing
    w.onmessage = (ev: MessageEvent<LimitReply>) => {
      const r = ev.data;
      setS((x) => limitReply(x, r));
      if (r.type !== 'step') stop(w);
    };
    // a worker that cannot start or load: say why (as the compare view does), not an unhandled page error
    w.onerror = (ev) => {
      ev.preventDefault();
      setS((x) => (x.phase === 'running' ? { ...x, phase: 'error', error: ev.message || t('無法啟動') } : x));
      stop(w);
    };
    const req: LimitRequest = { lang: getLang(), design, scenario };
    w.postMessage(req);
    return () => stop(w);
  }, [design, scenario, problems]);

  const cancel = () => {
    if (worker.current) stop(worker.current);
    setS((x) => (x.phase === 'running' ? { ...x, phase: 'cancelled' } : x));
  };

  const slo = sloOf();
  const background = design.nodes.some((n) => n.kind === 'queue');
  const events = scenario.events?.length ?? 0;
  const assumptions = useMemo(() => assumptionsOf(design), [design]);
  const name = (id: string) => {
    const n = design.nodes.find((x) => x.id === id);
    return n?.label && n.label !== id ? t('{label}（{id}）', { label: n.label, id }) : id;
  };
  const sorted = [...s.steps].sort((a, b) => a.rps - b.rps);
  // the steps that ran scaled down (src/engine/scale.ts): near full load they wait longer than full size
  const ks = s.noWork ? [] : [...new Set(s.steps.map((x) => x.k).filter((k) => k > 1))].sort((a, b) => a - b);

  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('找上限')} className="panel sd-dialog flex max-h-[92vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="find-limit">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <TrendingUp size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('找上限')}</div>
          <button className="btn ml-auto" onClick={close} aria-label={t('關閉')} autoFocus>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[14px] leading-relaxed">
          <p>{t('用穩定的流量，從每秒 1 個請求開始加倍，撐不住以後再往回找。每一步都先暖機，量測一段時間，再停掉流量看能不能做完。')}</p>
          <div data-testid="find-limit-conditions">
            <div className="mb-1 font-medium">{t('達標條件：')}</div>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{t('前台 p99 ≤ {ms} ms', { ms: slo.p99Ms })}</li>
              <li>{t('前台失敗率 ≤ {p}%', { p: slo.errorRate * 100 })}</li>
              {background && <li>{t('背景失敗率 ≤ {p}%（進 DLQ 或過期都算失敗）', { p: slo.asyncFailRate * 100 })}</li>}
              <li>{t('流量停止後 {s} 秒內做完', { s: slo.drainS })}</li>
            </ul>
          </div>
          <p className="muted" data-testid="find-limit-traffic">
            {t('流量：沿用目前情境「{name}」的設定（讀取比例、逾時、seed 等），每秒請求數由搜尋決定。不含情境裡的事件（尖峰、漸增、故障等）。', { name: t(scenario.name || '自訂') })}
            {events > 0 && ` ${t('這個情境有 {n} 個事件，找上限時都拿掉。', { n: events })}`}
          </p>

          <div className="border-t border-[var(--line)] pt-3" aria-live="polite" data-testid="find-limit-progress">
            {s.phase === 'running' && (
              <div className="flex items-center gap-1.5" data-testid="find-limit-running">
                <Hourglass size={14} className="muted shrink-0" />
                {t('第 {n} 步執行中…', { n: s.steps.length + 1 })}
              </div>
            )}
            {s.phase === 'cancelled' && <p data-testid="find-limit-cancelled">{t('已取消：跑完 {n} 步，沒有結論。', { n: s.steps.length })}</p>}
            {s.phase === 'invalid' && (
              <div data-testid="find-limit-problems">
                <div className="mb-1 font-medium">{t('不能找上限，要先改：')}</div>
                <ul className="space-y-1">
                  {s.problems!.map((p, i) => (
                    <li key={i} className="flex gap-1.5">
                      <CircleX size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--bad)' }} />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {s.phase === 'error' && (
              <p style={{ color: 'var(--bad-ink)' }} data-testid="find-limit-error">
                {t('找上限失敗：{e}', { e: s.error ?? '' })}
              </p>
            )}
            {s.noWork && (
              <p className="font-medium" data-testid="find-limit-no-work">
                {NO_WORK()}
              </p>
            )}
            {s.result && !s.noWork && (
              <div className="space-y-1 font-medium" data-testid="find-limit-result">
                {limitConclusion(s.result, name).map((x, i) => (
                  <p key={i}>{x}</p>
                ))}
                {s.result.firstFailRps === undefined && !s.result.stopped && (
                  <p className="font-normal" data-testid="find-limit-no-fail">
                    {t('搜尋到每秒 {rps} 個請求就停了，這不是上限：設計可能撐得更多，也可能是有會壞的地方沒有被模擬到。', { rps: Math.max(...s.result.steps.map((x) => x.rps)) })}
                  </p>
                )}
              </div>
            )}
            {!!sorted.length && !s.noWork && s.phase !== 'invalid' && (
              <ul className="mt-2 space-y-0.5 text-[13px]" data-testid="find-limit-steps">
                {sorted.map((x) => (
                  <li key={x.rps} className="flex gap-1.5" data-verdict={x.verdict}>
                    {x.verdict === 'pass' ? <CircleCheck size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--ok)' }} /> : x.verdict === 'fail' ? <CircleX size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--bad)' }} /> : <TriangleAlert size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--warn)' }} />}
                    <span className="num">{t('{rps}/秒', { rps: x.rps })}</span>
                    <span>{t(VERDICT[x.verdict])}</span>
                    {x.k > 1 && <span className="faint num" title={t('這一步用 1/{k} 的流量和容量模擬，再把數字乘回來', { k: x.k })}>1/{x.k}</span>}
                    {x.verdict === 'fail' && (
                      <span className="faint min-w-0 truncate">
                        {x.failed.map(criterionName).join('、')}
                        {x.bottleneck ? ` · ${t('最忙的是 {node}', { node: name(x.bottleneck) })}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-[var(--line)] pt-3" data-testid="find-limit-assumptions">
            {ks.length > 0 && (
              <p data-testid="find-limit-scale">
                {t('這次用縮小比例模擬（{ks}）：流量和容量都縮成 1/k 再把數字乘回來。接近滿載時，縮小後的等待時間比原尺寸長，所以上限可能偏保守。', { ks: ks.map((k) => `1/${k}`).join('、') })}
              </p>
            )}
            {assumptions.length ? (
              <>
                <p>{importMessage('limit.assumptions', { n: assumptions.length })}</p>
                <ul className="mt-1 max-h-[160px] list-disc space-y-0.5 overflow-y-auto pl-5 text-[13px]">
                  {assumptions.map((a) => (
                    <li key={`${a.node}.${a.param}`}>
                      <code>
                        {a.node}.{a.param}
                      </code>{' '}
                      = {a.value}
                      {a.from ? <span className="faint">（{a.from}）</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">{t('假設：每個元件的速度和容量就是畫布上填的值。實際系統的數字不同，上限也會不同。')}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
          {s.phase === 'running' ? (
            <button className="btn" onClick={cancel} data-testid="find-limit-cancel">
              {t('取消')}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={close} data-testid="find-limit-close">
              {t('關閉')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const CRITERION: Record<string, string> = {
  'simulate.p99': tx('p99 太慢'),
  'simulate.errorRate': tx('失敗太多'),
  'simulate.asyncFail': tx('背景失敗'),
  'simulate.asyncP99': tx('背景太慢'),
  'simulate.asyncNoSample': tx('背景沒有成功的訊息'),
  'simulate.drain': tx('停掉流量後做不完'),
};
const criterionName = (id: string) => (CRITERION[id] ? t(CRITERION[id]) : id);

/** End a worker and drop its handlers, so nothing it already sent is read. */
function stop(w: Worker) {
  w.onmessage = null;
  w.onerror = null;
  w.terminate();
}
