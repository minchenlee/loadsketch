import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, Check, Plus, Trash2, TriangleAlert, CircleX, X } from 'lucide-react';
import { KINDS, type ParamSpec } from '../../schema/kinds.ts';
import { EDGE, isPercent, layout, specsOf, toggleOn, unitLabel } from '../paramLayout.ts';
import { apiTraffic, edgeLatencyMs, ID_RE, regionsOf, STORE_KINDS, type DesignApi, type DesignEdge, type ParamSource, type ParamValue } from '../../schema/design.ts';
import type { NodeResult } from '../../engine/index.ts';
import { FAIL_LABEL, FAIL_REASONS } from '../../engine/index.ts';
import { useApp } from '../store.ts';
import { live, liveAt, viewTime, windowAt } from '../runtime.ts';
import { useTick } from '../useTick.ts';
import { Select } from './Select.tsx';
import { Help, NumberInput, Switch } from './fields.tsx';
import { Learn } from './Learn.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { DescriptionText, NoteText } from './Prose.tsx';
import { LESSONS } from '../../learn/lessons.ts';
import { CATEGORY_COLOR, fmtMs, fmtN, iconOf, pct } from '../ui.ts';
import { t, tx } from '../../i18n/index.ts';
import { EVIDENCE_LABEL, isGuess } from '../sources.ts';
import { ImportChecks } from './ImportChecks.tsx';
import { Versions } from './Versions.tsx';
import { MAX_PRESET_NAME, usePresets } from '../presets.ts';

const CV_PRESETS = [
  { value: 0, label: tx('Fixed (cv 0)') },
  { value: 0.5, label: tx('Small variation (cv 0.5)') },
  { value: 1, label: tx('Exponential (cv 1)') },
  { value: 2, label: tx('Long tail (cv 2)') },
];


function ParamField({ kind, name, spec, value, onChange, placeholder, origin }: { kind: string; name: string; spec: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue | undefined) => void; placeholder?: string; origin?: ParamSource }) {
  const isSet = value !== undefined;
  const id = `p-${name}`;
  const on = toggleOn(kind, name);
  const percent = isPercent(name, spec);
  // a "0 means off" field: a switch; the number shows only while it is on
  const current = (value as number | undefined) ?? (spec.type === 'dist' || spec.type === 'enum' ? 0 : spec.default);
  const off = on !== undefined && current === 0;
  let input: React.ReactNode = null;
  if (!off) {
    switch (spec.type) {
      case 'int':
      case 'number':
        input = (
          <NumberInput
            value={(value as number | undefined) ?? (placeholder !== undefined ? Number(placeholder) : spec.default)}
            min={on !== undefined ? Math.max(spec.min, spec.type === 'int' ? 1 : 0.001) : spec.min}
            max={spec.max}
            scale={percent ? 100 : 1}
            unit={percent ? '%' : t(unitLabel(spec.unit))}
            labelledBy={id}
            integer={spec.type === 'int' && !percent}
            onChange={onChange}
          />
        );
        break;
      case 'ratio': {
        const v = (value as number | undefined) ?? spec.default;
        input = (
          <div className="grid grid-cols-[1fr_5.5rem] items-start gap-2">
            <input type="range" min={0} max={1} step={0.01} value={v} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5" aria-labelledby={id} />
            <NumberInput value={v} min={on !== undefined ? 0.001 : 0} max={1} scale={100} unit="%" label={t('{label} (percent)', { label: t(spec.label) })} onChange={onChange} />
          </div>
        );
        break;
      }
      case 'dist': {
        const d = typeof value === 'number' ? { mean: value, cv: spec.default.cv } : ((value as { mean: number; cv?: number } | undefined) ?? spec.default);
        const cv = d.cv ?? spec.default.cv;
        input = (
          <div className="grid grid-cols-[1fr_1.3fr] items-start gap-1.5">
            <NumberInput value={d.mean} min={0} max={spec.max} unit="ms" labelledBy={id} onChange={(v) => onChange({ mean: v, cv })} />
            <Select
              className="w-full"
              aria-label={t('Change in {label}', { label: t(spec.label) })}
              value={cv}
              menuWidth={190}
              options={[...CV_PRESETS.map((p) => ({ value: p.value, label: t(p.label) })), ...(CV_PRESETS.some((p) => p.value === cv) ? [] : [{ value: cv, label: `cv ${cv}` }])]}
              onChange={(v) => onChange({ mean: d.mean, cv: v })}
            />
          </div>
        );
        break;
      }
      case 'enum':
        input = <Select className="w-full" aria-label={t(spec.label)} value={(value as string | undefined) ?? spec.default} options={spec.options.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(v) => onChange(v)} />;
        break;
    }
  }
  return (
    <div className="py-1.5" data-testid={`param-${name}`}>
      <div className="mb-1 flex items-center gap-2">
        <label id={id} className="font-medium">
          {t(spec.label)}
        </label>
        {origin && (
          <span
            className="sd-pill text-[12px]"
            style={{ '--pill': isGuess(origin) ? 'var(--warn)' : origin.evidence === 'answer' ? 'var(--accent)' : 'var(--line-strong)', borderStyle: isGuess(origin) ? 'dashed' : undefined } as React.CSSProperties}
            title={[origin.from, origin.ref].filter(Boolean).join(' · ') || undefined}
            data-testid={`origin-${name}`}
            data-evidence={origin.evidence}
          >
            {t(EVIDENCE_LABEL[origin.evidence])}
          </span>
        )}
        {isSet && (
          <button className="faint ml-auto text-[13px] hover:underline" onClick={() => onChange(undefined)} title={t('Reset to default')}>
            {t('Use default')}
          </button>
        )}
        {on !== undefined && (
          <span className={`flex items-center gap-1.5 ${isSet ? '' : 'ml-auto'}`}>
            <span className="faint text-[13px]">{off ? t('Off') : t('On')}</span>
            <Switch on={!off} label={t(spec.label)} onChange={(v) => onChange(v ? (spec.default === on ? undefined : on) : spec.default === 0 ? undefined : 0)} />
          </span>
        )}
      </div>
      {input}
      <Help text={t(spec.help)} />
    </div>
  );
}

/**
 * A kind's parameters in groups. A foldable group (retries, protection, autoscaling…) starts
 * folded while everything in it keeps its default, and its header then says "off".
 */
function ParamGroups({ kind, values, onChange, placeholder, hide, sources }: { kind: string; values: Record<string, ParamValue | undefined>; onChange: (name: string, v: ParamValue | undefined) => void; placeholder?: (name: string) => string | undefined; hide?: string[]; sources?: Record<string, ParamSource> }) {
  const specs = specsOf(kind);
  const groups = layout(kind, values)
    .map((g) => ({ ...g, params: g.params.filter((p) => !hide?.includes(p)) }))
    .filter((g) => g.params.length);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div>
      {groups.map((g) => {
        const isOpen = open[g.key] ?? !g.folded;
        const summary = g.changed.length ? g.changed.map((l) => t(l)).join(t(', @@list')) : g.folded ? t('Off') : '';
        return (
          <section key={g.key} className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }} data-testid={`group-${g.key}`}>
            <button type="button" className="flex w-full items-baseline gap-2 text-left" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [g.key]: !isOpen })}>
              <span className="font-semibold">{t(g.label)}</span>
              {!isOpen && summary && <span className="faint min-w-0 flex-1 truncate text-[13px]">{summary}</span>}
              <span className="faint ml-auto text-[13px]" aria-hidden>
                {isOpen ? '▾' : '▸'}
              </span>
            </button>
            {isOpen &&
              g.params.map((k) => <ParamField key={k} kind={kind} name={k} spec={specs[k]} value={values[k]} placeholder={placeholder?.(k)} origin={sources?.[k]} onChange={(v) => onChange(k, v)} />)}
          </section>
        );
      })}
    </div>
  );
}

function Stat({ k, v, hint, testId }: { k: string; v: React.ReactNode; hint?: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5" title={hint} data-testid={testId}>
      <span className="muted">{k}</span>
      <span className="num font-medium">{v}</span>
    </div>
  );
}

/** Live per-component numbers during a run, synchronized to tView (frozen when paused). */
function LiveNodeStats({ id, kind }: { id: string; kind: string }) {
  useTick();
  const now = viewTime();
  const s = liveAt(now)?.[id];
  const w = windowAt(now);
  const nw = w?.nodes[id];
  const spec = KINDS[kind];
  const hasCapacity = !!spec?.station;
  const hasQueue = kind === 'queue' || (!!spec?.station && 'queueLimit' in spec.params);
  const hasWait = !!spec?.station && 'queueLimit' in spec.params;

  let totalOk = 0;
  let totalFail = 0;
  for (const win of live.windows) {
    if (win.t * 1000 > now + 1e-6) continue;
    const wn = win.nodes[id];
    if (wn) {
      totalOk += wn.ok;
      totalFail += wn.fail;
    }
  }

  const dt = Math.max(0.001, w?.dt ?? 1);
  const done = nw ? nw.ok + nw.fail : 0;
  const errRate = done > 0 ? nw!.fail / done : 0;
  const util = nw?.util ?? (s?.slots ? s.busy / s.slots : 0);
  const queued = kind === 'queue' ? s?.depth : s?.queued;
  const allDown = !!s && s.down > 0 && (s.inst ? s.down === s.inst.length : true);

  return (
    <div className="card mt-3 p-2.5" data-testid="live-stats">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold">{t('Now')}</span>
        {allDown && (
          <span className="sd-pill text-[12px]" style={{ '--pill': 'var(--bad)', color: 'var(--bad-ink)' } as React.CSSProperties} data-testid="live-down">
            {t('Down')}
          </span>
        )}
        {!allDown && s && s.down > 0 && (
          <span className="sd-pill text-[12px]" style={{ '--pill': 'var(--warn)', color: 'var(--warn-ink)' } as React.CSSProperties} data-testid="live-down">
            {t('{n} down', { n: s.down })}
          </span>
        )}
        {s?.cb && s.cb !== 'closed' && (
          <span className="sd-pill text-[12px]" style={{ '--pill': s.cb === 'open' ? 'var(--bad)' : 'var(--warn)' } as React.CSSProperties}>
            {s.cb === 'open' ? t('Tripped') : t('Half-open probe')}
          </span>
        )}
      </div>
      {hasCapacity && <Stat testId="live-busy" k={t('In flight / capacity')} v={s ? `${fmtN(s.busy)}／${fmtN(s.slots)}` : '–'} />}
      {hasQueue && (
        <Stat
          testId="live-queued"
          k={t('Queued')}
          v={queued !== undefined ? <span style={queued > 0 ? { color: 'var(--warn-ink)' } : undefined}>{fmtN(queued)}</span> : '–'}
          hint={nw?.queue !== undefined ? t('Avg queued in the last second: {n}', { n: fmtN(nw.queue) }) : undefined}
        />
      )}
      <Stat testId="live-arrivals" k={t('Incoming / s')} v={nw ? fmtN(nw.arrivals / dt) : '–'} />
      <Stat testId="live-ok" k={t('Completed / s')} v={nw ? fmtN(nw.ok / dt) : '–'} />
      <Stat testId="live-err" k={t('Error rate')} v={nw ? <span style={errRate > 0 ? { color: 'var(--bad-ink)' } : undefined}>{pct(errRate)}</span> : '–'} />
      {hasCapacity && <Stat testId="live-util" k={t('Busy share')} v={nw || s ? pct(util) : '–'} />}
      {hasWait && <Stat testId="live-wait" k={t('Avg wait')} v={nw?.waitMs !== undefined ? fmtMs(nw.waitMs) : '–'} />}
      <Stat
        testId="live-total"
        k={t('Total ok / failed')}
        v={
          w ? (
            <>
              <span>{fmtN(totalOk)}</span>／<span style={totalFail > 0 ? { color: 'var(--bad-ink)' } : undefined}>{fmtN(totalFail)}</span>
            </>
          ) : (
            '–'
          )
        }
      />
      {live.scale > 1 && (
        <div className="faint mt-1 text-[12px]" data-testid="live-scale-note">
          {t('Simulated at 1/{k}; numbers scaled back', { k: live.scale })}
        </div>
      )}
    </div>
  );
}

function NodeStats({ r }: { r: NodeResult }) {
  const th = r.theory;
  return (
    <div className="card mt-3 p-2.5">
      <div className="mb-1 font-semibold">{t('Result of the last run')}</div>
      <Stat k={t('Requests per second')} v={fmtN(r.rps)} />
      {r.kind === 'client' && r.arrivals > 0 && (
        <Stat k={t('Failures for this user')} v={t('{n}/{total} ({pct})', { n: fmtN(r.fail), total: fmtN(r.arrivals), pct: pct(r.fail / r.arrivals) })} hint={t('Number of requests it sent that ended in failure (any reason)')} />
      )}
      {r.utilization !== undefined && <Stat k={t('Avg busy')} v={pct(r.utilization)} />}
      {r.peakUtilization !== undefined && <Stat k={t('Busiest second')} v={t('{pct} (second {s})', { pct: pct(r.peakUtilization), s: Math.round(r.peakAtS ?? 0) })} />}
      {r.waitMs !== undefined && <Stat k={t('Avg queue time')} v={fmtMs(r.waitMs)} />}
      {r.holdMs !== undefined && <Stat k={t('Hold time per request')} v={fmtMs(r.holdMs)} hint={t('Includes time waiting for the downstream response')} />}
      {r.hitRatio !== undefined && <Stat k={t('Hit rate')} v={pct(r.hitRatio)} />}
      {r.coalesced !== undefined && <Stat k={t('Coalesced reads')} v={fmtN(r.coalesced)} hint={t('Misses that waited for another request\'s DB read instead of reading the DB')} />}
      {r.leaseWaits !== undefined && <Stat k={t('Lease waits')} v={fmtN(r.leaseWaits)} hint={t('Times a request without the lease waited and asked the cache again')} />}
      {r.hcRemoved !== undefined && <Stat k={t('Health check removals')} v={fmtN(r.hcRemoved)} hint={t('Times the health check took an instance out of rotation')} />}
      {r.blindChecks !== undefined && <Stat k={t('Blind checks')} v={t('{n}@@times', { n: r.blindChecks })} hint={t('Times a control call failed, so the autoscaler, failover or DNS check did not act')} />}
      {r.ejections !== undefined && <Stat k={t('Outlier ejections')} v={fmtN(r.ejections)} hint={t('Times an instance was ejected for a while after failing in a row')} />}
      {r.queueDepthEnd !== undefined && <Stat k={t('Queue length at the end')} v={fmtN(r.queueDepthEnd)} />}
      {r.circuitOpens !== undefined && <Stat k={t('Circuit breaker trips')} v={r.circuitOpens} />}
      {r.autoscale && (
        <>
          <Stat k={t('Autoscaling instance count')} v={t('Up to {peak} instances, {end} at the end', { peak: r.autoscale.peakActive, end: r.autoscale.endActive })} hint={t('Range {min}–{max} instances', { min: r.autoscale.min, max: r.autoscale.max })} />
          <Stat k={t('Added / removed')} v={t('+{up} / −{down}', { up: r.autoscale.launches, down: r.autoscale.retires })} />
          {r.autoscale.bootFails !== undefined && <Stat k={t('Boot failures')} v={t('{n}@@times', { n: r.autoscale.bootFails })} hint={t('A component called at boot failed; the new instance boots again')} />}
        </>
      )}
      {r.asyncOk !== undefined && <Stat k={t('Message processed / failed')} v={`${fmtN(r.asyncOk)}／${fmtN(r.asyncFail ?? 0)}`} />}
      {r.holBlocked !== undefined && <Stat k={t('Waited behind its group')} v={fmtN(r.holBlocked)} hint={t('FIFO: messages that waited because an earlier one of their group was not done (head-of-line blocking)')} />}
      {r.dualWriteGaps !== undefined && <Stat k={t('Data and message disagree')} v={fmtN(r.dualWriteGaps)} hint={t('Writes where saving to the database and sending to the queue disagreed (dual write); none with the outbox on')} />}
      {r.outboxRetries !== undefined && <Stat k={t('Outbox resends')} v={fmtN(r.outboxRetries)} hint={t('Times the relay failed to send a message to the queue and sent it again later')} />}
      {r.redelivered !== undefined && (
        <>
          <Stat k={t('Redelivery')} v={fmtN(r.redelivered)} hint={t('Not done within the visibility timeout (failed, crashed or too slow), so the message comes back')} />
          <Stat k={t('Duplicate processing')} v={fmtN(r.duplicates ?? 0)} hint={t('The same message is processed twice: the worker must be idempotent')} />
          <Stat k={t('Moved to the DLQ')} v={fmtN(r.dlq ?? 0)} hint={t('Failed after the max receive count, so no more retries')} />
        </>
      )}
      {r.replicaReads !== undefined && (
        <>
          <Stat
            k={t('Stale read')}
            v={r.replicaReads ? t('{n}/{total} ({pct})', { n: fmtN(r.staleReads ?? 0), total: fmtN(r.replicaReads), pct: pct((r.staleReads ?? 0) / r.replicaReads) }) : `${fmtN(r.staleReads ?? 0)}／${fmtN(r.replicaReads)}`}
            hint={t('On a replica read, this key has data that the primary already wrote and the replica has not applied yet')}
          />
          <Stat k={t('Max replication lag@@detail')} v={fmtMs(r.maxReplLagMs ?? 0)} hint={t('At the end of each second, how far behind the slowest replica is')} />
        </>
      )}
      {r.rywMisses !== undefined && (
        <Stat k={t('Missed own writes')} v={<span style={{ color: r.rywMisses ? 'var(--bad-ink)' : undefined }}>{fmtN(r.rywMisses)}</span>} hint={t('The user read right after writing, and the replica had not applied that write yet (read-your-writes failed)')} />
      )}
      {r.lockWaits !== undefined && <Stat k={t('Writes waiting for locks')} v={fmtN(r.lockWaits)} hint={t('The key\'s row lock was held by another write, so this write waited for it')} />}
      {r.failovers !== undefined && (
        <>
          <Stat k={t('Failovers')} v={fmtN(r.failovers)} hint={t('Times a replica became the primary')} />
          <Stat k={t('Lost writes')} v={<span style={{ color: r.lostWrites ? 'var(--bad-ink)' : undefined }}>{fmtN(r.lostWrites ?? 0)}</span>} hint={t('Writes the primary acknowledged that the new primary never received (asynchronous replication)')} />
          {r.divergentWrites !== undefined && (
            <Stat k={t('Divergent writes')} v={<span style={{ color: 'var(--bad-ink)' }}>{fmtN(r.divergentWrites)}</span>} hint={t('Writes the old primary took after the new one was promoted during a network partition (split brain): the new primary does not have them')} />
          )}
        </>
      )}
      {r.expired !== undefined &&
        (r.queueDepthEnd !== undefined ? (
          <Stat k={t('Message expired')} v={fmtN(r.expired)} hint={t('Not done before the retention time, so it is dropped')} />
        ) : (
          <Stat k={t('Drop when expired')} v={fmtN(r.expired)} hint={t('The deadline had passed when it was dequeued, so it was dropped with no wasted work')} />
        ))}
      {FAIL_REASONS.filter((k) => r.origin[k]).map((k) => (
        <Stat key={k} k={t(FAIL_LABEL[k])} v={<span style={{ color: 'var(--bad)' }}>{fmtN(r.origin[k])}</span>} />
      ))}
      {th && (
        <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
          <div className="mb-1 font-medium">
            {t('Compared with queueing theory ({model}, c = {c})', { model: th.model, c: th.servers })}
          </div>
          <Stat k={t('Utilization ρ')} v={th.rho.toFixed(2)} />
          <Stat k={t('Probability of queuing')} v={t('Sim {sim}  Theory {theory}', { sim: pct(th.simPWait), theory: pct(th.pWait) })} />
          <Stat k={t('Avg queue time')} v={t('Sim {sim}  Theory {theory}', { sim: fmtMs(th.simWaitMs), theory: th.waitMs === null ? t('No limit') : fmtMs(th.waitMs) })} />
          {th.waitMs === null && <div className="faint text-[13px]">{t('ρ ≥ 1: arrivals are faster than service, so the queue keeps growing.')}</div>}
          {th.note && <div className="faint mt-1 text-[13px]">{th.note}</div>}
        </div>
      )}
    </div>
  );
}

/** Letters, digits, _ and - (the id rule), at most 48, starting with a letter or digit. */
const cleanRegion = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 48);

function RegionField({ id, region, field = 'region' }: { id: string; region: string | undefined; field?: 'region' | 'replicaRegion' }) {
  const updateNode = useApp((s) => s.updateNode);
  const nodes = useApp((s) => s.nodes);
  const regions = useMemo(() => regionsOf({ nodes: nodes.map((n) => n.data.node) }), [nodes]);
  return (
    <div className="py-1.5">
      <label className="mb-1 block font-medium" htmlFor={`node-${field}`}>
        {field === 'region' ? t('Region') : t('Replica region@@detail')}
      </label>
      <input
        id={`node-${field}`}
        className="field w-full"
        list={`region-list-${field}`}
        value={region ?? ''}
        placeholder={field === 'region' ? t('No region') : t('Same as the primary')}
        onChange={(e) => updateNode(id, { [field]: cleanRegion(e.target.value) })}
        data-testid={field === 'region' ? 'region' : 'replica-region'}
      />
      <datalist id={`region-list-${field}`}>
        {regions.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="faint mt-1 text-[13px] leading-snug">
        {field === 'region'
          ? t('The region (data center) the component runs in, for example us-east. A call between two regions takes the inter-region latency; a region outage takes all components of the region down together.')
          : t('Set this when the read replicas are in another region. Replication to them takes one inter-region trip longer; when the primary\'s region fails, the replicas stay up and can take over.')}
      </div>
    </div>
  );
}

function NodeInspector({ id }: { id: string }) {
  const node = useApp((s) => s.nodes.find((n) => n.id === id)?.data.node);
  const result = useApp((s) => s.result?.nodes[id]);
  const status = useApp((s) => s.status);
  const active = status === 'running' || status === 'paused';
  const updateNode = useApp((s) => s.updateNode);
  const remove = useApp((s) => s.remove);
  const savePreset = usePresets((s) => s.save);
  // the name being typed for a new preset (null: closed), and the last one saved here
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    setSaving(null);
    setSaved(null);
    setRefused(false);
  }, [id]);
  useEffect(() => setRefused(false), [saving === null]);
  if (!node) return null;
  const spec = KINDS[node.kind];
  const Icon = iconOf(node as { kind: string; params?: Record<string, unknown> });
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <div className="sd-icon flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: CATEGORY_COLOR[spec.category] }}>
          {Icon && <Icon size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t(spec.label)}</div>
          <div className="faint text-[13px]">
            {spec.labelEn} · id <code>{node.id}</code>
          </div>
        </div>
        <button className="btn" onClick={() => setSaving(saving === null ? (node.label?.trim() || t(spec.label)).slice(0, MAX_PRESET_NAME) : null)} title={t('Save as preset: then drag the same component from "My presets" on the left')} aria-label={t('Save as preset')} aria-expanded={saving !== null} data-testid="preset-save">
          <BookmarkPlus size={14} />
        </button>
        <button className="btn" onClick={() => remove({ type: 'node', id })} title={t('Delete component')}>
          <Trash2 size={14} />
        </button>
      </div>
      {saving !== null && (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving.trim()) return;
            // refused (too many changes wait for storage): the form stays open and says why
            if (!savePreset(node, saving)) return setRefused(true);
            setSaving(null);
            setSaved(saving.trim());
          }}
        >
          <input className="field min-w-0 flex-1" value={saving} maxLength={MAX_PRESET_NAME} autoFocus aria-label={t('Preset name')} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSaving(null)} data-testid="preset-name" />
          <button className="btn btn-primary" type="submit" disabled={!saving.trim()} title={t('Save as preset')} aria-label={t('Save as preset')} data-testid="preset-save-confirm">
            <Check size={14} />
          </button>
          <button className="btn" type="button" onClick={() => setSaving(null)} title={t('Cancel')} aria-label={t('Cancel')}>
            <X size={14} />
          </button>
        </form>
      )}
      {refused && saving !== null && (
        <p className="mt-2 text-[13px]" style={{ color: 'var(--bad-ink)' }} role="status" data-testid="preset-refused">
          {t('This browser cannot save presets, and too many changes are waiting: this change was not made. Export your presets first.')}
        </p>
      )}
      {saved !== null && saving === null && (
        <p className="muted mt-2 text-[13px]" role="status" data-testid="preset-saved">
          {t('Saved as preset "{name}": it is under "My presets" on the left.', { name: saved })}
        </p>
      )}
      <p className="muted mt-2 text-[14px] leading-relaxed">{t(spec.summary)}</p>
      {active && <LiveNodeStats id={id} kind={node.kind} />}
      <div className="py-1.5">
        <label className="mb-1 block font-medium">{t('Name')}</label>
        <input className="field w-full" value={node.label ?? ''} placeholder={t(spec.label)} onChange={(e) => updateNode(id, { label: e.target.value })} />
      </div>
      {node.kind !== 'client' && <RegionField id={id} region={node.region} />}
      {(node.kind === 'database' || node.kind === 'sharded_db') && <RegionField id={id} region={node.replicaRegion} field="replicaRegion" />}
      {/* localReplicas only means something with a replica region */}
      <ParamGroups
        kind={node.kind}
        values={node.params ?? {}}
        hide={node.replicaRegion ? undefined : ['localReplicas']}
        sources={node.source?.params}
        onChange={(k, v) => updateNode(id, { params: { [k]: v } })}
      />
      {!active && result && <NodeStats r={result} />}
    </div>
  );
}

function EdgeInspector({ id }: { id: string }) {
  const edge = useApp((s) => s.edges.find((e) => e.id === id)?.data?.edge);
  const from = useApp((s) => s.nodes.find((n) => n.id === edge?.from)?.data.node);
  const to = useApp((s) => s.nodes.find((n) => n.id === edge?.to)?.data.node);
  const interRegionMs = useApp((s) => s.doc.interRegionMs);
  const apis = useApp((s) => s.doc.apis);
  const result = useApp((s) => s.result?.edges[id]);
  const updateEdge = useApp((s) => s.updateEdge);
  const remove = useApp((s) => s.remove);
  if (!edge) return null;
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t('Call')}</div>
          <div className="faint text-[13px]">
            <code>{edge.from}</code> → <code>{edge.to}</code>
          </div>
        </div>
        <button className="btn" onClick={() => remove({ type: 'edge', id })} title={t('Delete this call')}>
          <Trash2 size={14} />
        </button>
      </div>
      {from?.kind === 'cache' && to && STORE_KINDS.has(to.kind) && (
        <p className="muted mt-2 text-[13px] leading-snug" data-testid="edge-through-note">
          {t('A cache connected straight to a database: this edge is read-through / write-through. On a read miss, the cache itself reads the database and fills itself; on a write, the cache writes the database first, then updates itself. The caller of the cache does not need its own edge to the database.')}
        </p>
      )}
      <ParamGroups
        kind={EDGE}
        values={edge as unknown as Record<string, ParamValue | undefined>}
        sources={edge.source?.params}
        placeholder={(k) => (k === 'latencyMs' ? String(edgeLatencyMs({}, from ?? { kind: '' }, to, interRegionMs)) : undefined)}
        onChange={(k, v) => updateEdge(id, { [k]: v } as Partial<DesignEdge>)}
      />
      {apis?.length ? <EdgeApis apis={apis} value={edge.apis} onChange={(v) => updateEdge(id, { apis: v })} /> : null}
      {result && (
        <div className="card mt-3 p-2.5">
          <div className="mb-1 font-semibold">{t('Result of the last run')}</div>
          <Stat k={t('Calls per second')} v={fmtN(result.rps)} />
          <Stat k={t('Failures')} v={fmtN(result.fail)} />
          <Stat k={t('Retry')} v={fmtN(result.retries)} />
          <Stat k={t('Comes back only after it is abandoned')} v={fmtN(result.late)} hint={t('The caller already timed out and gave up, and the downstream finishes later: wasted work')} />
          {result.denied !== undefined && <Stat k={t('Blocked by retry budget')} v={fmtN(result.denied)} hint={t('Wanted to retry, but the retry budget for the last 10 s is used up')} />}
          {result.throttled !== undefined && <Stat k={t('Throttled by caller')} v={fmtN(result.throttled)} hint={t('Calls the caller rejected locally and did not send, because few recent calls succeeded')} />}
          {result.bulkhead !== undefined && <Stat k={t('Rejected by bulkhead')} v={fmtN(result.bulkhead)} hint={t('Calls that failed at once because the caller\'s concurrent-call slots were full')} />}
          {result.fallbacks !== undefined && <Stat k={t('Fallback responses')} v={fmtN(result.fallbacks)} hint={t('After a failed call, the caller used a fallback response (degraded); the request still succeeds')} />}
          {result.hedges !== undefined && <Stat k={t('Hedges sent')} v={fmtN(result.hedges)} hint={t('Second copies sent to another instance after no reply for too long (included in calls per second)')} />}
          {result.hedges !== undefined && <Stat k={t('Hedge won')} v={fmtN(result.hedgeWins ?? 0)} hint={t('How many times the second copy succeeded before the original')} />}
          {result.connects !== undefined && <Stat k={t('New connections')} v={fmtN(result.connects)} hint={t('Calls that first did the TCP + TLS handshakes; the other calls reused an open connection')} />}
          {result.copies !== undefined && <Stat k={t('Fan-out copies sent')} v={fmtN(result.copies)} hint={t('Copies sent to shards or instances, over all calls. The target\'s load is the calls times this factor.')} />}
        </div>
      )}
    </div>
  );
}

/** Which APIs an edge carries: a chip per API of the design; none chosen means every API. */
function EdgeApis({ apis, value, onChange }: { apis: DesignApi[]; value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  const on = new Set(value ?? []);
  return (
    <div className="py-1.5" data-testid="edge-apis">
      <div className="mb-1 font-medium" id="p-apis">
        {t('APIs on this edge')}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="p-apis">
        {apis.map((a) => (
          <button
            key={a.name}
            className={`btn ${on.has(a.name) ? 'btn-on' : ''}`}
            aria-pressed={on.has(a.name)}
            onClick={() => {
              const next = apis.map((x) => x.name).filter((n) => (n === a.name ? !on.has(n) : on.has(n)));
              onChange(next.length ? next : undefined);
            }}
          >
            {a.name}
          </button>
        ))}
      </div>
      <div className="faint mt-1 text-[13px] leading-snug">{value?.length ? t('Only requests to these APIs take this edge.') : t('None chosen: requests to every API take this edge. Choose some, and only they take it (routing by API path).')}</div>
    </div>
  );
}

/**
 * The APIs users call and their share of the traffic. With APIs, each request calls one of them;
 * the API, not the scenario's read share, says whether it reads or writes.
 */
function ApiEditor() {
  const apis = useApp((s) => s.doc.apis) ?? [];
  const setApis = useApp((s) => s.setApis);
  const design = useApp((s) => s.design);
  // recomputed on every render: cheap, and edges or client weights may have changed
  const traffic = apis.length ? apiTraffic(design()) : {};
  const patch = (i: number, p: Partial<DesignApi>) => setApis(apis.map((a, k) => (k === i ? { ...a, ...p } : a)));
  const add = () => {
    const taken = new Set(apis.map((a) => a.name));
    let k = apis.length + 1;
    while (taken.has(`api${k}`)) k++;
    setApis([...apis, { name: `api${k}`, op: 'read', share: 1 }]);
  };
  return (
    <div className="mt-4" data-testid="api-editor">
      <div className="flex items-center gap-2">
        <div className="font-semibold">API</div>
        <button className="btn ml-auto" onClick={add} title={t('Add an API')} aria-label={t('Add an API')}>
          <Plus size={14} />
        </button>
      </div>
      {apis.length === 0 ? (
        <div className="faint mt-1 text-[13px] leading-snug">{t('No APIs: the scenario\'s read share decides whether each request reads or writes. Add APIs to let an edge carry only some of them.')}</div>
      ) : (
        <>
        <div className="faint mt-1 text-[13px] leading-snug">{t('Name, read or write, share. Each client calls only the APIs its edges carry, drawn by share; so the real share also depends on the client weights.')}</div>
        <ul className="mt-1 space-y-1.5">
          {apis.map((a, i) => (
            <li key={i} className="grid grid-cols-[1fr_5.5rem_3.5rem_auto] items-center gap-1.5">
              <ApiName value={a.name} taken={apis.filter((_, k) => k !== i).map((x) => x.name)} onCommit={(name) => setApis(apis.map((x, k) => (k === i ? { ...x, name } : x)), { [a.name]: name })} />
              <Select className="w-full" aria-label={t('"{api}": read or write', { api: a.name })} value={a.op} options={[{ value: 'read', label: t('Read') }, { value: 'write', label: t('Write') }]} onChange={(v) => patch(i, { op: v as DesignApi['op'] })} />
              <NumberInput value={a.share ?? 1} min={0} max={1000} onChange={(v) => patch(i, { share: v })} />
              <button className="btn" onClick={() => setApis(apis.filter((_, k) => k !== i))} title={t('Delete this API')} aria-label={t('Delete API "{api}"', { api: a.name })}>
                <X size={14} />
              </button>
              <div className="faint col-span-4 -mt-1 text-[12px]">{t('{p} of all traffic', { p: pct(traffic[a.name] ?? 0) })}</div>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}

/** An API name: committed on blur or Enter, when it is a valid, unused id. */
function ApiName({ value, taken, onCommit }: { value: string; taken: string[]; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const ok = ID_RE.test(text) && !taken.includes(text);
  const commit = () => (ok && text !== value ? onCommit(text) : setText(value));
  return <input className="field w-full" value={text} aria-label={t('API name')} aria-invalid={!ok} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function DesignInfo() {
  const doc = useApp((s) => s.doc);
  const issues = useApp((s) => s.issues);
  const result = useApp((s) => s.result);
  const example = useApp((s) => s.example);
  const lesson = example ? LESSONS[example] : undefined;
  // before the first run, a lesson hides the description: it gives the answer away
  const about = lesson && !result ? t(lesson.intro) : doc.description;
  return (
    <div>
      <div className="font-semibold">{doc.name}</div>
      {about && (
        <div className="muted mt-1 text-[14px] leading-relaxed" data-testid="design-about">
          <DescriptionText text={about} />
        </div>
      )}
      {/* notes of the design: what to try, what is simplified */}
      {doc.notes?.map((n) => (
        <div key={n.id} className="card mt-3 px-3 py-2.5 text-[14px] leading-relaxed" data-testid="design-note">
          <NoteText text={n.text} />
        </div>
      ))}
      {result && (
        <>
          <div className="mt-4 font-semibold">{t('Last run')}</div>
          <div className="mt-1">
            <Stat k={t('Offered')} v={fmtN(result.summary.offered)} />
            <Stat k={t('Success')} v={fmtN(result.summary.ok)} />
            <Stat k={t('Error rate')} v={pct(result.summary.errorRate)} />
            <Stat k="p50 / p99" v={`${fmtMs(result.summary.latencyMs.p50)} / ${fmtMs(result.summary.latencyMs.p99)}`} />
          </div>
          {result.apis && (
            <table className="mt-2 w-full text-[13px]" data-testid="api-results">
              <thead className="faint text-left">
                <tr>
                  <th className="font-normal">API</th>
                  <th className="text-right font-normal">{t('Offered')}</th>
                  <th className="text-right font-normal">{t('Error rate')}</th>
                  <th className="text-right font-normal">p99</th>
                </tr>
              </thead>
              <tbody className="num">
                {Object.entries(result.apis).map(([name, a]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="text-right">{fmtN(a.offered)}</td>
                    <td className="text-right" style={a.errorRate > 0.01 ? { color: 'var(--bad)' } : undefined}>
                      {pct(a.errorRate)}
                    </td>
                    <td className="text-right">{fmtMs(a.latencyMs.p99)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <ApiEditor />
      <div className="mt-4 font-semibold">{t('Design check')}</div>
      {issues.length === 0 ? (
        <div className="faint mt-1">{t('No problems.')}</div>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {issues.map((i, k) => (
            <li key={k} className="flex gap-1.5 text-[14px] leading-snug">
              {i.level === 'error' ? <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />}
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="faint mt-4 text-[13px] leading-relaxed">{t('Click a component or a call to change its settings. After a run, click the component again to see its results next to the queuing theory values.')}</div>
    </div>
  );
}

type Tab = 'design' | 'scenario' | 'learn' | 'versions' | 'checks';

/**
 * Four tabs: the settings of the design or the selected part, the scenario (traffic and events), the results (lesson questions, SLA, cost, the story
 * of the run, challenges) and the versions (one per finished run). A lesson example opens on the lesson; selecting a part shows its settings.
 */
const WIDTH_KEY = 'loadsketch-right-width';
const DEFAULT_W = 340;
const MIN_W = 280;
/** At most 60% of the window (and 900 px): the canvas keeps some room. */
const maxW = () => Math.max(MIN_W, Math.min(900, Math.round(window.innerWidth * 0.6)));
const clampW = (w: number) => Math.round(Math.min(maxW(), Math.max(MIN_W, w)));

/** The panel's width, dragged on its left edge (or arrow keys there); kept in localStorage. */
function usePanelWidth() {
  // pref: the width asked for; w: that width inside this window's limits (the window can shrink and grow back)
  const [pref, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v > 0 ? v : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  const [, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // the width shown during a drag, apart from the stored preference (a drag in a narrow window must not overwrite it)
  const [dragW, setDragW] = useState<number | null>(null);
  const w = clampW(dragW ?? pref);
  // the preference is kept as asked (within 280–900 px), not as this window clamps it: a wider window shows it again
  // A resize starts from the width shown. One that ends at this window's limit keeps a wider stored
  // width (a wider window shows it again); a narrower one is the new choice.
  const save = (v: number, exact = false) => {
    const c = Math.round(Math.min(900, Math.max(MIN_W, !exact && v >= maxW() ? Math.max(v, pref) : v)));
    setW(c);
    try {
      localStorage.setItem(WIDTH_KEY, String(c));
    } catch {
      // private mode: the width just is not kept
    }
  };
  const drag = useRef<{ x: number; w: number } | null>(null);
  const handle = (
    <div
      className="sd-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize the settings panel')}
      aria-valuenow={w}
      aria-valuemin={MIN_W}
      aria-valuemax={maxW()}
      tabIndex={0}
      title={t('Drag to change the width; double-click for the default')}
      data-testid="right-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = '';
        drag.current = { x: e.clientX, w };
      }}
      onPointerMove={(e) => {
        // the panel is on the right: dragging its left edge to the left makes it wider
        if (drag.current) setDragW(clampW(drag.current.w + drag.current.x - e.clientX));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        delete e.currentTarget.dataset.dragging;
        save(drag.current.w + drag.current.x - e.clientX);
        setDragW(null);
        drag.current = null;
      }}
      onDoubleClick={() => save(DEFAULT_W, true)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') save(w + 16);
        else if (e.key === 'ArrowRight') save(w - 16);
        else return;
        e.preventDefault();
      }}
    />
  );
  return { w, handle };
}

export function Inspector() {
  const { w: width, handle } = usePanelWidth();
  const selected = useApp((s) => s.selected);
  const example = useApp((s) => s.example);
  const status = useApp((s) => s.status);
  // the checks tab: only while the imported design is the one loaded
  const hasChecks = useApp((s) => !!s.imported && s.imported.loads === s.loads);
  const hasLesson = example ? LESSONS[example] !== undefined : false;
  // opened with a part already selected (the phone drawer after a tap): its settings, not the lesson
  const [tab, setTab] = useState<Tab>(hasLesson && !selected ? 'learn' : 'design');
  const [seen, setSeen] = useState(true);
  const imports = useApp((s) => s.imported?.loads);
  const asked = useApp((s) => s.settingsAsked);
  const [last, setLast] = useState({ selected, example, status, imports, asked });
  if (last.selected !== selected || last.example !== example || last.status !== status || last.imports !== imports || last.asked !== asked) {
    setLast({ selected, example, status, imports, asked });
    if (imports !== undefined && imports !== last.imports) setTab('checks');
    else if (asked !== last.asked || (selected && selected !== last.selected)) setTab('design');
    else if (example !== last.example) setTab(hasLesson ? 'learn' : 'design');
    // a finished run has a new story: mark the tab when it is not open
    if (status === 'done' && last.status !== 'done') setSeen(tab === 'learn');
  }
  // the checks tab went away (another design loaded) while it was open: back to settings
  if (tab === 'checks' && !hasChecks) setTab('design');
  const open = (x: Tab) => {
    setTab(x);
    if (x === 'learn') setSeen(true);
  };
  const tabBtn = (x: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === x}
      className={`relative flex-1 border-b-2 px-2 py-2 text-[14px] font-medium ${tab === x ? 'border-[var(--accent)]' : 'muted border-transparent'}`}
      onClick={() => open(x)}
      data-testid={`tab-${x}`}
    >
      {label}
      {x === 'learn' && !seen && tab !== 'learn' && <span className="absolute top-2 ml-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-label={t('New explanation')} />}
    </button>
  );
  return (
    <aside className="panel relative flex shrink-0 flex-col border-l" style={{ width }} aria-label={t('Settings')} data-testid="right-panel">
      {handle}
      <div role="tablist" className="flex shrink-0 border-b border-[var(--line)] px-3">
        {tabBtn('design', t('Settings'))}
        {tabBtn('scenario', t('Scenario'))}
        {tabBtn('learn', t('Results'))}
        {tabBtn('versions', t('Versions'))}
        {hasChecks && tabBtn('checks', t('Check'))}
      </div>
      <div className="flex-1 overflow-y-auto p-3" role="tabpanel">
        {tab === 'checks' && hasChecks ? (
          <ImportChecks onRun={() => open('learn')} />
        ) : tab === 'learn' ? (
          <Learn />
        ) : tab === 'versions' ? (
          <Versions />
        ) : tab === 'scenario' ? (
          <ScenarioEditor />
        ) : selected?.type === 'node' ? (
          <NodeInspector key={selected.id} id={selected.id} />
        ) : selected?.type === 'edge' ? (
          <EdgeInspector key={selected.id} id={selected.id} />
        ) : (
          <DesignInfo />
        )}
      </div>
    </aside>
  );
}
