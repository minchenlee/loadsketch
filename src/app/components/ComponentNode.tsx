import { memo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { KINDS, resolveParams } from '../../schema/kinds.ts';
import { instanceCount, instanceRoles, type DesignNode } from '../../schema/design.ts';
import { guessedParams } from '../sources.ts';
import { useApp } from '../store.ts';
import { enterDelay } from '../motion.ts';
import type { SdNode } from '../convert.ts';
import { liveAt, viewTime, windowAt } from '../runtime.ts';
import { CATEGORY_COLOR, ICONS, fmtN, pct, utilColor } from '../ui.ts';
import { useTick } from '../useTick.ts';
import { t, tx } from '../../i18n/index.ts';

export const NODE_W = 200;

/** One line that says what the node is set to. */
function paramSummary(n: DesignNode): string {
  const p = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
  const ms = (k: string) => `${(p[k] as { mean: number }).mean} ms`;
  switch (n.kind) {
    case 'client':
      return t('產生流量');
    case 'dns':
      return t('快取命中 {p}', { p: pct(p.resolverCacheHit as number) });
    case 'cdn':
      return t('命中 {p}', { p: pct(p.hitRatio as number) });
    case 'load_balancer':
      return String(p.policy);
    case 'rate_limiter':
      return t('{rate}/s · 突發 {burst}', { rate: fmtN(p.ratePerSec as number), burst: String(p.burst) });
    case 'circuit_breaker':
      return t('失敗 ≥ {p} 跳開', { p: pct(p.failureRatio as number) });
    case 'api_gateway':
    case 'service':
    case 'worker':
      return t('{c} 並行 · {ms}', { c: String(p.concurrency), ms: ms('serviceMs') }) + (p.autoscale === 'on' ? ` · ${t('自動擴充')}` : '');
    case 'function':
      return t('上限 {c} · {ms} · 冷啟動 {cold}', { c: fmtN(p.maxConcurrency as number), ms: ms('serviceMs'), cold: ms('coldStartMs') });
    case 'cache':
      return p.mode === 'lru' ? `LRU ${fmtN(p.capacityKeys as number)} keys` : t('命中 {p}', { p: pct(p.hitRatio as number) });
    case 'database':
      return (p.replicas as number) ? t('主庫＋{r} 副本 · {c} 連線', { r: String(p.replicas), c: String(p.connections) }) : t('單一主庫 · {c} 連線', { c: String(p.connections) });
    case 'sharded_db':
      return t('{s} 分片 · {c} 連線', { s: String(p.shards), c: String(p.connections) });
    case 'queue':
      return t('上限 {n} 則', { n: fmtN(p.maxDepth as number) });
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
const STATE_TEXT: Record<number, string> = { [OFF]: tx('未啟動'), [BOOT]: tx('開機中'), [WARM]: tx('暖機中'), [RETIRING]: tx('縮減中') };

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
        const note = STATE_TEXT[st] ? t('，{state}', { state: t(STATE_TEXT[st]) }) : '';
        return (
          <div
            key={i}
            className="num flex items-center gap-1.5 text-[11.5px]"
            data-instance={i}
            data-state={st || undefined}
            style={{ opacity: st === OFF ? 0.45 : 1 }}
            title={inst ? t('{role}：{b}/{sl} 個請求在處理', { role, b, sl }) + (q ? t('，{q} 個在排隊', { q }) : '') + (d ? t('，故障中') : '') + note : role}
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
              {!inst ? '–' : d ? t('故障') : idle || st === RETIRING ? t(STATE_TEXT[st]) : st === WARM && !q ? t('暖機') : q ? `${b}/${sl} +${fmtN(q)}` : `${b}/${sl}`}
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
      {t('{n} 台', { n: on })}{boot ? <span style={{ color: 'var(--warn-ink)' }}> {t('+{n} 開機中', { n: boot })}</span> : null}
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
        <div className="flex items-center gap-2" title={t('最近一秒的平均忙碌程度')}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--panel-2)' }}>
            <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${Math.min(100, util * 100)}%`, background: utilColor(util) }} />
          </div>
          <span className="num w-9 text-right text-[12px] font-medium">{pct(util)}</span>
        </div>
      )}
      {s.inst && !expanded && (
        <div className="flex gap-0.5" title={t('每台實例的忙碌程度（斜線：開機中；虛線框：暖機中）')}>
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
        {station && s.queued > 0 && <span style={{ color: 'var(--warn-ink)' }}>{t('排隊 {n}', { n: fmtN(s.queued) })}</span>}
        {s.depth !== undefined && <span style={{ color: s.depth > 1000 ? 'var(--warn-ink)' : undefined }}>{t('佇列 {n}', { n: fmtN(s.depth) })}</span>}
        {w?.hitRatio !== undefined && <span>{t('命中 {p}', { p: pct(w.hitRatio) })}</span>}
        {w && w.fail > 0 && <span style={{ color: 'var(--bad-ink)' }}>{t('失敗 {n}', { n: fmtN(w.fail) })}</span>}
        {s.cb && s.cb !== 'closed' && (
          <span className="sd-pill" style={{ '--pill': s.cb === 'open' ? 'var(--bad)' : 'var(--warn)' } as React.CSSProperties}>
            {s.cb === 'open' ? t('跳開') : t('試探中')}
          </span>
        )}
        {allDown && <span className="sd-pill" style={{ '--pill': 'var(--bad)', color: 'var(--bad-ink)' } as React.CSSProperties}>{t('故障')}</span>}
      </div>
    </div>
  );
}

export const ComponentNode = memo(function ComponentNode({ data }: NodeProps<SdNode>) {
  const n = data.node;
  const spec = KINDS[n.kind];
  const Icon = ICONS[spec.icon];
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
  return (
    <div
      className={`sd-node px-2.5 py-2${enter !== null ? ' sd-in' : ''}`}
      // the entrance scales the card: measure the handles again when it is over. A card that is
      // held is turned by the drag; the drag measures it when it is level again (Canvas)
      onAnimationEnd={(e) => e.target === e.currentTarget && !e.currentTarget.classList.contains('sd-held') && remeasure(n.id)}
      data-node={n.id}
      data-guessed={guessed.length ? 'true' : undefined}
      data-stacked={stacked && !expanded ? 'true' : undefined}
      title={guessed.length ? t('匯入時猜的值：{params}（在設定面板改成實際的值）', { params: guessed.join(', ') }) : undefined}
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
              <span className="faint num shrink-0 text-[12px]" title={autoMin !== null ? t('自動擴充：最少 {min} 台，最多 {max} 台', { min: autoMin, max: count }) : undefined}>
                ×{autoMin !== null ? `${autoMin}–${count}` : count}
              </span>
            )}
          </div>
          <div className="faint truncate text-[12px]">
            {n.region && (
              <span className="num mr-1.5 rounded px-1 text-[11px]" style={{ background: 'var(--panel-2)', color: 'var(--ink-2)' }} title={t('區域')} data-testid="node-region">
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
            aria-label={expanded ? t('收合 {n} 台實例', { n: count }) : t('展開 {n} 台實例', { n: count })}
            title={expanded ? t('收合') : t('展開，看每一台（{n} 台）', { n: count })}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
      </div>
      <LiveRow id={n.id} station={spec.station} expanded={expanded} />
      {expanded && <InstanceList id={n.id} roles={instanceRoles(n)} />}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
