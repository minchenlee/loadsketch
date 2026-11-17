// The course page (/learn/): the table of contents, and one lesson at a time. A lesson is steps on
// the left (read, guess, run, see the answers, the challenges) and the simulator on the right: the
// app in an iframe with ?embed=1&course=1, which tells this page about every run
// (src/app/courseBridge.ts). Every answer and verdict is read from that run. Progress is kept in
// this browser (src/course/progress.ts).
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, Languages, Lightbulb, Moon, Play, RotateCcw, Sun, Trophy } from 'lucide-react';
import '../app/index.css';
import './course.css';
import logoBlack from '../app/assets/logo-black.svg';
import logoWhite from '../app/assets/logo-white.svg';
import { pickLang, setLang, t, type Lang } from '../i18n/index.ts';
import { judge, sameScenario, type Lesson, type Verdict } from '../learn/lesson.ts';
import type { RunData } from '../learn/metrics.ts';
import type { Design, Scenario } from '../schema/design.ts';
import type { FromCourse, ToCourse } from '../app/courseBridge.ts';
import { ALL_LESSONS, UNITS, findLesson, lessonOf, nextReady, type CourseLesson } from './catalog.ts';
import { EMPTY, loadProgress, saveProgress, type LessonProgress, type Progress } from './progress.ts';
import { clampStep, stepsOf, type Step } from './steps.ts';
import { loadExample, loadScenario } from './examples.ts';

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

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
  );
}

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

function Bar({ lang, theme, onLang, onTheme, onHome }: { lang: Lang; theme: Theme; onLang: () => void; onTheme: () => void; onHome: (() => void) | null }) {
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
  if (!lessonOf(l)) return 'soon';
  if (p?.done) return 'done';
  return p && (p.reached > 0 || Object.keys(p.guesses).length) ? 'started' : 'ready';
}

function StatePill({ s }: { s: State }) {
  if (s === 'soon') return <span className="sd-pill no-dot faint">{t('Coming soon')}</span>;
  const label = s === 'done' ? t('Done') : s === 'started' ? t('In progress') : t('Start');
  const color = s === 'done' ? 'var(--ok)' : s === 'started' ? 'var(--accent)' : 'var(--ink-3)';
  return (
    <span className="sd-pill" style={{ '--pill': color } as React.CSSProperties}>
      {label}
    </span>
  );
}

function Catalog({ progress, open }: { progress: Progress; open: (id: string) => void }) {
  const ready = ALL_LESSONS.filter((l) => lessonOf(l));
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

const stepLabel = (s: Step, lesson: Lesson): string => {
  switch (s.kind) {
    case 'intro':
      return t('Read@@step');
    case 'guess':
      return t('Guess {n}', { n: lesson.questions.indexOf(s.question) + 1 });
    case 'run':
      return t('Run');
    case 'answers':
      return t('Answers');
    case 'challenge':
      return t('Challenge {n}', { n: lesson.challenges.indexOf(s.challenge) + 1 });
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

function Answers({ lesson, run, guesses }: { lesson: Lesson; run: RunData; guesses: Record<string, string> }) {
  return (
    <div className="space-y-4">
      {lesson.questions.map((q) => {
        const answer = q.answer(run);
        const mine = guesses[q.id];
        const right = q.options.find((o) => o.id === answer);
        const guess = q.options.find((o) => o.id === mine);
        return (
          <div key={q.id} data-testid={`course-answer-${q.id}`} data-right={mine === answer || undefined}>
            <div className="text-[15px] leading-snug">{t(q.text)}</div>
            <div className="mt-1.5 flex gap-1.5 text-[15px] font-medium">
              {mine === undefined ? null : mine === answer ? <CircleCheck size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
              <span>{mine === undefined ? t('Measured: {m}', { m: q.measured(run) }) : mine === answer ? t('Right. Measured: {m}', { m: q.measured(run) }) : t('Not quite. Measured: {m}', { m: q.measured(run) })}</span>
            </div>
            {guess && mine !== answer && <div className="muted mt-0.5 text-[14px]">{t('Your guess: {g}', { g: t(guess.text) })}</div>}
            {right && <div className="muted mt-0.5 text-[14px]">{t('Answer: {a}', { a: t(right.text) })}</div>}
            <div className="mt-1 text-[15px] leading-relaxed">{t((q.explainFor?.[answer]) || q.explain)}</div>
          </div>
        );
      })}
      <div className="faint text-[14px]">{t('What happened, second by second, is under "Results" in the simulator.')}</div>
    </div>
  );
}

function ChallengeStep({ step, verdict, passed, scenarioOk, scenarioName }: { step: Extract<Step, { kind: 'challenge' }>; verdict: Verdict | null; passed: boolean; scenarioOk: boolean; scenarioName: string }) {
  const c = step.challenge;
  return (
    <div data-testid={`course-challenge-${c.id}`}>
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-semibold">{t(c.title)}</span>
        {passed && (
          <span className="flex items-center gap-1 text-[14px]" style={{ color: 'var(--ok-ink)' }} data-testid="course-passed">
            <Trophy size={14} />
            {t('Passed')}
          </span>
        )}
      </div>
      <div className="mt-1 text-[15px] leading-relaxed">{t(c.text)}</div>
      {c.rules.map((r) => (
        <div key={r.short} className="muted mt-1.5 text-[14px] leading-snug">
          <span className="font-medium">{t(r.short)}</span>
          {t(': {text}', { text: t(r.text) })}
        </div>
      ))}
      <div className="faint mt-2 text-[14px]">{t('Change the design in the simulator (click a component or a connection to change its settings), then press Run. Each finished run is judged.')}</div>
      {!scenarioOk && <div className="mt-2 text-[14px]" style={{ color: 'var(--warn-ink)' }}>{t('The scenario was changed. Switch back to "{name}" for the challenges to count.', { name: scenarioName })}</div>}
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
      <details className="mt-3">
        <summary className="muted flex cursor-pointer items-center gap-1 text-[14px]">
          <Lightbulb size={14} />
          {t('Hint')}
        </summary>
        <div className="muted mt-1 text-[14px] leading-relaxed">{t(c.hint)}</div>
      </details>
    </div>
  );
}

function LessonView({ entry, lesson, progress, update, lang, theme, openLesson, home }: {
  entry: CourseLesson;
  lesson: Lesson;
  progress: LessonProgress;
  update: (p: LessonProgress) => void;
  lang: Lang;
  theme: Theme;
  openLesson: (id: string) => void;
  home: () => void;
}) {
  const steps = useMemo(() => stepsOf(lesson), [lesson]);
  const i = clampStep(progress.step, steps);
  const step = steps[i];
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [run, setRun] = useState<RunData | null>(null);
  const [reload, setReload] = useState(0);
  const [original, setOriginal] = useState<Design | null>(null);
  const [want, setWant] = useState<Scenario | null>(null);
  const phoneFrame = useMedia('(max-width: 512px)');
  // the latest progress, for the message handler
  const latest = useRef(progress);
  latest.current = progress;

  useEffect(() => {
    let live = true;
    void Promise.all([loadExample(lesson.example), loadScenario(lesson.scenario)]).then(([d, s]) => {
      if (!live) return;
      setOriginal(d ?? null);
      setWant(s ?? null);
    });
    return () => {
      live = false;
    };
  }, [lesson]);

  const scenarioOk = !run || (want !== null && sameScenario(run.scenario, want));
  const verdicts = useMemo(() => (run && original && scenarioOk ? new Map(lesson.challenges.map((c) => [c.id, judge(c, run, original)])) : null), [run, original, scenarioOk, lesson]);

  const go = (n: number) => {
    const p = latest.current;
    const k = clampStep(n, steps);
    update({ ...p, step: k, reached: Math.max(p.reached, k), done: p.done || steps[k].kind === 'done' });
  };

  // a finished run answers the guesses and is judged; on the run step it moves on to the answers
  useEffect(() => {
    if (!run) return;
    const p = latest.current;
    const passedNow = verdicts ? [...verdicts].filter(([, v]) => v.passed).map(([id]) => id) : [];
    const passed = [...new Set([...p.passed, ...passedNow])];
    const at = clampStep(p.step, steps);
    const next = steps[at].kind === 'run' ? at + 1 : at;
    update({ ...p, answered: true, passed, step: next, reached: Math.max(p.reached, next), done: p.done || steps[next].kind === 'done' });
  }, [run, verdicts]);

  const send = (m: FromCourse) => frame.current?.contentWindow?.postMessage(m, location.origin);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const m = e.data as ToCourse | null;
      if (!m || m.source !== 'loadsketch-app' || m.example !== lesson.example) return;
      if (m.kind === 'ready') {
        setStatus('idle');
        setRun(null);
        if (!latest.current.answered) send({ source: 'loadsketch-course', kind: 'guesses', guesses: latest.current.guesses });
      } else if (m.kind === 'status') {
        if (m.status === 'idle' || m.status === 'running' || m.status === 'paused' || m.status === 'done') setStatus(m.status);
      } else if (m.kind === 'run') setRun(m.run);
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [lesson]);

  const startRun = () => {
    if (!latest.current.answered) send({ source: 'loadsketch-course', kind: 'guesses', guesses: latest.current.guesses });
    send({ source: 'loadsketch-course', kind: 'run' });
  };
  const guess = (q: string, o: string) => {
    if (progress.answered) return;
    const guesses = { ...progress.guesses, [q]: o };
    update({ ...progress, guesses });
    send({ source: 'loadsketch-course', kind: 'guesses', guesses });
  };
  const restart = () => {
    update({ ...EMPTY });
    setRun(null);
    setStatus('loading');
    setReload((r) => r + 1);
  };

  const q = new URLSearchParams({ embed: '1', course: '1', example: lesson.example, scenario: lesson.scenario, lang, theme });
  // the settings panel on the right; no charts under the canvas: the frame is too short for both
  q.set('panels', phoneFrame ? '' : 'right');
  if (phoneFrame) q.set('phone', '1');
  const speed = new URLSearchParams(location.search).get('speed');
  if (speed) q.set('speed', speed);
  const src = `${APP}?${q.toString()}`;
  const next = nextReady(entry.id);
  const right = run ? lesson.questions.filter((x) => progress.guesses[x.id] === x.answer(run)).length : 0;

  let body: React.ReactNode;
  switch (step.kind) {
    case 'intro':
      body = (
        <>
          <p className="text-[16px] leading-relaxed">{t(lesson.intro)}</p>
          <p className="muted mt-3 text-[15px] leading-relaxed">{t('How a lesson goes: guess the answers first, then run the simulator. The answers are read from that run. Then change the design to pass the challenges.')}</p>
        </>
      );
      break;
    case 'guess': {
      const qq = step.question;
      const mine = progress.guesses[qq.id];
      body = (
        <div data-testid={`course-guess-${qq.id}`}>
          <div className="text-[16px] leading-relaxed">{t(qq.text)}</div>
          <div className="mt-3 flex flex-col gap-1.5" role="radiogroup">
            {qq.options.map((o) => (
              <button
                key={o.id}
                role="radio"
                aria-checked={mine === o.id}
                className={`btn course-option justify-start text-left ${mine === o.id ? 'btn-on' : ''}`}
                onClick={() => guess(qq.id, o.id)}
                disabled={progress.answered}
                data-testid={`course-option-${qq.id}-${o.id}`}
              >
                {t(o.text)}
              </button>
            ))}
          </div>
          <div className="faint mt-2 text-[14px]">{progress.answered ? t('A run has answered this question: the guess is locked. Start the lesson again to guess again.') : t('Pick one. The answer shows after the run.')}</div>
        </div>
      );
      break;
    }
    case 'run':
      body = (
        <>
          <p className="text-[16px] leading-relaxed">{t('Press Run. The simulator sends the traffic of the lesson\'s scenario through the design. You can also press Run in the simulator itself, or jump to the end there.')}</p>
          {lesson.questions.some((x) => !progress.guesses[x.id]) && !progress.answered && <p className="muted mt-2 text-[14px]">{t('Some questions have no guess yet. Go back to guess, or run without one.')}</p>}
          <RunButton status={status} onRun={startRun} />
        </>
      );
      break;
    case 'answers':
      body = run ? (
        <Answers lesson={lesson} run={run} guesses={progress.guesses} />
      ) : (
        <>
          <p className="text-[16px] leading-relaxed">{t('The answers are read from a run. Run the design to see them.')}</p>
          <RunButton status={status} onRun={startRun} />
        </>
      );
      break;
    case 'challenge': {
      const c = step.challenge;
      body = (
        <>
          <ChallengeStep step={step} verdict={verdicts?.get(c.id) ?? null} passed={progress.passed.includes(c.id)} scenarioOk={scenarioOk} scenarioName={want ? t(want.name ?? lesson.scenario) : lesson.scenario} />
          <RunButton status={status} onRun={startRun} />
        </>
      );
      break;
    }
    case 'done':
      body = (
        <div data-testid="course-finish">
          <p className="text-[16px] leading-relaxed">{t('You finished this lesson.')}</p>
          <ul className="muted mt-2 space-y-1 text-[15px]">
            {run && lesson.questions.length > 0 && <li>{t('Guesses right: {n} of {all}', { n: right, all: lesson.questions.length })}</li>}
            <li>{t('Challenges passed: {n} of {all}', { n: lesson.challenges.filter((c) => progress.passed.includes(c.id)).length, all: lesson.challenges.length })}</li>
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

  const nextOk = step.kind !== 'done' && (step.kind !== 'run' || !!run || progress.answered);
  return (
    <div className="course-lesson" data-testid="course-lesson">
      <section className="course-steps" aria-label={t('Lesson')}>
        <div className="course-steps-in">
          <div className="faint num text-[14px]">{t('Lesson {id} · {m} min', { id: entry.id, m: entry.minutes })}</div>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight">{t(entry.title)}</h1>
          <ol className="course-dots mt-3" aria-label={t('Steps')}>
            {steps.map((s, k) => (
              <li key={s.id}>
                <button
                  className="course-dot"
                  data-at={k === i || undefined}
                  data-seen={k <= progress.reached || undefined}
                  disabled={k > progress.reached}
                  onClick={() => go(k)}
                  aria-current={k === i ? 'step' : undefined}
                  aria-label={t('Step {n}: {name}', { n: k + 1, name: stepLabel(s, lesson) })}
                  title={stepLabel(s, lesson)}
                />
              </li>
            ))}
          </ol>
          <div className="muted mt-2 text-[14px]" data-testid="course-step" data-step={step.id}>
            {t('Step {n} of {all}: {name}', { n: i + 1, all: steps.length, name: stepLabel(step, lesson) })}
          </div>
          <div className="mt-4">{body}</div>
          <div className="mt-6 flex gap-2">
            <button className="btn" onClick={() => go(i - 1)} disabled={i === 0} data-testid="course-back">
              <ArrowLeft size={14} />
              {t('Back')}
            </button>
            <button className="btn btn-primary" onClick={() => go(i + 1)} disabled={!nextOk} data-testid="course-next">
              {step.kind === 'guess' && !progress.guesses[step.question.id] && !progress.answered ? t('Skip') : t('Next@@step')}
              <ArrowRight size={14} />
            </button>
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
  const [id, go] = useRoute();
  setLang(lang);
  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  }, [lang]);
  const entry = findLesson(id);
  const lesson = entry ? lessonOf(entry) : undefined;
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
  const update = useCallback((lessonId: string, p: LessonProgress) => {
    setProgress((all) => {
      const next = { ...all, [lessonId]: p };
      saveProgress(next);
      return next;
    });
  }, []);
  return (
    <div className="course-page" key={lang}>
      <Bar lang={lang} theme={theme} onLang={flipLang} onTheme={flipTheme} onHome={entry && lesson ? () => go(null) : null} />
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
