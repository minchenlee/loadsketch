// Practice: design briefs, constraint problems, on-call incidents and the guess log, apart from the design being
// edited. The dialog lists them; the one in progress stays on the canvas (PracticeOverlay).
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Dumbbell, X } from 'lucide-react';
import { Briefs, Constraints, ProblemCard } from './Constraints.tsx';
import { OnCall, OnCallCard } from './OnCall.tsx';
import { GuessLog } from './GuessLog.tsx';
import { t } from '../../i18n/index.ts';
import { useExit, useModal } from '../modal.ts';

export function PracticeDialog({ onClose }: { onClose: () => void }) {
  const [closing, close] = useExit(onClose);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, close);
  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('練習')} className="panel sd-dialog flex max-h-[90vh] w-[min(980px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="practice">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <Dumbbell size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('練習')}</div>
          <div className="muted text-[13px]">{t('選一題開始：題目會載入畫布，目標顯示在畫布右上角。')}</div>
          <button className="btn ml-auto" onClick={close} aria-label={t('關閉')} autoFocus>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Briefs onStart={close} />
          <div className="mt-6 grid grid-cols-1 gap-6 border-t border-[var(--line)] pt-4 md:grid-cols-2">
            <Constraints onStart={close} />
            <OnCall onStart={close} />
          </div>
          <GuessLog className="mt-6 border-t border-[var(--line)] pt-4" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The practice in progress, over the top right of the canvas. */
export function PracticeOverlay() {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 flex max-h-[calc(100%-24px)] w-[min(600px,calc(100%-24px))] flex-col items-end gap-2" data-testid="practice-overlay">
      <ProblemCard />
      <OnCallCard />
    </div>
  );
}
