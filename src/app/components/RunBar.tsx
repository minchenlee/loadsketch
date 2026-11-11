import { FastForward, Gauge, Pause, Play, RotateCcw, Square, Zap } from 'lucide-react';
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

function Clock() {
  useTick();
  const status = useApp((s) => s.status);
  const sec = status === 'idle' ? 0 : viewTime() / 1000;
  const dur = live.durationMs / 1000;
  return (
    <span className="num faint shrink-0 text-[14px] whitespace-nowrap" style={{ minWidth: 92 }} data-testid="clock">
      {status === 'idle' ? t('尚未執行') : dur > LONG_RUN_S ? `${fmtClock(sec)} / ${fmtClock(dur)}` : t('{t} / {dur} 秒', { t: sec.toFixed(sec < 10 ? 2 : 1), dur: dur || '–' })}
      {live.lagging && status === 'running' ? ` · ${t('算不及')}` : ''}
    </span>
  );
}

const SPEED_HINT: Record<number, string> = {
  0.01: tx('慢動作：看單一請求一步步走'),
  0.03: tx('慢動作'),
  0.1: tx('看得到每個請求'),
  1: tx('真實時間'),
  10: tx('快轉'),
  300: tx('30 分鐘的情境約 6 秒播完'),
};
// Built at render time so the labels follow the current language.
const speedOptions = (): Option<number>[] => SPEEDS.map((s) => ({ value: s, label: `${s}×`, hint: SPEED_HINT[s] && t(SPEED_HINT[s]) }));
const readOptions = (): Option<number>[] =>
  [1, 0.95, 0.9, 0.8, 0.7, 0.5, 0.3, 0].map((r) => ({ value: r, label: t('{p}% 讀取', { p: Math.round(r * 100) }), short: t('讀 {p}%', { p: Math.round(r * 100) }) }));
const durationOptions = (): Option<number>[] => [10, 30, 60, 120, 300, 900, 1800].map((d) => ({ value: d, label: d >= 600 ? t('{m} 分鐘', { m: d / 60 }) : t('{s} 秒', { s: d }) }));
/** Scenario name written into the design when the user changes the traffic by hand (shown with t()). */
const CUSTOM = tx('自訂');

type ScenarioEvent = NonNullable<Scenario['events']>[number];
function describeEvent(e: ScenarioEvent): string {
  // {span} is the optional ", for N s" tail; it is its own message.
  const span = 'forS' in e && e.forS !== undefined ? t('，持續 {s} 秒', { s: e.forS }) : '';
  switch (e.type) {
    case 'spike':
      return t('第 {at} 秒流量變 {m} 倍{span}', { at: e.atS, m: e.multiplier, span });
    case 'ramp':
      return t('第 {at} 秒起，{for} 秒內流量漸變到 {m} 倍', { at: e.atS, for: e.forS, m: e.toMultiplier });
    case 'down':
      return t('第 {at} 秒 {node} 故障{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, span });
    case 'slow':
      return t('第 {at} 秒 {node} 變慢 {m} 倍{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, m: e.multiplier, span });
    case 'errors':
      return t('第 {at} 秒 {node} 有 {p}% 請求出錯{span}', { at: e.atS, node: e.instance !== undefined ? `${e.node} #${e.instance}` : e.node, p: Math.round(e.rate * 100), span });
    case 'wave':
      return t('第 {at} 秒起流量週期變化，每 {p} 秒一輪，±{a}%{span}', { at: e.atS, p: e.periodS, a: Math.round(e.amplitude * 100), span });
    case 'cron':
      return e.jitterS
        ? t('第 {at} 秒起每 {e} 秒一次排程突波（{m} 倍，分散到 {j} 秒）{span}', { at: e.atS, e: e.everyS, m: e.multiplier, j: Math.round((e.burstS + e.jitterS) * 100) / 100, span })
        : t('第 {at} 秒起每 {e} 秒一次排程突波（{m} 倍，{b} 秒）{span}', { at: e.atS, e: e.everyS, m: e.multiplier, b: e.burstS, span });
    case 'region_down':
      return t('第 {at} 秒區域 {region} 整區故障{span}', { at: e.atS, region: e.region, span });
    case 'partition':
      return t('第 {at} 秒區域 {a} 和 {b} 之間網路分區{span}', { at: e.atS, a: e.regions[0], b: e.regions[1], span });
    case 'pause':
      return t('第 {at} 秒起 {node} 每 {e} 秒 GC 停頓 {ms} ms{span}', { at: e.atS, node: e.node, e: e.everyS, ms: e.pauseMs, span });
    case 'shift':
      return e.forS
        ? t('第 {at} 秒起 {s} 秒內把 {from} → {to} 的權重移到 {w}', { at: e.atS, s: e.forS, from: e.from, to: e.to, w: e.weight })
        : t('第 {at} 秒把 {from} → {to} 的權重改成 {w}', { at: e.atS, from: e.from, to: e.to, w: e.weight });
    case 'reshard':
      return t('第 {at} 秒起把 {node} 重新分成 {n} 份（複製 {s} 秒）', { at: e.atS, node: e.node, n: e.toShards, s: e.forS ?? 60 });
    case 'rollout': {
      const who = e.node ?? t('全部伺服器');
      const halt = e.haltAt !== undefined ? t('，失敗超過 {p}% 自動回滾', { p: Math.round(e.haltAt * 1000) / 10 }) : '';
      return (e.waves ?? 1) > 1
        ? t('第 {at} 秒起分 {w} 波部署新版本到 {node}，每波 {s} 秒{halt}', { at: e.atS, w: e.waves ?? 1, node: who, s: e.waveS ?? 60, halt })
        : t('第 {at} 秒一次部署新版本到 {node}{halt}', { at: e.atS, node: who, halt });
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
  const presetName = Object.entries(SCENARIOS).find(([, s]) => s.name === scenario.name)?.[0];
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

  return (
    <div className="sd-runbar panel flex h-11 shrink-0 items-center gap-2 overflow-hidden border-t px-3 whitespace-nowrap" role="toolbar" aria-label={t('執行')}>
      {!active ? (
        <button className="btn btn-primary shrink-0" onClick={run} data-testid="run">
          {status === 'done' ? <RotateCcw size={14} /> : <Play size={14} />}
          {status === 'done' ? t('再跑一次') : t('執行')}
        </button>
      ) : (
        <>
          <button className="btn shrink-0" onClick={() => pause(status === 'running')} data-testid="pause">
            {status === 'running' ? <Pause size={14} /> : <Play size={14} />}
            {status === 'running' ? t('暫停') : t('繼續')}
          </button>
          <button className="btn shrink-0" onClick={finish} title={t('不看動畫，直接算完')} aria-label={t('跳到結尾')}>
            <FastForward size={14} /> <span className="sd-desk">{t('跳到結尾')}</span>
          </button>
          <button className="btn shrink-0 px-2" onClick={stop} title={t('停止')} aria-label={t('停止')}>
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
        aria-label={t('速度')}
        title={t('播放速度')}
        icon={<Gauge size={14} className="faint shrink-0" />}
        value={speed}
        options={speedOptions()}
        menuWidth={220}
        onChange={setSpeed}
        data-testid="speed"
      />
      <Sep />
      <span className="muted sd-desk shrink-0">{t('情境')}</span>
      <Select
        className="sd-run-scenario w-[230px] min-w-[120px] shrink"
        aria-label={t('情境')}
        value={presetName}
        placeholder={t(scenario.name || CUSTOM)}
        options={scenarioOptions}
        menuWidth={300}
        disabled={active}
        onChange={(k) => setScenario(structuredClone(SCENARIOS[k]))}
      />
      <NumberField
        className="w-[76px] shrink-0"
        aria-label={t('每秒請求數')}
        value={scenario.traffic.rps}
        min={0}
        step={50}
        suffix={t('/秒')}
        disabled={active}
        onChange={(v) => patch({ rps: v }, { name: CUSTOM })}
      />
      {apis?.length ? (
        <span
          className="faint sd-desk w-[100px] shrink-0 truncate text-[13px]"
          title={t('這個設計分了 API：每個請求依 API 的比例決定呼叫哪個 API，讀或寫由 API 決定，不看讀取比例。')}
          data-testid="api-mix"
        >
          {t('讀 {p}%', { p: Math.round(apis.filter((a) => a.op === 'read').reduce((s, a) => s + (traffic[a.name] ?? 0), 0) * 100) })}
          {' · '}
          {t('{n} 個 API', { n: apis.length })}
        </span>
      ) : (
      <Select
        className="sd-desk w-[100px] shrink-0"
        aria-label={t('讀取比例')}
        value={scenario.traffic.readRatio ?? 0.9}
        placeholder={t('讀 {p}%', { p: Math.round((scenario.traffic.readRatio ?? 0.9) * 100) })}
        options={readOptions()}
        menuWidth={120}
        disabled={active}
        onChange={(r) => patch({ readRatio: r }, { name: CUSTOM })}
      />
      )}
      <Select
        className="sd-desk w-[96px] shrink-0"
        aria-label={t('時長')}
        value={scenario.durationS ?? 60}
        placeholder={t('{s} 秒', { s: scenario.durationS ?? 60 })}
        options={durationOptions()}
        disabled={active}
        onChange={(d) => setScenario({ ...scenario, durationS: d, name: CUSTOM })}
      />
      {events.length > 0 && !causeHidden && (
        <span className="sd-pill no-dot sd-desk shrink-0" title={events.map(describeEvent).join('\n')} data-testid="events">
          <Zap size={12} /> {t('{n} 個事件', { n: events.length })}
        </span>
      )}
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
    hint: t('每秒 {rps} 個請求，讀取 {read}%，{dur} 秒', { rps: s.traffic.rps, read: Math.round((s.traffic.readRatio ?? 0.9) * 100), dur: s.durationS ?? 60 }),
    group,
  });
  const general = new Set(GENERAL_SCENARIOS);
  const entries = Object.entries(SCENARIOS);
  const mine = entries.filter(([k, s]) => k === own || (!general.has(k) && (k === current || (namesParts(s) && fits(s)))));
  const rest = entries.filter(([k]) => k !== own && general.has(k));
  return [...mine.map(([k, s]) => opt(k, s, t('這個設計'))), ...rest.map(([k, s]) => opt(k, s, t('通用')))];
}
