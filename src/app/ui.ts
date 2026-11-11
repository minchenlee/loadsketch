import {
  Archive,
  Cloud,
  Cog,
  Database,
  DoorOpen,
  Gauge,
  Globe,
  Layers,
  ListOrdered,
  MemoryStick,
  Server,
  Split,
  Unplug,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Category } from '../schema/kinds.ts';

export const ICONS: Record<string, LucideIcon> = {
  Archive,
  Cloud,
  Cog,
  Database,
  DoorOpen,
  Gauge,
  Globe,
  Layers,
  ListOrdered,
  MemoryStick,
  Server,
  Split,
  Unplug,
  Users,
  Zap,
};

export const CATEGORY_COLOR: Record<Category, string> = {
  traffic: 'var(--cat-traffic)',
  edge: 'var(--cat-edge)',
  compute: 'var(--cat-compute)',
  resilience: 'var(--cat-resilience)',
  data: 'var(--cat-data)',
  messaging: 'var(--cat-messaging)',
};

export const CATEGORY_ORDER: Category[] = ['traffic', 'edge', 'compute', 'data', 'messaging', 'resilience'];

export const pct = (x: number) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
/** Runs longer than this show time in minutes. */
/** Series colours for one line per component or instance. */
export const PALETTE = ['#2563eb', '#ea580c', '#16a34a', '#c026d3', '#0891b2', '#ca8a04', '#dc2626', '#7c3aed', '#db2777', '#475569'];

export const LONG_RUN_S = 300;
/** 125 s → "2:05". */
export const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
};
/** A time-axis label: seconds for short runs; whole minutes ("5m") or m:ss for long ones. */
export const fmtAxisTime = (x: number, long: boolean) => (!long ? `${x}s` : x % 60 === 0 ? `${x / 60}m` : fmtClock(x));
/** Tick steps for the time axis: in minutes once a run is long. */
export const timeIncrs = (span: number) => (span > LONG_RUN_S ? [60, 120, 300, 600, 900, 1800, 3600, 7200] : [1, 2, 5, 10, 15, 20, 30, 60, 120, 300]);
export const fmtN = (x: number) => (x >= 10000 ? `${(x / 1000).toFixed(0)}k` : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : `${Math.round(x)}`);
export const fmtMs = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : x >= 100 ? `${x.toFixed(0)} ms` : x >= 10 ? `${x.toFixed(1)} ms` : `${x.toFixed(2)} ms`);

/** Colour for a utilisation value: calm until 70%, then warning, then bad. */
export function utilColor(u: number): string {
  if (u >= 0.95) return 'var(--bad)';
  if (u >= 0.7) return 'var(--warn)';
  return 'var(--ok)';
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Panel shortcuts, as shown in tooltips. */
export const SHORTCUT = {
  left: IS_MAC ? '⌘B' : 'Ctrl+B',
  right: IS_MAC ? '⌥⌘B' : 'Ctrl+Alt+B',
  bottom: IS_MAC ? '⌘J' : 'Ctrl+J',
};
