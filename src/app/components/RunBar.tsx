import { FastForward, Gauge, Loader2, Pause, Play, RotateCcw, Square, TrendingUp, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { useApp, GENERAL_SCENARIOS, SCENARIOS, SPEEDS, exampleScenario } from '../store.ts';
import { live, viewTime } from '../runtime.ts';
import { useTick } from '../useTick.ts';
import { apiTraffic, checkScenario, type Design, type Scenario } from '../../schema/design.ts';
import { toDesign } from '../convert.ts';
import { NumberField, Select, type Option } from './Select.tsx';
import { t, tx } from '../../i18n/index.ts';
import { LONG_RUN_S, fmtClock } from '../ui.ts';
import { useCauseHidden } from './OnCall.tsx';
import { presetOf } from '../presetName.ts';

function Clock() {
  useTick();
  const status = useApp((s) => s.status);
  const finishing = useApp((s) => s.finishing);
  const sec = status === 'idle' ? 0 : viewTime() / 1000;
  const dur = live.durationMs / 1000;
  const pct = dur > 0 ? Math.min(99, Math.floor((sec / dur) * 100)) : 0;
  return (
    <span className="num faint shrink-0 text-[14px] whitespace-nowrap" style={{ minWidth: 92 }} data-testid="clock">
      {status === 'idle' ? t('Not run yet') : dur > LONG_RUN_S ? `${fmtClock(sec)} / ${fmtClock(dur)}` : t('{t} / {dur} s', { t: sec.toFixed(sec < 10 ? 2 : 1), dur: dur || '–' })}
      {finishing ? ` · ${t('Computing… {p}%', { p: pct })}` : live.lagging && status === 'running' ? ` · ${t('Cannot keep up')}` : ''}
    </span>
  );
}

const SPEED_HINT: Record<number, string> = {
  0.01: tx('Slow motion: watch a single request step by step'),
  0.03: tx('Slow motion'),
  0.1: tx('See every request'),
  1: tx('Real time'),
  10: tx('Fast forward'),
  300: tx('A 30-minute scenario plays in about 6 seconds'),
};
// Built at render time so the labels follow the current language.
const speedOptions = (): Option<number>[] => SPEEDS.map((s) => ({ value: s, label: `${s}×`, hint: SPEED_HINT[s] && t(SPEED_HINT[s]) }));
const readOptions = (): Option<number>[] =>
  [1, 0.95, 0.9, 0.8, 0.7, 0.5, 0.3, 0].map((r) => ({ value: r, label: t('{p}% reads', { p: Math.round(r * 100) }), short: t('{p}% read', { p: Math.round(r * 100) }) }));
const durationOptions = (): Option<number>[] => [10, 30, 60, 120, 300, 900, 1800].map((d) => ({ value: d, label: d >= 600 ? t('{m} min', { m: d / 60 }) : t('{s} s', { s: d }) }));
/** Scenario name written into the design when the user changes the traffic by hand (shown with t()). */
const CUSTOM = tx('Custom');

type ScenarioEvent = NonNullable<Scenario['events']>[number];
function describeEvent(e: ScenarioEvent): string {
  // {span} is the optional ", for N s" tail; it is its own message.
  const span = 'forS' in e && e.forS !== undefined ? t(', for {s} s', { s: e.forS }) : '';
  switch (e.type) {
    case 'spike':
      return t('Second {at}: traffic {m}×{span}', { at: e.atS, m: e.multiplier, span });
    case 'ramp':
      return t('From second {at}, traffic ramps to {m}× over {for} s', { at: e.atS, for: e.forS, m: e.toMultiplier });
    case 'down':
      return t('Second {at}: {node} goes down{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, span });
    case 'slow':
      return t('Second {at}: {node} slowed down {m}×{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, m: e.multiplier, span });
    case 'errors':
      return t('Second {at}: {p}% of requests to {node} fail{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, p: Math.round(e.rate * 100), span });
    case 'wave':
      return t('From second {at}: traffic cycles every {p} s, ±{a}%{span}', { at: e.atS, p: e.periodS, a: Math.round(e.amplitude * 100), span });
    case 'cron':
      return e.jitterS
        ? t('From second {at}: a scheduled burst every {e} s ({m}×, spread over {j} s){span}', { at: e.atS, e: e.everyS, m: e.multiplier, j: Math.round((e.burstS + e.jitterS) * 100) / 100, span })
        : t('From second {at}: a scheduled burst every {e} s ({m}×, {b} s){span}', { at: e.atS, e: e.everyS, m: e.multiplier, b: e.burstS, span });
    case 'region_down':
      return t('At {at} s region {region} goes down{span}', { at: e.atS, region: e.region, span });
    case 'partition':
      return t('At {at} s, a network partition between regions {a} and {b}{span}', { at: e.atS, a: e.regions[0], b: e.regions[1], span });
    case 'pause':
      return t('From second {at}: {node} pauses {ms} ms for GC every {e} s{span}', { at: e.atS, node: e.node, e: e.everyS, ms: e.pauseMs, span });
    case 'shift':
      return e.forS
        ? t('From {at} s, {from} → {to} moves to weight {w} over {s} s', { at: e.atS, s: e.forS, from: e.from, to: e.to, w: e.weight })
        : t('At {at} s, {from} → {to} gets weight {w}', { at: e.atS, from: e.from, to: e.to, w: e.weight });
    case 'reshard':
      return t('From {at} s, reshard {node} into {n} shards (copy {s} s)', { at: e.atS, node: e.node, n: e.toShards, s: e.forS ?? 60 });
    case 'rollout': {
      const who = e.node ?? t('every server');
      const halt = e.haltAt !== undefined ? t(', rolled back automatically above {p}% failures', { p: Math.round(e.haltAt * 1000) / 10 }) : '';
      return (e.waves ?? 1) > 1
        ? t('From {at} s a new version is deployed to {node} in {w} waves, {s} s each{halt}', { at: e.atS, w: e.waves ?? 1, node: who, s: e.waveS ?? 60, halt })
        : t('At {at} s a new version is deployed to {node} at once{halt}', { at: e.atS, node: who, halt });
    }
  }
}

function Sep() {
  return <div className="sd-desk mx-0.5 h-5 w-px shrink-0" style={{ background: 'var(--line)' }} />;
}

export function RunBar() {
  const scenario = useApp((s) => s.scenario);
  const apis = useApp((s) => s.doc.apis);
  // the read share with APIs: depends on the client weights and edges too
  const setScenario = useApp((s) => s.setScenario);
  const status = useApp((s) => s.status);
  const finishing = useApp((s) => s.finishing);
  const speed = useApp((s) => s.speed);
  const run = useApp((s) => s.run);
  const pause = useApp((s) => s.pause);
  const setSpeed = useApp((s) => s.setSpeed);
  const finish = useApp((s) => s.finish);
  const stop = useApp((s) => s.stop);
  const error = useApp((s) => s.error);
  const active = status === 'running' || status === 'paused';

  const patch = (p: Partial<Scenario['traffic']>, top: Partial<Scenario> = {}) =>
    setScenario({ ...scenario, ...top, traffic: { ...scenario.traffic, ...p } });
  const presetName = presetOf(SCENARIOS, scenario.name);
  const nodes = useApp((s) => s.nodes);
  const edges = useApp((s) => s.edges);
  const doc = useApp((s) => s.doc);
  // the read share with APIs: it depends on the client weights and the edges too
  const traffic = useMemo(() => (doc.apis?.length ? apiTraffic(toDesign(doc, nodes, edges)) : {}), [doc, nodes, edges]);
  const example = useApp((s) => s.example);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const design = useMemo(() => useApp.getState().design(), [nodes, edges]);
  const scenarioOptions = useMemo(() => scenarioChoices(design, example, presetName), [design, example, presetName]);
  const events = scenario.events ?? [];
  // on call, before the answer: the events' tooltip would name the fault
  const causeHidden = useCauseHidden();
  // M18: the limit search, next to the scenario it takes its settings from; a new search each time
  // (M24: the panel is beside the canvas, App.tsx)
  const openLimit = useApp((s) => s.openLimit);

  return (
    <div className="sd-runbar panel flex h-11 shrink-0 items-center gap-2 overflow-hidden border-t px-3 whitespace-nowrap" role="toolbar" aria-label={t('Run')}>
      {!active ? (
        <button className="btn btn-primary shrink-0" onClick={run} data-testid="run">
          {status === 'done' ? <RotateCcw size={14} /> : <Play size={14} />}
          {status === 'done' ? t('Run again') : t('Run')}
        </button>
      ) : (
        <>
          <button className="btn shrink-0" onClick={() => pause(status === 'running')} disabled={finishing} data-testid="pause">
            {status === 'running' ? <Pause size={14} /> : <Play size={14} />}
            {status === 'running' ? t('Pause') : t('Resume')}
          </button>
          <button
            className="btn shrink-0"
            onClick={finish}
            disabled={finishing}
            aria-busy={finishing || undefined}
            title={finishing ? t('Computing to the end…') : t('Skip the animation and compute to the end')}
            aria-label={finishing ? t('Skipping to end…') : t('Skip to end')}
            data-testid="skip-to-end"
          >
            {finishing ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <FastForward size={14} />} <span className="sd-desk">{finishing ? t('Skipping…') : t('Skip to end')}</span>
          </button>
          <button className="btn shrink-0 px-2" onClick={stop} title={t('Stop')} aria-label={t('Stop')}>
            <Square size={13} />
          </button>
        </>
      )}
      <span className="sd-dot" style={{ background: status === 'running' ? 'var(--ok)' : status === 'paused' ? 'var(--warn)' : status === 'done' ? 'var(--accent)' : undefined }} aria-hidden />
      <Clock />
      <Sep />
      {/* on a phone the row breaks here: the controls above, the scenario below */}
      <div className="sd-run-break" aria-hidden />
      <Select
        className="w-[96px] shrink-0"
        aria-label={t('Speed')}
        title={t('Playback speed')}
        icon={<Gauge size={14} className="faint shrink-0" />}
        value={speed}
        options={speedOptions()}
        menuWidth={220}
        onChange={setSpeed}
        data-testid="speed"
      />
      <Sep />
      <span className="muted sd-desk shrink-0">{t('Scenario')}</span>
      <Select
        className="sd-run-scenario w-[230px] min-w-[120px] shrink"
        aria-label={t('Scenario')}
        value={presetName}
        placeholder={t(scenario.name || CUSTOM)}
        options={scenarioOptions}
        menuWidth={300}
        disabled={active}
        onChange={(k) => setScenario(structuredClone(SCENARIOS[k]))}
      />
      <NumberField
        className="w-[76px] shrink-0"
        aria-label={t('Requests per second@@count')}
        value={scenario.traffic.rps}
        min={0}
        step={50}
        suffix={t('/s')}
        disabled={active}
        onChange={(v) => patch({ rps: v }, { name: CUSTOM })}
      />
      {apis?.length ? (
        <span
          className="faint sd-desk w-[100px] shrink-0 truncate text-[13px]"
          title={t('This design has APIs: each request calls one of them by its share, and the API says whether it reads or writes. The read share is not used.')}
          data-testid="api-mix"
        >
          {t('{p}% read', { p: Math.round(apis.filter((a) => a.op === 'read').reduce((s, a) => s + (traffic[a.name] ?? 0), 0) * 100) })}
          {' · '}
          {t('{n} APIs', { n: apis.length })}
        </span>
      ) : (
      <Select
        className="sd-desk w-[100px] shrink-0"
        aria-label={t('Read ratio')}
        value={scenario.traffic.readRatio ?? 0.9}
        placeholder={t('{p}% read', { p: Math.round((scenario.traffic.readRatio ?? 0.9) * 100) })}
        options={readOptions()}
        menuWidth={120}
        disabled={active}
        onChange={(r) => patch({ readRatio: r }, { name: CUSTOM })}
      />
      )}
      <Select
        className="sd-desk w-[96px] shrink-0"
        aria-label={t('Duration')}
        value={scenario.durationS ?? 60}
        placeholder={t('{s} s', { s: scenario.durationS ?? 60 })}
        options={durationOptions()}
        disabled={active}
        onChange={(d) => setScenario({ ...scenario, durationS: d, name: CUSTOM })}
      />
      {events.length > 0 && !causeHidden && (
        <span className="sd-pill no-dot sd-desk shrink-0" title={events.map(describeEvent).join('\n')} data-testid="events">
          <Zap size={12} /> {t('Events: {n}', { n: events.length })}
        </span>
      )}
      {/* on a phone only the icon: the panel opens in the drawer */}
      <button
        className="btn shrink-0"
        onClick={openLimit}
        disabled={active}
        title={t('Raise steady traffic step by step to find about how many requests per second this design holds')}
        aria-label={t('Find limit')}
        data-testid="find-limit-open"
      >
        <TrendingUp size={14} /> <span className="sd-desk">{t('Find limit')}</span>
      </button>
      {error && (
        <span className="sd-run-error ml-auto min-w-0 truncate text-[14px]" style={{ color: 'var(--bad-ink)' }} title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

/** A scenario that names a component or region (an event aimed at it). */
function namesParts(s: Scenario): boolean {
  return (s.events ?? []).some((e) => 'node' in e || e.type === 'region_down' || e.type === 'partition');
}

/**
 * The scenarios to offer for a design: first the ones made for it (the example's own, and others
 * whose events name only parts the design has), then the general ones (GENERAL_SCENARIOS). Others
 * are left out, unless one is in use.
 */
export function scenarioChoices(design: Design, example: string | null, current: string | undefined): Option<string>[] {
  const own = example ? exampleScenario(example) : undefined;
  const fits = (s: Scenario) => !checkScenario(s, design).some((i) => i.level === 'error');
  const opt = (k: string, s: Scenario, group: string): Option<string> => ({
    value: k,
    label: s.name ? t(s.name) : k,
    hint: t('{rps} requests per second, {read}% reads, {dur} s', { rps: s.traffic.rps, read: Math.round((s.traffic.readRatio ?? 0.9) * 100), dur: s.durationS ?? 60 }),
    group,
  });
  const general = new Set(GENERAL_SCENARIOS);
  const entries = Object.entries(SCENARIOS);
  const mine = entries.filter(([k, s]) => k === own || (!general.has(k) && (k === current || (namesParts(s) && fits(s)))));
  const rest = entries.filter(([k]) => k !== own && general.has(k));
  return [...mine.map(([k, s]) => opt(k, s, t('For this design'))), ...rest.map(([k, s]) => opt(k, s, t('General')))];
}
