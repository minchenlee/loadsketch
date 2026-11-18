// The course page (/learn/): the table of contents, and one lesson at a time. A lesson is steps on
// the left (read, guess, run, see the answers, the challenges) and the simulator on the right: the
// app in an iframe with ?embed=1&course=1, which tells this page about every run
// (src/app/courseBridge.ts). Every answer and verdict is read from that run. Progress is kept in
// this browser (src/course/progress.ts).
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowRight, ChartLine, CircleCheck, CircleX, Languages, Lightbulb, Moon, Play, RotateCcw, Sun, Trophy, Wrench } from 'lucide-react';
import '../app/index.css';
import './course.css';
import logoBlack from '../app/assets/logo-black.svg';
import logoWhite from '../app/assets/logo-white.svg';
import { pickLang, setLang, t, tx, type Lang } from '../i18n/index.ts';
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
import { answerable, judgedOn, opensCharts, clampStep, ctxKey, ctxOf, feedbackOf, pagesOf, type Ctx, type Page } from './steps.ts';
import { loadExample, loadScenario } from './examples.ts';
import { readings, type Row } from './measures.ts';

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

function Bar({ lang, theme, onLang, onTheme, onHome, charts }: { lang: Lang; theme: Theme; onLang: () => void; onTheme: () => void; onHome: (() => void) | null; charts: { on: boolean; toggle: () => void } | null }) {
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
  return (
    <main className="course-wrap pb-16 pt-8" data-testid="course-catalog">
      <h1 className="text-[28px] font-semibold leading-tight sm:text-[34px]">{t('Learn system design by running it')}</h1>
      <p className="muted mt-3 max-w-[680px] text-[16px] leading-relaxed">
        {t('Each lesson opens a design in the simulator. Guess what happens, run it, read why, then change the design and run it again. Every number comes from the simulation, not from the text.')}
      </p>
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

function RunButton({ status, onRun }: { status: Status; onRun: () => void }) {
  const busy = status === 'running' || status === 'paused' || status === 'loading';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" onClick={onRun} disabled={busy} data-testid="course-run">
        <Play size={14} />
        {t('Run')}
      </button>
      <span className="faint text-[14px]" data-testid="course-status" data-status={status}>
        {status === 'loading' ? t('The simulator is loading…') : status === 'running' ? t('Running…') : status === 'paused' ? t('Paused in the simulator') : status === 'done' ? t('The run ended.') : ''}
      </span>
    </div>
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
    <div data-testid={`course-answer-${q.id}`} data-right={mine === answer || undefined}>
      <div className="text-[15px] leading-snug">{t(q.text)}</div>
      <div className="mt-1.5 flex gap-1.5 text-[15px] font-medium">
        {mine === undefined ? null : mine === answer ? <CircleCheck size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
        <span>{mine === undefined ? t('Measured: {m}', { m: q.measured(run) }) : mine === answer ? t('Right. Measured: {m}', { m: q.measured(run) }) : t('Not quite. Measured: {m}', { m: q.measured(run) })}</span>
      </div>
      {guess && mine !== answer && <div className="muted mt-0.5 text-[14px]">{t('Your guess: {g}', { g: t(guess.text) })}</div>}
      {right && <div className="muted mt-0.5 text-[14px]">{t('Answer: {a}', { a: t(right.text) })}</div>}
      <div className="mt-1 text-[15px] leading-relaxed">{t(q.explainFor?.[answer] || q.explain)}</div>
      {first && (
        <div className="faint mt-1 text-[14px]" data-testid={`course-scored-${q.id}`}>
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
          <div key={r.key} className="flex flex-wrap items-baseline justify-between gap-x-3" data-measure={r.key} data-before={r.before !== undefined || undefined} data-change={r.change}>
            <dt className="text-[15px]">
              {r.label}
              {r.who && !r.key.startsWith('clientFail:') && <span className="faint"> · {r.who}</span>}
            </dt>
            <dd className="num text-[15px] font-medium">
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
      <div className="mt-1 text-[15px] leading-relaxed">{t(c.text)}</div>
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
        <div className="muted mt-1 text-[14px] leading-relaxed">{t(c.hint)}</div>
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
  /** The latest run of each example and scenario, in this visit. */
  const [runs, setRuns] = useState<Record<string, RunData>>({});
  /** The last two finished runs in this visit, with the page each started on: a run or try step shows the last one, next to the one before it. */
  const [lastRuns, setLastRuns] = useState<{ run: RunData; page: number }[]>([]);
  /** The page each of those runs started on (a challenge judges only a run started on its page). */
  const [runPages, setRunPages] = useState<Record<string, number>>({});
  const [reload, setReload] = useState(0);
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
    setLastRuns((x) => [...x.slice(-1), { run: r.run, page: r.page }]);
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
        // a new frame takes the charts choice; on a phone the drawer stays closed until asked
        send({ source: 'loadsketch-course', kind: 'panels', bottom: latest.current.charts });
        d({ kind: 'ready' });
      } else if (msg.kind === 'status') {
        if (msg.status === 'idle' || msg.status === 'running' || msg.status === 'paused' || msg.status === 'done') d({ kind: 'status', status: msg.status, page: latest.current.i });
      } else if (msg.kind === 'loaded') d({ kind: 'loaded' });
      else if (msg.kind === 'run') {
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
    if (takesGuesses(rs.current)) sendGuesses();
    send({ source: 'loadsketch-course', kind: 'run' });
  };
  // a page's guesses go to the simulator when the page opens: a run started there answers them
  useEffect(() => void dispatch({ kind: 'page' }), [i]);
  // a step about what changes over time opens the charts
  useEffect(() => {
    if (opensCharts(page) && !charts) openCharts();
  }, [i]);
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
    setLastRuns([]);
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
    if (frameKey !== firstFrame.current) dispatch({ kind: 'gone' });
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
      <div className="mt-5 space-y-4" data-testid="course-answers">
        {answeredHere.map((x) => (
          <Answer key={x.id} q={x} run={answerRuns[x.id]} mine={progress.guesses[x.id]} scored={progress.answers[x.id]} />
        ))}
        <div className="faint text-[14px]">{t('What happened, second by second, is under "Results" in the simulator.')}</div>
      </div>
    ) : (
      run && <p className="faint mt-2 text-[14px]">{t('What happened, second by second, is under "Results" in the simulator.')}</p>
    );
  /** The run started on this step, next to the run before it (in this visit, whatever it ran). */
  const measuredHere = (show: string[] | undefined) => {
    const now = lastRuns[lastRuns.length - 1];
    if (!now || now.page !== i) return null;
    const before = lastRuns.length > 1 ? lastRuns[0].run : undefined;
    return <Measured rows={readings(show, now.run, before)} />;
  };
  const score = scoreOf(
    lesson.questions.map((x) => x.id),
    progress,
  );

  let body: React.ReactNode;
  switch (page.kind) {
    case 'read':
      body = (
        <>
          <p className="text-[16px] leading-relaxed">{t(page.text)}</p>
          {i === 0 && <p className="muted mt-3 text-[15px] leading-relaxed">{t('How a lesson goes: guess the answers first, then run the simulator. The answers are read from that run. Then change the design to pass the challenges.')}</p>}
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
          <p className="text-[16px] leading-relaxed">{page.text ? t(page.text) : t('Press Run. The simulator sends the traffic of the lesson\'s scenario through the design. You can also press Run in the simulator itself, or jump to the end there.')}</p>
          {!run && askedHere.some((x) => !progress.guesses[x.id]) && <p className="muted mt-2 text-[14px]">{t('Some questions have no guess yet. Go back to guess, or run without one.')}</p>}
          <RunButton status={status} onRun={startRun} />
          {measuredHere(page.show)}
          {answers(run)}
        </>
      );
      break;
    }
    case 'try':
      body = (
        <>
          <p className="text-[16px] leading-relaxed">{t(page.text)}</p>
          {page.patch && page.patch.length > 0 && (
            <button className="btn mt-3" onClick={() => send({ source: 'loadsketch-course', kind: 'patch', patches: page.patch! })} disabled={status === 'running' || status === 'paused' || status === 'loading'} data-testid="course-patch">
              <Wrench size={14} />
              {t('Make this change in the simulator')}
            </button>
          )}
          <RunButton status={status} onRun={startRun} />
          {measuredHere(page.show)}
          {answers(runs[ctxKey(ctx)])}
        </>
      );
      break;
    case 'challenge':
      body = (
        <>
          <div className="faint mb-3 text-[14px]">{t('Change the design in the simulator (click a component or a connection to change its settings), then press Run. Each finished run is judged.')}</div>
          <div className="space-y-3">
            {cs(page.challenges).map((c) => (
              <ChallengeCard key={c.id} c={c} verdict={verdictOf(c)} passed={progress.passed.includes(c.id)} />
            ))}
          </div>
          {runs[ctxKey(ctx)] && runPages[ctxKey(ctx)] === i && scenarios[ctx.scenario] && !sameScenario(runs[ctxKey(ctx)].scenario, scenarios[ctx.scenario]) && (
            <div className="mt-2 text-[14px]" style={{ color: 'var(--warn-ink)' }}>{t('The scenario was changed. Switch back to "{name}" for the challenges to count.', { name: t(scenarios[ctx.scenario].name ?? ctx.scenario) })}</div>
          )}
          <RunButton status={status} onRun={startRun} />
        </>
      );
      break;
    case 'practice':
      body = (
        <>
          <p className="text-[16px] leading-relaxed">{page.text ? t(page.text) : t('To practise what this lesson showed, try these problems in the simulator, under "Practice".')}</p>
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
          <div className="mt-4">{body}</div>
          <div className="mt-6 flex gap-2">
            <button className="btn" onClick={() => go(i - 1)} disabled={i === 0} data-testid="course-back">
              <ArrowLeft size={14} />
              {t('Back')}
            </button>
            {page.kind !== 'done' && (
              <button className="btn btn-primary" onClick={() => go(i + 1)} data-testid="course-next">
                {unguessed ? t('Skip') : t('Next@@step')}
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="course-frame" aria-label={t('Simulator')}>
        <iframe key={`${src}#${reload}`} ref={frame} src={src} title={t('Simulator')} data-testid="course-frame" />
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
      <Bar lang={lang} theme={theme} onLang={flipLang} onTheme={flipTheme} onHome={entry && lesson ? () => go(null) : null} charts={entry && lesson ? { on: charts, toggle: () => setCharts(!charts) } : null} />
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
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Course />
  </StrictMode>,
);
