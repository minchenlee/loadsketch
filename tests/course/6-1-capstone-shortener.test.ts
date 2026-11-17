// Lesson 6.1 (url-shortener on its own traffic and on hot-keys). Every expected answer is read from
// a run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design, lessonRuns, runOf, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['6.1'];
const { run, question, challenge } = lessonRuns(lesson);
const heavy = (...c: Change[]) => runOf('url-shortener', 'hot-keys', ...c);
const soloOk = (r: RunData) => judge(challenge('capstone/solo-shortener'), r, design('url-shortener')).passed;
const heavyOk = (r: RunData) => judge(challenge('capstone/write-heavy'), r, design('url-shortener')).passed;
const db = (k: string, v: unknown) => setParam('db', k, v);

describe('capstone lesson (6.1)', () => {
  it('writes take over: most requests fail; a larger primary fixes it', () => {
    expect(question('writes-fail').answer(heavy())).toBe('most');
    expect(question('writes-fail').answer(heavy(db('connections', 32)))).toBe('few');
  }, SLOW);

  it('one person: dropping the read replica passes; the shipped design and more replicas do not', () => {
    expect(soloOk(run())).toBe(false);
    expect(soloOk(run(db('replicas', 0)))).toBe(true);
    expect(soloOk(run(db('replicas', 3)))).toBe(false);
    expect(soloOk(run(db('replicas', 0), setParam('db', 'readMs', { mean: 1, cv: 1 })))).toBe(false); // faster than given
  }, SLOW);

  it('write-heavy: a larger primary without the replica passes; a larger primary alone costs too many points', () => {
    expect(heavyOk(heavy())).toBe(false);
    expect(heavyOk(heavy(db('replicas', 0), db('connections', 32)))).toBe(true);
    expect(heavyOk(heavy(db('connections', 32)))).toBe(false);
    expect(heavyOk(heavy(setParam('api', 'instances', 6)))).toBe(false);
  }, SLOW);
});
