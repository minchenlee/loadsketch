import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal, flushSync } from 'react-dom';
import uPlot from 'uplot';
import { Maximize2, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { t } from '../../i18n/index.ts';
import { LONG_RUN_S, fmtAxisTime, fmtClock, fmtMs, timeIncrs } from '../ui.ts';

export interface SeriesSpec {
  label: string;
  color: string; // CSS colour or var(--token)
  dash?: boolean;
  fill?: boolean;
}

function resolve(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#888' : c;
}

/** A value as the tooltip shows it: '%' is a 0–1 share, 'ms' a duration, otherwise a count or rate. */
function fmtValue(v: number, unit?: string): string {
  if (unit === '%') return `${Math.round(v * 100)}%`;
  if (unit === 'ms') return fmtMs(v);
  return v >= 100 ? Math.round(v).toLocaleString() : `${Math.round(v * 10) / 10}`;
}

/** Most rows a tooltip shows (the largest values first when there are more). */
const TIP_ROWS = 6;

/**
 * Fill the hover tooltip for data index idx, or hide it. Built with DOM nodes, not HTML, because
 * series labels come from the design (component names).
 */
function showTip(tip: HTMLDivElement, u: uPlot, specs: SeriesSpec[], unit: string | undefined, holder: HTMLElement): void {
  const idx = u.cursor.idx;
  const left = u.cursor.left ?? -1;
  if (idx == null || left < 0) {
    tip.style.display = 'none';
    return;
  }
  let rows = specs.map((s, i) => ({ s, v: u.data[i + 1]?.[idx] })).filter((r): r is { s: SeriesSpec; v: number } => r.v != null);
  const more = rows.length > TIP_ROWS;
  if (more) rows = [...rows].sort((a, b) => b.v - a.v).slice(0, TIP_ROWS);
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'sd-tip-t';
  const at = u.data[0][idx];
  head.textContent = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0) > LONG_RUN_S ? fmtClock(at) : `${at}s`;
  tip.append(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'sd-tip-r';
    const dot = document.createElement('span');
    dot.className = 'sd-tip-dot';
    dot.style.background = resolve(r.s.color);
    const label = document.createElement('span');
    label.className = 'sd-tip-l';
    label.textContent = r.s.label;
    const val = document.createElement('span');
    val.className = 'num sd-tip-v';
    val.textContent = fmtValue(r.v, unit);
    row.append(dot, label, val);
    tip.append(row);
  }
  if (more) {
    const rest = document.createElement('div');
    rest.className = 'faint';
    rest.textContent = t('（只列最高的 {n} 個）', { n: TIP_ROWS });
    tip.append(rest);
  }
  tip.style.display = 'block';
  // beside the cursor, on the side with room; inside the plot area
  const over = u.over.getBoundingClientRect();
  const box = holder.getBoundingClientRect();
  const x = over.left - box.left + left;
  const w = tip.offsetWidth;
  tip.style.left = `${x + 12 + w <= box.width ? x + 12 : Math.max(0, x - 12 - w)}px`;
  // inside the card vertically: below the plot top when it fits, else moved up (into the title row if needed)
  const card = (holder.parentElement ?? holder).getBoundingClientRect();
  const minTop = card.top - box.top + 2;
  const maxTop = card.bottom - box.top - 2 - tip.offsetHeight;
  tip.style.top = `${Math.max(minTop, Math.min(over.top - box.top + 4, maxTop))}px`;
}

/**
 * Open or close the dialog as a view transition: the card morphs into the dialog and back. Only
 * this card carries the transition name, and only while it morphs; a name on every card would lift
 * all of them above the dialog during the morph. At once without support or with reduced motion.
 */
function morph(card: HTMLElement | null, name: string, opening: boolean, update: () => void, after?: () => void): void {
  const d = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!card || !d.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    flushSync(update);
    return after?.();
  }
  card.style.viewTransitionName = opening ? name : ''; // the old picture: the card when opening, the dialog when closing
  const vt = d.startViewTransition(() => {
    flushSync(update);
    card.style.viewTransitionName = opening ? '' : name;
    after?.(); // the DOM is the new one here: the dialog is gone and the app is not inert
  });
  vt.finished.finally(() => (card.style.viewTransitionName = ''));
}

/** An event time on the x axis: a line at t, and a light band to t1 when the event ends. */
export interface ChartMark {
  t: number;
  t1?: number;
  label: string;
}

/**
 * Draw the marks as DOM elements over the plot (not on the canvas), so they have a text
 * alternative and tests can find them.
 */
function placeMarks(u: uPlot, marks: ChartMark[]): void {
  let layer = u.over.querySelector<HTMLDivElement>('.sd-marks');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'sd-marks';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    u.over.append(layer);
  }
  layer.replaceChildren();
  const min = u.scales.x.min ?? 0;
  const max = u.scales.x.max ?? 0;
  for (const m of marks) {
    // an event that started before the first point is drawn from the plot's left edge
    if (m.t > max || (m.t1 !== undefined && m.t1 < min)) continue;
    const x0 = u.valToPos(Math.max(min, m.t), 'x');
    if (m.t1 !== undefined && m.t1 > m.t) {
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;top:0;bottom:0;left:${x0}px;width:${Math.max(0, u.valToPos(Math.min(max, m.t1), 'x') - x0)}px;background:color-mix(in srgb, var(--warn) 9%, transparent)`;
      layer.append(band);
    }
    const line = document.createElement('div');
    line.className = 'sd-mark';
    line.dataset.testid = 'event-mark';
    line.dataset.t = String(m.t);
    line.title = m.label;
    line.setAttribute('aria-label', m.label);
    line.style.cssText = `position:absolute;top:0;bottom:0;left:${x0}px;border-left:1px dashed var(--warn)`;
    layer.append(line);
  }
}

interface ChartProps {
  title: string;
  /** Event times to mark on the x axis. */
  marks?: ChartMark[];
  series: SeriesSpec[];
  data: (number | null)[][];
  height?: number;
  yMax?: number;
  unit?: string;
  testId?: string;
}

/**
 * A small time-series chart. `data` is [xs, ...ys]; x is seconds. Hover shows the values.
 * The button at the top right opens the same chart big in a dialog; the card morphs into it.
 */
export function Chart(props: ChartProps) {
  const [open, setOpen] = useState(false);
  const name = `chart-${useId().replace(/[^\w-]/g, '')}`;
  const expand = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    morph(card.current, name, false, () => setOpen(false), () => expand.current?.focus());
  }, [name]);
  return (
    <>
      <ChartCard
        {...props}
        cardRef={card}
        action={
          <button ref={expand} className="sd-chart-btn" onClick={() => morph(card.current, name, true, () => setOpen(true))} aria-label={t('放大「{title}」', { title: props.title })} title={t('放大')} data-testid={props.testId ? `${props.testId}-expand` : undefined}>
            <Maximize2 size={14} />
          </button>
        }
      />
      {open && <ChartDialog {...props} name={name} onClose={close} />}
    </>
  );
}

/** The chart big, over a dim backdrop. Esc, the close button or a click outside closes it. */
function ChartDialog({ name, onClose, ...props }: ChartProps & { name: string; onClose: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // the chart height follows the window: title, legend and padding take about 220 px
  const fit = () => Math.round(Math.min(620, Math.max(140, window.innerHeight - 220)));
  const [height, setHeight] = useState(fit);
  useEffect(() => {
    const onResize = () => setHeight(fit());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    closeBtn.current?.focus();
    // a modal dialog: the app behind it takes no focus or clicks while it is open
    const app = document.getElementById('root');
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = false;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !box.current) return;
      // Tab and Shift+Tab go round the dialog's own controls; focus never leaves it
      const all = [...box.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i < 0 || i === all.length - 1 ? 0 : i + 1;
      e.preventDefault();
      all[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="sd-chart-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={props.title} className="max-h-full w-[min(1200px,100%)] overflow-y-auto rounded-[inherit]">
        <ChartCard
          {...props}
          big
          height={height}
          testId={props.testId ? `${props.testId}-big` : undefined}
          transitionName={name}
          action={
            <button ref={closeBtn} className="sd-chart-btn" onClick={onClose} aria-label={t('關閉')} title={t('關閉')}>
              <X size={16} />
            </button>
          }
        />
      </div>
    </div>,
    document.body,
  );
}

function ChartCard({ title, series, data, height = 150, yMax, unit, testId, big, action, transitionName, cardRef, marks }: ChartProps & { big?: boolean; action?: ReactNode; transitionName?: string; cardRef?: Ref<HTMLDivElement> }) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  // after a resize the tooltip stays hidden until the pointer moves (live data would show it again)
  const quiet = useRef(false);
  const specs = useRef(series);
  specs.current = series;
  const markRef = useRef(marks ?? []);
  markRef.current = marks ?? [];
  const theme = useApp((s) => s.theme);
  const key = series.map((s) => s.label + s.color).join('|');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ink = resolve('var(--ink-3)');
    const grid = resolve('var(--line-strong)');
    // a whole px size: uPlot scales only the digits before "px" for the screen, so 10.5px became 10.10px
    const axis = { stroke: ink, grid: { stroke: grid, width: 1, dash: [3, 4] }, ticks: { stroke: grid, width: 1, size: 4 }, font: '13px -apple-system, sans-serif' };
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      padding: [6, 14, 0, 0],
      cursor: { drag: { x: false, y: false } },
      legend: { show: true, live: false },
      hooks: {
        setCursor: [(u) => !quiet.current && tip.current && holder.current && showTip(tip.current, u, specs.current, unit, holder.current)],
        // a resize moves the plot under a still pointer: hide the tooltip until the pointer moves again
        setSize: [
          () => {
            quiet.current = true;
            if (tip.current) tip.current.style.display = 'none';
          },
        ],
        draw: [(u) => placeMarks(u, markRef.current)],
      },
      scales: { x: { time: false, range: (_u, min, max) => (min == null || max == null ? [0, 10] : min === max ? [min - 1, max + 1] : [min, max]) }, y: yMax !== undefined ? { range: [0, yMax] } : { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] } },
      axes: [
        { ...axis, size: 28, incrs: (_u, _i, min, max) => timeIncrs(max - min), values: (u, v) => v.map((x) => fmtAxisTime(x, (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0) > LONG_RUN_S)) },
        { ...axis, size: 44, values: (_u, v) => v.map((x) => (unit === '%' ? `${Math.round(x * 100)}%` : x >= 1000 ? `${x / 1000}k` : `${x}`)) },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: resolve(s.color),
          width: 1.5,
          dash: s.dash ? [5, 4] : undefined,
          fill: s.fill ? resolve(s.color) + '1c' : undefined,
          points: { show: false },
          spanGaps: true,
        })),
      ],
    };
    plot.current = new uPlot(opts, data as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // data is applied by the next effect; rebuild only when the series or theme change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme, height, yMax, unit]);

  useEffect(() => {
    plot.current?.setData(data as uPlot.AlignedData);
  }, [data]);

  const markKey = (marks ?? []).map((m) => `${m.t}-${m.t1}-${m.label}`).join('|');
  useEffect(() => {
    if (plot.current) placeMarks(plot.current, markRef.current);
  }, [markKey]);

  return (
    <div
      className={`card min-w-0 overflow-hidden ${big ? 'sd-chart-big px-4 pb-2 pt-3 shadow-2xl' : 'flex-1 px-2.5 pt-1.5'}`}
      ref={cardRef}
      style={transitionName ? { viewTransitionName: transitionName } : undefined}
      data-testid={testId}
    >
      <div className={`flex items-start justify-between gap-2 ${big ? 'mb-2' : 'mb-0.5'}`}>
        <div className={big ? 'text-[17px] font-semibold' : 'muted text-[14px] font-medium'}>{title}</div>
        {action}
      </div>
      <div className="relative" ref={holder} onMouseMoveCapture={() => (quiet.current = false)} onMouseLeave={() => tip.current && (tip.current.style.display = 'none')}>
        <div ref={box} />
        <div ref={tip} className="sd-tip" role="tooltip" data-testid={testId ? `${testId}-tip` : undefined} />
        {(data[0]?.length ?? 0) === 0 && (
          <div className="faint pointer-events-none absolute inset-0 flex items-center justify-center pb-6 text-[14px]">{t('還沒有資料')}</div>
        )}
      </div>
    </div>
  );
}

/** A tiny line with a soft fill under it, for KPI cards. Gaps (null) are skipped. */
export function Spark({ values, color = 'var(--accent)', height = 22 }: { values: (number | null)[]; color?: string; height?: number }) {
  const v = values.map((x) => x ?? 0);
  const W = 100;
  if (v.length < 2) return <div style={{ height }} />;
  const max = Math.max(...v) || 1;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * W).toFixed(2)},${(height - 1 - (y / max) * (height - 3)).toFixed(2)}`);
  const id = `spark-${color.replace(/[^\w]/g, '')}`;
  return (
    <svg className="block w-full" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.28} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(' ')} ${W},${height}`} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
