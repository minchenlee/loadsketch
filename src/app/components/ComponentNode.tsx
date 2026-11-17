import { memo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { KINDS, resolveParams } from '../../schema/kinds.ts';
import { instanceCount, instanceRoles, type DesignNode } from '../../schema/design.ts';
import { guessedParams } from '../sources.ts';
import { useApp } from '../store.ts';
import { enterDelay } from '../motion.ts';
import type { SdNode } from '../convert.ts';
import type { LimitMark } from '../findLimit.ts';
import { liveAt, viewTime, windowAt } from '../runtime.ts';
import { CATEGORY_COLOR, fmtN, iconOf, pct, utilColor } from '../ui.ts';
import { useTick } from '../useTick.ts';
import { t, tx } from '../../i18n/index.ts';

export const NODE_W = 200;

/** One line that says what the node is set to. */
function paramSummary(n: DesignNode): string {
  const p = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
  const ms = (k: string) => `${(p[k] as { mean: number }).mean} ms`;
  switch (n.kind) {
    case 'client':
      return t('Generate traffic');
    case 'dns':
      return t('Cache hit {p}', { p: pct(p.resolverCacheHit as number) });
    case 'cdn':
      return t('Hit {p}', { p: pct(p.hitRatio as number) });
    case 'load_balancer':
      return String(p.policy);
    case 'rate_limiter':
      return t('{rate}/s · burst {burst}', { rate: fmtN(p.ratePerSec as number), burst: String(p.burst) });
    case 'circuit_breaker':
      return t('Open at failures ≥ {p}', { p: pct(p.failureRatio as number) });
    case 'api_gateway':
    case 'service':
    case 'custom':
    case 'worker':
      return t('{c} concurrent · {ms}', { c: String(p.concurrency), ms: ms('serviceMs') }) + (p.autoscale === 'on' ? ` · ${t('Autoscaling')}` : '');
    case 'function':
      return t('limit {c} · {ms} · cold start {cold}', { c: fmtN(p.maxConcurrency as number), ms: ms('serviceMs'), cold: ms('coldStartMs') });
    case 'cache':
      return p.mode === 'lru' ? `LRU ${fmtN(p.capacityKeys as number)} keys` : t('Hit {p}', { p: pct(p.hitRatio as number) });
    case 'database':
      return (p.replicas as number) ? t('Primary + {r} replicas · {c} connections', { r: String(p.replicas), c: String(p.connections) }) : t('Single primary · {c} connections', { c: String(p.connections) });
    case 'sharded_db':
      return t('{s} shards · {c} connections', { s: String(p.shards), c: String(p.connections) });
    case 'queue':
      return t('Limit {n} messages', { n: fmtN(p.maxDepth as number) });
    case 'object_storage':
      return `GET ${ms('getMs')}`;
    default:
      return '';
  }
}

/** Autoscaling state codes from LiveNode.inst[i][4]. */
const OFF = 1;
const BOOT = 2;
const WARM = 3;
const RETIRING = 4;
const STATE_TEXT: Record<number, string> = { [OFF]: tx('Not started'), [BOOT]: tx('Booting'), [WARM]: tx('Warming up'), [RETIRING]: tx('Scaling down') };

/** One row per instance: role, how busy it is now, its queue, and whether it is down. */
function InstanceList({ id, roles }: { id: string; roles: string[] }) {
  useTick();
  const status = useApp((st) => st.status);
  const s = status === 'idle' ? undefined : liveAt(viewTime())?.[id];
  const inst = s?.inst;
  return (
    <div className="mt-2 space-y-[3px] border-t pt-1.5" style={{ borderColor: 'var(--line)' }} data-instances={id}>
      {roles.map((role, i) => {
        const [b, sl, q, d, st] = inst?.[i] ?? [0, 0, 0, 0, 0];
        const u = sl ? b / sl : 0;
        const idle = st === OFF || st === BOOT;
        const note = STATE_TEXT[st] ? t(', {state}', { state: t(STATE_TEXT[st]) }) : '';
        return (
          <div
            key={i}
            className="num flex items-center gap-1.5 text-[11.5px]"
            data-instance={i}
            data-state={st || undefined}
            style={{ opacity: st === OFF ? 0.45 : 1 }}
            title={inst ? t('{role}: {b}/{sl} requests in flight', { role, b, sl }) + (q ? t(', {q} queued', { q }) : '') + (d ? t(', down') : '') + note : role}
          >
            <span className="muted w-[62px] shrink-0 truncate">{role}</span>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full"
              style={{
                background: d ? 'color-mix(in srgb, var(--bad) 35%, transparent)' : st === BOOT ? 'repeating-linear-gradient(-45deg, var(--panel-2) 0 3px, var(--line-strong) 3px 5px)' : 'var(--panel-2)',
                outline: st === WARM ? '1px dashed var(--warn)' : undefined,
              }}
            >
              {!d && !idle && inst && <div className="h-full rounded-full" style={{ width: `${Math.min(100, u * 100)}%`, background: utilColor(u) }} />}
            </div>
            <span className="w-[54px] shrink-0 text-right" style={{ color: d ? 'var(--bad-ink)' : st === WARM || q ? 'var(--warn-ink)' : 'var(--ink-3)' }}>
              {!inst ? '–' : d ? t('Down') : idle || st === RETIRING ? t(STATE_TEXT[st]) : st === WARM && !q ? t('Warm-up') : q ? `${b}/${sl} +${fmtN(q)}` : `${b}/${sl}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Autoscaled node: how many instances serve now, and how many are booting. */
function InstanceCounts({ inst }: { inst: [number, number, number, number, number][] }) {
  const on = inst.filter((x) => x[4] === 0 || x[4] === WARM).length;
  const boot = inst.filter((x) => x[4] === BOOT).length;
  return (
    <span data-active={on}>
      {t('{n} instances', { n: on })}{boot ? <span style={{ color: 'var(--warn-ink)' }}> {t('+{n} starting up', { n: boot })}</span> : null}
    </span>
  );
}

function LiveRow({ id, station, expanded }: { id: string; station: boolean; expanded: boolean }) {
  useTick();
  const now = viewTime();
  const s = liveAt(now)?.[id];
  if (!s) return null;
  const w = windowAt(now)?.nodes[id];
  // The main bar shows the average over the last second: with only a few slots per instance
  // the instant value jumps between 0% and 100%. The per-instance bars stay instant.
  const util = w?.util ?? (s.slots ? s.busy / s.slots : 0);
  const allDown = s.down > 0 && (s.inst ? s.down === s.inst.length : true);
  return (
    <div className="mt-2 space-y-1" data-live>
      {station && (
        <div className="flex items-center gap-2" title={t('Average utilization in the last second')}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--panel-2)' }}>
            <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${Math.min(100, util * 100)}%`, background: utilColor(util) }} />
          </div>
          <span className="num w-9 text-right text-[12px] font-medium">{pct(util)}</span>
        </div>
      )}
      {s.inst && !expanded && (
        <div className="flex gap-0.5" title={t('Utilization per instance (hatched: booting; dashed frame: warming up)')}>
          {s.inst.map(([b, sl, , d, st], i) =>
            st === OFF ? null : (
              <div
                key={i}
                className="h-3 flex-1 overflow-hidden rounded-sm"
                data-state={st || undefined}
                style={{
                  background: d ? 'var(--bad)' : st === BOOT ? 'repeating-linear-gradient(-45deg, var(--panel-2) 0 3px, var(--line-strong) 3px 5px)' : 'var(--panel-2)',
                  opacity: d || st === RETIRING ? 0.5 : 1,
                  outline: st === WARM ? '1px dashed var(--warn)' : undefined,
                  outlineOffset: -1,
                }}
              >
                {!d && st !== BOOT && <div className="w-full" style={{ height: '100%', transform: `scaleY(${Math.min(1, b / sl)})`, transformOrigin: 'bottom', background: utilColor(b / sl) }} />}
              </div>
            ),
          )}
        </div>
      )}
      <div className="faint num flex flex-wrap gap-x-2 text-[12px]">
        {w && <span>{fmtN(w.arrivals / Math.max(0.001, (windowAt(now)?.dt ?? 1)))}/s</span>}
        {s.inst && s.inst.some((x) => x[4]) && <InstanceCounts inst={s.inst} />}
        {station && s.queued > 0 && <span style={{ color: 'var(--warn-ink)' }}>{t('Queued {n}', { n: fmtN(s.queued) })}</span>}
        {s.depth !== undefined && <span style={{ color: s.depth > 1000 ? 'var(--warn-ink)' : undefined }}>{t('Queue {n}', { n: fmtN(s.depth) })}</span>}
        {w?.hitRatio !== undefined && <span>{t('Hit {p}', { p: pct(w.hitRatio) })}</span>}
        {w && w.fail > 0 && <span style={{ color: 'var(--bad-ink)' }}>{t('Failed {n}', { n: fmtN(w.fail) })}</span>}
        {s.cb && s.cb !== 'closed' && (
          <span className="sd-pill" style={{ '--pill': s.cb === 'open' ? 'var(--bad)' : 'var(--warn)' } as React.CSSProperties}>
            {s.cb === 'open' ? t('Tripped') : t('Half-open probe')}
          </span>
        )}
        {allDown && <span className="sd-pill" style={{ '--pill': 'var(--bad)', color: 'var(--bad-ink)' } as React.CSSProperties}>{t('Down')}</span>}
      </div>
    </div>
  );
}

/** A limit search on the canvas (M24): how busy this component was in the step on screen (while its
 *  traffic ran), and, once the search is over, whether it went first. In place of the last run's row. */
function LimitRow({ id, station, mark }: { id: string; station: boolean; mark: LimitMark }) {
  const u = Object.hasOwn(mark.util, id) ? mark.util[id] : undefined;
  const first = mark.done?.node === id ? mark.done : undefined;
  return (
    <div className="mt-2 space-y-1" data-limit-row={id}>
      {station && u !== undefined && (
        <div className="flex items-center gap-2" title={t('Find limit: how busy, on average, while the traffic of the {rps} requests/s step ran', { rps: fmtN(mark.rps) })} data-limit-util={u.toFixed(3)} data-util-color={utilColor(u)}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--panel-2)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, u * 100)}%`, background: utilColor(u) }} />
          </div>
          <span className="num w-9 text-right text-[12px] font-medium">{pct(u)}</span>
        </div>
      )}
      {first && (
        // inside the card: a long label wraps instead of running over the card's edge and the call labels
        <span className="sd-pill !h-auto max-w-full !whitespace-normal !rounded-[10px] py-0.5 !leading-snug [&::before]:shrink-0" style={{ '--pill': 'var(--bad)', color: 'var(--bad-ink)' } as React.CSSProperties} data-testid="limit-first-down">
          {first.holdsRps !== undefined ? t('Goes first ~{rps}/s', { rps: first.holdsRps }) : t('Fails at {rps}/s', { rps: first.firstFailRps ?? 0 })}
        </span>
      )}
    </div>
  );
}

export const ComponentNode = memo(function ComponentNode({ data }: NodeProps<SdNode>) {
  const n = data.node;
  const spec = KINDS[n.kind];
  const Icon = iconOf(n as { kind: string; params?: Record<string, unknown> });
  const color = CATEGORY_COLOR[spec.category];
  const count = instanceCount(n);
  const stacked = count > 1;
  const rp = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
  const autoMin = rp.autoscale === 'on' ? (rp.instances as number) : null;
  const expanded = useApp((st) => !!st.expanded[n.id]) && stacked;
  const toggle = useApp((st) => st.toggleExpanded);
  // imported with a guessed performance value: a dashed frame, the guesses in the tooltip
  const guessed = guessedParams(n);
  // a card that is new on the canvas comes into focus (motion.ts plans when)
  const [enter] = useState(() => enterDelay('node', n.id));
  const remeasure = useUpdateNodeInternals();
  // a limit search's colours come before the last run's figures
  const limit = useApp((st) => st.limit);
  return (
    <div
      className={`sd-node px-2.5 py-2${enter !== null ? ' sd-in' : ''}`}
      // the entrance scales the card: measure the handles again when it is over. A card that is
      // held is turned by the drag; the drag measures it when it is level again (Canvas)
      onAnimationEnd={(e) => e.target === e.currentTarget && !e.currentTarget.classList.contains('sd-held') && remeasure(n.id)}
      data-node={n.id}
      data-guessed={guessed.length ? 'true' : undefined}
      data-stacked={stacked && !expanded ? 'true' : undefined}
      title={guessed.length ? t('Guessed at import: {params} (set the real values in the settings panel)', { params: guessed.join(', ') }) : undefined}
      style={{ width: NODE_W, '--cat': color, '--in-delay': enter ? `${enter}ms` : undefined } as React.CSSProperties}
    >
      {n.kind !== 'client' && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2.5">
        <div className="sd-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ color }}>
          {Icon && <Icon size={20} strokeWidth={1.9} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[14px] font-semibold">{n.label ?? t(spec.label)}</span>
            {stacked && (
              <span className="faint num shrink-0 text-[12px]" title={autoMin !== null ? t('Autoscaling: min {min} instances, max {max} instances', { min: autoMin, max: count }) : undefined}>
                ×{autoMin !== null ? `${autoMin}–${count}` : count}
              </span>
            )}
          </div>
          <div className="faint truncate text-[12px]">
            {n.region && (
              <span className="num mr-1.5 rounded px-1 text-[11px]" style={{ background: 'var(--panel-2)', color: 'var(--ink-2)' }} title={t('Region')} data-testid="node-region">
                {n.region}
              </span>
            )}
            {paramSummary(n)}
          </div>
        </div>
        {stacked && (
          <button
            className="nodrag faint -mr-1 flex h-6 w-6 shrink-0 items-center justify-center self-start rounded-md hover:bg-[var(--panel-2)] hover:text-[var(--ink)]"
            onClick={(e) => {
              e.stopPropagation();
              toggle(n.id);
            }}
            aria-expanded={expanded}
            aria-label={expanded ? t('Collapse {n} instances', { n: count }) : t('Expand {n} instances', { n: count })}
            title={expanded ? t('Collapse') : t('Expand to see each one ({n} instances)', { n: count })}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
      </div>
      {limit ? <LimitRow id={n.id} station={spec.station} mark={limit} /> : <LiveRow id={n.id} station={spec.station} expanded={expanded} />}
      {expanded && !limit && <InstanceList id={n.id} roles={instanceRoles(n)} />}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
