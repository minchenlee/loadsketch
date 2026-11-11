// The cost of a finished run (#68) and the constraint problems in the Learn tab. A problem loads
// its starting design and scenario onto the canvas; every run of that scenario is judged against the
// error rate, p99, budget and complexity limits, and a passed run scores higher when it is cheaper.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronUp, CircleCheck, CircleX, Lightbulb, Target, Trophy } from 'lucide-react';
import { KINDS } from '../../schema/kinds.ts';
import type { Design } from '../../schema/design.ts';
import { localizeDesign } from '../../i18n/content.ts';
import { t, tx } from '../../i18n/index.ts';
import { sameScenario } from '../../learn/lesson.ts';
import type { RunData } from '../../learn/metrics.ts';
import { costOf, fmtUsd, type Cost } from '../../learn/cost.ts';
import { PROBLEMS, PROBLEM_BY_ID, judgeProblem, type Check, type Problem, type ProblemVerdict } from '../../learn/constraints.ts';
import { applyPatches } from '../../learn/oncall.ts';
import { EXAMPLES, useApp } from '../store.ts';
import { fmtMs } from '../ui.ts';
import { PracticeItem } from './PracticeItem.tsx';

const SECTION = 'border-t border-[var(--line)] pt-3 mt-4';
const BEST_KEY = 'loadsketch-constraints';

function loadBest(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}

interface ConstraintState {
  /** The problem loaded on the canvas. */
  id: string | null;
  /** useApp's load count after the problem loaded: another load ends the problem. */
  loads: number;
  best: Record<string, number>;
  start: (id: string) => void;
  record: (id: string, score: number) => void;
  quit: () => void;
}

export const useConstraints = create<ConstraintState>((set, get) => ({
  id: null,
  loads: -1,
  best: loadBest(),
  start: (id) => {
    const p = PROBLEM_BY_ID[id];
    if (!p) return;
    const app = useApp.getState();
    // in the current language: a language change builds it again to swap the text
    const build = () => ({ ...applyPatches(localizeDesign(structuredClone(EXAMPLES[p.example])), p.start), name: t(p.title) });
    app.load(build(), build);
    app.setScenario(structuredClone(p.scenario));
    set({ id, loads: useApp.getState().loads });
  },
  record: (id, score) => {
    const best = get().best;
    if (score <= (best[id] ?? 0)) return;
    const next = { ...best, [id]: score };
    set({ best: next });
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  },
  quit: () => set({ id: null, loads: -1 }),
}));

// another design loaded (an example, a file, an incident): the problem is over, so it judges
// no run on a design it did not load
useApp.subscribe((s, prev) => {
  const c = useConstraints.getState();
  if (s.loads !== prev.loads && c.id && c.loads !== s.loads) c.quit();
});

/** The finished run, when there is one. */
function useRun(): RunData | null {
  const result = useApp((s) => s.result);
  const ran = useApp((s) => s.ran);
  const windows = useApp((s) => s.windows);
  const status = useApp((s) => s.status);
  return useMemo(() => (result && ran && status === 'done' ? { design: ran.design, scenario: ran.scenario, result, windows } : null), [result, ran, windows, status]);
}

/** The verdict of the last run when it ran the problem's scenario. */
function useVerdict(): ProblemVerdict | null {
  const id = useConstraints((s) => s.id);
  const run = useRun();
  return useMemo(() => {
    const p = id ? PROBLEM_BY_ID[id] : undefined;
    if (!p || !run || !sameScenario(run.scenario, p.scenario)) return null;
    return judgeProblem(p, run.design, run);
  }, [id, run]);
}

/** Saves the best score of every passed problem run. Always mounted. */
export function ConstraintJudge(): null {
  const id = useConstraints((s) => s.id);
  const record = useConstraints((s) => s.record);
  const v = useVerdict();
  useEffect(() => {
    if (id && v?.passed) record(id, v.score);
  }, [id, v, record]);
  return null;
}

const nameOf = (d: Design, id: string) => {
  if (id === 'egress') return t('送給使用者的流量');
  if (id === 'cross-region') return t('跨區流量');
  const n = d.nodes.find((x) => x.id === id);
  return n ? (n.label ?? t(KINDS[n.kind]?.label ?? n.kind)) : id;
};

function CostTable({ cost, design, testId }: { cost: Cost; design: Design; testId: string }) {
  return (
    <table className="mt-1 w-full text-[13px]" data-testid={testId}>
      <tbody>
        {cost.items
          .filter((i) => i.perHour > 0)
          .map((i) => (
            <tr key={i.id} className="border-t border-[var(--line)] first:border-t-0">
              <td className="py-0.5 pr-2">
                {nameOf(design, i.id)}
                <span className="faint block">{t(i.what.text, i.what.vars)}</span>
              </td>
              <td className="num py-0.5 text-right align-top">{t('{v}/月', { v: fmtUsd(i.perHour * 730) })}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/** What the design that ran costs, at the run's traffic. */
export function CostSection({ run }: { run: RunData }) {
  const cost = useMemo(() => costOf(run.design, run), [run]);
  return (
    <section className={SECTION} data-testid="cost">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-semibold">{t('成本')}</div>
        <div className="num text-[15px] font-semibold" data-testid="cost-month">
          {t('{v}/月', { v: fmtUsd(cost.perMonth) })}
        </div>
      </div>
      <div className="faint text-[13px]">{t('示意價格（接近 2026 年 AWS 的比例，不是報價），照這次執行的流量算一整個月。')}</div>
      <details className="mt-1">
        <summary className="muted cursor-pointer text-[13px]">{t('明細')}</summary>
        <CostTable cost={cost} design={run.design} testId="cost-items" />
      </details>
    </section>
  );
}

const CHECK_TEXT: Record<Check['id'], string> = {
  errors: tx('失敗率'),
  p99: 'p99',
  budget: tx('每月成本'),
  points: tx('複雜度'),
};

function fmtCheck(c: Check): string {
  if (c.id === 'errors') return t('{v}（上限 {l}）', { v: `${(c.value * 100).toFixed(2)}%`, l: `${(c.limit * 100).toFixed(2)}%` });
  if (c.id === 'p99') return t('{v}（上限 {l}）', { v: fmtMs(c.value), l: fmtMs(c.limit) });
  if (c.id === 'budget') return t('{v}（上限 {l}）', { v: fmtUsd(c.value), l: fmtUsd(c.limit) });
  return t('{v} 點（上限 {l} 點）', { v: c.value, l: c.limit });
}

const LIMIT_TEXT: Record<Check['id'], (l: Problem['limits']) => string> = {
  errors: (l) => t('失敗率 ≤ {v}', { v: `${(l.maxErrorRate * 100).toFixed(2)}%` }),
  p99: (l) => t('p99 ≤ {v}', { v: fmtMs(l.maxP99Ms) }),
  budget: (l) => t('成本 ≤ {v}/月', { v: fmtUsd(l.budgetPerMonth) }),
  points: (l) => t('複雜度 ≤ {v} 點', { v: l.maxPoints }),
};
const CHECK_IDS: Check['id'][] = ['errors', 'p99', 'budget', 'points'];

/** The problem loaded on the canvas: a bar with its goals (green or red after a run), open for the details. */
export function ProblemCard() {
  const id = useConstraints((s) => s.id);
  return id ? <ProblemBar key={id} id={id} /> : null;
}

function ProblemBar({ id }: { id: string }) {
  const p = PROBLEM_BY_ID[id];
  const v = useVerdict();
  const best = useConstraints((s) => s.best[id]);
  const quit = useConstraints((s) => s.quit);
  const run = useRun();
  const [open, setOpen] = useState(false);
  const check = (c: Check['id']) => v?.checks.find((x) => x.id === c);
  return (
    <div className="card sd-float px-3 py-2.5 text-[14px] leading-snug" data-testid={`problem-${id}`}>
      {/* the title and the actions on one line; the goals on the next */}
      <div className="flex items-center gap-2">
        <Target size={15} className="shrink-0" style={{ color: 'var(--accent)' }} />
        <span className="min-w-0 font-medium">{t(p.title)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {v ? (
            <span className="font-medium" style={{ color: v.passed ? 'var(--ok-ink)' : undefined }} data-testid="problem-score">
              {v.passed ? t('過關！得分 {n}', { n: v.score }) : t('還沒過關')}
            </span>
          ) : (
            best !== undefined && (
              <span className="flex items-center gap-1 text-[13px]" style={{ color: 'var(--ok-ink)' }}>
                <Trophy size={12} />
                {t('最高 {n} 分', { n: best })}
              </span>
            )
          )}
          <button className="btn text-[13px]" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="problem-details-toggle">
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {t('詳情')}
          </button>
          <button className="btn text-[13px]" onClick={quit} data-testid="problem-quit">
            {t('結束題目')}
          </button>
        </span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="problem-checks" aria-label={t('目標')}>
        {CHECK_IDS.map((c) => {
          const k = check(c);
          return (
            <li key={c} className="sd-goal num" data-testid={`check-${c}`} data-ok={k ? k.ok : undefined} title={k ? `${t(CHECK_TEXT[c])}${t('：{v}', { v: fmtCheck(k) })}` : undefined}>
              {k ? k.ok ? <CircleCheck size={12} style={{ color: 'var(--ok)' }} aria-label={t('達到')} /> : <CircleX size={12} style={{ color: 'var(--bad)' }} aria-label={t('沒達到')} /> : <span className="sd-goal-dot" aria-hidden />}
              {LIMIT_TEXT[c](p.limits)}
            </li>
          );
        })}
      </ul>
      {!v && <div className="faint mt-2 text-[13px]">{run ? t('情境改過了：換回「{name}」才算數。', { name: t(p.scenario.name ?? '') }) : t('改設計、按「執行」，每次跑完都會自動判定。')}</div>}
      {open && (
        <div className="mt-2 border-t border-[var(--line)] pt-2" data-testid="problem-details">
          <div className="muted">{t(p.text)}</div>
          {v && (
            <>
              <ul className="mt-1.5 space-y-0.5">
                {v.checks.map((c) => (
                  <li key={c.id} className="flex gap-1.5">
                    {c.ok ? <CircleCheck size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
                    <span>
                      {t(CHECK_TEXT[c.id])}
                      <span className="num faint">{t('：{v}', { v: fmtCheck(c) })}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {v.passed && <div className="faint mt-1 text-[13px]">{t('越便宜分數越高。')}</div>}
              <details className="mt-1">
                <summary className="muted cursor-pointer text-[13px]">{t('成本和複雜度明細')}</summary>
                <CostTable cost={v.cost} design={run!.design} testId="problem-cost" />
                <table className="mt-1 w-full text-[13px]" data-testid="problem-points">
                  <tbody>
                    {v.points.items.map((i, k) => (
                      <tr key={k} className="border-t border-[var(--line)] first:border-t-0">
                        <td className="py-0.5 pr-2">
                          {i.where ? (i.where.includes('->') ? i.where : nameOf(run!.design, i.where)) : t('整個設計')}
                          <span className="faint">{t('：{v}', { v: KINDS[i.text] ? t(KINDS[i.text].label) : t(i.text) })}</span>
                        </td>
                        <td className="num py-0.5 text-right">{t('{n} 點', { n: i.points })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
          <details className="mt-1">
            <summary className="muted flex cursor-pointer items-center gap-1 text-[13px]">
              <Lightbulb size={12} />
              {t('提示')}
            </summary>
            <div className="muted mt-0.5 text-[13px]">{t(p.hint)}</div>
          </details>
        </div>
      )}
    </div>
  );
}

/** The constraint problems, in the practice dialog. `onStart`: a problem was loaded on the canvas. */
export function Constraints({ onStart }: { onStart?: () => void }) {
  const id = useConstraints((s) => s.id);
  const best = useConstraints((s) => s.best);
  const start = useConstraints((s) => s.start);
  return (
    <section data-testid="constraints">
      <div className="text-[15px] font-semibold">{t('限制條件題目')}</div>
      <div className="muted mt-0.5 text-[13px] leading-snug">
        {t('在預算和團隊能顧的複雜度裡，達到失敗率和 p99 的目標。目標是門檻；過關後，越便宜分數越高。')}
      </div>
      <ul className="mt-2.5 space-y-2">
        {PROBLEMS.map((p) => (
          <li key={p.id}>
            <PracticeItem
              title={t(p.title)}
              about={t(p.text)}
              best={best[p.id]}
              on={id === p.id}
              onClick={() => {
                // the one in progress: back to it, with its edits and run kept
                if (id !== p.id) start(p.id);
                onStart?.();
              }}
              testId={`problem-start-${p.id}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
