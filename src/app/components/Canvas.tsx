import { isPhone, usePhone } from '../phone.ts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleX, TriangleAlert, X } from 'lucide-react';
import { Background, BackgroundVariant, Controls, MarkerType, Panel, ReactFlow, getViewportForBounds, useReactFlow, useStoreApi, useUpdateNodeInternals, type Viewport } from '@xyflow/react';
import { usePresets } from '../presets.ts';
import { useApp } from '../store.ts';
import type { SdNode } from '../convert.ts';
import { reducedMotion, springAt, useTilt } from '../motion.ts';
import { ComponentNode, NODE_W } from './ComponentNode.tsx';
import { FlowEdge, throughText } from './FlowEdge.tsx';
import { startEdgeFlow } from '../edgeFlow.ts';
import { t } from '../../i18n/index.ts';
import { KINDS } from '../../schema/kinds.ts';

const nodeTypes = { component: ComponentNode };
const edgeTypes = { flow: FlowEdge };
const defaultEdgeOptions = { type: 'flow', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--edge)' } };
/** Above this number of cards the glass has no blur: each blurred card is one more pass for the GPU. */
const MANY = 24;
const FIT = { padding: 0.1, minZoom: 0.2, maxZoom: 1.1 };
/** ?controls=0: no zoom buttons. The intro site uses it on a phone, where its canvas only plays. */
const CONTROLS = new URLSearchParams(location.search).get('controls') !== '0';

/** ?focus=<component id>: on a phone the first view is centred on this component. */
const FOCUS = new URLSearchParams(location.search).get('focus');
/** A phone never opens a design smaller than this: the cards must be readable, the rest is a swipe away. */
const PHONE_ZOOM = 0.65;

/**
 * The first view of a design: all of it. On a phone a wide design would be too small to read, so
 * the view keeps PHONE_ZOOM and shows one end: the ?focus= component, or else the leftmost one
 * (where the traffic starts). The part of the canvas under the run card and an open drawer is not counted,
 * and neither is the part beside an open design brief.
 */
function firstView(nodes: SdNode[], w: number, h: number): Viewport {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.position.x);
    y0 = Math.min(y0, n.position.y);
    x1 = Math.max(x1, n.position.x + (n.measured?.width ?? NODE_W));
    y1 = Math.max(y1, n.position.y + (n.measured?.height ?? 84));
  }
  if (!isPhone()) {
    const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const brief = document.querySelector<HTMLElement>('.sd-brief');
    if (!brief) return getViewportForBounds(bounds, w, h, FIT.minZoom, FIT.maxZoom, FIT.padding);
    // an open design brief covers the right of the canvas from top to bottom: the design goes beside it
    if (brief.hasAttribute('data-open')) return getViewportForBounds(bounds, Math.max(260, w - brief.offsetWidth - 24), h, FIT.minZoom, FIT.maxZoom, FIT.padding);
    // closed, it is a bar with the goals at the top: the design goes under it
    const top = brief.offsetHeight + 24;
    const v = getViewportForBounds(bounds, w, Math.max(200, h - top), FIT.minZoom, FIT.maxZoom, FIT.padding);
    return { ...v, y: v.y + top };
  }
  const covered = useApp.getState().drawer ? Math.min(innerHeight * 0.56, 520) + 66 : 112;
  // a design brief's bar is at the top of the canvas
  const card = document.querySelector<HTMLElement>('.sd-brief');
  const top = card ? card.offsetHeight + 16 : 0;
  const free = Math.max(120, h - covered - top);
  const all = getViewportForBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, w, free, FIT.minZoom, FIT.maxZoom, FIT.padding);
  if (all.zoom >= PHONE_ZOOM) return { ...all, y: all.y + top };
  const focus = nodes.find((n) => n.id === FOCUS);
  const at = focus ?? nodes.reduce((a, n) => (n.position.x < a.position.x ? n : a));
  const cx = at.position.x + (at.measured?.width ?? NODE_W) / 2;
  const cy = at.position.y + (at.measured?.height ?? 84) / 2;
  // the focus in the middle; without one, the design's left edge at the screen's left edge
  const x = focus ? w / 2 - cx * PHONE_ZOOM : 16 - x0 * PHONE_ZOOM;
  return { x, y: top + free / 2 - cy * PHONE_ZOOM, zoom: PHONE_ZOOM };
}

export const DRAG_MIME = 'application/x-loadsketch-kind';
/** A preset dragged from the palette: its id (M8). */
export const PRESET_MIME = 'application/x-loadsketch-preset';

// The last pan and zoom. The canvas is mounted again when the language changes; it keeps this view
// instead of fitting the design again.
let lastViewport: Viewport | undefined;

type XY = { x: number; y: number };

/**
 * A new design on a canvas that shows one already: the cards both designs have (same id) fly to
 * their new places, and the view fits the new design. Returns the positions to draw during the flight.
 */
function useFlight(nodes: SdNode[]): Map<string, XY> | null {
  const loads = useApp((s) => s.loads);
  const { setViewport } = useReactFlow();
  const [fly, setFly] = useState<Map<string, XY> | null>(null);
  const shown = useRef(new Map<string, XY>());

  useLayoutEffect(() => {
    const before = shown.current;
    const to = useApp.getState().nodes;
    if (!before.size || !to.length) return;
    const el = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (el?.width) void setViewport(firstView(to, el.width, el.height), { duration: reducedMotion() ? 0 : 650 });
    const from = new Map<string, XY>();
    let moving = false;
    for (const n of to) {
      const p = before.get(n.id);
      if (!p) continue;
      from.set(n.id, p);
      if (p.x !== n.position.x || p.y !== n.position.y) moving = true;
    }
    if (!moving || reducedMotion()) return;
    setFly(from);
    const t0 = performance.now();
    let raf = requestAnimationFrame(function step() {
      const s = (performance.now() - t0) / 1000;
      if (s >= 0.9) return setFly(null);
      const p = springAt(s);
      const at = new Map<string, XY>();
      for (const n of useApp.getState().nodes) {
        const f = from.get(n.id);
        if (f) at.set(n.id, { x: f.x + (n.position.x - f.x) * p, y: f.y + (n.position.y - f.y) * p });
      }
      setFly(at);
      raf = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(raf);
      setFly(null);
    };
  }, [loads, setViewport]);

  // after the flight effect: it reads the positions of the design shown before this one
  useEffect(() => {
    if (!fly) shown.current = new Map(nodes.map((n) => [n.id, n.position]));
  });
  return fly;
}

/**
 * A dragged card swings from the point it is held by: it leans against the direction it moves in,
 * and springs back level when it is let go.
 */
function useDragTilt() {
  const { getZoom } = useReactFlow();
  const remeasure = useUpdateNodeInternals();
  const d = useRef<{ id: string; el: HTMLElement; ox: number; oy: number; pos: XY; deg: number; vel: number; want: number; s: number; held: boolean; lastX: number; lastT: number; raf: number } | null>(null);

  const end = () => {
    const c = d.current;
    if (!c) return;
    cancelAnimationFrame(c.raf);
    c.el.style.transform = '';
    c.el.style.transformOrigin = '';
    c.el.classList.remove('sd-held');
    useTilt.setState((s) => {
      const { [c.id]: _, ...rest } = s;
      return rest;
    }, true);
    d.current = null;
    // the card is level again: a measure made while it was turned (the end of its entrance) is wrong
    remeasure(c.id);
  };
  useEffect(() => end, []);

  const clientX = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) => ('clientX' in e ? e.clientX : (e.touches[0]?.clientX ?? 0));
  const clientY = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) => ('clientY' in e ? e.clientY : (e.touches[0]?.clientY ?? 0));

  const start = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent, node: SdNode) => {
    end();
    if (reducedMotion()) return;
    const el = document.querySelector<HTMLElement>(`[data-node="${CSS.escape(node.id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const zoom = getZoom() || 1;
    const c = { id: node.id, el, ox: (clientX(e) - r.left) / zoom, oy: (clientY(e) - r.top) / zoom, pos: node.position, deg: 0, vel: 0, want: 0, s: 1, held: true, lastX: clientX(e), lastT: performance.now(), raf: 0 };
    d.current = c;
    el.style.transformOrigin = `${c.ox}px ${c.oy}px`;
    el.classList.add('sd-held');
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      // the lean follows the pointer speed, and fades when the pointer rests
      c.want *= Math.pow(0.0015, dt);
      const k = c.held ? 260 : 210;
      const damp = c.held ? 22 : 12;
      c.vel += (k * ((c.held ? c.want : 0) - c.deg) - damp * c.vel) * dt;
      c.deg += c.vel * dt;
      c.s += ((c.held ? 1.03 : 1) - c.s) * Math.min(1, dt * 14);
      if (!c.held && Math.abs(c.deg) < 0.04 && Math.abs(c.vel) < 0.4 && Math.abs(c.s - 1) < 0.002) return end();
      el.style.transform = `rotate(${c.deg.toFixed(2)}deg) scale(${c.s.toFixed(3)})`;
      useTilt.setState({ [c.id]: { deg: c.deg, s: c.s, cx: c.pos.x + c.ox, cy: c.pos.y + c.oy } });
      c.raf = requestAnimationFrame(step);
    };
    c.raf = requestAnimationFrame(step);
  };

  const move = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent, node: SdNode) => {
    const c = d.current;
    if (!c || c.id !== node.id) return;
    const now = performance.now();
    const x = clientX(e);
    const v = (x - c.lastX) / Math.max(4, now - c.lastT) / (getZoom() || 1); // canvas px per ms
    c.lastX = x;
    c.lastT = now;
    c.pos = node.position;
    c.want = Math.max(-13, Math.min(13, c.want * 0.6 + v * 9 * 0.4));
  };

  const stop = (_: unknown, node: SdNode) => {
    const c = d.current;
    if (!c) return;
    c.pos = node.position;
    c.held = false;
  };
  return { start, move, stop };
}

export function Canvas() {
  const nodes = useApp((s) => s.nodes);
  const edges = useApp((s) => s.edges);
  const theme = useApp((s) => s.theme);
  const onNodesChange = useApp((s) => s.onNodesChange);
  const onEdgesChange = useApp((s) => s.onEdgesChange);
  const onConnect = useApp((s) => s.onConnect);
  const addNode = useApp((s) => s.addNode);
  const select = useApp((s) => s.select);
  const { screenToFlowPosition } = useReactFlow();
  const fly = useFlight(nodes);
  const tilt = useDragTilt();

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const preset = usePresets.getState().presets.find((x) => x.id === e.dataTransfer.getData(PRESET_MIME));
      const kind = preset?.kind ?? e.dataTransfer.getData(DRAG_MIME);
      if (!kind) return;
      e.preventDefault();
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(kind, p.x - NODE_W / 2, p.y - 24, preset && { label: preset.name, params: preset.params });
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <ReactFlow
      // many cards: no blur behind them (see .sd-many in index.css)
      className={nodes.length > MANY ? 'sd-many' : undefined}
      nodes={fly ? nodes.map((n) => (fly.has(n.id) ? { ...n, position: fly.get(n.id)! } : n)) : nodes}
      edges={edges.map((e) => ({ ...e, markerEnd: defaultEdgeOptions.markerEnd }))}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => select(null)}
      // a phone: a tap on a component or a call opens its settings
      onNodeClick={() => isPhone() && useApp.getState().setDrawer('inspector')}
      onEdgeClick={() => isPhone() && useApp.getState().setDrawer('inspector')}
      onNodeDragStart={(e, n) => tilt.start(e, n)}
      onNodeDrag={(e, n) => tilt.move(e, n)}
      onNodeDragStop={(e, n) => tilt.stop(e, n)}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      colorMode={theme}
      fitView={!lastViewport && !isPhone()}
      onInit={(flow) => {
        // a phone: not the whole design (see firstView)
        const el = document.querySelector('.react-flow')?.getBoundingClientRect();
        const all = useApp.getState().nodes;
        if (isPhone() && !lastViewport && el?.width && all.length) void flow.setViewport(firstView(all, el.width, el.height));
      }}
      defaultViewport={lastViewport}
      onMoveEnd={(_, vp) => {
        lastViewport = vp;
      }}
      fitViewOptions={{ padding: FIT.padding, maxZoom: FIT.maxZoom }}
      minZoom={FIT.minZoom}
      maxZoom={2}
      deleteKeyCode={['Backspace', 'Delete']}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--grid)" />
      {CONTROLS && <Controls showInteractive={false} position="bottom-left" />}
      <EdgeFlow />
      <Checks />
      <ThroughHint />
    </ReactFlow>
  );
}

/**
 * The design check on the canvas: a count of errors and warnings, open for the list. A message
 * names a component or a connection: clicking it selects that part.
 */
/** The traffic on the lines: one canvas for all edges (edgeFlow.ts). */
function EdgeFlow() {
  const store = useStoreApi();
  useEffect(() => {
    const pane = store.getState().domNode;
    return pane ? startEdgeFlow(pane, () => store.getState().transform) : undefined;
  }, [store]);
  return null;
}

/** How long the hint on a cache just connected to a store stays. */
const THROUGH_HINT_MS = 12_000;

/**
 * A cache just connected straight to a store: once, at the bottom of the canvas (where the panels do
 * not cover it; on a phone, at the top), what that line does. The line keeps its "read-through" label.
 */
function ThroughHint() {
  const id = useApp((s) => s.throughHint);
  const names = useApp((s) => {
    const e = s.edges.find((x) => x.id === s.throughHint);
    const name = (nid: string) => { const n = s.nodes.find((x) => x.id === nid)?.data.node; return n ? n.label ?? t(KINDS[n.kind].label) : nid; };
    return e ? `${name(e.source)} → ${name(e.target)}` : null;
  });
  useEffect(() => {
    if (!id) return;
    const h = setTimeout(() => useApp.getState().throughHint === id && useApp.setState({ throughHint: null }), THROUGH_HINT_MS);
    return () => clearTimeout(h);
  }, [id]);
  // on a phone the run card and the drawers take the bottom: the hint goes on top, under the
  // design-check button, where an open drawer does not reach it
  const phone = usePhone();
  if (!id || !names) return null;
  return (
    <Panel position={phone ? 'top-center' : 'bottom-center'} className={`w-[min(440px,calc(100%-24px))] ${phone ? '!mt-14' : '!mb-3'}`}>
      <div className="card sd-over flex gap-2 p-2.5 text-[13px] leading-snug" role="status" data-testid="edge-through-hint">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 font-medium">{names}</div>
          {throughText()}
        </div>
        <button className="faint shrink-0 self-start" onClick={() => useApp.setState({ throughHint: null })} aria-label={t('關閉')} data-testid="edge-through-hint-close">
          <X size={14} />
        </button>
      </div>
    </Panel>
  );
}

function Checks() {
  const issues = useApp((s) => s.issues);
  const focus = useApp((s) => s.focus);
  const [open, setOpen] = useState(false);
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const text = [errors ? t('{n} 個錯誤', { n: errors }) : '', warnings ? t('{n} 個警告', { n: warnings }) : ''].filter(Boolean).join(t('、'));
  return (
    <Panel position="top-left" className="!m-3 max-w-[420px]">
      <button
        className="btn sd-over text-[14px]"
        style={{ color: errors ? 'var(--bad-ink)' : 'var(--warn-ink)' }}
        onClick={() => {
          // the list takes the top of the canvas, where the one-time read-through hint sits on a phone:
          // the hint goes (the line keeps its label)
          if (!open) useApp.setState({ throughHint: null });
          setOpen(!open);
        }}
        aria-expanded={open}
        data-testid="checks"
      >
        {errors ? <CircleX size={15} /> : <TriangleAlert size={15} />}
        {t('設計檢查：{text}', { text })}
      </button>
      {open && (
        <ul className="card sd-over mt-1.5 space-y-1 p-2" data-testid="checks-list">
          {issues.map((i, k) => {
            const target = i.edge ? { type: 'edge' as const, id: i.edge } : i.node ? { type: 'node' as const, id: i.node } : null;
            return (
              <li key={k}>
                <button
                  className="flex w-full gap-1.5 rounded-md p-1 text-left text-[14px] leading-snug hover:bg-[var(--panel-2)] disabled:cursor-default disabled:hover:bg-transparent"
                  disabled={!target}
                  onClick={() => target && focus(target)}
                >
                  {i.level === 'error' ? <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />}
                  <span>{i.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
