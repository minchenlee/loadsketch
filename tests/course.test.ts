// The course page's pure parts: the table of contents, the pages of a lesson, saved progress.
import { describe, expect, it } from 'vitest';
import { ALL_LESSONS, UNITS, nextReady } from '../src/course/catalog.ts';
import { clampStep, ctxOf, pagesOf } from '../src/course/steps.ts';
import { parseProgress, scoreOf } from '../src/course/progress.ts';
import { COURSE, COURSE_BY_ID } from '../src/learn/course.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { stepsOf, type Lesson } from '../src/learn/lesson.ts';

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

  it('the retry storm shows as 3.1 until it has a course file', () => {
    const e = ALL_LESSONS.find((l) => l.id === '3.1')!;
    expect(e.lesson).toBe(COURSE_BY_ID['3.1'] ?? LESSONS['retry-storm']);
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
