// A side or bottom panel that opens and closes with a slide (index.css: .sd-slide). The panel
// stays mounted while it closes, and is removed after.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { reducedMotion } from '../motion.ts';

/** A little longer than the transition in index.css. */
const SLIDE_MS = 320;

export function Slide({ open, axis, anchor, children }: { open: boolean; axis: 'x' | 'y'; anchor?: 'end'; children: React.ReactNode }) {
  // closed → opening → open → closing → closed
  const [state, setState] = useState<'closed' | 'opening' | 'open' | 'closing'>(open ? 'open' : 'closed');
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reducedMotion()) return setState(open ? 'open' : 'closed');
    setState(open ? 'opening' : 'closing');
  }, [open]);
  const [wide, setWide] = useState(open);
  useEffect(() => {
    if (state === 'opening') {
      // one frame at size 0, then the track grows
      const raf = requestAnimationFrame(() => setWide(true));
      const timer = setTimeout(() => setState('open'), SLIDE_MS);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
    if (state === 'closing') {
      setWide(false);
      const timer = setTimeout(() => setState('closed'), SLIDE_MS);
      return () => clearTimeout(timer);
    }
    setWide(state === 'open');
  }, [state]);
  if (state === 'closed') return null;
  const moving = state !== 'open';
  return (
    <div className="sd-slide" data-axis={axis} data-anchor={anchor} data-shut={(moving && !wide) || undefined} data-moving={moving || undefined}>
      <div>{children}</div>
    </div>
  );
}
