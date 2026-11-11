import { useSyncExternalStore } from 'react';
import { getTick, subscribeTick } from './runtime.ts';

/** Re-render about 10 times a second while a run is on screen. */
export function useTick(): number {
  return useSyncExternalStore(subscribeTick, getTick);
}
