// The phone layout: a window this narrow shows the canvas alone, and the component list, the
// settings and the charts come up from the bottom as drawers (components/Phone.tsx).
import { useSyncExternalStore } from 'react';

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
