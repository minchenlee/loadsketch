// The phone layout: a window this narrow shows the canvas alone, and the component list, the
// settings and the charts come up from the bottom as drawers (components/Phone.tsx).
import { useSyncExternalStore } from 'react';
import type { Drawer } from './store.ts';

const QUERY = '(max-width: 480px)';
const mq = () => window.matchMedia(QUERY);

/** The window is phone-sized now. */
export const isPhone = () => mq().matches;

export function usePhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = mq();
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    isPhone,
  );
}

/**
 * What the phone's bottom sheet shows. One source each: the find-limit panel shows while
 * `limitOpen` (the store; the run bar's Find limit sets it, on a phone or not), over any drawer;
 * else the drawer of the tab. The panel is mounted only while it shows, so closing the sheet ends
 * the search (its worker stops when it unmounts).
 */
export type Sheet = Exclude<Drawer, null> | 'limit' | null;
export const sheetOf = (s: { drawer: Drawer; limitOpen: boolean }): Sheet => (s.limitOpen ? 'limit' : s.drawer);
/** Closing the sheet (its X, a drag down, Escape) closes the panel and the drawer under it. */
export const closeSheet = (): { drawer: Drawer; limitOpen: boolean } => ({ drawer: null, limitOpen: false });
/** A tab: closes the sheet when it shows that tab, else shows the tab (ending a search). */
export const pickTab = (s: { drawer: Drawer; limitOpen: boolean }, tab: Exclude<Drawer, null>): { drawer: Drawer; limitOpen: boolean } =>
  sheetOf(s) === tab ? closeSheet() : { drawer: tab, limitOpen: false };
