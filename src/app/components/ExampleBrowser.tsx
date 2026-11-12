// The example browser: a dialog with categories on the left and example cards on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, GitCompareArrows, GraduationCap, Search, Trophy, X } from 'lucide-react';
import { EXAMPLES, SCENARIOS, exampleScenario, useApp } from '../store.ts';
import { categorize, pairOf, TIERS } from '../examples.ts';
import { LESSONS } from '../../learn/lessons.ts';
import { useExit } from '../modal.ts';
import { t } from '../../i18n/index.ts';

const ALL = 'all';

export function ExampleBrowser({ onClose }: { onClose: () => void }) {
  const [closing, close] = useExit(onClose);
  const loadExample = useApp((s) => s.loadExample);
  const current = useApp((s) => s.example);
  const cats = useMemo(() => categorize(Object.keys(EXAMPLES)), []);
  const [cat, setCat] = useState(() => cats.find((c) => current && c.examples.includes(current))?.id ?? ALL);
  const [q, setQ] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const passed = useApp((s) => s.passed);

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // a lesson's description gives its answer away: the card shows the lesson's intro instead
  const about = (k: string) => (LESSONS[k] ? t(LESSONS[k].intro) : EXAMPLES[k].description ? t(EXAMPLES[k].description!) : '');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? cats.flatMap((c) => c.examples).filter((k) => `${t(EXAMPLES[k].name)} ${about(k)} ${k}`.toLowerCase().includes(needle))
    : cat === ALL
      ? cats.flatMap((c) => c.examples)
      : (cats.find((c) => c.id === cat)?.examples ?? []);
  const catOf = (k: string) => cats.find((c) => c.examples.includes(k));

  const navBtn = (id: string, label: string, n: number) => (
    <button
      key={id}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[14px] ${cat === id && !needle ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]' : 'hover:bg-[var(--panel-2)]'}`}
      onClick={() => {
        setCat(id);
        setQ('');
      }}
      aria-current={cat === id && !needle ? 'true' : undefined}
    >
      <span>{label}</span>
      <span className="faint num text-[12px]">{n}</span>
    </button>
  );

  return (
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label={t('範例')} className="panel sd-dialog flex h-[min(680px,90vh)] w-[min(980px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="example-browser">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <BookOpen size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('範例')}</div>
          <label className="field ml-1 flex sm:ml-4 max-w-[360px] flex-1 items-center gap-2">
            <Search size={14} className="faint shrink-0" />
            <input ref={search} className="w-full bg-transparent outline-none" placeholder={t('搜尋範例')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('搜尋範例')} />
          </label>
          <button className="btn ml-auto" onClick={close} aria-label={t('關閉')}>
            <X size={16} />
          </button>
        </div>
        <div className="sd-ex-body flex min-h-0 flex-1">
          <nav className="sd-ex-nav w-[200px] shrink-0 space-y-0.5 overflow-y-auto border-r border-[var(--line)] p-2" aria-label={t('分類')}>
            {navBtn(ALL, t('全部'), cats.reduce((a, c) => a + c.examples.length, 0))}
            <div className="sd-ex-rule my-1.5 border-t border-[var(--line)]" />
            {TIERS.map((tier) => {
              const own = cats.filter((c) => c.tier === tier.id);
              if (!own.length) return null;
              return (
                <div key={tier.id} className="sd-ex-tier pb-1.5" data-testid={`tier-${tier.id}`}>
                  <div className="sd-ex-tier-name faint px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide" title={t(tier.help)}>
                    {t(tier.label)}
                  </div>
                  {own.map((c) => navBtn(c.id, t(c.label), c.examples.length))}
                </div>
              );
            })}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {needle && <div className="muted mb-2 text-[13px]">{t('找到 {n} 個', { n: shown.length })}</div>}
            {shown.length === 0 && <div className="muted text-[14px]">{t('沒有符合的範例。')}</div>}
            {TIERS.map((tier) => {
              const part = shown.filter((k) => catOf(k)?.tier === tier.id);
              if (!part.length) return null;
              return (
                <section key={tier.id} className="mb-5" aria-label={t(tier.label)} data-testid={`tier-section-${tier.id}`}>
                  <div className="mb-2">
                    <div className="text-[14px] font-semibold">{t(tier.label)}</div>
                    <div className="muted text-[13px]">{t(tier.help)}</div>
                  </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {part.map((k) => {
                const lesson = LESSONS[k];
                const won = lesson ? lesson.challenges.filter((c) => passed.includes(c.id)).length : 0;
                const sc = SCENARIOS[exampleScenario(k)];
                const pair = pairOf(k);
                const other = pair ? (pair[0] === k ? pair[1] : pair[0]) : null;
                return (
                  <div key={k} className={`card flex flex-col transition-colors hover:border-[var(--accent)] ${k === current ? 'border-[var(--accent)]' : ''}`}>
                  <button
                    className="flex flex-1 flex-col gap-1.5 p-3 text-left"
                    onClick={() => {
                      loadExample(k);
                      close();
                    }}
                    data-testid={`example-${k}`}
                  >
                    <div className="text-[15px] font-semibold leading-snug">{t(EXAMPLES[k].name)}</div>
                    <div className="muted line-clamp-3 text-[13px] leading-relaxed">{about(k)}</div>
                    <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[12px]">
                      {(needle || cat === ALL) && <span className="faint">{t(catOf(k)?.label ?? '')}</span>}
                      <span className="faint">{t('情境：{name}', { name: sc?.name ? t(sc.name) : t('平穩流量') })}</span>
                      {lesson && (
                        <span className="flex items-center gap-1 font-medium" style={{ color: 'var(--accent)' }}>
                          <GraduationCap size={13} />
                          {t('題目＋挑戰')}
                        </span>
                      )}
                      {lesson && won > 0 && (
                        <span className="flex items-center gap-1" style={{ color: 'var(--ok-ink)' }}>
                          <Trophy size={12} />
                          {t('過關 {n}/{m}', { n: won, m: lesson.challenges.length })}
                        </span>
                      )}
                    </div>
                  </button>
                  {pair && other && EXAMPLES[other] && (
                    <button
                      className="flex items-center gap-1.5 border-t border-[var(--line)] px-3 py-1.5 text-left text-[13px] font-medium hover:bg-[var(--panel-2)]"
                      style={{ color: 'var(--accent)' }}
                      onClick={() => {
                        useApp.getState().compareExamples(pair[0], pair[1], k);
                        close();
                      }}
                      title={t('兩個範例用同一個情境跑，並排看差在哪裡')}
                      data-testid={`example-compare-${k}`}
                    >
                      <GitCompareArrows size={13} className="shrink-0" />
                      {t('和「{name}」比較', { name: t(EXAMPLES[other].name) })}
                    </button>
                  )}
                  </div>
                );
              })}
            </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
