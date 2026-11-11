// A modal dialog rendered outside #root (createPortal to document.body): while it is open the app
// behind it is inert (no focus, clicks or shortcuts, see App.tsx), Escape closes it, and Tab goes
// round the dialog's own controls.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { reducedMotion } from './motion.ts';

export function useModal(box: RefObject<HTMLElement | null>, onClose: () => void): void {
  useLayoutEffect(() => {
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
      // only what Tab can reach: not disabled, not hidden (a file input behind its button)
      const all = [...box.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0,
      );
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i < 0 || i === all.length - 1 ? 0 : i + 1;
      e.preventDefault();
      all[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [box, onClose]);
}

/** How long a dialog takes to leave (index.css: .sd-backdrop[data-closing]). */
const EXIT_MS = 140;

/**
 * A dialog that shrinks away before it is removed. `close` starts the exit; `onClose` (which
 * removes the dialog) runs when the exit is over. `closing` goes on the backdrop as data-closing.
 */
export function useExit(onClose: () => void): [closing: boolean, close: () => void] {
  const [closing, setClosing] = useState(false);
  const done = useRef(onClose);
  done.current = onClose;
  const close = useCallback(() => {
    if (reducedMotion()) done.current();
    else setClosing(true);
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => done.current(), EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  return [closing, close];
}
