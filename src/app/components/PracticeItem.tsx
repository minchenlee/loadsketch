// One entry in the practice dialog: a card with a title, a short line about it, and its state.
import { Play, Trophy } from 'lucide-react';
import { t } from '../../i18n/index.ts';

export function PracticeItem({ title, about, best, on, onClick, testId }: { title: string; about: string; best?: number; on: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      className={`card sd-practice-item ${on ? 'is-on' : ''}`}
      onClick={onClick}
      aria-current={on ? 'true' : undefined}
      data-testid={testId}
    >
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold leading-snug">{title}</span>
        <span className="muted mt-0.5 line-clamp-2 text-[13px] leading-snug">{about}</span>
      </span>
      <span className="sd-practice-state num">
        {on ? (
          <span style={{ color: 'var(--accent)' }} className="flex items-center gap-1">
            <Play size={11} />
            {t('In progress')}
          </span>
        ) : best !== undefined ? (
          <span style={{ color: 'var(--ok-ink)' }} className="flex items-center gap-1">
            <Trophy size={11} />
            {t('best {n}', { n: best })}
          </span>
        ) : (
          <span className="faint">{t('not done')}</span>
        )}
      </span>
    </button>
  );
}
