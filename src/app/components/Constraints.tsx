// The cost of a finished run (#68) and the constraint problems in the Learn tab. A problem loads
// its starting design and scenario onto the canvas; every run of that scenario is judged against the
// error rate, p99, budget and complexity limits, and a passed run scores higher when it is cheaper.
// A design brief (learn/briefs.ts) is judged the same way, but starts from requirements and an
// almost empty canvas: its card opens with the requirements, and adds what the design must have.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronUp, CircleCheck, CircleX, Eye, Lightbulb, PencilRuler, Target, Trophy } from 'lucide-react';
import { KINDS } from '../../schema/kinds.ts';
import type { Design } from '../../schema/design.ts';
import { localizeDesign } from '../../i18n/content.ts';
import { t, tx } from '../../i18n/index.ts';
import { sameScenario } from '../../learn/lesson.ts';
import type { RunData } from '../../learn/metrics.ts';
import { costOf, fmtUsd, type Cost } from '../../learn/cost.ts';
import { PROBLEMS, PROBLEM_BY_ID, complexity, judgeProblem, type Check, type Problem, type ProblemVerdict } from '../../learn/constraints.ts';
import { BRIEFS, BRIEF_BY_ID, judgeBrief, type Brief, type BriefVerdict } from '../../learn/briefs.ts';
import { applyPatches } from '../../learn/oncall.ts';
import { EXAMPLES, useApp } from '../store.ts';
import { live } from '../runtime.ts';
import { fmtMs } from '../ui.ts';
import { isPhone } from '../phone.ts';
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
  /** A brief whose reference design was shown: its runs are judged, but the score is not kept. */
  peeked: boolean;
  best: Record<string, number>;
  start: (id: string) => void;
  /** Put the brief's reference design on the canvas. */
  reference: () => void;
  record: (id: string, score: number) => void;
  quit: () => void;
}

export const useConstraints = create<ConstraintState>((set, get) => ({
  id: null,
  loads: -1,
  peeked: false,
  best: loadBest(),
  start: (id) => {
    const app = useApp.getState();
    const b = BRIEF_BY_ID[id];
    if (b) {
      const build = () => localizeDesign(structuredClone(b.start));
      app.load(build(), build);
      app.setScenario(structuredClone(b.scenario));
      set({ id, loads: useApp.getState().loads, peeked: false });
      return;
    }
    const p = PROBLEM_BY_ID[id];
    if (!p) return;
    // in the current language: a language change builds it again to swap the text
    const build = () => ({ ...applyPatches(localizeDesign(structuredClone(EXAMPLES[p.example])), p.start), name: t(p.title) });
    app.load(build(), build);
    app.setScenario(structuredClone(p.scenario));
    set({ id, loads: useApp.getState().loads, peeked: false });
  },
  reference: () => {
    const id = get().id;
    const b = id ? BRIEF_BY_ID[id] : undefined;
    if (!b) return;
    const app = useApp.getState();
    const build = () => localizeDesign(structuredClone(b.reference));
    // the brief goes on with this design: say so before the load, which ends a brief it does not know
    set({ loads: app.loads + 1, peeked: true });
    app.load(build(), build);
    app.setScenario(structuredClone(b.scenario));
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
  quit: () => set({ id: null, loads: -1, peeked: false }),
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
function useVerdict(): ProblemVerdict | BriefVerdict | null {
  const id = useConstraints((s) => s.id);
  const run = useRun();
  return useMemo(() => {
    const b = id ? BRIEF_BY_ID[id] : undefined;
    // the store's windows end with the traffic; the needs also count the time after it, while queues empty
    if (b) return run && sameScenario(run.scenario, b.scenario) ? judgeBrief(b, run.design, { ...run, allWindows: live.windows.slice() }) : null;
    const p = id ? PROBLEM_BY_ID[id] : undefined;
    if (!p || !run || !sameScenario(run.scenario, p.scenario)) return null;
    return judgeProblem(p, run.design, run, applyPatches(EXAMPLES[p.example], p.start));
  }, [id, run]);
}

/** Saves the best score of every passed problem run. Always mounted. */
export function ConstraintJudge(): null {
  const id = useConstraints((s) => s.id);
  const record = useConstraints((s) => s.record);
  const peeked = useConstraints((s) => s.peeked);
  const v = useVerdict();
  useEffect(() => {
    if (id && v?.passed && !peeked) record(id, v.score);
  }, [id, v, record, peeked]);
  return null;
}

const nameOf = (d: Design, id: string) => {
  if (id === 'egress') return t('Traffic to users');
  if (id === 'cross-region') return t('Traffic between regions');
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
              <td className="num py-0.5 text-right align-top">{t('{v}/month', { v: fmtUsd(i.perHour * 730) })}</td>
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
        <div className="text-[15px] font-semibold">{t('Cost')}</div>
        <div className="num text-[15px] font-semibold" data-testid="cost-month">
          {t('{v}/month', { v: fmtUsd(cost.perMonth) })}
        </div>
      </div>
      <div className="faint text-[13px]">{t('Sample prices (close to the ratios of 2026 AWS prices, not a quote), for a whole month at this run\'s traffic.')}</div>
      <details className="mt-1">
        <summary className="muted cursor-pointer text-[13px]">{t('Detail')}</summary>
        <CostTable cost={cost} design={run.design} testId="cost-items" />
      </details>
    </section>
  );
}

/** Operational complexity points of the design that ran (components and extra mechanisms). */
export function ComplexitySection({ run }: { run: RunData }) {
  const points = useMemo(() => complexity(run.design), [run.design]);
  return (
    <section className={SECTION} data-testid="complexity">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-semibold">{t('Complexity')}</div>
        <div className="num text-[15px] font-semibold" data-testid="complexity-total">
          {t('{n} pt', { n: points.total })}
        </div>
      </div>
      <div className="faint text-[13px]">{t('Each component and extra mechanism costs points to build and run. Fewer points means a simpler system to maintain.')}</div>
      {points.items.length > 0 && (
        <details className="mt-1">
          <summary className="muted cursor-pointer text-[13px]">{t('Detail')}</summary>
          <table className="mt-1 w-full text-[13px]" data-testid="complexity-items">
            <tbody>
              {points.items.map((i, k) => (
                <tr key={k} className="border-t border-[var(--line)] first:border-t-0">
                  <td className="py-0.5 pr-2">
                    {i.where ? (i.where.includes('->') ? i.where : nameOf(run.design, i.where)) : t('Whole design')}
                    <span className="faint">{t(': {v}', { v: KINDS[i.text] ? t(KINDS[i.text].label) : t(i.text) })}</span>
                  </td>
                  <td className="num py-0.5 text-right">{t('{n} pt', { n: i.points })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

const CHECK_TEXT: Record<Check['id'], string> = {
  errors: tx('Error rate@@failure'),
  p99: 'p99',
  budget: tx('Cost per month'),
  points: tx('Complexity'),
};

function fmtCheck(c: Check): string {
  if (c.id === 'errors') return t('{v} (limit {l})', { v: `${(c.value * 100).toFixed(2)}%`, l: `${(c.limit * 100).toFixed(2)}%` });
  if (c.id === 'p99') return t('{v} (limit {l})', { v: fmtMs(c.value), l: fmtMs(c.limit) });
  if (c.id === 'budget') return t('{v} (limit {l})', { v: fmtUsd(c.value), l: fmtUsd(c.limit) });
  return t('{v} pt (limit {l} pt)', { v: c.value, l: c.limit });
}

const LIMIT_TEXT: Record<Check['id'], (l: Problem['limits']) => string> = {
  errors: (l) => t('Failure rate ≤ {v}', { v: `${(l.maxErrorRate * 100).toFixed(2)}%` }),
  p99: (l) => t('p99 ≤ {v}', { v: fmtMs(l.maxP99Ms) }),
  budget: (l) => t('Cost ≤ {v}/mo', { v: fmtUsd(l.budgetPerMonth) }),
  points: (l) => t('Complexity ≤ {v} pts', { v: l.maxPoints }),
};
const CHECK_IDS: Check['id'][] = ['errors', 'p99', 'budget', 'points'];

/** The problem loaded on the canvas: a bar with its goals (green or red after a run), open for the details. */
export function ProblemCard() {
  const id = useConstraints((s) => s.id);
  return id ? <ProblemBar key={id} id={id} /> : null;
}

const BRIEF_PARTS: { key: 'functional' | 'load' | 'given' | 'outOfScope'; title: string }[] = [
  { key: 'functional', title: tx('Functional requirements') },
  { key: 'load', title: tx('Traffic') },
  { key: 'given', title: tx('Given') },
  { key: 'outOfScope', title: tx('Out of scope') },
];

/** The requirements of a brief: what to build, the load, how fast each part is, and what to leave out. */
function BriefText({ b }: { b: Brief }) {
  return (
    <div data-testid="brief-text">
      <div className="muted">{t(b.text)}</div>
      <dl className="mt-1.5 space-y-1.5">
        {BRIEF_PARTS.map((part) => (
          <div key={part.key}>
            <dt className="text-[13px] font-semibold">{t(part.title)}</dt>
            <dd>
              <ul className="muted list-disc pl-4 text-[13px]">
                {b[part.key].map((line) => (
                  <li key={line}>{t(line)}</li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ProblemBar({ id }: { id: string }) {
  const brief = BRIEF_BY_ID[id];
  const p = brief ?? PROBLEM_BY_ID[id];
  const v = useVerdict();
  const bv = brief && v && 'needs' in v ? v : null;
  const best = useConstraints((s) => s.best[id]);
  const quit = useConstraints((s) => s.quit);
  const peeked = useConstraints((s) => s.peeked);
  const reference = useConstraints((s) => s.reference);
  const run = useRun();
  // a brief opens with its requirements: they are the problem
  const [open, setOpen] = useState(!!brief && !isPhone());
  const check = (c: Check['id']) => v?.checks.find((x) => x.id === c);
  return (
    <div className={`card sd-float px-3 py-2.5 text-[14px] leading-snug ${brief ? 'sd-brief' : ''}`} data-open={brief && open ? '' : undefined} data-testid={`problem-${id}`}>
      {/* the title and the actions on one line; the goals on the next */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {brief ? <PencilRuler size={15} className="shrink-0" style={{ color: 'var(--accent)' }} /> : <Target size={15} className="shrink-0" style={{ color: 'var(--accent)' }} />}
        <span className="min-w-0 whitespace-nowrap font-medium">{t(p.title)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {v ? (
            <span className="font-medium" style={{ color: v.passed ? 'var(--ok-ink)' : undefined }} data-testid="problem-score">
              {v.passed ? (peeked ? t('The reference design passes (no score)') : t('Passed! Score {n}', { n: v.score })) : t('Not passed yet')}
            </span>
          ) : (
            best !== undefined && (
              <span className="flex items-center gap-1 text-[13px]" style={{ color: 'var(--ok-ink)' }}>
                <Trophy size={12} />
                {t('best {n}', { n: best })}
              </span>
            )
          )}
          <button className="btn text-[13px]" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="problem-details-toggle">
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {t('Details')}
          </button>
          <button className="btn text-[13px]" onClick={quit} data-testid="problem-quit">
            {t('End problem')}
          </button>
        </span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="problem-checks" aria-label={t('Goals')}>
        {CHECK_IDS.map((c) => {
          const k = check(c);
          return (
            <li key={c} className="sd-goal num" data-testid={`check-${c}`} data-ok={k ? k.ok : undefined} title={k ? `${t(CHECK_TEXT[c])}${t(': {v}', { v: fmtCheck(k) })}` : undefined}>
              {k ? k.ok ? <CircleCheck size={12} style={{ color: 'var(--ok)' }} aria-label={t('Met')} /> : <CircleX size={12} style={{ color: 'var(--bad)' }} aria-label={t('Not met')} /> : <span className="sd-goal-dot" aria-hidden />}
              {LIMIT_TEXT[c](p.limits)}
            </li>
          );
        })}
        {brief?.needs.map((n) => {
          const k = bv?.needs.find((x) => x.id === n.id);
          return (
            <li key={n.id} className="sd-goal" data-testid={`need-${n.id}`} data-ok={k ? k.ok : undefined}>
              {k ? k.ok ? <CircleCheck size={12} style={{ color: 'var(--ok)' }} aria-label={t('Met')} /> : <CircleX size={12} style={{ color: 'var(--bad)' }} aria-label={t('Not met')} /> : <span className="sd-goal-dot" aria-hidden />}
              {t(n.text)}
            </li>
          );
        })}
      </ul>
      {v && v.broken.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[13px]" data-testid="brief-broken">
          {v.broken.map((x, k) => (
            <li key={k} className="flex gap-1.5">
              <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />
              {t(x.text, { ...x.vars, name: t(String(x.vars.name)), what: t(String(x.vars.what ?? '')) })}
            </li>
          ))}
        </ul>
      )}
      {!v && <div className="faint mt-2 text-[13px]">{run ? t('The scenario was changed. Switch back to "{name}" for the challenges to count.', { name: t(p.scenario.name ?? '') }) : brief ? (isPhone() ? t('Add components from "Component" below, connect them, then press "Run". Every run is judged automatically.') : t('Drag components in from the left, connect them, then press "Run". Every run is judged automatically.')) : t('Change the design and press Run. Each finished run is judged automatically.')}</div>}
      {open && (
        <div className="sd-brief-body mt-2 border-t border-[var(--line)] pt-2" data-testid="problem-details">
          {brief ? <BriefText b={brief} /> : <div className="muted">{t(p.text)}</div>}
          {v && (
            <>
              <ul className="mt-1.5 space-y-0.5">
                {v.checks.map((c) => (
                  <li key={c.id} className="flex gap-1.5">
                    {c.ok ? <CircleCheck size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
                    <span>
                      {t(CHECK_TEXT[c.id])}
                      <span className="num faint">{t(': {v}', { v: fmtCheck(c) })}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {v.passed && <div className="faint mt-1 text-[13px]">{brief ? t('A cheaper design scores higher. Traffic to users and the given components cost the same in every design, so they are not compared.') : t('Cheaper scores higher.')}</div>}
              <details className="mt-1">
                <summary className="muted cursor-pointer text-[13px]">{t('Cost and complexity in detail')}</summary>
                <div className="faint text-[13px]" data-testid="problem-cost-note">{t('Sample prices (close to the ratios of 2026 AWS prices, not a quote), for a whole month at this run\'s traffic.')}</div>
                <CostTable cost={v.cost} design={run!.design} testId="problem-cost" />
                <table className="mt-1 w-full text-[13px]" data-testid="problem-points">
                  <tbody>
                    {v.points.items.map((i, k) => (
                      <tr key={k} className="border-t border-[var(--line)] first:border-t-0">
                        <td className="py-0.5 pr-2">
                          {i.where ? (i.where.includes('->') ? i.where : nameOf(run!.design, i.where)) : t('Whole design')}
                          <span className="faint">{t(': {v}', { v: KINDS[i.text] ? t(KINDS[i.text].label) : t(i.text) })}</span>
                        </td>
                        <td className="num py-0.5 text-right">{t('{n} pt', { n: i.points })}</td>
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
              {t('Hint')}
            </summary>
            <div className="muted mt-0.5 text-[13px]">{t(p.hint)}</div>
          </details>
          {brief && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="btn text-[13px]"
                onClick={() => {
                  // the design is what to look at now
                  setOpen(false);
                  reference();
                }}
                data-testid="brief-reference"
              >
                <Eye size={13} />
                {t('Show the reference design')}
              </button>
              <span className="faint text-[13px]">{peeked ? t('The canvas shows the reference design. It is one way among several; end the problem and pick it again to start over.') : t('It replaces the design on the canvas, and this brief keeps no score after that.')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The design briefs, in the practice dialog. `onStart`: a brief was loaded on the canvas. */
export function Briefs({ onStart }: { onStart?: () => void }) {
  const id = useConstraints((s) => s.id);
  const best = useConstraints((s) => s.best);
  const start = useConstraints((s) => s.start);
  return (
    <section data-testid="briefs">
      <div className="text-[15px] font-semibold">{t('Design from requirements')}</div>
      <div className="muted mt-0.5 text-[13px] leading-snug">{t('Only the requirements and an almost empty canvas. You decide which components to use and how large, then run it to see if it holds. The first design most people draw does not pass.')}</div>
      <ul className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-3">
        {BRIEFS.map((b) => (
          <li key={b.id}>
            <PracticeItem
              title={t(b.title).replace(/^[^：:]+[：:]\s*/, '')}
              about={`${t(b.functional[0])}${t('; ')}${t(b.load[0])}`}
              best={best[b.id]}
              on={id === b.id}
              onClick={() => {
                if (id !== b.id) start(b.id);
                onStart?.();
              }}
              testId={`brief-start-${b.id}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The constraint problems, in the practice dialog. `onStart`: a problem was loaded on the canvas. */
export function Constraints({ onStart }: { onStart?: () => void }) {
  const id = useConstraints((s) => s.id);
  const best = useConstraints((s) => s.best);
  const start = useConstraints((s) => s.start);
  return (
    <section data-testid="constraints">
      <div className="text-[15px] font-semibold">{t('Constraint problems')}</div>
      <div className="muted mt-0.5 text-[13px] leading-snug">
        {t('Meet the error rate and p99 targets inside the budget and the complexity the team can look after. The targets are gates; once you pass, cheaper scores higher.')}
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
