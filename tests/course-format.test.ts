// The course format (src/learn/course.ts): every lesson file fits, without running a simulation.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COURSE, COURSE_BY_ID, UNITS } from '../src/learn/course.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { stepsOf, runOf } from '../src/learn/lesson.ts';
import { TOPICS } from '../src/learn/guessLog.ts';
import { INCIDENT_BY_ID } from '../src/learn/oncall.ts';
import { PROBLEMS } from '../src/learn/constraints.ts';
import { BRIEFS } from '../src/learn/briefs.ts';

const root = join(import.meta.dirname, '..');
const designExists = (e: string) => existsSync(join(root, 'examples', 'designs', `${e}.json`));
const scenarioExists = (s: string) => existsSync(join(root, 'examples', 'scenarios', `${s}.json`));

describe('course format', () => {
  it('has lessons, each with a unique number, a title, a unit, an order, minutes and a wave', () => {
    expect(COURSE.length).toBeGreaterThan(0);
    const ids = COURSE.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of COURSE) {
      expect(l.id, l.example).toMatch(/^\d\.\d+$/);
      expect(l.title, l.id).toBeTruthy();
      expect(UNITS[l.unit!], l.id).toBeTruthy();
      expect(l.id).toBe(`${l.unit}.${l.order}`);
      expect(l.minutes, l.id).toBeGreaterThan(0);
      expect([1, 2], l.id).toContain(l.wave);
      expect(COURSE_BY_ID[l.id!]).toBe(l);
    }
  });

  it('is in course order', () => {
    const key = (id: string) => id.split('.').map(Number);
    const ids = COURSE.map((l) => key(l.id!));
    const sorted = [...ids].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(ids).toEqual(sorted);
  });

  it('every example and scenario a lesson, question, challenge or step opens exists', () => {
    for (const l of COURSE) {
      for (const e of [l.example, ...(l.extraExamples ?? [])]) expect(designExists(e), `${l.id}: ${e}`).toBe(true);
      expect(scenarioExists(l.scenario), `${l.id}: ${l.scenario}`).toBe(true);
      for (const x of [...l.questions, ...l.challenges, ...stepsOf(l).filter((s) => s.kind === 'run' || s.kind === 'try')]) {
        const r = runOf(l, x as { example?: string; scenario?: string });
        expect(designExists(r.example), `${l.id}: ${r.example}`).toBe(true);
        expect(scenarioExists(r.scenario), `${l.id}: ${r.scenario}`).toBe(true);
        expect([l.example, ...(l.extraExamples ?? [])], `${l.id}: ${r.example} is not in example or extraExamples`).toContain(r.example);
      }
    }
  });

  it('challenge ids are unique over every lesson; question ids are unique per example', () => {
    const all = [...COURSE, ...Object.values(LESSONS).filter((l) => !COURSE.includes(l))];
    const cs = all.flatMap((l) => l.challenges.map((c) => c.id));
    expect(new Set(cs).size).toBe(cs.length);
    const byExample = new Map<string, string[]>();
    for (const l of all) for (const q of l.questions) {
      const e = runOf(l, q).example;
      byExample.set(e, [...(byExample.get(e) ?? []), q.id]);
    }
    for (const [e, qs] of byExample) expect(new Set(qs).size, e).toBe(qs.length);
  });

  it('questions have a known topic and at least two options with unique ids', () => {
    for (const l of COURSE) for (const q of l.questions) {
      expect(TOPICS[q.topic ?? ''], `${l.id}/${q.id}`).toBeTruthy();
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
    }
  });

  it('steps name questions and challenges of their lesson, and practice that exists', () => {
    for (const l of COURSE) {
      const qs = new Set(l.questions.map((q) => q.id));
      const cs = new Set(l.challenges.map((c) => c.id));
      for (const s of stepsOf(l)) {
        if (s.kind === 'guess') for (const q of s.questions) expect(qs.has(q), `${l.id}: ${q}`).toBe(true);
        if (s.kind === 'challenge') for (const c of s.challenges) expect(cs.has(c), `${l.id}: ${c}`).toBe(true);
        if (s.kind === 'practice')
          for (const p of s.items) {
            const found = p.kind === 'oncall' ? INCIDENT_BY_ID[p.id] : p.kind === 'constraint' ? PROBLEMS.find((x) => x.id === p.id) : BRIEFS.find((x) => x.id === p.id);
            expect(found, `${l.id}: ${p.kind} ${p.id}`).toBeTruthy();
          }
      }
      // every question and challenge shows in some step
      const steps = stepsOf(l);
      for (const q of qs) expect(steps.some((s) => s.kind === 'guess' && s.questions.includes(q)), `${l.id}: ${q} in no step`).toBe(true);
      for (const c of cs) expect(steps.some((s) => s.kind === 'challenge' && s.challenges.includes(c)), `${l.id}: ${c} in no step`).toBe(true);
    }
  });

  it('a lesson without steps reads the intro, guesses, runs, then takes the challenges', () => {
    const l = COURSE_BY_ID['2.1'];
    expect(stepsOf({ ...l, steps: undefined }).map((s) => s.kind)).toEqual(['read', 'guess', 'run', 'challenge']);
  });
});
