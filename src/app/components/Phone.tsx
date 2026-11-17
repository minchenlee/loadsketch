// The phone layout's bottom: three tabs, and the drawer each one opens over the lower part of the
// canvas. The drawers hold the same panels as the desktop layout (index.css fits them to the drawer).
import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import { ChartLine, Shapes, SlidersHorizontal, X } from 'lucide-react';
import { useApp, type Drawer } from '../store.ts';
import { Inspector } from './Inspector.tsx';
import { Metrics } from './Metrics.tsx';
import { Palette } from './Palette.tsx';
import { FindLimitPanel } from './FindLimit.tsx';
import { t, tx } from '../../i18n/index.ts';

const TABS: { key: Exclude<Drawer, null | 'limit'>; label: string; Icon: typeof Shapes }[] = [
  { key: 'palette', label: tx('Component'), Icon: Shapes },
  { key: 'inspector', label: tx('Settings'), Icon: SlidersHorizontal },
  { key: 'metrics', label: tx('Charts'), Icon: ChartLine },
];

export function PhoneTabs() {
  const drawer = useApp((s) => s.drawer);
  const setDrawer = useApp((s) => s.setDrawer);
  return (
    <nav className="sd-tabs panel shrink-0 border-t" aria-label={t('Panel')}>
      {TABS.map(({ key, label, Icon }) => (
        <button key={key} className="sd-tab" aria-pressed={drawer === key} onClick={() => setDrawer(drawer === key ? null : key)} data-testid={`phone-tab-${key}`}>
          <Icon size={18} />
          {t(label)}
        </button>
      ))}
    </nav>
  );
}

export function PhoneDrawer() {
  const drawer = useApp((s) => s.drawer);
  const setDrawer = useApp((s) => s.setDrawer);
  // the panel stays in the drawer while it slides shut
  const shown = useRef(drawer);
  if (drawer) shown.current = drawer;
  const which = shown.current;
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(null);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [drawer, setDrawer]);
  const label = which === 'limit' ? tx('Find limit') : TABS.find((x) => x.key === which)?.label;
  // Find limit (the run bar) opens its panel here; closing the drawer or opening another one ends the search
  const limitOpen = useApp((s) => s.limitOpen);
  const closeLimit = useApp((s) => s.closeLimit);
  const was = useRef({ drawer, limitOpen });
  useEffect(() => {
    const prev = was.current;
    was.current = { drawer, limitOpen };
    if (limitOpen && !prev.limitOpen) setDrawer('limit');
    else if (!limitOpen && prev.limitOpen && drawer === 'limit') setDrawer(null);
    else if (prev.drawer === 'limit' && drawer !== 'limit' && limitOpen) closeLimit();
  }, [drawer, limitOpen, setDrawer, closeLimit]);
  const el = useRef<HTMLDivElement>(null);
  // a drag down on the top edge closes it. The offset is a CSS variable on the parent, so the run
  // card above the drawer moves with it.
  const drag = useRef<{ y: number; t: number } | null>(null);
  const host = () => el.current?.parentElement;
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { y: e.clientY, t: e.timeStamp };
    e.currentTarget.setPointerCapture(e.pointerId);
    host()?.setAttribute('data-dragging', '');
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current) host()?.style.setProperty('--drawer-drag', `${Math.max(0, e.clientY - drag.current.y)}px`);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    host()?.removeAttribute('data-dragging');
    host()?.style.removeProperty('--drawer-drag');
    const dy = e.clientY - d.y;
    // far enough, or a quick flick down
    if (e.type === 'pointerup' && (dy > 90 || (dy > 24 && dy / Math.max(1, e.timeStamp - d.t) > 0.5))) setDrawer(null);
  };
  return (
    <div ref={el} className="sd-drawer" data-open={drawer ? '' : undefined} inert={!drawer} role="region" aria-label={label ? t(label) : undefined} data-testid="phone-drawer">
      <div className="sd-drawer-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} data-testid="phone-drawer-grip">
        <span className="sd-drawer-grip" aria-hidden />
        <button className="sd-chart-btn" onClick={() => setDrawer(null)} aria-label={t('Close')} title={t('Close')} data-testid="phone-drawer-close">
          <X size={16} />
        </button>
      </div>
      {/* a component picked from the list goes on the canvas: the drawer closes to show it */}
      <div key={which} className="sd-drawer-body" onClick={(e) => which === 'palette' && (e.target as HTMLElement).closest('[data-kind], [data-adds]') && setDrawer(null)}>
        {which === 'palette' ? <Palette /> : which === 'inspector' ? <Inspector /> : which === 'metrics' ? <Metrics /> : which === 'limit' ? <FindLimitPanel /> : null}
      </div>
    </div>
  );
}
