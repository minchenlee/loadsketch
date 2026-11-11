// An edge drawn as a smooth curve, coloured from its source's category to its target's, with two
// kinds of animation that show the simulation:
// - particles: how much traffic flows (density follows calls per second; colour shows read, write, failed)
// - request dots: real sampled requests, placed by their recorded send/arrive/reply times
// A new edge draws itself from the source to the target (motion.ts plans when).
import { memo, useEffect, useRef, useState } from 'react';
import { CircleX, TriangleAlert } from 'lucide-react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import type { SdEdge } from '../convert.ts';
import { live, viewTime, windowAt } from '../runtime.ts';
import { useApp } from '../store.ts';
import { EDGE_IN_MS, enterDelay, tiltPoint, useTilt } from '../motion.ts';
import { fmtN } from '../ui.ts';
import { useTick } from '../useTick.ts';
import { t } from '../../i18n/index.ts';
import { edgeFailShare } from '../../engine/index.ts';

type Pt = [number, number];

/** Polyline from the source handle (right side) to the target handle (left side). */
/** What an edge filtered by `on` carries, for its label. */
const onLabel = (on: string): string =>
  on === 'read' ? t('只走讀取') : on === 'write' ? t('只走寫入') : on === 'boot' ? t('只在開機時用') : t('控制面（監控、協調）');

type Geo = { d: string; pts: Pt[]; acc: number[] };

/**
 * The line from the source handle (right side) to the target handle (left side): the SVG path, and
 * the same line as points (for a position at a share of its length).
 */
export function curve(sx: number, sy: number, tx: number, ty: number): Geo {
  const pts: Pt[] = [];
  let d: string;
  if (tx >= sx + 12) {
    // forward: one S-curve that leaves and arrives level
    const c = Math.max(30, Math.min(180, (tx - sx) * 0.5));
    d = `M ${sx} ${sy} C ${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}`;
    const N = 32;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const v = 1 - u;
      const b1 = 3 * v * v * u;
      const b2 = 3 * v * u * u;
      pts.push([v * v * v * sx + b1 * (sx + c) + b2 * (tx - c) + u * u * u * tx, v * v * v * sy + b1 * sy + b2 * ty + u * u * u * ty]);
    }
  } else {
    // target is behind the source: go around below, with wide corners
    const gap = 24;
    const y = Math.max(sy, ty) + 90;
    const k: Pt[] = [[sx, sy], [sx + gap, sy], [sx + gap, y], [tx - gap, y], [tx - gap, ty], [tx, ty]];
    d = `M ${sx} ${sy}`;
    pts.push(k[0]);
    for (let i = 1; i < k.length - 1; i++) {
      const [px, py] = k[i - 1];
      const [x, yy] = k[i];
      const [nx, ny] = k[i + 1];
      const l1 = Math.hypot(x - px, yy - py);
      const l2 = Math.hypot(nx - x, ny - yy);
      const r = Math.min(30, l1 / 2, l2 / 2);
      const ax = x - ((x - px) / (l1 || 1)) * r;
      const ay = yy - ((yy - py) / (l1 || 1)) * r;
      const bx = x + ((nx - x) / (l2 || 1)) * r;
      const by = yy + ((ny - yy) / (l2 || 1)) * r;
      d += ` L ${ax} ${ay} Q ${x} ${yy} ${bx} ${by}`;
      for (let j = 0; j <= 6; j++) {
        const u = j / 6;
        const v = 1 - u;
        pts.push([v * v * ax + 2 * v * u * x + u * u * bx, v * v * ay + 2 * v * u * yy + u * u * by]);
      }
    }
    const last = k[k.length - 1];
    d += ` L ${last[0]} ${last[1]}`;
    pts.push(last);
  }
  return { d, pts, acc: lengths(pts) };
}

function lengths(pts: Pt[]): number[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}

function pointAt(pts: Pt[], acc: number[], f: number): Pt {
  const total = acc[acc.length - 1];
  const d = Math.max(0, Math.min(1, f)) * total;
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const seg = acc[i] - acc[i - 1] || 1;
  const u = (d - acc[i - 1]) / seg;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
}

const STORE_KINDS = new Set(['database', 'sharded_db', 'object_storage']);

/**
 * Cache-aside order on a read: a node (not a cache) that calls both a cache and a store reads the
 * cache first and the store only on a miss (the engine's 'aside' step). Returns the label for
 * this edge, or null.
 */
function useAsideOrder(id: string): string | null {
  return useApp((s) => {
    const edge = s.edges.find((e) => e.id === id);
    if (!edge) return null;
    const kind = (nid: string) => s.nodes.find((n) => n.id === nid)?.data.node.kind;
    if (kind(edge.source) === 'cache') return null;
    // boot and control edges carry no requests: not part of the read path
    const reads = s.edges.filter((e) => e.source === edge.source && !['write', 'boot', 'control'].includes(e.data?.edge.on ?? 'all'));
    if (!reads.some((e) => e.id === id)) return null;
    const hasCache = reads.some((e) => kind(e.target) === 'cache');
    const hasStore = reads.some((e) => STORE_KINDS.has(kind(e.target) ?? ''));
    if (!hasCache || !hasStore) return null;
    const k = kind(edge.target);
    return k === 'cache' ? t('① 讀取先查') : STORE_KINDS.has(k ?? '') ? t('② 沒命中才查') : null;
  });
}

const MAX_PARTICLES = 28;
const MAX_DOTS = 24;
const PARTICLE_SPEED = 70; // px per real second

function Label({ id, x, y, maxW, cls, delay, timeout, retries, bulkhead, fallback, hedge, fanout, quorum }: { id: string; x: number; y: number; maxW: number; cls: string; delay?: React.CSSProperties; timeout?: number; retries?: number; bulkhead?: number; fallback?: boolean; hedge?: number; fanout?: number; quorum?: number }) {
  useTick();
  const status = useApp((s) => s.status);
  const w = status === 'idle' ? null : windowAt(viewTime());
  const e = w?.edges[id];
  const rate = e ? e.calls / w!.dt : 0;
  const failed = e ? edgeFailShare(e) : 0;
  const fan = fanout && fanout > 1 ? fanout : 0;
  if (!e && !timeout && !retries && !bulkhead && !fallback && !hedge && !fan) return null;
  return (
    <div
      className={`sd-edge-label nodrag nopan num pointer-events-none absolute rounded-md px-1.5 py-0.5 text-[11.5px] leading-tight${cls}`}
      style={{
        ...delay,
        // no wider than the space between the two cards: the parts go onto more lines instead
        maxWidth: maxW,
        transform: `translate(-50%, -100%) translate(${x}px, ${y - 4}px)`,
        color: failed > 0.05 ? 'var(--bad-ink)' : 'var(--ink-2)',
      }}
    >
      <div>
        {e && <span>{fmtN(rate)}/s</span>}
        {e && failed > 0.005 && <span>{t('失敗 {p}%', { p: Math.round(failed * 100) })}</span>}
        {timeout ? <span className="faint">{t('逾時 {ms} ms', { ms: timeout })}</span> : null}
        {retries ? <span className="faint">{t('重試 {n}', { n: retries })}</span> : null}
        {bulkhead ? <span className="faint">{t('隔艙 {n}', { n: bulkhead })}</span> : null}
        {fallback ? <span className="faint">{t('降級')}</span> : null}
        {hedge && !fan ? <span className="faint">{t('對沖 {ms} ms', { ms: hedge })}</span> : null}
        {fan ? <span className="faint" data-testid="edge-fanout">{quorum && quorum < fan ? t('扇出 {n}，等 {k}', { n: fan, k: quorum }) : t('扇出 {n}', { n: fan })}</span> : null}
      </div>
    </div>
  );
}

export const FlowEdge = memo(function FlowEdge({ id, source, target, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }: EdgeProps<SdEdge>) {
  // a dragged card tilts: the line stays on its handles
  const [sx, sy] = tiltPoint(sourceX, sourceY, useTilt((s) => s[source]));
  const [ex, ey] = tiltPoint(targetX, targetY, useTilt((s) => s[target]));
  const line = curve(sx, sy, ex, ey);
  const { d, pts } = line;
  const particles = useRef<SVGGElement>(null);
  const dots = useRef<SVGGElement>(null);
  const geo = useRef(line);
  geo.current = line;
  // entrance: the line draws first; the arrow and the labels come when it has arrived
  const [enter] = useState(() => enterDelay('edge', id));
  const [drawn, setDrawn] = useState(enter === null);
  useEffect(() => {
    if (enter === null) return;
    const h = setTimeout(() => setDrawn(true), enter + EDGE_IN_MS);
    return () => clearTimeout(h);
  }, [enter]);
  const lab = enter !== null ? ' sd-label-in' : '';
  const labDelay = enter !== null ? ({ '--in-delay': `${enter + EDGE_IN_MS * 0.5}ms` } as React.CSSProperties) : undefined;
  const edge = data?.edge;
  const order = useAsideOrder(id);

  useEffect(() => {
    let raf = 0;
    let phase = 0;
    let last = performance.now();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dtReal = (now - last) / 1000;
      last = now;
      const g = particles.current;
      const g2 = dots.current;
      if (!g || !g2) return;
      const { pts: p, acc } = geo.current;
      const total = acc[acc.length - 1] || 1;
      const c = live.clock;
      const t = viewTime(now);
      const w = c.running || live.windows.length ? windowAt(t) : null;
      const e = w?.edges[id];
      const rate = e ? e.calls / w!.dt : 0;
      // particles: up to MAX_PARTICLES, about 6 per tenfold increase in rate
      const n = rate > 0 ? Math.min(MAX_PARTICLES, Math.max(1, Math.round(Math.log10(rate + 1) * 6))) : 0;
      if (c.running && !c.paused) phase = (phase + (dtReal * PARTICLE_SPEED) / total) % 1;
      const failShare = e ? edgeFailShare(e) : 0;
      const writeShare = e && e.calls ? e.write / e.calls : 0;
      const kids = g.children;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const el = kids[i] as SVGCircleElement | undefined;
        if (!el) break;
        if (i >= n) {
          el.setAttribute('opacity', '0');
          continue;
        }
        const [x, y] = pointAt(p, acc, (phase + i / n) % 1);
        el.setAttribute('cx', x.toFixed(1));
        el.setAttribute('cy', y.toFixed(1));
        el.setAttribute('opacity', '0.85');
        const k = (i * 0.618034) % 1; // spread colours evenly over the particles
        el.setAttribute('fill', k < failShare ? 'var(--bad)' : k < failShare + writeShare ? 'var(--write)' : 'var(--read)');
      }
      // request dots: hops of sampled requests that are on this edge at time t
      let m = 0;
      const dk = g2.children;
      if (live.traces.length && c.speed <= 1) {
        for (let ti = live.traces.length - 1; ti >= 0 && m < MAX_DOTS; ti--) {
          const tr = live.traces[ti];
          if (tr.t0 > t || tr.t1 + 1000 < t) continue;
          for (const h of tr.hops) {
            if (h.edge !== id || m >= MAX_DOTS) continue;
            let f = -1;
            let back = false;
            if (h.tArrive !== undefined && t >= h.tSend && t <= h.tArrive) f = (t - h.tSend) / Math.max(0.001, h.tArrive - h.tSend);
            else if (h.tReply !== undefined && h.tDone !== undefined && t >= h.tReply && t <= h.tDone) {
              f = 1 - (t - h.tReply) / Math.max(0.001, h.tDone - h.tReply);
              back = true;
            }
            if (f < 0) continue;
            const el = dk[m++] as SVGCircleElement;
            const [x, y] = pointAt(p, acc, f);
            el.setAttribute('cx', x.toFixed(1));
            el.setAttribute('cy', y.toFixed(1));
            el.setAttribute('opacity', '1');
            const fill = back && h.ok === false ? 'var(--bad)' : back && h.hit ? 'var(--ok)' : h.op === 'write' || h.op === 'cache_del' ? 'var(--write)' : 'var(--read)';
            el.setAttribute('fill', fill);
          }
        }
      }
      for (let i = m; i < MAX_DOTS; i++) (dk[i] as SVGCircleElement).setAttribute('opacity', '0');
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [id]);

  const mid = pointAt(pts, line.acc, 0.5);
  const warn = useApp((s) => s.issues.filter((i) => i.edge === id).map((i) => i.message).join('\n'));
  const blocking = useApp((s) => s.issues.some((i) => i.edge === id && i.level === 'error'));
  return (
    <>
    <g className="sd-edge">
      <BaseEdge
        id={id}
        path={d}
        markerEnd={drawn ? markerEnd : undefined}
        interactionWidth={16}
        className={enter !== null ? 'sd-edge-in' : undefined}
        style={{
          stroke: selected ? 'var(--accent)' : 'var(--edge)',
          strokeWidth: selected ? 2.2 : 1.6,
          strokeDasharray: (edge?.on && edge.on !== 'all') || edge?.apis?.length ? '6 4' : undefined,
          ...(enter !== null ? ({ '--in-delay': `${enter}ms`, '--len': Math.ceil(line.acc[line.acc.length - 1]) } as React.CSSProperties) : null),
        }}
      />
      <g ref={particles} pointerEvents="none">
        {Array.from({ length: MAX_PARTICLES }, (_, i) => (
          <circle key={i} r={2.3} opacity={0} />
        ))}
      </g>
      <g ref={dots} pointerEvents="none" data-dots={id}>
        {Array.from({ length: MAX_DOTS }, (_, i) => (
          <circle key={i} r={5} opacity={0} stroke="var(--panel)" strokeWidth={1.5} />
        ))}
      </g>
      </g>
      <EdgeLabelRenderer>
        {warn && (
          <div
            className="nodrag nopan absolute flex h-5 w-5 items-center justify-center rounded-full"
            style={{ transform: `translate(-50%, -50%) translate(${pts[0][0] + 14}px, ${pts[0][1]}px)`, background: 'var(--panel)', color: blocking ? 'var(--bad)' : 'var(--warn)', border: `1px solid ${blocking ? 'var(--bad)' : 'var(--warn)'}`, pointerEvents: 'all' }}
            title={warn}
            aria-label={warn}
            data-testid={`edge-warn-${id}`}
          >
            {blocking ? <CircleX size={12} /> : <TriangleAlert size={12} />}
          </div>
        )}
        <Label id={id} x={mid[0]} y={mid[1]} maxW={Math.max(96, Math.abs(ex - sx) - 28)} cls={lab} delay={labDelay} timeout={edge?.timeoutMs} retries={edge?.retries} bulkhead={edge?.bulkhead} fallback={edge?.fallback === 'on'} hedge={edge?.hedgeMs} fanout={edge?.fanout} quorum={edge?.quorum} />
        {order && (
          <div
            className={`nodrag nopan pointer-events-none absolute rounded px-1 text-[11px]${lab}`}
            style={{ ...labDelay, transform: `translate(-50%, 0) translate(${mid[0]}px, ${mid[1] + 4}px)`, color: 'var(--ink-3)', background: 'var(--bg)' }}
            title={t('cache-aside：讀取先查快取，沒命中才查資料庫，再寫回快取')}
            data-testid="aside-order"
          >
            {order}
          </div>
        )}
        {/* the APIs are the main routing fact: shown under the cache-aside order when there is one */}
        {!!edge?.apis?.length && (
          <div
            className={`nodrag nopan pointer-events-none absolute rounded px-1 text-[11px]${lab}`}
            style={{ ...labDelay, transform: `translate(-50%, 0) translate(${mid[0]}px, ${mid[1] + (order ? 22 : 4)}px)`, color: 'var(--ink-2)', background: 'var(--bg)' }}
            data-testid="edge-apis-label"
          >
            {edge.apis.join(' · ')}
            {edge.on && edge.on !== 'all' ? ` · ${onLabel(edge.on)}` : ''}
          </div>
        )}
        {!order && !edge?.apis?.length && edge?.on && edge.on !== 'all' && (
          <div
            className={`nodrag nopan pointer-events-none absolute rounded px-1 text-[11px]${lab}`}
            style={{ ...labDelay, transform: `translate(-50%, 0) translate(${mid[0]}px, ${mid[1] + 4}px)`, color: edge.on === 'read' ? 'var(--read)' : edge.on === 'write' ? 'var(--write)' : 'var(--ink-3)', background: 'var(--bg)' }}
          >
            {onLabel(edge.on)}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});
