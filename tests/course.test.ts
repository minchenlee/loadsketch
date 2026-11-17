// The course page's pure parts: the table of contents, the steps of a lesson, saved progress.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_LESSONS, UNITS, lessonOf, nextReady } from '../src/course/catalog.ts';
import { clampStep, stepsOf } from '../src/course/steps.ts';
import { parseProgress } from '../src/course/progress.ts';
import { LESSONS } from '../src/learn/lessons.ts';

const ROOT = join(import.meta.dirname, '..');
/** Examples the course outline adds (C3); until they land, their lessons stay "coming soon". */
const PLANNED_EXAMPLES = new Set(['single-server']);

describe('course table of contents', () => {
  it('has 7 units and 33 lessons with unique ids in order', () => {
    expect(UNITS.map((u) => u.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ALL_LESSONS).toHaveLength(33);
    expect(new Set(ALL_LESSONS.map((l) => l.id)).size).toBe(33);
    for (const u of UNITS) for (const l of u.lessons) expect(l.id.startsWith(`${u.id}.`)).toBe(true);
    expect(ALL_LESSONS.filter((l) => l.wave === 1)).toHaveLength(18);
  });

  it('opens only examples that exist (or are planned)', () => {
    for (const l of ALL_LESSONS) if (l.example && !PLANNED_EXAMPLES.has(l.example)) expect(existsSync(join(ROOT, 'examples/designs', `${l.example}.json`)), l.example).toBe(true);
  });

  it('shows every written lesson, and a lesson as ready only when its text exists', () => {
    const shown = new Set(ALL_LESSONS.map((l) => l.example));
    for (const ex of Object.keys(LESSONS)) expect(shown.has(ex), ex).toBe(true);
    expect(lessonOf(ALL_LESSONS.find((l) => l.id === '3.1')!)).toBe(LESSONS['retry-storm']);
    for (const l of ALL_LESSONS) expect(!!lessonOf(l)).toBe(!!l.example && l.example in LESSONS);
  });

  it('the next lesson skips the ones not written yet', () => {
    const n = nextReady('0.1');
    expect(n === undefined || !!lessonOf(n)).toBe(true);
    expect(nextReady(ALL_LESSONS[ALL_LESSONS.length - 1].id)).toBeUndefined();
  });
});

describe('lesson steps', () => {
  it('read, each guess, run, answers, each challenge, finish', () => {
    const l = LESSONS['retry-storm'];
    const s = stepsOf(l);
    expect(s.map((x) => x.kind)).toEqual(['intro', ...l.questions.map(() => 'guess'), 'run', 'answers', ...l.challenges.map(() => 'challenge'), 'done']);
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
  });

  it('a lesson without questions has no answers step', () => {
    const s = stepsOf({ ...LESSONS['retry-storm'], questions: [] });
    expect(s.map((x) => x.kind)).not.toContain('answers');
    expect(s.map((x) => x.kind)).not.toContain('guess');
  });

  it('a saved step outside the lesson is pulled back in', () => {
    const s = stepsOf(LESSONS['retry-storm']);
    expect(clampStep(-3, s)).toBe(0);
    expect(clampStep(99, s)).toBe(s.length - 1);
    expect(clampStep(1.5, s)).toBe(0);
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
    const p = parseProgress(JSON.stringify({ format: 'loadsketch/course-progress@1', lessons: { '3.1': { step: 4, reached: 2, guesses: { a: 'x', b: 3 }, answered: true, passed: ['c', 7], done: 'yes' }, '1.1': 'junk' } }));
    expect(p['3.1']).toEqual({ step: 4, reached: 4, guesses: { a: 'x' }, answered: true, passed: ['c'], done: false });
    expect(p['1.1']).toEqual({ step: 0, reached: 0, guesses: {}, answered: false, passed: [], done: false });
  });
});
