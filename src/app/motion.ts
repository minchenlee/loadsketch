// Canvas motion that is not simulation data: the entrance of a loaded design and the tilt of
// a dragged card. All of it is off with prefers-reduced-motion.
import { create } from 'zustand';

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- Entrance: lines draw layer by layer from the traffic sources; a card appears when its line arrives.

/** Time between two layers of the graph. */
const STEP_MS = 220;
const MAX_DEPTH = 7;
/** How long one line takes to draw. */
export const EDGE_IN_MS = 420;

const nodeIn = new Map<string, number>();
const edgeIn = new Map<string, number>();
let until = 0;

type E = { id: string; source: string; target: string };

/**
 * Plans the entrance of a design that is about to be shown. Nodes and edges in `kept` are on the
 * canvas already: they move to their new place instead (Canvas), and do not enter again.
 */
export function planEntrance(nodes: { id: string }[], edges: E[], kept: { nodes: Set<string>; edges: Set<string> }): void {
  // a part that is still entering (the same design loaded twice in a row) enters as planned
  const entering = performance.now() < until;
  const isKept = (set: Set<string>, pending: Map<string, number>, id: string) => set.has(id) && !(entering && pending.has(id));
  const keptNodes = new Set(nodes.filter((n) => isKept(kept.nodes, nodeIn, n.id)).map((n) => n.id));
  const keptEdges = new Set(edges.filter((e) => isKept(kept.edges, edgeIn, e.id)).map((e) => e.id));
  nodeIn.clear();
  edgeIn.clear();
  if (reducedMotion()) return;
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
    hasIn.add(e.target);
  }
  const depth = new Map<string, number>();
  let layer = nodes.filter((n) => !hasIn.has(n.id)).map((n) => n.id);
  if (!layer.length && nodes.length) layer = [nodes[0].id];
  for (const id of layer) depth.set(id, 0);
  while (layer.length) {
    const next: string[] = [];
    for (const id of layer) {
      for (const to of out.get(id) ?? []) {
        if (depth.has(to)) continue;
        depth.set(to, depth.get(id)! + 1);
        next.push(to);
      }
    }
    layer = next;
  }
  const at = (id: string) => Math.min(MAX_DEPTH, depth.get(id) ?? 0) * STEP_MS;
  let last = 0;
  for (const n of nodes) {
    if (keptNodes.has(n.id)) continue;
    nodeIn.set(n.id, at(n.id));
    last = Math.max(last, at(n.id));
  }
  for (const e of edges) {
    if (keptEdges.has(e.id)) continue;
    // the line leaves just after its source card shows, and ends as its target card comes into focus
    edgeIn.set(e.id, at(e.source) + 80);
    last = Math.max(last, at(e.source) + 80);
  }
  until = performance.now() + last + 1500;
}

/** One new node or edge made by the user: it enters at once. */
export function markNew(kind: 'node' | 'edge', id: string): void {
  if (reducedMotion()) return;
  (kind === 'node' ? nodeIn : edgeIn).set(id, 0);
  until = Math.max(until, performance.now() + 1000);
}

/** The entrance delay (ms) of a part that is mounting now, or null when it does not enter. */
export function enterDelay(kind: 'node' | 'edge', id: string): number | null {
  if (performance.now() > until) return null;
  return (kind === 'node' ? nodeIn : edgeIn).get(id) ?? null;
}

// ---- Tilt: a dragged card swings from the point it is held by. Edges read this to stay on its handles.

/** A card's turn (degrees) and scale about the point (cx, cy), in canvas coordinates. */
export type Tilt = { deg: number; s: number; cx: number; cy: number };
export const useTilt = create<Record<string, Tilt>>(() => ({}));

/** Where a point of a tilted card is drawn. */
export function tiltPoint(x: number, y: number, t: Tilt | undefined): [number, number] {
  if (!t) return [x, y];
  const a = (t.deg * Math.PI) / 180;
  const dx = (x - t.cx) * t.s;
  const dy = (y - t.cy) * t.s;
  return [t.cx + dx * Math.cos(a) - dy * Math.sin(a), t.cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Progress 0 → 1 of a spring that overshoots a little, t in seconds. Settles in about 0.6 s. */
export function springAt(t: number): number {
  const w = 13;
  const z = 0.62;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}
