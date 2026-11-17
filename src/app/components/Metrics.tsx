import { useMemo } from 'react';
import { FAIL_LABEL, FAIL_REASONS } from '../../engine/index.ts';
import { KINDS, resolveParams } from '../../schema/kinds.ts';
import { live } from '../runtime.ts';
import { EVENT_SPEC, eventMarks } from '../scenarioEdit.ts';
import { useApp } from '../store.ts';
import { useCauseHidden } from './OnCall.tsx';
import { PALETTE, fmtMs, fmtN, pct } from '../ui.ts';
import { Chart, Spark, type SeriesSpec } from './Chart.tsx';
import { SlaSummary } from './Sla.tsx';
import { t } from '../../i18n/index.ts';


export function Metrics() {
  const windows = useApp((s) => s.windows);
  const timeline = useApp((s) => s.timeline);
  const result = useApp((s) => s.result);
  const status = useApp((s) => s.status);
  const nodes = useApp((s) => s.nodes);
  // the events of the run on screen (or of the scenario about to run)
  const ran = useApp((s) => s.ran);
  const current = useApp((s) => s.scenario);
  const shown = ran?.scenario ?? current;
  // on call, before the answer: the event marks, the bottleneck and the timeline name the cause
  const hidden = useCauseHidden();
  const marks = useMemo(
    () =>
      eventMarks(hidden ? [] : shown.events, shown.durationS ?? 60, (ev) => {
        const what = t(EVENT_SPEC[ev.type].label);
        const target = 'node' in ev ? ev.node : ev.type === 'region_down' ? ev.region : '';
        return t('{t} s: {what}', { t: ev.atS, what: target ? `${what}（${target}）` : what });
      }),
    [shown, hidden],
  );

  const stations = useMemo(() => nodes.filter((n) => KINDS[n.data.node.kind].station).map((n) => ({ id: n.id, label: n.data.node.label ?? t(KINDS[n.data.node.kind].label) })), [nodes]);

  const traffic = useMemo(() => {
    const xs = windows.map((w) => w.t);
    const ok = windows.map((w) => w.ok / w.dt);
    const fail = windows.map((w) => FAIL_REASONS.reduce((a, k) => a + w.fail[k], 0) / w.dt);
    const target = windows.map((w) => (w.targetRps > 0 ? w.targetRps : null));
    return [xs, target, ok, fail];
  }, [windows]);
  const latency = useMemo(() => {
    const xs = windows.map((w) => w.t);
    const v = (k: 'p50' | 'p95' | 'p99') => windows.map((w) => (w.latency.count ? w.latency[k] : null));
    return [xs, v('p50'), v('p95'), v('p99')];
  }, [windows]);
  const util = useMemo(() => [windows.map((w) => w.t), ...stations.map((s) => windows.map((w) => w.nodes[s.id]?.maxUtil ?? null))], [windows, stations]);
  // Autoscaled nodes: instances serving and booting per second.
  const autos = useMemo(() => stations.filter((s) => {
    const n = nodes.find((x) => x.id === s.id)!.data.node;
    return resolveParams(n.kind, n.params as Record<string, unknown> | undefined).autoscale === 'on';
  }), [stations, nodes]);
  const inst = useMemo(() => [windows.map((w) => w.t), ...autos.flatMap((s) => [windows.map((w) => w.nodes[s.id]?.active ?? null), windows.map((w) => w.nodes[s.id]?.booting ?? null)])], [windows, autos]);
  const instSeries: SeriesSpec[] = useMemo(() => autos.flatMap((s, i) => [
    { label: t('{name} online', { name: s.label }), color: PALETTE[i % PALETTE.length] },
    { label: t('{name} starting up', { name: s.label }), color: PALETTE[i % PALETTE.length], dash: true },
  ]), [autos]);
  const utilSeries: SeriesSpec[] = useMemo(() => stations.map((s, i) => ({ label: s.label, color: PALETTE[i % PALETTE.length] })), [stations]);

  const recent = windows.slice(-40);
  const last = windows[windows.length - 1];
  const lastFail = last ? FAIL_REASONS.reduce((a, k) => a + last.fail[k], 0) : 0;

  return (
    <section className="panel flex h-[248px] shrink-0 gap-2.5 border-t p-2.5" style={{ background: 'var(--bg)' }} aria-label={t('Metrics')}>
      <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto" data-testid="metrics-side">
        {status === 'idle' && !result ? (
          <div className="faint m-auto text-center text-[14px] leading-relaxed">
            {t('Press "Run" to start the simulation.')}
            <br />
            {t('At 0.01×–0.1× speed you can watch one request travel; at 1× and above you see the overall traffic.')}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2" data-testid="kpis">
              <Kpi k={t('Success/s')} v={last ? fmtN(last.ok / last.dt) : '–'} spark={recent.map((w) => w.ok / w.dt)} />
              <Kpi k={t('Failures/s')} v={last ? fmtN(lastFail / last.dt) : '–'} bad={lastFail > 0} spark={recent.map((w) => FAIL_REASONS.reduce((a, k) => a + w.fail[k], 0) / w.dt)} color="var(--bad)" />
              <Kpi k="p99" v={last?.latency.count ? fmtMs(last.latency.p99) : '–'} spark={recent.map((w) => (w.latency.count ? w.latency.p99 : null))} />
            </div>
            {live.scale > 1 && (
              <div className="faint mt-1 text-[13px]" data-testid="scale-note" title={t('Traffic and capacity (slots per instance, queue limits, rate limits) are divided by {k}; processing times and time do not change. Requests, rps and errors are multiplied back by {k}.', { k: live.scale })}>
                {t('Simulated at 1/{k}; numbers scaled back', { k: live.scale })}
              </div>
            )}
            <SlaSummary />
            {result?.bottleneck && !hidden && (
              <div className="card mt-2 px-2 py-1.5 text-[14px] leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, var(--line))' }} data-testid="bottleneck">
                <span className="font-semibold">{t('Bottleneck: ')}</span>
                {result.bottleneck.why}
              </div>
            )}
            {result && (
              <div className="faint mt-1 text-[13px]" data-testid="run-summary">
                {t('Whole run: {ok} success, error rate {err}, p99 {p99}', { ok: fmtN(result.summary.ok), err: pct(result.summary.errorRate), p99: fmtMs(result.summary.latencyMs.p99) })}
                {result.summary.degraded ? t(' (degraded {n})', { n: fmtN(result.summary.degraded) }) : ''}
                {!hidden && FAIL_REASONS.filter((k) => result.summary.fail[k]).map((k) => t(', {label} {n}', { label: t(FAIL_LABEL[k]), n: fmtN(result.summary.fail[k]) }))}
              </div>
            )}
            <ul className="mt-2 min-h-[4.5rem] flex-1 space-y-0.5 overflow-y-auto text-[14px]" aria-label={t('Events')}>
              {hidden && <li className="faint text-[13px]" data-testid="timeline-hidden">{t('On call: the event log shows after you answer.')}</li>}
              {!hidden && timeline.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="faint num w-11 shrink-0 text-right">{e.t.toFixed(1)}s</span>
                  <span>{e.text}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {/* the charts keep their width: more charts (autoscaling) scroll sideways instead of shrinking */}
      <div className="sd-charts flex min-w-0 flex-1 gap-2.5 overflow-x-auto" data-testid="charts">
      <Chart
        testId="chart-traffic"
        marks={marks}
        title={t('Requests per second')}
        data={traffic}
        series={[
          { label: t('Offered'), color: 'var(--ink-3)', dash: true },
          { label: t('Success'), color: 'var(--ok)', fill: true },
          { label: t('Failures'), color: 'var(--bad)', fill: true },
        ]}
        height={160}
      />
      <Chart
        testId="chart-latency"
        marks={marks}
        title={t('Latency (successful requests)')}
        data={latency}
        series={[
          { label: 'p50', color: 'var(--read)' },
          { label: 'p95', color: 'var(--warn)' },
          { label: 'p99', color: 'var(--bad)' },
        ]}
        height={160}
        unit="ms"
      />
      <Chart testId="chart-util" marks={marks} title={t('Utilization (the busiest instance of each component)')} data={util} series={utilSeries} height={160} yMax={1.05} unit="%" />
      {autos.length > 0 && <Chart testId="chart-instances" marks={marks} title={t('Instances (autoscaling)')} data={inst} series={instSeries} height={160} />}
      </div>
    </section>
  );
}

function Kpi({ k, v, bad, spark, color }: { k: string; v: string; bad?: boolean; spark: (number | null)[]; color?: string }) {
  return (
    <div className="card overflow-hidden pt-1.5">
      <div className="muted px-2 text-[13px]">{k}</div>
      <div className="num px-2 text-[18px] leading-tight font-semibold tracking-tight" style={{ color: bad ? 'var(--bad-ink)' : undefined }}>
        {v}
      </div>
      <Spark values={spark} color={color} />
    </div>
  );
}
