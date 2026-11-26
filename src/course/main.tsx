// The course page (/learn/): the table of contents, and one lesson at a time. A lesson is steps on
// the left (read, guess, run, see the answers, the challenges) and the simulator on the right: the
// app in an iframe with ?embed=1&course=1, which tells this page about every run
// (src/app/courseBridge.ts). Every answer and verdict is read from that run. Progress is kept in
// this browser (src/course/progress.ts).
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowRight, BookOpen, ChartLine, SkipForward, Calculator, Check, Circle, KeyRound, CircleCheck, CircleX, Languages, Lightbulb, Loader2, Moon, Play, RotateCcw, Search, Sun, Trophy, Wrench, X } from 'lucide-react';
import '../app/index.css';
import './course.css';
import logoBlack from '../app/assets/logo-black.svg';
import logoWhite from '../app/assets/logo-white.svg';
import { pickLang, setLang, t, tx, type Lang } from '../i18n/index.ts';
import { useExit, useModal } from '../app/modal.ts';
import { judge, runOf, sameScenario, type Challenge, type Lesson, type PracticeLink, type Question, type Verdict } from '../learn/lesson.ts';
import { INCIDENT_BY_ID } from '../learn/oncall.ts';
import { PROBLEM_BY_ID } from '../learn/constraints.ts';
import { BRIEF_BY_ID } from '../learn/briefs.ts';
import type { RunData } from '../learn/metrics.ts';
import type { Design, Scenario } from '../schema/design.ts';
import type { FromCourse, ToCourse } from '../app/courseBridge.ts';
import { ALL_LESSONS, UNITS, findLesson, nextReady, type CourseLesson } from './catalog.ts';
import { EMPTY, PROGRESS_KEY, loadProgress, mergeStored, saveProgress, scoreOf, withAnswers, type LessonProgress, type Progress } from './progress.ts';
import { INITIAL, runStep, takesGuesses, type RunEvent, type RunState } from './runState.ts';
import { addRun, answerable, judgedOn, learnTicks, lookOf, nextTitle, opensCharts, patchFocus, clampStep, ctxKey, ctxOf, feedbackOf, pagesOf, tryBaseline, type Ctx, type Page, type PageRuns } from './steps.ts';
import { loadExample, loadScenario } from './examples.ts';
import { readings, type Row } from './measures.ts';
import { calcParts } from './calc.ts';

const APP = '../app/';
type Theme = 'light' | 'dark';

/** The same order as the simulator: ?lang=, then the saved choice, then the browser language. */
function initialLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q) return pickLang(q);
  try {
    const saved = localStorage.getItem('loadsketch-lang');
    if (saved) return pickLang(saved);
  } catch {
    /* private mode */
  }
  return pickLang(navigator.language);
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

/** The lesson in the address (?lesson=3.1), followed through back and forward. */
function useRoute(): [string | null, (id: string | null) => void] {
  const read = () => new URLSearchParams(location.search).get('lesson');
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const onPop = () => setId(read());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: string | null) => {
    const q = new URLSearchParams(location.search);
    if (next) q.set('lesson', next);
    else q.delete('lesson');
    const s = q.toString();
    history.pushState(null, '', s ? `?${s}` : location.pathname);
    setId(next);
    scrollTo(0, 0);
  }, []);
  return [id, go];
}

// ---------------------------------------------------------------------------------------------
// Top bar

/** The Charts toggle's choice (the charts under the simulator's canvas), kept in this browser. */
const CHARTS_KEY = 'loadsketch-course-charts';
const savedCharts = () => {
  try {
    return localStorage.getItem(CHARTS_KEY) === '1';
  } catch {
    return false;
  }
};

/** Render `\n\n`-separated prose as separate `.course-prose` paragraphs; single-paragraph text keeps identical markup. */
function Prose({ text, className = '', space }: { text: string; className?: string; space?: string }) {
  const parts = text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p, k) => (
        <p key={k} className={`course-prose${k === 0 && space ? ` ${space}` : ''}${className ? ` ${className}` : ''}`}>
          {p}
        </p>
      ))}
    </>
  );
}

function Bar({ lang, theme, onLang, onTheme, onHome, onGlossary, charts }: { lang: Lang; theme: Theme; onLang: () => void; onTheme: () => void; onHome: (() => void) | null; onGlossary: () => void; charts: { on: boolean; toggle: () => void } | null }) {
  return (
    <header className="course-bar panel flex items-center gap-2 border-b px-3 py-2">
      <a href="../" className="flex shrink-0 items-center gap-2" aria-label="loadsketch">
        <img src={logoBlack} alt="" width={24} height={24} className="dark:hidden" />
        <img src={logoWhite} alt="" width={24} height={24} className="hidden dark:block" />
        <span className="course-wide text-[16px] font-semibold">loadsketch</span>
      </a>
      {onHome ? (
        <button className="btn min-w-0" onClick={onHome} data-testid="course-home">
          <ArrowLeft size={16} className="shrink-0" />
          <span className="truncate">{t('All lessons')}</span>
        </button>
      ) : (
        <span className="muted truncate text-[15px]">{t('Course')}</span>
      )}
      <span className="flex-1" />
      <button className="btn shrink-0" onClick={onGlossary} aria-label={t('Glossary')} title={t('Glossary')} data-testid="course-glossary-open">
        <BookOpen size={16} />
        <span className="course-wide">{t('Glossary')}</span>
      </button>
      {charts && (
        <button className={`btn shrink-0 ${charts.on ? 'btn-on' : ''}`} onClick={charts.toggle} aria-pressed={charts.on} aria-label={t('Charts')} title={t('Charts under the canvas: requests, latency and how busy each component is, over time')} data-testid="course-charts">
          <ChartLine size={16} />
          <span className="course-wide">{t('Charts')}</span>
        </button>
      )}
      <button className="btn shrink-0" onClick={onLang} aria-label={t('Language')} title={t('Language')} data-testid="course-lang">
        <Languages size={16} />
        <span className="course-wide">{lang === 'en' ? '中文' : 'English'}</span>
      </button>
      <button className="btn shrink-0" onClick={onTheme} aria-label={t('Dark / light')} title={t('Dark / light')} data-testid="course-theme">
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <a className="btn btn-primary course-wide shrink-0" href={APP}>
        {t('Open the simulator')}
      </a>
    </header>
  );
}

/** Course-wide glossary and visual simulator guide modal. */
function GlossaryDialog({ onClose, onOpenLesson }: { onClose: () => void; onOpenLesson: (id: string) => void }) {
  const [closing, close] = useExit(onClose);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const termsTabRef = useRef<HTMLButtonElement>(null);
  const guideTabRef = useRef<HTMLButtonElement>(null);
  useModal(box, close);
  const [tab, setTab] = useState<'terms' | 'guide'>('terms');
  const [q, setQ] = useState('');
  useEffect(() => {
    search.current?.focus();
  }, []);
  const switchTab = (next: 'terms' | 'guide', focus = false) => {
    setTab(next);
    if (focus) (next === 'terms' ? termsTabRef : guideTabRef).current?.focus();
  };
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      switchTab(tab === 'terms' ? 'guide' : 'terms', true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      switchTab('terms', true);
    } else if (e.key === 'End') {
      e.preventDefault();
      switchTab('guide', true);
    }
  };

  const items = useMemo(
    () =>
      ALL_LESSONS.flatMap((entry) =>
        (entry.lesson?.terms ?? []).map((item) => ({
          lessonId: entry.id,
          lessonTitle: entry.title,
          term: item.term,
          plain: item.plain,
          example: item.example,
        })),
      ),
    [],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter((item) =>
        `${t(item.term)} ${t(item.plain)} ${item.example ? t(item.example) : ''} ${item.lessonId} ${t(item.lessonTitle)}`.toLowerCase().includes(needle),
      )
    : items;

  const statusColors: { color: string; name: string; text: string }[] = [
    { color: 'var(--ok)', name: t('Green'), text: t('Comfortable room: plenty of spare capacity.') },
    { color: 'var(--warn)', name: t('Amber'), text: t('Getting busy: starting to fill up.') },
    { color: 'var(--bad)', name: t('Red'), text: t('Overloaded or queuing: requests are waiting or failing.') },
  ];
  const dotColors: { color: string; name: string; text: string }[] = [
    { color: 'var(--read)', name: t('Blue dot'), text: t('Read request: fetching data, like opening a page.') },
    { color: 'var(--write)', name: t('Orange dot'), text: t('Write request: saving or changing data.') },
  ];
  const numbersToWatch: { label: string; text: string }[] = [
    { label: t('Busy %'), text: t('How full a component is (utilization). Near 100% means a traffic jam is forming.') },
    { label: t('p99'), text: t('Sort 100 successful requests from fastest to slowest and take the 99th (99% stay under it, estimated from a histogram). Failed requests are counted in Error rate instead.') },
    { label: t('Error rate'), text: t('Share of requests that failed or timed out.') },
    { label: t('Bottleneck'), text: t('The part that fills up first and sets the limit for the whole system.') },
  ];

  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t('Glossary')}
        className="panel sd-dialog flex max-h-[min(680px,90dvh)] w-[min(680px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl"
        data-testid="course-glossary"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-3">
          <BookOpen size={18} className="muted shrink-0" />
          <div className="text-[16px] font-semibold">{t('Glossary')}</div>
          {tab === 'terms' && items.length > 0 && (
            <span className="faint num text-[13px]">
              {needle ? t('{n} of {all}', { n: shown.length, all: items.length }) : items.length}
            </span>
          )}
          <button className="btn ml-auto shrink-0" onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </div>
        <div className="shrink-0 space-y-2.5 border-b border-[var(--line)] px-4 py-2.5">
          <div className="seg" role="tablist" aria-label={t('Glossary')} onKeyDown={onTabKeyDown}>
            <button
              ref={termsTabRef}
              id="course-glossary-tab-terms"
              type="button"
              role="tab"
              aria-selected={tab === 'terms'}
              aria-controls="course-glossary-panel-terms"
              tabIndex={tab === 'terms' ? 0 : -1}
              className={`btn ${tab === 'terms' ? 'btn-on' : ''}`}
              onClick={() => switchTab('terms')}
              data-testid="course-glossary-tab-terms"
            >
              {t('Terms')}
            </button>
            <button
              ref={guideTabRef}
              id="course-glossary-tab-guide"
              type="button"
              role="tab"
              aria-selected={tab === 'guide'}
              aria-controls="course-glossary-panel-guide"
              tabIndex={tab === 'guide' ? 0 : -1}
              className={`btn ${tab === 'guide' ? 'btn-on' : ''}`}
              onClick={() => switchTab('guide')}
              data-testid="course-glossary-tab-guide"
            >
              {t('How to read the simulator')}
            </button>
          </div>
          {tab === 'terms' && (
            <label className="field flex w-full items-center gap-2">
              <Search size={14} className="faint shrink-0" />
              <input
                ref={search}
                className="w-full min-w-0 bg-transparent outline-none"
                placeholder={t('Search terms or explanations')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label={t('Search terms or explanations')}
                data-testid="course-glossary-search"
              />
            </label>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div id="course-glossary-panel-terms" role="tabpanel" aria-labelledby="course-glossary-tab-terms" hidden={tab !== 'terms'}>
            {items.length === 0 ? (
              <div className="muted text-[14px]">{t('No glossary terms yet.')}</div>
            ) : shown.length === 0 ? (
              <div className="muted text-[14px]">{t('No matching terms.')}</div>
            ) : (
              <dl className="space-y-2.5">
                {shown.map((item, k) => (
                  <div key={`${item.lessonId}:${k}`} className="card p-3" data-testid="course-glossary-item">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="min-w-0 break-words text-[15px] font-semibold leading-snug" style={{ color: 'var(--ink-strong)' }}>
                        {t(item.term)}
                      </dt>
                      <button
                        type="button"
                        className="course-glossary-badge num shrink-0"
                        onClick={() => {
                          onOpenLesson(item.lessonId);
                          close();
                        }}
                        title={t('Open lesson {id}: {title}', { id: item.lessonId, title: t(item.lessonTitle) })}
                        aria-label={t('Open lesson {id}: {title}', { id: item.lessonId, title: t(item.lessonTitle) })}
                      >
                        {item.lessonId}
                      </button>
                    </div>
                    <dd className="mt-1 break-words text-[14.5px] leading-relaxed">{t(item.plain)}</dd>
                    {item.example && (
                      <dd className="muted mt-1 break-words text-[13.5px] leading-relaxed">
                        {t('Example: {text}', { text: t(item.example) })}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div id="course-glossary-panel-guide" role="tabpanel" aria-labelledby="course-glossary-tab-guide" hidden={tab !== 'guide'}>
            <div className="space-y-3" data-testid="course-glossary-guide">
              <section className="card p-3">
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  {t('Card status colors')}
                </h3>
                <ul className="mt-2 space-y-1.5 text-[14.5px] leading-relaxed">
                  {statusColors.map((s) => (
                    <li key={s.name} className="flex items-start gap-2">
                      <span className="course-guide-dot" style={{ background: s.color }} aria-hidden />
                      <span className="min-w-0">
                        <strong className="font-semibold" style={{ color: 'var(--ink-strong)' }}>
                          {s.name}
                        </strong>
                        {' — '}
                        {s.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="card p-3">
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  {t('Moving dots on lines')}
                </h3>
                <ul className="mt-2 space-y-1.5 text-[14.5px] leading-relaxed">
                  {dotColors.map((d) => (
                    <li key={d.name} className="flex items-start gap-2">
                      <span className="course-guide-dot" style={{ background: d.color }} aria-hidden />
                      <span className="min-w-0">
                        <strong className="font-semibold" style={{ color: 'var(--ink-strong)' }}>
                          {d.name}
                        </strong>
                        {' — '}
                        {d.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="card p-3">
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  {t('4 numbers to watch')}
                </h3>
                <dl className="mt-2 space-y-2 text-[14.5px] leading-relaxed">
                  {numbersToWatch.map((n) => (
                    <div key={n.label}>
                      <dt className="font-semibold" style={{ color: 'var(--ink-strong)' }}>
                        {n.label}
                      </dt>
                      <dd className="muted mt-0.5 text-[14px]">{n.text}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section className="card p-3">
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  {t('How to edit')}
                </h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed">
                  {t('Click any card or connecting line in the simulator to open and change its settings, then press Run.')}
                </p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------
// Table of contents

type State = 'done' | 'started' | 'ready' | 'soon';
function stateOf(l: CourseLesson, p: LessonProgress | undefined): State {
  if (!l.lesson) return 'soon';
  if (p?.done) return 'done';
  return p && (p.reached > 0 || Object.keys(p.guesses).length) ? 'started' : 'ready';
}

function StatePill({ s }: { s: State }) {
  if (s === 'soon')
    return (
      <span className="sd-pill no-dot" style={{ color: 'var(--ink-3)', fontWeight: 400 }}>
        {t('Coming soon')}
      </span>
    );
  const label = s === 'done' ? t('Done') : s === 'started' ? t('In progress') : t('Start');
  const color = s === 'done' ? 'var(--ok)' : s === 'started' ? 'var(--accent)' : 'var(--ink-3)';
  return (
    <span className="sd-pill" style={{ '--pill': color } as React.CSSProperties}>
      {label}
    </span>
  );
}

function Catalog({ progress, open }: { progress: Progress; open: (id: string) => void }) {
  const ready = ALL_LESSONS.filter((l) => l.lesson);
  const done = ready.filter((l) => progress[l.id]?.done).length;
  const starterReady = Boolean(findLesson('0.0')?.lesson);
  return (
    <main className="course-wrap pb-16 pt-8" data-testid="course-catalog">
      <h1 className="text-[28px] font-semibold leading-tight sm:text-[34px]">{t('Learn system design by running it')}</h1>
      <p className="muted mt-3 max-w-[680px] text-[16px] leading-relaxed">
        {t('Each lesson opens a design in the simulator. Guess what happens, run it, read why, then change the design and run it again. Every number comes from the simulation, not from the text.')}
      </p>
      <p className="muted mt-2 max-w-[680px] text-[15px] leading-relaxed" data-testid="course-beginner-note">
        {t('New to system design? Start with 0.0 — no background needed. Every new term is explained in plain words when it first appears.')}
      </p>
      {done === 0 && starterReady && (
        <div className="mt-3">
          <button className="btn btn-primary" onClick={() => open('0.0')} data-testid="course-start-beginner">
            {t('Start from 0.0: Follow one click')}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <p className="faint mt-2 text-[14px]" data-testid="course-count">
        {t('{done} of {ready} ready lessons done. {soon} more are coming soon.', { done, ready: ready.length, soon: ALL_LESSONS.length - ready.length })}
      </p>
      {UNITS.map((u) => (
        <section key={u.id} className="mt-8" data-testid="course-unit">
          <h2 className="text-[18px] font-semibold">
            <span className="faint num mr-2">{u.id}</span>
            {t(u.title)}
          </h2>
          <ol className="card mt-2 overflow-hidden">
            {u.lessons.map((l) => {
              const s = stateOf(l, progress[l.id]);
              const body = (
                <>
                  <span className="num faint w-9 shrink-0">{l.id}</span>
                  <span className="min-w-0 flex-1">{t(l.title)}</span>
                  <span className="num faint course-wide shrink-0 text-[13px]">{t('{m} min', { m: l.minutes })}</span>
                  <StatePill s={s} />
                </>
              );
              return (
                <li key={l.id} className="course-row" data-testid={`course-lesson-${l.id}`} data-state={s}>
                  {s === 'soon' ? (
                    <div className="course-row-in" aria-disabled="true">
                      {body}
                    </div>
                  ) : (
                    <a
                      className="course-row-in course-row-link"
                      href={`?lesson=${l.id}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        open(l.id);
                      }}
                    >
                      {body}
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// One lesson

type Status = 'loading' | 'idle' | 'running' | 'paused' | 'done';

const pageLabel = (p: Page): string => {
  switch (p.kind) {
    case 'read':
      return t('Read@@step');
    case 'guess':
      return t('Guess');
    case 'run':
      return t('Run');
    case 'try':
      return t('Try a change');
    case 'challenge':
      return t('Challenges');
    case 'practice':
      return t('Practice');
    case 'done':
      return t('Finish');
  }
};

type Clock = { atS: number; ofS: number };

function RunButton({ status, clock, finishing, onRun, onSkip, extra }: { status: Status; clock: Clock | null; finishing: boolean; onRun: () => void; onSkip: () => void; extra?: React.ReactNode }) {
  const busy = status === 'running' || status === 'paused' || status === 'loading';
  const going = status === 'running' || status === 'paused';
  const at = clock ? { at: clock.atS, of: clock.ofS } : null;
  const pct = clock && clock.ofS > 0 ? Math.min(99, Math.floor((clock.atS / clock.ofS) * 100)) : null;
  const statusText =
    status === 'loading'
      ? t('The simulator is loading…')
      : finishing && going
        ? at && pct !== null
          ? t('Skipping to end… {at} / {of} s ({p}%)', { ...at, p: pct })
          : t('Skipping to end…')
        : status === 'running'
          ? at
            ? t('Running… {at} / {of} s', at)
            : t('Running…')
          : status === 'paused'
            ? at
              ? t('Paused in the simulator at {at} / {of} s', at)
              : t('Paused in the simulator')
            : status === 'done'
              ? t('The run ended.')
              : '';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" onClick={onRun} disabled={busy} data-testid="course-run">
        <Play size={14} />
        {t('Run')}
      </button>
      {extra}
      <span className="faint text-[14px]" data-testid="course-status" data-status={status}>
        {statusText}
      </span>
      {going && (
        <button
          className="btn"
          onClick={onSkip}
          disabled={finishing}
          aria-busy={finishing || undefined}
          title={finishing ? t('Computing to the end…') : t('Skip the animation and compute to the end')}
          data-testid="course-skip"
        >
          {finishing ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <SkipForward size={14} />}
          {finishing ? t('Skipping…') : t('Skip to end')}
        </button>
      )}
    </div>
  );
}

/** Wrap `<number> <unit>` pairs in nowrap spans so line breaks never split a number from its unit. */
function renderCalcLine(line: string): React.ReactNode {
  const parts = calcParts(line);
  if (parts.length === 1 && !parts[0].nowrap) return line;
  return parts.map((p, k) =>
    p.nowrap ? (
      <span key={k} className="whitespace-nowrap">
        {p.text}
      </span>
    ) : (
      p.text
    ),
  );
}

/**
 * One question's answer, read from `run` (the latest run that answers it): the measurement, the
 * answer and the explanation agree. `scored`: the answer of the first run, which the score keeps;
 * a note says so when this run's answer is another.
 */
function Answer({ q, run, mine, scored }: { q: Question; run: RunData; mine: string | undefined; scored: string | undefined }) {
  const answer = q.answer(run);
  const first = scored !== undefined && scored !== answer ? q.options.find((o) => o.id === scored) : undefined;
  const right = q.options.find((o) => o.id === answer);
  const guess = q.options.find((o) => o.id === mine);
  return (
    <div className="course-answer" data-testid={`course-answer-${q.id}`} data-right={mine === answer || undefined}>
      <div className="text-[15px] font-semibold leading-snug" style={{ color: 'var(--ink-strong)' }}>
        {t(q.text)}
      </div>
      {mine !== undefined && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[15px] font-medium"
          style={{ color: mine === answer ? 'var(--ok-ink)' : 'var(--bad-ink)' }}
        >
          {mine === answer ? <CircleCheck size={16} className="shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={16} className="shrink-0" style={{ color: 'var(--bad)' }} />}
          <span>{mine === answer ? t('Right@@answer') : t('Not quite')}</span>
        </div>
      )}
      <dl className="course-answer-meta mt-2">
        {guess && mine !== answer && (
          <div className="course-answer-row" data-answer-field="guess">
            <dt className="muted">{t('Your guess')}</dt>
            <dd>{t(guess.text)}</dd>
          </div>
        )}
        {right && (
          <div className="course-answer-row" data-answer-field="answer">
            <dt className="muted">{t('Answer')}</dt>
            <dd>{t(right.text)}</dd>
          </div>
        )}
        <div className="course-answer-row" data-answer-field="measured">
          <dt className="muted">{t('Measured')}</dt>
          <dd className="num">{q.measured(run)}</dd>
        </div>
      </dl>
      <Prose text={t(q.explainFor?.[answer] || q.explain)} space="mt-3" className="text-[15px]" />
      {q.calc && q.calc.length > 0 && (
        <div className="course-calc mt-3" data-testid={`course-calc-${q.id}`}>
          <div className="course-calc-title faint mb-1 flex items-center gap-1.5 text-[13px] font-medium">
            <Calculator size={13} />
            {t('The arithmetic')}
          </div>
          <div className="space-y-0.5">
            {q.calc.map((line, k) => (
              <div key={k}>{renderCalcLine(t(line))}</div>
            ))}
          </div>
        </div>
      )}
      {first && (
        <div className="faint mt-2.5 text-[14px]" data-testid={`course-scored-${q.id}`}>
          {t('The design changed since the first run. Your score counts that run, whose answer was: {a}', { a: t(first.text) })}
        </div>
      )}
    </div>
  );
}

/** What a run or try step's run measured (its `show`, src/course/measures.ts), next to the run before it. Data: no motion. */
function Measured({ rows }: { rows: Row[] }) {
  if (!rows.length) return null;
  const ink = (c: Row['change']) => (c === 'better' ? 'var(--ok-ink)' : c === 'worse' ? 'var(--bad-ink)' : undefined);
  return (
    <div className="card mt-4 p-3" data-testid="course-measured">
      <div className="faint text-[14px]">{rows.some((r) => r.before !== undefined) ? t('This run, next to the run before it') : t('This run measured')}</div>
      <dl className="mt-1.5 space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-x-3" data-measure={r.key} data-before={r.before !== undefined || undefined} data-change={r.change}>
            <dt className="min-w-0 text-[15px]">
              {r.label}
              {r.shown && <span className="faint"> · {r.shown}</span>}
            </dt>
            <dd className="num shrink-0 text-[15px] font-medium">
              {r.before !== undefined && (
                <>
                  <span className="muted">{r.before}</span>
                  <span className="faint"> → </span>
                </>
              )}
              <span style={{ color: ink(r.change) }}>{r.now}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ChallengeCard({ c, verdict, passed }: { c: Challenge; verdict: Verdict | null; passed: boolean }) {
  return (
    <div className="card p-3" data-testid={`course-challenge-${c.id}`}>
      <div className="flex items-center gap-2">
        <span className="text-[16px] font-semibold">{t(c.title)}</span>
        {passed && (
          <span className="flex items-center gap-1 text-[14px]" style={{ color: 'var(--ok-ink)' }} data-testid="course-passed">
            <Trophy size={14} />
            {t('Passed')}
          </span>
        )}
      </div>
      <Prose text={t(c.text)} space="mt-1" className="text-[15px]" />
      {verdict && (
        <ul className="mt-2 space-y-1 text-[15px]" data-testid="course-verdict">
          {verdict.goals.map((g, i) => (
            <li key={i} className="flex gap-1.5">
              {g.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
              <span>
                {g.text}
                <span className="num faint">{t(' (this run: {v})', { v: g.value })}</span>
              </span>
            </li>
          ))}
          {verdict.broken.map((b, i) => (
            <li key={`r${i}`} className="flex gap-1.5">
              <CircleX size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />
              <span>{t('Breaks a rule: {why}', { why: b })}</span>
            </li>
          ))}
        </ul>
      )}
      {c.rules.map((r) => (
        <div key={r.short} className="faint mt-1.5 text-[14px]" title={t(r.text)}>
          {t('Rule: {r}', { r: t(r.short) })}
        </div>
      ))}
      <details className="mt-2">
        <summary className="muted flex cursor-pointer items-center gap-1 text-[14px]">
          <Lightbulb size={14} />
          {t('Hint')}
        </summary>
        <Prose text={t(c.hint)} space="mt-1" className="muted text-[14px]" />
      </details>
    </div>
  );
}

const PRACTICE_KIND: Record<PracticeLink['kind'], string> = { oncall: tx('On-call practice'), constraint: tx('Constraint problem'), brief: tx('Design from requirements') };
function practiceTitle(p: PracticeLink): string {
  const x = p.kind === 'oncall' ? INCIDENT_BY_ID[p.id] : p.kind === 'constraint' ? PROBLEM_BY_ID[p.id] : BRIEF_BY_ID[p.id];
  return x ? t(x.title) : p.id;
}

/** One finished run, with the example and scenario the frame had open. */
interface Ran {
  ctx: Ctx;
  run: RunData;
  /** The questions it answers (runState.ts). */
  answers: string[];
  /** The page it started on. */
  page: number;
}

/**
 * The guesses the simulator gets on page `i`: those a run started there answers, not those a run
 * already answered (a new frame, after a reload or the lesson opened again, would log them a
 * second time).
 */
const openGuesses = (lesson: Lesson, pages: Page[], i: number, p: LessonProgress): Record<string, string> => {
  const ids = answerable(lesson, pages, i, ctxOf(lesson, pages, i), p.guesses);
  return Object.fromEntries(Object.entries(p.guesses).filter(([q]) => ids.includes(q) && !p.answered.includes(q)));
};

function LessonView({ entry, lesson, progress, update, lang, theme, openLesson, home, charts, openCharts }: {
  entry: CourseLesson;
  lesson: Lesson;
  progress: LessonProgress;
  update: (p: LessonProgress) => void;
  lang: Lang;
  theme: Theme;
  openLesson: (id: string) => void;
  home: () => void;
  /** The charts under the simulator's canvas are on (the Charts toggle in the top bar). */
  charts: boolean;
  /** A step that shows what changes over time opens them (look.panel; not saved). */
  openCharts: () => void;
}) {
  const pages = useMemo(() => pagesOf(lesson), [lesson]);
  const i = clampStep(progress.step, pages);
  const page = pages[i];
  const ctx = ctxOf(lesson, pages, i);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The frame and its runs, as the table in runState.ts says. `status` and `started` show it. */
  const rs = useRef<RunState>(INITIAL);
  const [status, setStatus] = useState<Status>('loading');
  /** The simulated time of the run that goes, from the frame's status (null when none goes). */
  const [clock, setClock] = useState<Clock | null>(null);
  /** True while "Skip to end" is computing ahead in chunks. */
  const [finishing, setFinishing] = useState(false);
  /** The latest run of each example and scenario, in this visit. */
  const [runs, setRuns] = useState<Record<string, RunData>>({});
  /** The last two finished runs in this visit, with the page each started on: a run or try step shows the last one, next to the one before it. */
  const [pageRuns, setPageRuns] = useState<PageRuns<RunData>>({ pages: {} });
  /** The page each of those runs started on (a challenge judges only a run started on its page). */
  const [runPages, setRunPages] = useState<Record<string, number>>({});
  const [reload, setReload] = useState(0);
  /** Whether a try step patched the design on the current simulator frame (reset before challenges). */
  const tryPatched = useRef(false);
  /** Challenge auto-reset queued until the iframe is idle/done and replies with `kind: 'reset'`. */
  const pendingReset = useRef(false);
  const resetInFlight = useRef(false);
  const [autoResetNote, setAutoResetNote] = useState(false);
  /** Questions a run started in this visit answers: their guesses are locked (the simulator's guess log keeps the guesses a run starts with). */
  const [started, setStarted] = useState<string[]>([]);
  const isLocked = (q: Question) => progress.answered.includes(q.id) || started.includes(q.id);
  /** The latest run in this visit that answers each question (it started on a page after the question's guess). */
  const [answerRuns, setAnswerRuns] = useState<Record<string, RunData>>({});
  /** Example designs and scenarios as they ship, by name: challenges are judged against them. */
  const [designs, setDesigns] = useState<Record<string, Design>>({});
  const [scenarios, setScenarios] = useState<Record<string, Scenario>>({});
  const latest = useRef({ progress, ctx, lang, theme, i, charts });
  latest.current = { progress, ctx, lang, theme, i, charts };

  useEffect(() => {
    let live = true;
    const ex = [lesson.example, ...(lesson.extraExamples ?? [])];
    const sc = [...new Set([lesson.scenario, ...[...lesson.questions, ...lesson.challenges].map((x) => runOf(lesson, x).scenario)])];
    void Promise.all([Promise.all(ex.map(loadExample)), Promise.all(sc.map(loadScenario))]).then(([ds, ss]) => {
      if (!live) return;
      setDesigns(Object.fromEntries(ex.flatMap((e, k) => (ds[k] ? [[e, ds[k]!]] : []))));
      setScenarios(Object.fromEntries(sc.flatMap((s, k) => (ss[k] ? [[s, ss[k]!]] : []))));
    });
    return () => {
      live = false;
    };
  }, [lesson]);

  /** A challenge's verdict on its run, when that run used the challenge's scenario. */
  const verdictOf = (c: Challenge): Verdict | null => {
    const r = runOf(lesson, c);
    const key = ctxKey(r);
    const run = runPages[key] !== undefined && judgedOn(pages, runPages[key], c.id) ? runs[key] : undefined;
    const want = scenarios[r.scenario];
    const original = designs[r.example];
    return run && want && original && sameScenario(run.scenario, want) ? judge(c, run, original) : null;
  };

  const go = (n: number) => {
    const p = latest.current.progress;
    const k = clampStep(n, pages);
    update({ ...p, step: k, reached: Math.max(p.reached, k), done: p.done || pages[k].kind === 'done' });
  };

  // a finished run answers the questions guessed before the page it started on, and is judged
  const onRun = (r: Ran) => {
    const key = ctxKey(r.ctx);
    const all = { ...runs, [key]: r.run };
    setRuns(all);
    setRunPages((x) => ({ ...x, [key]: r.page }));
    setPageRuns((x) => addRun(x, r.page, r.run));
    const p = latest.current.progress;
    const ids = r.answers;
    const answered = lesson.questions.filter((q) => ids.includes(q.id));
    setAnswerRuns((a) => ({ ...a, ...Object.fromEntries(ids.map((id) => [id, r.run])) }));
    // the right answers are kept with the progress (the score survives a reload, which has no
    // runs); the first run's answer stays
    update(withAnswers(p, Object.fromEntries(answered.map((q) => [q.id, q.answer(r.run)]))));
  };
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // the passed challenges are saved
  useEffect(() => {
    const now = lesson.challenges.filter((c) => verdictOf(c)?.passed).map((c) => c.id);
    const p = latest.current.progress;
    if (now.some((id) => !p.passed.includes(id))) update({ ...p, passed: [...new Set([...p.passed, ...now])] });
  });

  const send = (msg: FromCourse) => frame.current?.contentWindow?.postMessage(msg, location.origin);
  /** The guesses a run started on the current page answers, with the course lesson (the simulator's guess log records them under it). */
  const sendGuesses = (p = latest.current.progress) => send({ source: 'loadsketch-course', kind: 'guesses', lesson: entry.id, guesses: openGuesses(lesson, pages, latest.current.i, p) });
  /** One event through the table: the new state shows, and its sends go out. */
  const dispatch = (e: RunEvent, p?: LessonProgress) => {
    const r = runStep(rs.current, e, (page) => answerable(lesson, pages, page, latest.current.ctx, latest.current.progress.guesses));
    rs.current = r.state;
    setStatus(r.state.frame);
    setStarted(r.state.locked);
    if (r.send) sendGuesses(p);
    return r;
  };
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const msg = e.data as ToCourse | null;
      const here = latest.current.ctx;
      // routed by the frame's lesson context (its address), which stays when the learner opens or
      // pastes another design there
      if (!msg || msg.source !== 'loadsketch-app' || msg.ctx?.example !== here.example || msg.ctx.scenario !== here.scenario) return;
      const d = dispatchRef.current;
      if (msg.kind === 'ready') {
        send({ source: 'loadsketch-course', kind: 'look', theme: latest.current.theme, lang: latest.current.lang });
        // a new frame takes the charts choice; on a phone the drawer stays closed until asked (a
        // step that opens the charts asks); and the step's look, which a loading frame missed
        const here = pages[latest.current.i];
        send({ source: 'loadsketch-course', kind: 'panels', bottom: latest.current.charts, ...(opensCharts(here) ? { show: true } : {}) });
        const f = lookOf(here);
        if (f) send({ source: 'loadsketch-course', kind: 'focus', ...f });
        setFinishing(false);
        d({ kind: 'ready' });
      } else if (msg.kind === 'status') {
        setClock(typeof msg.atS === 'number' && typeof msg.ofS === 'number' ? { atS: msg.atS, ofS: msg.ofS } : null);
        setFinishing(!!msg.finishing);
        // the clock ticks repeat the status: only a new status goes through the table
        if ((msg.status === 'idle' || msg.status === 'running' || msg.status === 'paused' || msg.status === 'done') && msg.status !== rs.current.frame) d({ kind: 'status', status: msg.status, page: latest.current.i });
      } else if (msg.kind === 'loaded') {
        setFinishing(false);
        d({ kind: 'loaded' });
      } else if (msg.kind === 'reset') {
        tryPatched.current = false;
        resetInFlight.current = false;
        if (pendingReset.current) {
          pendingReset.current = false;
          setAutoResetNote(true);
        }
      } else if (msg.kind === 'run') {
        setFinishing(false);
        const answers = d({ kind: 'finished', page: latest.current.i }).answer ?? [];
        onRunRef.current({ ctx: here, run: msg.run, answers, page: rs.current.runPage ?? latest.current.i });
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  // the guesses lock when the simulator says the run started (status 'running'), not here: it
  // refuses a design that does not pass its checks, and then no run starts
  const startRun = () => {
    setFinishing(false);
    if (takesGuesses(rs.current)) sendGuesses();
    send({ source: 'loadsketch-course', kind: 'run' });
  };
  const skipRun = () => {
    setFinishing(true);
    send({ source: 'loadsketch-course', kind: 'skip' });
  };
  // a page's guesses go to the simulator when the page opens: a run started there answers them
  useEffect(() => void dispatch({ kind: 'page' }), [i]);
  // a step about what changes over time opens the charts; a step's look points the simulator;
  // entering a challenge step after earlier try-step patches queues a reset until the iframe can accept it
  useEffect(() => {
    if (page.kind === 'challenge' && tryPatched.current) {
      pendingReset.current = true;
    } else if (page.kind !== 'challenge') {
      pendingReset.current = false;
      resetInFlight.current = false;
      setAutoResetNote(false);
    }
    if (opensCharts(page) && !charts) openCharts();
    const f = lookOf(page);
    if (f) send({ source: 'loadsketch-course', kind: 'focus', ...f });
  }, [i]);
  // deliver a queued challenge auto-reset only when the iframe is idle or done; retry if it was busy
  useEffect(() => {
    if (status === 'running' || status === 'paused' || status === 'loading') {
      resetInFlight.current = false;
      return;
    }
    if (page.kind === 'challenge' && pendingReset.current && !resetInFlight.current) {
      resetInFlight.current = true;
      send({ source: 'loadsketch-course', kind: 'reset' });
    }
  }, [i, status, page.kind]);
  // the toggle (or such a step) opens or closes them now, on a phone as the charts drawer
  const chartsSent = useRef(charts);
  useEffect(() => {
    if (chartsSent.current === charts) return;
    chartsSent.current = charts;
    send({ source: 'loadsketch-course', kind: 'panels', bottom: charts, show: true });
  }, [charts]);
  const guess = (q: string, o: string) => {
    const qq = lesson.questions.find((x) => x.id === q);
    if (!qq || isLocked(qq)) return;
    const guesses = { ...progress.guesses, [q]: o };
    update({ ...progress, guesses });
    dispatch({ kind: 'guess' }, { ...progress, guesses });
  };
  const restart = () => {
    update({ ...EMPTY });
    setRuns({});
    setRunPages({});
    setPageRuns({ pages: {} });
    setAnswerRuns({});
    dispatch({ kind: 'restart' });
    setReload((r) => r + 1);
  };

  // A new theme or language goes to the frame as a message: a new address would reload it and lose
  // the learner's changes. The address only takes them when the frame loads anyway (a new run).
  const look = useRef({ lang, theme, at: '' });
  if (look.current.at !== `${ctxKey(ctx)}#${reload}`) look.current = { lang, theme, at: `${ctxKey(ctx)}#${reload}` };
  useEffect(() => {
    send({ source: 'loadsketch-course', kind: 'look', theme, lang });
  }, [theme, lang]);
  // a new address is a new frame: the old frame and its run are gone
  const frameKey = `${ctxKey(ctx)}#${reload}`;
  const firstFrame = useRef(frameKey);
  useEffect(() => {
    if (frameKey !== firstFrame.current) {
      tryPatched.current = false;
      pendingReset.current = false;
      resetInFlight.current = false;
      setAutoResetNote(false);
      setFinishing(false);
      dispatch({ kind: 'gone' });
    }
    firstFrame.current = frameKey;
  }, [frameKey]);
  const q = new URLSearchParams({ embed: '1', course: '1', example: ctx.example, scenario: ctx.scenario, lang: look.current.lang, theme: look.current.theme });
  // The settings panel on the right; no charts under the canvas: the frame is too short for both.
  // phone=1: a frame as narrow as a phone shows the phone layout instead. The frame decides with
  // its own width and the simulator's breakpoint (src/app/phone.ts), so both always agree.
  q.set('panels', 'right');
  q.set('phone', '1');
  const speed = new URLSearchParams(location.search).get('speed');
  if (speed) q.set('speed', speed);
  const src = `${APP}?${q.toString()}`;
  // a new example or scenario loads in the frame: wait for it
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setStatus('loading');
  }
  const next = nextReady(entry.id);
  const qs = (ids: string[]) => ids.flatMap((id) => lesson.questions.filter((x) => x.id === id));
  const cs = (ids: string[]) => ids.flatMap((id) => lesson.challenges.filter((x) => x.id === id));
  /** Questions whose answers this run or try page shows (guessed since the last run or try page). */
  const askedHere = qs(feedbackOf(lesson, pages, i));
  // each answer comes from a run of its own experiment: a run started before the guess (the same
  // example and scenario, the design not changed yet) does not answer it
  const answeredHere = askedHere.filter((x) => answerRuns[x.id]);
  const answers = (run: RunData | undefined) =>
    answeredHere.length > 0 ? (
      <div className="mt-5" data-testid="course-answers">
        {answeredHere.map((x) => (
          <Answer key={x.id} q={x} run={answerRuns[x.id]} mine={progress.guesses[x.id]} scored={progress.answers[x.id]} />
        ))}
        <div className="faint mt-5 text-[14px]">{t('What happened, second by second, is under "Results" in the simulator.')}</div>
      </div>
    ) : (
      run && <p className="faint mt-2 text-[14px]">{t('What happened, second by second, is under "Results" in the simulator.')}</p>
    );
  const prevExpStep = useMemo(() => {
    if (page.kind !== 'try') return null;
    const key = ctxKey(ctx);
    for (let k = i - 1; k >= 0; k--) {
      if ((pages[k].kind === 'run' || pages[k].kind === 'try') && ctxKey(ctxOf(lesson, pages, k)) === key) return k;
    }
    return null;
  }, [lesson, pages, i, page.kind, ctx]);
  /** Matching run from the previous experiment step (same ctx + matching patch & scenario), used as the comparison baseline on a try step. */
  const prevBaseline = useMemo(() => {
    if (prevExpStep === null) return undefined;
    return tryBaseline(pages[prevExpStep], pageRuns.pages[prevExpStep]?.run, page, pageRuns.pages[i]?.run, scenarios[ctx.scenario]);
  }, [prevExpStep, pageRuns, pages, page, i, scenarios, ctx.scenario]);
  /** The last run started on this step, next to its baseline (previous experiment step on a try step, else the run before it). */
  const measuredHere = (show: string[] | undefined) => {
    const here = pageRuns.pages[i];
    if (!here) return null;
    const before = prevExpStep !== null ? prevBaseline : here.before;
    return <Measured rows={readings(show, here.run, before)} />;
  };
  // an answer that shows points where to look (the first answered question with a look)
  const lookAt = answeredHere.map((x) => lookOf(x)).find((f) => f);
  const lookKey = lookAt ? JSON.stringify(lookAt) + answeredHere.map((x) => x.id).join() : '';
  useEffect(() => {
    if (lookAt) send({ source: 'loadsketch-course', kind: 'focus', ...lookAt });
  }, [lookKey]);
  const score = scoreOf(
    lesson.questions.map((x) => x.id),
    progress,
  );

  let body: React.ReactNode;
  switch (page.kind) {
    case 'read':
      body = (
        <>
          <Prose text={t(page.text)} className="text-[16px]" />
          {page.key && (
            <div className="course-key mt-3" data-testid="course-key">
              <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide">
                <KeyRound size={13} />
                {t('Key idea')}
              </div>
              <Prose text={t(page.key)} className="text-[16px]" />
            </div>
          )}
          {i === 0 && <p className="course-prose muted mt-3 text-[15px]">{t('How a lesson goes: guess the answers first, then run the simulator. The answers are read from that run. Then change the design to pass the challenges.')}</p>}
        </>
      );
      break;
    case 'guess':
      body = (
        <div className="space-y-5">
          {qs(page.questions).map((qq) => {
            const mine = progress.guesses[qq.id];
            const locked = isLocked(qq);
            return (
              <div key={qq.id} data-testid={`course-guess-${qq.id}`}>
                <div className="text-[16px] leading-relaxed">{t(qq.text)}</div>
                <div className="mt-2 flex flex-col gap-1.5" role="radiogroup">
                  {qq.options.map((o) => (
                    <button
                      key={o.id}
                      role="radio"
                      aria-checked={mine === o.id}
                      className={`btn course-option justify-start text-left ${mine === o.id ? 'btn-on' : ''}`}
                      onClick={() => guess(qq.id, o.id)}
                      disabled={locked}
                      data-testid={`course-option-${qq.id}-${o.id}`}
                    >
                      {t(o.text)}
                    </button>
                  ))}
                </div>
                {locked && <div className="faint mt-1.5 text-[14px]">{t('A run has started with this guess: the guess is locked. Start the lesson again to guess again.')}</div>}
              </div>
            );
          })}
          <div className="faint text-[14px]">{t('Pick one for each. The answers show after the run.')}</div>
        </div>
      );
      break;
    case 'run': {
      const run = runs[ctxKey(ctx)];
      body = (
        <>
          <Prose text={page.text ? t(page.text) : t('Press Run. The simulator sends the traffic of the lesson\'s scenario through the design. You can also press Run in the simulator itself, or jump to the end there.')} className="text-[16px]" />
          {!run && askedHere.some((x) => !progress.guesses[x.id]) && <p className="muted mt-2 text-[14px]">{t('Some questions have no guess yet. Go back to guess, or run without one.')}</p>}
          <RunButton status={status} clock={clock} finishing={finishing} onRun={startRun} onSkip={skipRun} />
          {measuredHere(page.show)}
          {answers(run)}
        </>
      );
      break;
    }
    case 'try': {
      const prev = prevExpStep !== null ? pages[prevExpStep] : null;
      const prevTitle = prev ? (prev.kind !== 'done' && prev.title ? t(prev.title) : pageLabel(prev)) : '';
      body = (
        <>
          {prevExpStep !== null && !prevBaseline && (
            <div className="card mb-3 p-3 text-[14px]" data-testid="course-resume-note">
              <p className="muted">
                {t('The simulator reloaded its starting design, so your earlier run (and any previous step’s change) is not here to compare against.')}
              </p>
              <button type="button" className="btn mt-2" onClick={() => go(prevExpStep)} data-testid="course-resume-back">
                <ArrowLeft size={14} />
                {t('Go back to "{title}"', { title: prevTitle })}
              </button>
            </div>
          )}
          <Prose text={t(page.text)} className="text-[16px]" />
          {page.patch && page.patch.length > 0 && (
            <button
              className="btn mt-3"
              onClick={() => {
                tryPatched.current = true;
                send({ source: 'loadsketch-course', kind: 'patch', patches: page.patch! });
                // then the simulator shows the change: the node selected, centred, its settings open
                const f = patchFocus(page);
                if (f) send({ source: 'loadsketch-course', kind: 'focus', ...f });
              }} disabled={status === 'running' || status === 'paused' || status === 'loading'} data-testid="course-patch">
              <Wrench size={14} />
              {t('Make this change in the simulator')}
            </button>
          )}
          <RunButton status={status} clock={clock} finishing={finishing} onRun={startRun} onSkip={skipRun} />
          {measuredHere(page.show)}
          {answers(runs[ctxKey(ctx)])}
        </>
      );
      break;
    }
    case 'challenge':
      body = (
        <>
          <div className="faint mb-3 text-[14px]">{t('Change the design in the simulator (click a component or a connection to change its settings), then press Run. Each finished run is judged.')}</div>
          {autoResetNote && (
            <div className="faint mb-3 text-[13.5px]" data-testid="course-reset-note">
              {t('Restored to the starting design so earlier try-step changes do not interfere with the challenges.')}
            </div>
          )}
          <div className="space-y-3">
            {cs(page.challenges).map((c) => (
              <ChallengeCard key={c.id} c={c} verdict={verdictOf(c)} passed={progress.passed.includes(c.id)} />
            ))}
          </div>
          {runs[ctxKey(ctx)] && runPages[ctxKey(ctx)] === i && scenarios[ctx.scenario] && !sameScenario(runs[ctxKey(ctx)].scenario, scenarios[ctx.scenario]) && (
            <div className="mt-2 text-[14px]" style={{ color: 'var(--warn-ink)' }}>{t('The scenario was changed. Switch back to "{name}" for the challenges to count.', { name: t(scenarios[ctx.scenario].name ?? ctx.scenario) })}</div>
          )}
          <RunButton
            status={status}
            clock={clock}
            finishing={finishing}
            onRun={startRun}
            onSkip={skipRun}
            extra={
              <button
                className="btn"
                onClick={() => {
                  tryPatched.current = false;
                  pendingReset.current = false;
                  resetInFlight.current = false;
                  setAutoResetNote(false);
                  send({ source: 'loadsketch-course', kind: 'reset' });
                }}
                disabled={status === 'running' || status === 'paused' || status === 'loading'}
                title={t('Restore this step’s original design and scenario')}
                data-testid="course-reset"
              >
                <RotateCcw size={14} />
                {t('Reset design')}
              </button>
            }
          />
        </>
      );
      break;
    case 'practice':
      body = (
        <>
          <Prose text={page.text ? t(page.text) : t('To practise what this lesson showed, try these problems in the simulator, under "Practice".')} className="text-[16px]" />
          <ul className="mt-3 space-y-1.5 text-[15px]">
            {page.items.map((p) => (
              <li key={`${p.kind}:${p.id}`} className="flex flex-wrap gap-x-2">
                <span className="faint">{t(PRACTICE_KIND[p.kind])}</span>
                <span>{practiceTitle(p)}</span>
              </li>
            ))}
          </ul>
          <a className="btn mt-3" href={APP}>
            {t('Open the simulator')}
          </a>
        </>
      );
      break;
    case 'done':
      body = (
        <div data-testid="course-finish">
          <p className="text-[16px] leading-relaxed">{t('You finished this lesson.')}</p>
          {lesson.recap && lesson.recap.length > 0 && (
            <div className="card mt-3 p-3" data-testid="course-recap">
              <div className="faint text-[14px]">{t('To remember')}</div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[15px] leading-relaxed">
                {lesson.recap.map((r, k) => (
                  <li key={k}>{t(r)}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className="muted mt-2 space-y-1 text-[15px]">
            {lesson.questions.length > 0 && (
              <li data-testid="course-score" data-right={score.right}>
                {t('Guesses right: {n} of {all}', { n: score.right, all: lesson.questions.length })}
              </li>
            )}
            {score.unscored > 0 && <li>{t('{n} answered guesses have no saved score. Start the lesson again to score them.', { n: score.unscored })}</li>}
            {lesson.challenges.length > 0 && <li>{t('Challenges passed: {n} of {all}', { n: lesson.challenges.filter((c) => progress.passed.includes(c.id)).length, all: lesson.challenges.length })}</li>}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            {next ? (
              <button className="btn btn-primary" onClick={() => openLesson(next.id)} data-testid="course-next-lesson">
                {t('Next lesson: {id} {title}', { id: next.id, title: t(next.title) })}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={home}>
                {t('Back to all lessons')}
              </button>
            )}
            <button className="btn" onClick={restart} data-testid="course-restart">
              <RotateCcw size={14} />
              {t('Start the lesson again')}
            </button>
          </div>
        </div>
      );
      break;
  }

  const ticks = learnTicks(lesson, progress.reached);
  const upNext = nextTitle(pages, i);
  const unguessed = page.kind === 'guess' && qs(page.questions).some((x) => !progress.guesses[x.id] && !progress.answered.includes(x.id));
  return (
    <div className="course-lesson" data-testid="course-lesson">
      <section className="course-steps" aria-label={t('Lesson')}>
        <div className="course-steps-in">
          <div className="faint num text-[14px]">{t('Lesson {id} · {m} min', { id: entry.id, m: entry.minutes })}</div>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight">{t(entry.title)}</h1>
          <ol className="course-dots mt-3" aria-label={t('Steps')}>
            {pages.map((p, k) => (
              <li key={k}>
                <button
                  className="course-dot"
                  data-at={k === i || undefined}
                  data-seen={k <= progress.reached || undefined}
                  disabled={k > progress.reached}
                  onClick={() => go(k)}
                  aria-current={k === i ? 'step' : undefined}
                  aria-label={t('Step {n}: {name}', { n: k + 1, name: pageLabel(p) })}
                  title={pageLabel(p)}
                />
              </li>
            ))}
          </ol>
          <div className="muted mt-2 text-[14px]" data-testid="course-step" data-step={`${i}:${page.kind}`}>
            {t('Step {n} of {all}: {name}', { n: i + 1, all: pages.length, name: pageLabel(page) })}
          </div>
          {lesson.learn && lesson.learn.length > 0 && (
            <details className="course-learn mt-3" open={i === 0 || undefined} key={i === 0 ? 'first' : 'later'} data-testid="course-learn">
              <summary className="text-[14px] font-medium">
                {t('What this lesson teaches')} <span className="faint num">{t('{n} of {all}', { n: ticks.filter(Boolean).length, all: ticks.length })}</span>
              </summary>
              <ul className="mt-1.5 space-y-1 text-[15px]">
                {lesson.learn.map((l, k) => (
                  <li key={k} className="flex gap-1.5" data-ticked={ticks[k] || undefined}>
                    {ticks[k] ? <Check size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--ok-ink)' }} /> : <Circle size={16} className="faint mt-0.5 shrink-0" />}
                    <span className={ticks[k] ? 'muted' : undefined}>{t(l)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {lesson.terms && lesson.terms.length > 0 && (
            <details className="course-terms card mt-3" data-testid="course-terms">
              <summary className="course-terms-sum text-[14px] font-medium">
                {t('New terms in this lesson')} <span className="faint num">{lesson.terms.length}</span>
              </summary>
              <dl className="course-terms-list">
                {lesson.terms.map((item, k) => (
                  <div key={k} className="course-term">
                    <dt className="font-semibold">{t(item.term)}</dt>
                    <dd className="course-term-plain">{t(item.plain)}</dd>
                    {item.example && (
                      <dd className="course-term-example muted">
                        {t('Example: {text}', { text: t(item.example) })}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </details>
          )}
          <div className="mt-4">{body}</div>
          <div className="mt-6 flex gap-2">
            <button className="btn" onClick={() => go(i - 1)} disabled={i === 0} data-testid="course-back">
              <ArrowLeft size={14} />
              {t('Back')}
            </button>
            {page.kind !== 'done' && (
              <button className="btn btn-primary" onClick={() => go(i + 1)} data-testid="course-next">
                {unguessed ? t('Skip') : upNext ? t('Next: {title}', { title: t(upNext) }) : t('Next@@step')}
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="course-frame" aria-label={t('Simulator')}>
        <iframe key={`${src}#${reload}`} ref={frame} src={src} title={t('Simulator')} data-testid="course-frame" />
        {status === 'loading' && (
          <div className="course-frame-skeleton" role="status" aria-busy="true" aria-label={t('The simulator is loading…')} data-testid="course-frame-skeleton">
            <div className="course-skel-canvas">
              <div className="course-skel-graph">
                <div className="course-skel-node" />
                <div className="course-skel-edge" />
                <div className="course-skel-node" />
                <div className="course-skel-edge" />
                <div className="course-skel-node" />
              </div>
              <div className="course-skel-bar">
                <div className="course-skel-pill w-20" />
                <div className="course-skel-pill w-28" />
                <div className="course-skel-pill w-16" />
              </div>
            </div>
            <div className="course-skel-side">
              <div className="course-skel-tabs">
                <div className="course-skel-line w-12" />
                <div className="course-skel-line w-14" />
                <div className="course-skel-line w-12" />
              </div>
              <div className="course-skel-line mt-4 w-3/4" />
              <div className="course-skel-line mt-2.5 w-full" />
              <div className="course-skel-line mt-2 w-5/6" />
              <div className="course-skel-block mt-5" />
              <div className="course-skel-block mt-3" />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Course() {
  const [lang, setL] = useState<Lang>(initialLang);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [progress, setProgress] = useState<Progress>(loadProgress);
  // the charts under the simulator's canvas: the toggle saves its choice; a step that opens them
  // (look.panel) does not
  const [charts, setChartsOn] = useState(savedCharts);
  const setCharts = useCallback((on: boolean, keep = true) => {
    if (keep) save(CHARTS_KEY, on ? '1' : '0');
    setChartsOn(on);
  }, []);
  const [id, go] = useRoute();
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  setLang(lang);
  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  }, [lang]);
  const entry = findLesson(id);
  const lesson = entry?.lesson;
  useEffect(() => {
    document.title = entry && lesson ? t('{id} {title} · loadsketch course', { id: entry.id, title: t(entry.title) }) : t('loadsketch course');
  }, [entry, lesson, lang]);
  const flipLang = () => {
    const l: Lang = lang === 'en' ? 'zh-TW' : 'en';
    save('loadsketch-lang', l);
    setL(l);
  };
  const flipTheme = () => {
    const th: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', th === 'dark');
    save('loadsketch-theme', th);
    setTheme(th);
  };
  // Another tab may have saved since this one loaded: read the saved progress before writing, and
  // follow what other tabs save (the storage event), so no tab erases another's lessons.
  // A lesson this tab could not save (full storage) keeps its progress here: the stored one is older.
  const unsaved = useRef(new Set<string>());
  const update = useCallback((lessonId: string, p: LessonProgress) => {
    setProgress((all) => {
      const next = { ...mergeStored(all, loadProgress(), unsaved.current), [lessonId]: p };
      if (saveProgress(next)) unsaved.current.clear();
      else unsaved.current.add(lessonId);
      return next;
    });
  }, []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROGRESS_KEY) setProgress((all) => mergeStored(all, loadProgress(), unsaved.current));
    };
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
  }, []);
  return (
    <div className="course-page">
      <Bar
        lang={lang}
        theme={theme}
        onLang={flipLang}
        onTheme={flipTheme}
        onHome={entry && lesson ? () => go(null) : null}
        onGlossary={() => setGlossaryOpen(true)}
        charts={entry && lesson ? { on: charts, toggle: () => setCharts(!charts) } : null}
      />
      {entry && lesson ? (
        <LessonView
          key={entry.id}
          entry={entry}
          lesson={lesson}
          progress={progress[entry.id] ?? EMPTY}
          update={(p) => update(entry.id, p)}
          lang={lang}
          theme={theme}
          openLesson={go}
          home={() => go(null)}
          charts={charts}
          openCharts={() => setCharts(true, false)}
        />
      ) : (
        <Catalog progress={progress} open={go} />
      )}
      {glossaryOpen && <GlossaryDialog onClose={() => setGlossaryOpen(false)} onOpenLesson={go} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Course />
  </StrictMode>,
);
