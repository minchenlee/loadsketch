// On-call mode in the Learn tab. The incident runs here, in its own simulation, not on the
// canvas: the canvas cards, the event log, the scenario tab and the bottleneck notes would show the
// cause. The learner sees what users see, pays points to open a component, answers, and then fixes
// the design on the canvas (judged on every run of the incident's scenario).
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronUp, CircleCheck, CircleX, Eye, Siren, Wrench, X } from 'lucide-react';
import { Simulation, type WindowStat } from '../../engine/index.ts';
import { KINDS } from '../../schema/kinds.ts';
import type { Design } from '../../schema/design.ts';
import { localizeDesign } from '../../i18n/content.ts';
import { t, tx } from '../../i18n/index.ts';
import { sameScenario } from '../../learn/lesson.ts';
import { FAULTS, INCIDENTS, INCIDENT_BY_ID, POINTS, judgeFix, openCost, nodeSamples, score, symptoms, type Fault } from '../../learn/oncall.ts';
import { EXAMPLES, useApp } from '../store.ts';
import { Chart } from './Chart.tsx';
import { PALETTE } from '../ui.ts';
import { PracticeItem } from './PracticeItem.tsx';

const BEST_KEY = 'loadsketch-oncall';

function loadBest(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}

interface OnCallState {
  id: string | null;
  /** running: the incident is being simulated; watch: the learner looks and answers; revealed: answered. */
  phase: 'idle' | 'running' | 'watch' | 'revealed';
  windows: WindowStat[];
  opened: string[];
  node: string | null;
  fault: Fault | null;
  /** The incident is loaded on the canvas for fixing; fixed: a run met the goal. */
  fixing: boolean;
  /** useApp's load count after the incident loaded for fixing: another load ends the fixing. */
  loads: number;
  /** useApp's load count after the incident's system loaded at the start (see useCauseHidden). */
  canvasLoads: number;
  fixed: boolean;
  /** Best score per incident in this browser (kept in localStorage). */
  best: Record<string, number>;
  start: (id: string) => void;
  open: (node: string) => void;
  pick: (p: { node?: string; fault?: Fault }) => void;
  answer: () => void;
  fixOnCanvas: () => void;
  markFixed: () => void;
  quit: () => void;
}

/** The incident's design as the learner sees it (component names in the current language). */
const designOf = (id: string): Design => localizeDesign(structuredClone(EXAMPLES[INCIDENT_BY_ID[id].example]));

type ScenarioEvent = NonNullable<ReturnType<typeof useApp.getState>['scenario']['events']>[number];
let incidentEvents = new Set<ScenarioEvent>();

export const useOnCall = create<OnCallState>((set, get) => {
  const save = () => {
    const { id, node, fault, opened, fixed, best } = get();
    if (!id || !node || !fault) return;
    const s = score(INCIDENT_BY_ID[id], { node, fault }, opened.length, fixed).total;
    if (s <= (best[id] ?? -1)) return;
    const next = { ...best, [id]: s };
    set({ best: next });
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  return {
    id: null,
    phase: 'idle',
    windows: [],
    opened: [],
    node: null,
    fault: null,
    fixing: false,
    fixed: false,
    loads: -1,
    canvasLoads: -1,
    best: loadBest(),
    start: (id) => {
      const inc = INCIDENT_BY_ID[id];
      if (!inc) return;
      set({ id, phase: 'running', windows: [], opened: [], node: null, fault: null, fixing: false, fixed: false });
      // the canvas shows the system on call with its fault, so a run there shows the same incident.
      // Nothing names the cause: a plain name, no description or notes; until the answer the UI hides
      // the events, the timeline and the bottleneck (useCauseHidden)
      const app = useApp.getState();
      const build = (): Design => {
        const { description: _d, notes: _n, ...d } = designOf(id);
        return { ...d, name: t('值班中的系統') };
      };
      // set first: the load below ends any practice whose design it replaces (see the subscription)
      set({ canvasLoads: app.loads + 1 });
      app.load(build(), build);
      // the message id, translated where it is shown (a language change then follows)
      app.setScenario({ ...structuredClone(inc.scenario), name: tx('值班中的情境') });
      // the incident's own event objects: quitting removes these, not events that only look the same
      incidentEvents = new Set(useApp.getState().scenario.events ?? []);
      // Run in slices of ~12 ms of real time, so the page still answers input (a busy incident
      // is millions of events). A new start or quit stops the old run.
      const sim = new Simulation(EXAMPLES[inc.example], inc.scenario);
      let simT = 0;
      const slice = () => {
        if (get().id !== id || get().phase !== 'running') return;
        const t0 = performance.now();
        while (!sim.done && performance.now() - t0 < 12) sim.runUntil((simT += 100));
        if (!sim.done) setTimeout(slice, 0);
        else set({ phase: 'watch', windows: sim.drainWindows().filter((w) => w.measured) });
      };
      setTimeout(slice, 30);
    },
    open: (node) => {
      if (get().phase !== 'watch' || get().opened.includes(node)) return;
      set({ opened: [...get().opened, node] });
    },
    pick: (p) => {
      if (get().phase !== 'watch') return;
      set({ ...(p.node !== undefined ? { node: p.node } : {}), ...(p.fault !== undefined ? { fault: p.fault } : {}) });
    },
    answer: () => {
      if (get().phase !== 'watch' || !get().node || !get().fault) return;
      set({ phase: 'revealed' });
      save();
    },
    fixOnCanvas: () => {
      const { id, phase, fixed } = get();
      if (!id || phase !== 'revealed' || fixed) return;
      const inc = INCIDENT_BY_ID[id];
      const app = useApp.getState();
      set({ fixing: true, loads: app.loads + 1 });
      app.loadExample(inc.example);
      app.setScenario(structuredClone(inc.scenario));
    },
    markFixed: () => {
      if (get().fixed) return;
      set({ fixed: true });
      save();
    },
    quit: () => {
      const { id, phase, canvasLoads } = get();
      set({ id: null, phase: 'idle', windows: [], opened: [], node: null, fault: null, fixing: false, fixed: false, loads: -1, canvasLoads: -1 });
      // quit before the answer, with the incident's system still on the canvas: once nothing is
      // hidden, its events, its run and that run's notes would name the cause, so they go
      const app = useApp.getState();
      if (id && (phase === 'running' || phase === 'watch') && canvasLoads === app.loads) {
        app.stop();
        useApp.setState({ result: null, windows: [], timeline: [], tView: 0, ran: null });
        // only the incident's own events go: a scenario picked since (a preset) keeps its events
        const events = app.scenario.events ?? [];
        const kept = events.filter((e) => !incidentEvents.has(e));
        if (kept.length !== events.length) app.setScenario({ ...app.scenario, events: kept });
      }
    },
  };
});

/** Before the answer, on the incident's system: the scenario's events, the timeline and the bottleneck stay hidden. */
export function useCauseHidden(): boolean {
  const loads = useApp((s) => s.loads);
  return useOnCall((s) => (s.phase === 'running' || s.phase === 'watch') && s.canvasLoads === loads);
}

// a run on the canvas before the answer shows every component's metrics: it counts as opening them all
useApp.subscribe((s, prev) => {
  if (s.status !== 'running' || prev.status === 'running') return;
  const o = useOnCall.getState();
  if ((o.phase === 'running' || o.phase === 'watch') && o.id && o.canvasLoads === s.loads) {
    useOnCall.setState({ opened: designOf(o.id).nodes.map((n) => n.id) });
  }
});

// the scenario changed before the answer (a preset, the traffic, the seed): a run would no longer
// be the incident, so the incident is over (quit then clears what would show the cause)
useApp.subscribe((s, prev) => {
  if (s.scenario === prev.scenario) return;
  const o = useOnCall.getState();
  if (!o.id || (o.phase !== 'running' && o.phase !== 'watch') || o.canvasLoads !== s.loads) return;
  if (!sameScenario(s.scenario, INCIDENT_BY_ID[o.id].scenario)) o.quit();
});

// another design loaded (an example, a file, a problem): the incident is over, so its card does not
// stay over an unrelated canvas, and its fix cannot replace the new design
useApp.subscribe((s, prev) => {
  const o = useOnCall.getState();
  if (s.loads === prev.loads || o.phase === 'idle') return;
  if (s.loads !== o.canvasLoads && s.loads !== o.loads) o.quit();
});

/** Judges every finished canvas run while an incident is being fixed. Always mounted. */
export function OnCallJudge(): null {
  const result = useApp((s) => s.result);
  const ran = useApp((s) => s.ran);
  const status = useApp((s) => s.status);
  const id = useOnCall((s) => s.id);
  const fixing = useOnCall((s) => s.fixing);
  const markFixed = useOnCall((s) => s.markFixed);
  useEffect(() => {
    if (!id || !fixing || !result || !ran || status !== 'done') return;
    const inc = INCIDENT_BY_ID[id];
    if (!sameScenario(ran.scenario, inc.scenario)) return;
    if (judgeFix(inc, EXAMPLES[inc.example], ran.design, result).ok) markFixed();
  }, [id, fixing, result, ran, status, markFixed]);
  return null;
}

const pctText = (x: number) => `${(x * 100).toFixed(1)}%`;

function NodeMetrics({ windows, design, id }: { windows: WindowStat[]; design: Design; id: string }) {
  const s = useMemo(() => nodeSamples(windows, design, id), [windows, design, id]);
  const xs = s.map((x) => x.t);
  const insts = s.find((x) => x.instUtil)?.instUtil?.length ?? 0;
  const hasUtil = s.some((x) => x.util !== undefined);
  const hasQueue = s.some((x) => x.queue !== undefined);
  return (
    <div className="mt-1" data-testid={`oncall-metrics-${id}`}>
      <Chart
        title={t('每秒請求與失敗')}
        height={110}
        data={[xs, s.map((x) => x.rps), s.map((x) => x.fail)]}
        series={[
          { label: t('每秒請求'), color: 'var(--ink-3)' },
          { label: t('失敗'), color: 'var(--bad)', fill: true },
        ]}
      />
      {hasUtil && (
        <Chart
          title={insts ? t('使用率（每台）') : t('使用率')}
          height={110}
          yMax={1.05}
          unit="%"
          data={insts ? [xs, ...Array.from({ length: insts }, (_, i) => s.map((x) => x.instUtil?.[i] ?? null))] : [xs, s.map((x) => x.util ?? null)]}
          series={insts ? Array.from({ length: insts }, (_, i) => ({ label: `#${i}`, color: PALETTE[i % PALETTE.length] })) : [{ label: t('使用率'), color: 'var(--accent)' }]}
        />
      )}
      {hasQueue && <Chart title={t('排隊中')} height={110} data={[xs, s.map((x) => x.queue ?? null)]} series={[{ label: t('排隊中'), color: 'var(--warn)' }]} />}
    </div>
  );
}

function Watch() {
  const st = useOnCall();
  const inc = INCIDENT_BY_ID[st.id!];
  const design = useMemo(() => designOf(st.id!), [st.id]);
  const sym = useMemo(() => symptoms(st.windows), [st.windows]);
  const xs = sym.map((x) => x.t);
  const name = (id: string) => {
    const n = design.nodes.find((x) => x.id === id);
    return n ? (n.label ?? t(KINDS[n.kind].label)) : id;
  };
  const revealed = st.phase === 'revealed';
  const sc = revealed && st.node && st.fault ? score(inc, { node: st.node, fault: st.fault }, st.opened.length, st.fixed) : null;
  return (
    <div data-testid="oncall-incident">
      <div className="card mt-2 flex gap-2 p-2 text-[14px] leading-snug" style={{ borderColor: 'var(--bad)' }} data-testid="oncall-page">
        <Siren size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />
        {/* the example's name can tell the cause (e.g. "slow dependency"): shown only after the answer */}
        <span>
          {revealed && <span className="faint block text-[13px]">{t('系統：{name}', { name: design.name })}</span>}
          {t(inc.title)}
        </span>
      </div>
      <Chart testId="oncall-errors" title={t('使用者看到的失敗率')} height={120} yMax={1.05} unit="%" data={[xs, sym.map((x) => x.errorRate)]} series={[{ label: t('失敗率'), color: 'var(--bad)', fill: true }]} />
      <Chart testId="oncall-p99" title={t('使用者看到的 p99')} height={120} unit="ms" data={[xs, sym.map((x) => x.p99)]} series={[{ label: 'p99', color: 'var(--warn)' }]} />

      <div className="mt-3 text-[14px] font-medium">{t('元件')}</div>
      <div className="faint text-[13px]" data-testid="oncall-score-rule">
        {t('前 {free} 個元件的指標免費；第 {next} 個起，每打開一個扣 {n} 分。', { free: POINTS.free, next: POINTS.free + 1, n: -POINTS.open })}{' '}
        {t('已打開 {k} 個。', { k: st.opened.length })}
      </div>
      {!revealed && (
        <div className="faint text-[13px]" data-testid="oncall-canvas-note">
          {t('畫布上就是這個系統。在畫布上按「執行」會重現問題，也會看到每個元件的指標：算打開全部元件（−{n} 分）。', { n: -openCost(design.nodes.length) })}
        </div>
      )}
      <ul className="mt-1 space-y-1">
        {design.nodes.map((n) => {
          const opened = st.opened.includes(n.id);
          return (
            <li key={n.id} className="card p-1.5 text-[14px]">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {name(n.id)} {name(n.id) !== t(KINDS[n.kind].label) && <span className="faint text-[13px]">{t(KINDS[n.kind].label)}</span>}
                </span>
                {!opened && !revealed && (
                  <button className="btn text-[13px]" onClick={() => st.open(n.id)} data-testid={`oncall-open-${n.id}`}>
                    <Eye size={12} />
                    {st.opened.length < POINTS.free ? t('打開指標（免費）') : t('打開指標（−{n} 分）', { n: -POINTS.open })}
                  </button>
                )}
              </div>
              {(opened || (revealed && n.id === inc.answer.node)) && <NodeMetrics windows={st.windows} design={design} id={n.id} />}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 text-[14px] font-medium">{t('你的判斷')}</div>
      <div className="mt-1 text-[13px]">{t('哪個元件出問題？')}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {design.nodes.map((n) => {
          const right = revealed && n.id === inc.answer.node;
          const wrong = revealed && st.node === n.id && !right;
          return (
            <button key={n.id} className={`btn text-[13px] ${st.node === n.id ? 'btn-on' : ''}`} onClick={() => st.pick({ node: n.id })} disabled={revealed} aria-pressed={st.node === n.id} data-testid={`oncall-node-${n.id}`}>
              {right && <CircleCheck size={12} style={{ color: 'var(--ok)' }} aria-label={t('答案')} />}
              {wrong && <CircleX size={12} style={{ color: 'var(--bad)' }} aria-label={t('你猜的')} />}
              {name(n.id)}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[13px]">{t('是哪種故障？')}</div>
      <div className="mt-1 flex flex-col gap-1">
        {FAULTS.map((f) => {
          const right = revealed && f.id === inc.answer.fault;
          const wrong = revealed && st.fault === f.id && !right;
          return (
            <button key={f.id} className={`btn justify-start text-left text-[13px] ${st.fault === f.id ? 'btn-on' : ''}`} onClick={() => st.pick({ fault: f.id })} disabled={revealed} aria-pressed={st.fault === f.id} data-testid={`oncall-fault-${f.id}`}>
              {right && <CircleCheck size={12} style={{ color: 'var(--ok)' }} aria-label={t('答案')} />}
              {wrong && <CircleX size={12} style={{ color: 'var(--bad)' }} aria-label={t('你猜的')} />}
              {t(f.text)}
            </button>
          );
        })}
      </div>
      {!revealed && (
        <button className="btn btn-primary mt-2" onClick={st.answer} disabled={!st.node || !st.fault} data-testid="oncall-answer">
          {t('送出答案')}
        </button>
      )}

      {sc && (
        <div className="mt-3 text-[14px] leading-snug" data-testid="oncall-reveal">
          <div className="font-medium" data-testid="oncall-score">
            {t('得分：{n}', { n: sc.total })}
          </div>
          <ul className="muted mt-0.5 text-[13px]">
            <li>{sc.node ? t('元件答對 +{n}', { n: POINTS.node }) : t('元件答錯：是「{name}」', { name: name(inc.answer.node) })}</li>
            <li>{sc.fault ? t('故障種類答對 +{n}', { n: POINTS.fault }) : t('故障種類答錯：是「{f}」', { f: t(FAULTS.find((f) => f.id === inc.answer.fault)!.text) })}</li>
            {sc.opened > 0 && <li>{openCost(sc.opened) < 0 ? t('打開 {k} 個元件（前 {free} 個免費）{n}', { k: sc.opened, free: POINTS.free, n: openCost(sc.opened) }) : t('打開 {k} 個元件（免費）', { k: sc.opened })}</li>}
            {sc.fixed && <li>{t('修好了 +{n}', { n: POINTS.fix })}</li>}
          </ul>
          <div className="mt-1.5">{t(inc.explain)}</div>
          <div className="mt-1.5">
            <span className="font-medium">{t('怎麼修：')}</span>
            {t(inc.hint)}
          </div>
          {/* fixed once: the points are earned, and a later attempt is not judged again */}
          {!st.fixing && !st.fixed && (
            <button className="btn mt-2" onClick={st.fixOnCanvas} data-testid="oncall-fix">
              <Wrench size={12} />
              {t('在畫布上修（+{n} 分）', { n: POINTS.fix })}
            </button>
          )}
          {st.fixing && !st.fixed && (
            <div className="mt-2" style={{ color: 'var(--warn-ink)' }} data-testid="oncall-fixing">
              {t('設計和情境已經載入畫布。改設計、按「執行」：整場失敗率不超過 {e}{p}，而且沒有刪掉元件，就加 {n} 分。', {
                e: pctText(inc.fixGoal.maxErrorRate),
                p: inc.fixGoal.maxP99Ms ? t('、p99 不超過 {ms} ms', { ms: inc.fixGoal.maxP99Ms }) : '',
                n: POINTS.fix,
              })}
            </div>
          )}
          {st.fixed && (
            <div className="mt-2 font-medium" style={{ color: 'var(--ok-ink)' }} data-testid="oncall-fixed">
              {t('修好了！')}
            </div>
          )}
        </div>
      )}
      <button className="btn mt-3 text-[13px]" onClick={st.quit} data-testid="oncall-quit">
        {t('換一題')}
      </button>
    </div>
  );
}

/** Every incident title starts with the same "page" word: the list shows only what is wrong. */
const alertText = (s: string) => {
  const r = s.replace(/^(值班告警：|Page: )/, '');
  return r.charAt(0).toUpperCase() + r.slice(1);
};

/** The on-call incidents, in the practice dialog. `onStart`: an incident was started. */
export function OnCall({ onStart }: { onStart?: () => void }) {
  const id = useOnCall((s) => s.id);
  const phase = useOnCall((s) => s.phase);
  const best = useOnCall((s) => s.best);
  const start = useOnCall((s) => s.start);
  return (
    <section data-testid="oncall">
      <div className="text-[15px] font-semibold">{t('值班練習')}</div>
      <div className="muted mt-0.5 text-[13px] leading-snug">
        {t('系統裡偷偷放了一個故障。你只看得到使用者的失敗率和 p99；要看元件的指標得花點數。找出哪個元件、哪種故障，再到畫布上修好。')}
      </div>
      <ul className="mt-2.5 space-y-2">
        {INCIDENTS.map((inc, i) => (
          <li key={inc.id}>
            <PracticeItem
              title={t('第 {i} 題', { i: i + 1 })}
              about={alertText(t(inc.title))}
              best={best[inc.id]}
              on={phase !== 'idle' && id === inc.id}
              onClick={() => {
                // the one in progress: back to it, as it is
                if (phase === 'idle' || id !== inc.id) start(inc.id);
                onStart?.();
              }}
              testId={`oncall-start-${inc.id}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The incident being worked on, in a card on the canvas; it folds to its title. */
export function OnCallCard() {
  const id = useOnCall((s) => s.id);
  const phase = useOnCall((s) => s.phase);
  const quit = useOnCall((s) => s.quit);
  const [folded, setFolded] = useState(false);
  if (phase === 'idle' || !id) return null;
  return (
    <div className="card sd-float sd-float-tall flex flex-col text-[14px]" data-testid="oncall-card">
      <div className="flex shrink-0 items-center gap-2 py-2 pl-3 pr-2">
        <Siren size={15} className="shrink-0" style={{ color: 'var(--bad)' }} />
        <span className="font-medium">{t('值班練習')}</span>
        <button className="btn ml-auto text-[13px]" onClick={() => setFolded(!folded)} aria-expanded={!folded} data-testid="oncall-fold">
          {folded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          {folded ? t('展開') : t('收合')}
        </button>
        <button className="btn px-1.5" onClick={quit} aria-label={t('結束值班練習')} title={t('結束值班練習')} data-testid="oncall-close">
          <X size={14} />
        </button>
      </div>
      {!folded && (
        <div className="min-h-0 overflow-y-auto px-3 pb-2.5">
          {phase === 'running' && <div className="muted mt-1 text-[14px]" data-testid="oncall-running">{t('收到告警，正在取得資料…')}</div>}
          {(phase === 'watch' || phase === 'revealed') && <Watch />}
        </div>
      )}
    </div>
  );
}
