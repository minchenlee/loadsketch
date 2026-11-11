// The moving marks on the edges, drawn on one canvas by one animation loop:
// - particles: how much traffic flows (density follows calls per second; colour shows read, write, failed)
// - request dots: real sampled requests, placed by their recorded send/arrive/reply times
// One canvas keeps the cost of a frame small when a design has many edges: an SVG circle per mark
// made the browser restyle and lay out hundreds of elements each frame.
import { edgeFailShare } from '../engine/index.ts';
import { live, viewTime, windowAt } from './runtime.ts';

type Pt = [number, number];
export interface EdgeGeo {
  pts: Pt[];
  acc: number[];
}

/** The point at share f (0–1) of the length of a line. */
export function pointAt(pts: Pt[], acc: number[], f: number): Pt {
  const total = acc[acc.length - 1];
  const d = Math.max(0, Math.min(1, f)) * total;
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const seg = acc[i] - acc[i - 1] || 1;
  const u = (d - acc[i - 1]) / seg;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
}

interface Entry {
  geo: EdgeGeo;
  phase: number;
  dots: number; // request dots drawn on this edge in the current frame
}

const edges = new Map<string, Entry>();
let version = 0; // changes when a line moves, so a still picture is drawn again

/** An edge tells where its line is (on every change of the line). */
export function setEdgeGeo(id: string, geo: EdgeGeo): void {
  const e = edges.get(id);
  if (e) e.geo = geo;
  else edges.set(id, { geo, phase: 0, dots: 0 });
  version++;
}

export function dropEdgeGeo(id: string): void {
  if (edges.delete(id)) version++;
}

const MAX_PARTICLES = 28;
const MAX_DOTS = 24;
const PARTICLE_SPEED = 70; // px per real second
const PARTICLE_R = 2.3;
const DOT_R = 5;
const TAU = Math.PI * 2;

const COLOURS = ['--read', '--write', '--bad', '--ok', '--panel'] as const;
const READ = 0;
const WRITE = 1;
const BAD = 2;
const OK = 3;
const PANEL = 4;

/**
 * Starts the drawing loop. `pane` is the flow's container, `transform` gives the current pan and
 * zoom as [x, y, zoom]. Returns the function that stops it.
 *
 * The canvas sits in the edge layer (above the lines, below the labels and the cards), but that
 * layer is panned and zoomed; the canvas takes the opposite transform, so it always covers the
 * pane with sharp pixels, and the drawing applies pan and zoom itself.
 */
export function startEdgeFlow(pane: HTMLElement, transform: () => [number, number, number]): () => void {
  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'edge-flow';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0';
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let w = 0;
  let h = 0;
  let dpr = 1;
  let sized = '';
  const size = () => {
    w = pane.clientWidth;
    h = pane.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
  };
  size();
  const ro = new ResizeObserver(size);
  ro.observe(pane);

  let colours: string[] = [];
  let themed = '';
  const readColours = () => {
    const cs = getComputedStyle(document.documentElement);
    colours = COLOURS.map((c) => cs.getPropertyValue(c).trim() || '#888');
  };

  // marks of one frame, by colour: x, y, x, y, …
  const parts: number[][] = [[], [], []];
  const dots: number[][] = [[], [], [], []];
  let placed = '';
  let lastKey = '';
  let last = performance.now();
  let raf = 0;

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const now = performance.now();
    const dtReal = (now - last) / 1000;
    last = now;
    if (!canvas.isConnected) {
      // (again after the flow built its layers anew)
      const host = pane.querySelector('.react-flow__edges');
      if (!host) return;
      host.appendChild(canvas);
    }
    const theme = document.documentElement.className;
    if (theme !== themed || !colours.length) {
      themed = theme;
      readColours();
    }
    const [x, y, z] = transform();
    const c = live.clock;
    const moving = c.running && !c.paused;
    const t = viewTime(now);
    // nothing moves: the picture of the last frame is still right
    const key = `${t}|${x}|${y}|${z}|${w}|${h}|${dpr}|${version}|${themed}|${live.windows.length}|${live.traces.length}|${c.speed}`;
    if (!moving && key === lastKey) return;
    lastKey = key;

    const size = `${w}|${h}|${dpr}`;
    if (size !== sized) {
      sized = size;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const at = `${x}|${y}|${z}`;
    if (at !== placed) {
      placed = at;
      canvas.style.transform = `translate(${-x / z}px, ${-y / z}px) scale(${1 / z})`;
    }

    // the part of the flow that is on screen (marks outside are not drawn)
    const x0 = -x / z - 8;
    const x1 = (w - x) / z + 8;
    const y0 = -y / z - 8;
    const y1 = (h - y) / z + 8;
    for (const a of parts) a.length = 0;
    for (const a of dots) a.length = 0;
    let nParts = 0;
    let nDots = 0;

    const win = c.running || live.windows.length ? windowAt(t) : null;
    for (const [id, en] of edges) {
      en.dots = 0;
      const e = win?.edges[id];
      if (!e) continue;
      const rate = e.calls / win!.dt;
      if (!(rate > 0)) continue;
      const { pts, acc } = en.geo;
      const total = acc[acc.length - 1] || 1;
      if (moving) en.phase = (en.phase + (dtReal * PARTICLE_SPEED) / total) % 1;
      // up to MAX_PARTICLES, about 6 per tenfold increase in rate
      const n = Math.min(MAX_PARTICLES, Math.max(1, Math.round(Math.log10(rate + 1) * 6)));
      const failShare = edgeFailShare(e);
      const writeShare = e.calls ? e.write / e.calls : 0;
      nParts += n;
      for (let i = 0; i < n; i++) {
        const [px, py] = pointAt(pts, acc, (en.phase + i / n) % 1);
        if (px < x0 || px > x1 || py < y0 || py > y1) continue;
        const k = (i * 0.618034) % 1; // spread colours evenly over the particles
        parts[k < failShare ? BAD : k < failShare + writeShare ? WRITE : READ].push(px, py);
      }
    }

    // request dots: hops of sampled requests that are on an edge at time t (slow motion only)
    if (live.traces.length && c.speed <= 1) {
      for (let ti = live.traces.length - 1; ti >= 0; ti--) {
        const tr = live.traces[ti];
        if (tr.t0 > t || tr.t1 + 1000 < t) continue;
        for (const hop of tr.hops) {
          let f = -1;
          let back = false;
          if (hop.tArrive !== undefined && t >= hop.tSend && t <= hop.tArrive) f = (t - hop.tSend) / Math.max(0.001, hop.tArrive - hop.tSend);
          else if (hop.tReply !== undefined && hop.tDone !== undefined && t >= hop.tReply && t <= hop.tDone) {
            f = 1 - (t - hop.tReply) / Math.max(0.001, hop.tDone - hop.tReply);
            back = true;
          }
          if (f < 0) continue;
          const en = edges.get(hop.edge);
          if (!en || en.dots >= MAX_DOTS) continue;
          en.dots++;
          nDots++;
          const [px, py] = pointAt(en.geo.pts, en.geo.acc, f);
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          const col = back && hop.ok === false ? BAD : back && hop.hit ? OK : hop.op === 'write' || hop.op === 'cache_del' ? WRITE : READ;
          dots[col].push(px, py);
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * x, dpr * y);
    ctx.globalAlpha = 0.85;
    for (let k = 0; k < parts.length; k++) {
      const a = parts[k];
      if (!a.length) continue;
      ctx.beginPath();
      for (let i = 0; i < a.length; i += 2) {
        ctx.moveTo(a[i] + PARTICLE_R, a[i + 1]);
        ctx.arc(a[i], a[i + 1], PARTICLE_R, 0, TAU);
      }
      ctx.fillStyle = colours[k];
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colours[PANEL];
    for (let k = 0; k < dots.length; k++) {
      const a = dots[k];
      if (!a.length) continue;
      ctx.beginPath();
      for (let i = 0; i < a.length; i += 2) {
        ctx.moveTo(a[i] + DOT_R, a[i + 1]);
        ctx.arc(a[i], a[i + 1], DOT_R, 0, TAU);
      }
      ctx.fillStyle = colours[k];
      ctx.fill();
      ctx.stroke();
    }

    // for tests: how many marks the frame has (written only on a change)
    const ds = canvas.dataset;
    if (ds.particles !== String(nParts)) ds.particles = String(nParts);
    if (ds.dots !== String(nDots)) ds.dots = String(nDots);
  };
  raf = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.remove();
  };
}
