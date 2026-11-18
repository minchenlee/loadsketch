// The course page's pure parts: the table of contents, the pages of a lesson, saved progress.
import { describe, expect, it } from 'vitest';
import { ALL_LESSONS, UNITS, nextReady } from '../src/course/catalog.ts';
import { answerable, clampStep, ctxOf, feedbackOf, judgedOn, opensCharts, pagesOf } from '../src/course/steps.ts';
import { mergeStored, parseProgress, saveProgress, scoreOf, withAnswers } from '../src/course/progress.ts';
import { COURSE, COURSE_BY_ID } from '../src/learn/course.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { stepsOf, type Lesson } from '../src/learn/lesson.ts';
import { entriesForRun, lessonOfEntry, logFile, parseLog } from '../src/learn/guessLog.ts';
import type { RunData } from '../src/learn/metrics.ts';

describe('course table of contents', () => {
  it('has the 7 units of the course and the 33 lessons of the outline, in order', () => {
    expect(UNITS.map((u) => u.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ALL_LESSONS.length).toBeGreaterThanOrEqual(33);
    expect(new Set(ALL_LESSONS.map((l) => l.id)).size).toBe(ALL_LESSONS.length);
    for (const u of UNITS) for (const l of u.lessons) expect(l.id.startsWith(`${u.id}.`)).toBe(true);
    expect(UNITS.flatMap((u) => u.lessons)).toEqual(ALL_LESSONS);
  });

  it('every course file is in it, with its own text and title', () => {
    for (const l of COURSE) {
      const e = ALL_LESSONS.find((x) => x.id === l.id);
      expect(e?.lesson, l.id).toBe(l);
      expect(e?.title).toBe(l.title);
    }
    expect(ALL_LESSONS.find((l) => l.id === '2.1')?.lesson).toBe(COURSE_BY_ID['2.1']);
  });

  it('a lesson of the outline with no course file is coming soon', () => {
    for (const e of ALL_LESSONS) expect(e.lesson).toBe(COURSE_BY_ID[e.id]);
  });

  it('the next lesson skips the ones not written yet', () => {
    const n = nextReady('0.1');
    expect(n === undefined || !!n.lesson).toBe(true);
    expect(nextReady(ALL_LESSONS[ALL_LESSONS.length - 1].id)).toBeUndefined();
  });
});

describe('lesson pages', () => {
  it('one page per step of the lesson, then a page to finish', () => {
    for (const l of [...COURSE, LESSONS['retry-storm']]) {
      const p = pagesOf(l);
      expect(p.slice(0, -1)).toEqual(stepsOf(l));
      expect(p[p.length - 1].kind).toBe('done');
    }
  });

  it("each page works with the run of its step, else the page before's", () => {
    const base = LESSONS['retry-storm'];
    const l: Lesson = {
      ...base,
      extraExamples: ['retry-budget'],
      challenges: [{ ...base.challenges[0], example: 'retry-budget' }],
      steps: [
        { kind: 'read', text: 'x' },
        { kind: 'run' },
        { kind: 'try', text: 'y', scenario: 'spike' },
        { kind: 'read', text: 'z' },
        { kind: 'challenge', challenges: [base.challenges[0].id] },
      ],
    };
    const pages = pagesOf(l);
    const at = (i: number) => ctxOf(l, pages, i);
    expect(at(0)).toEqual({ example: 'retry-storm', scenario: 'retry-storm' });
    expect(at(1)).toEqual({ example: 'retry-storm', scenario: 'retry-storm' });
    expect(at(2)).toEqual({ example: 'retry-storm', scenario: 'spike' });
    expect(at(3)).toEqual({ example: 'retry-storm', scenario: 'spike' });
    expect(at(4)).toEqual({ example: 'retry-budget', scenario: 'retry-storm' });
  });

  it('a saved page outside the lesson is pulled back in', () => {
    const p = pagesOf(LESSONS['retry-storm']);
    expect(clampStep(-3, p)).toBe(0);
    expect(clampStep(99, p)).toBe(p.length - 1);
    expect(clampStep(1.5, p)).toBe(0);
  });
});

describe('saved progress', () => {
  it('reads broken or foreign values as no progress', () => {
    expect(parseProgress(null)).toEqual({});
    expect(parseProgress('{not json')).toEqual({});
    expect(parseProgress('[]')).toEqual({});
    expect(parseProgress(JSON.stringify({ format: 'other', lessons: {} }))).toEqual({});
  });

  it('keeps good fields and drops bad ones', () => {
    const p = parseProgress(JSON.stringify({ format: 'loadsketch/course-progress@1', lessons: { '3.1': { step: 4, reached: 2, guesses: { a: 'x', b: 3 }, answered: ['a', 1], answers: { a: 'x', b: 2 }, passed: ['c', 7], done: 'yes' }, '1.1': 'junk' } }));
    expect(p['3.1']).toEqual({ step: 4, reached: 4, guesses: { a: 'x' }, answered: ['a'], answers: { a: 'x' }, passed: ['c'], done: false });
    expect(p['1.1']).toEqual({ step: 0, reached: 0, guesses: {}, answered: [], answers: {}, passed: [], done: false });
  });
});

describe('the score of the guesses', () => {
  it('counts the saved answers, not this visit\'s runs, and says which are not scored yet', () => {
    const p = { step: 0, reached: 0, guesses: { a: 'x', b: 'y', c: 'z' }, answered: ['a', 'b', 'c'], answers: { a: 'x', b: 'n' }, passed: [], done: true };
    expect(scoreOf(['a', 'b', 'c', 'd'], p)).toEqual({ right: 1, unscored: 1 });
  });
});

describe('answers of a run', () => {
  it('a later run does not change the answers already scored; it adds the new ones', () => {
    const p = { step: 2, reached: 2, guesses: { a: 'x', b: 'y' }, answered: ['a'], answers: { a: 'x' }, passed: [], done: false };
    const q = withAnswers(p, { a: 'other', b: 'y' });
    expect(q.answers).toEqual({ a: 'x', b: 'y' });
    expect(q.answered).toEqual(['a', 'b']);
    expect(scoreOf(['a', 'b'], q)).toEqual({ right: 2, unscored: 0 });
  });
});

describe('questions by experiment', () => {
  // the shape of 2.4 and 2.5: a guess, a run, a second guess on the same example, then a try
  const base = LESSONS['retry-storm'];
  const l: Lesson = {
    ...base,
    steps: [
      { kind: 'read', text: 'x' },
      { kind: 'guess', questions: ['recover'] },
      { kind: 'run' },
      { kind: 'guess', questions: ['amp'] },
      { kind: 'try', text: 'y', patch: [{ edge: 'lb->api', set: { retries: 0 } }] },
      { kind: 'try', text: 'z' },
      { kind: 'challenge', challenges: [base.challenges[0].id] },
    ],
  };
  const pages = pagesOf(l);
  const ctx = ctxOf(l, pages, 2);

  it('a run answers only the questions guessed on a page before it', () => {
    expect(answerable(l, pages, 1, ctx)).toEqual([]);
    expect(answerable(l, pages, 2, ctx)).toEqual(['recover']);
    expect(answerable(l, pages, 3, ctx)).toEqual(['recover']);
    expect(answerable(l, pages, 4, ctx)).toEqual(['recover', 'amp']);
    expect(answerable(l, pages, 2, { example: 'other', scenario: ctx.scenario })).toEqual([]);
  });

  it('a run started on a guess page answers the guesses already made there (the simulator has its own Run)', () => {
    expect(answerable(l, pages, 1, ctx, { recover: 'fast' })).toEqual(['recover']);
    expect(answerable(l, pages, 1, ctx, {})).toEqual([]);
    expect(answerable(l, pages, 3, ctx, { recover: 'fast', amp: 'x' })).toEqual(['recover', 'amp']);
    expect(answerable(l, pages, 3, ctx, { recover: 'fast' })).toEqual(['recover']);
    // not on a run page: a later guess page's guesses wait
    expect(answerable(l, pages, 2, ctx, { recover: 'fast', amp: 'x' })).toEqual(['recover']);
  });

  it('a run or try page shows the questions guessed since the last run or try page', () => {
    expect(feedbackOf(l, pages, 2)).toEqual(['recover']);
    expect(feedbackOf(l, pages, 4)).toEqual(['amp']);
    expect(feedbackOf(l, pages, 5)).toEqual([]);
    expect(feedbackOf(l, pages, 3)).toEqual([]);
  });

  it('a challenge judges only a run started on a challenge page that lists it', () => {
    const id = base.challenges[0].id;
    expect(judgedOn(pages, 6, id)).toBe(true);
    // a run or try page before it (the reported case: a try run on the same example and scenario)
    for (const p of [2, 4, 5]) expect(judgedOn(pages, p, id)).toBe(false);
    expect(judgedOn(pages, 6, 'other')).toBe(false);
    expect(judgedOn(pages, 99, id)).toBe(false);
  });

  it('a step with look.panel bottom opens the charts; others do not', () => {
    expect(opensCharts({ kind: 'run', look: { panel: 'bottom' } })).toBe(true);
    expect(opensCharts({ kind: 'read', text: 'x', look: { node: 'api' } })).toBe(false);
    expect(opensCharts({ kind: 'run' })).toBe(false);
    expect(opensCharts({ kind: 'done' })).toBe(false);
  });

  it('without steps, the one run answers every question', () => {
    const d = LESSONS['retry-storm'];
    const p = pagesOf(d);
    const run = p.findIndex((x) => x.kind === 'run');
    expect(answerable(d, p, run, ctxOf(d, p, run))).toEqual(d.questions.map((q) => q.id));
    expect(feedbackOf(d, p, run)).toEqual(d.questions.map((q) => q.id));
  });
});

describe('guess log entries of a course lesson', () => {
  // a lesson on an example another lesson also uses (6.1 and 2.1 both open url-shortener)
  const l = {
    ...LESSONS['retry-storm'],
    id: '9.9',
    example: 'url-shortener',
    questions: [{ id: 'q', text: 'q', options: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }], answer: () => 'b', measured: () => 'm', explain: 'e' }],
  } as unknown as Lesson;
  const run = {} as RunData;

  it('carry the course lesson, and are read back with it', () => {
    const e = entriesForRun(l, { q: 'a' }, run, new Date('2026-11-18T00:00:00Z'), '9.9');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ lesson: '9.9', example: 'url-shortener', question: 'q', guess: 'a', answer: 'b' });
    const course = { '9.9': l };
    expect(parseLog(logFile(e), LESSONS, course).ok).toBe(true);
    expect(lessonOfEntry(e[0], LESSONS, course)).toBe(l);
    // without the course lesson, the entry is not taken for the example's side-panel lesson
    expect(lessonOfEntry(e[0], LESSONS, {})).toBeUndefined();
  });

  it('side-panel entries stay as they were', () => {
    const e = entriesForRun(l, { q: 'a' }, run, new Date('2026-11-18T00:00:00Z'));
    expect(e[0].lesson).toBeUndefined();
    expect(e[0].id).toBe('2026-11-18T00:00:00.000Z/url-shortener/q');
  });
});

describe('saved progress from another tab', () => {
  const p = (step: number) => ({ step, reached: step, guesses: {}, answered: [], answers: {}, passed: [], done: false });
  it('the stored lessons are newer, except those this tab could not save', () => {
    const mine = { '2.1': p(5), '3.1': p(4) };
    const stored = { '2.1': p(1), '3.1': p(1), '1.1': p(2) };
    expect(mergeStored(mine, stored, new Set(['2.1']))).toEqual({ '2.1': p(5), '3.1': p(1), '1.1': p(2) });
  });
  it('saving says whether it worked', () => {
    // no localStorage here: the write fails
    expect(saveProgress({})).toBe(false);
  });
});
