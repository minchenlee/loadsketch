// Rules and goals in src/learn/lessonKit2.ts. A node a rule or goal is about that is gone must
// count as broken, never as kept (Codex review of 2df379f).
import { describe, expect, it } from 'vitest';
import type { Design } from '../../src/schema/design.ts';
import { givenParts, keepParam, keepThrottle, oneEdgeOnly, slotsAtMost } from '../../src/learn/lessonKit2.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design } from './run.ts';

const clone = (d: Design): Design => JSON.parse(JSON.stringify(d));
const nodeOf = (d: Design, id: string) => d.nodes.find((n) => n.id === id)!;
const fakeRun = (d: Design, nodes: Record<string, unknown> = {}) => ({ design: d, result: { nodes, summary: {} }, windows: [], scenario: {} }) as unknown as RunData;

describe('oneEdgeOnly', () => {
  it('sees a changed component parameter', () => {
    const o = design('retry-storm');
    const d = clone(o);
    nodeOf(d, 'api').params = { ...nodeOf(d, 'api').params, queueLimit: 20 };
    expect(oneEdgeOnly.check(d, o)).not.toEqual([]);
    expect(oneEdgeOnly.check(clone(o), o)).toEqual([]);
  });
});

describe('keepThrottle', () => {
  it('a removed throttled connection breaks the rule', () => {
    const o = design('adaptive-throttle');
    const e = o.edges.find((x) => x.throttleK)!;
    const d = clone(o);
    d.edges = d.edges.filter((x) => !(x.from === e.from && x.to === e.to));
    expect(keepThrottle(3).check(d, o)).not.toEqual([]);
  });
});

describe('slotsAtMost', () => {
  const goal = slotsAtMost('jobs', 10, 'x');
  it('counts every consumer of the queue, not only the first worker', () => {
    const d = clone(design('async-queue'));
    d.nodes.push({ id: 'thumb2', kind: 'worker', pos: [0, 0], params: { instances: 1, concurrency: 4 } } as Design['nodes'][number]);
    d.edges.push({ from: 'jobs', to: 'thumb2' } as Design['edges'][number]);
    expect(goal.check(fakeRun(d)).ok).toBe(false); // 8 + 4 = 12
  });
  it('counts the maximum instances of an autoscaled consumer', () => {
    const d = clone(design('async-queue'));
    nodeOf(d, 'thumb').params = { ...nodeOf(d, 'thumb').params, autoscale: 'on', maxInstances: 6 };
    expect(goal.check(fakeRun(d)).ok).toBe(false);
  });
  it('fails when the queue is gone', () => {
    const d = clone(design('async-queue'));
    d.nodes = d.nodes.filter((n) => n.id !== 'jobs');
    expect(goal.check(fakeRun(d)).ok).toBe(false);
  });
  it('passes 2 × 5', () => {
    const d = clone(design('async-queue'));
    nodeOf(d, 'thumb').params = { ...nodeOf(d, 'thumb').params, concurrency: 5 };
    expect(goal.check(fakeRun(d)).ok).toBe(true);
  });
});

describe('keepParam and the 5.2 goals', () => {
  it('a removed node breaks the rule', () => {
    const o = design('async-reliable');
    const d = clone(o);
    d.nodes = d.nodes.filter((n) => n.id !== 'jobs');
    expect(keepParam('jobs', 'delivery', 'x', 'y').check(d, o)).not.toEqual([]);
  });
  it('no message lost and none twice fail when the queue is gone', () => {
    const c = COURSE_BY_ID['5.2'].challenges.find((x) => x.id === 'async-reliable/crash-safe')!;
    const d = clone(design('async-reliable'));
    d.nodes = d.nodes.filter((n) => n.id !== 'jobs');
    const r = fakeRun(d);
    for (const g of c.goals.slice(1, 3)) expect(g.check(r).ok).toBe(false);
  });
});

describe('givenParts', () => {
  it('a database under a new id is not faster than the one it replaces', () => {
    const o = design('url-shortener');
    const d = clone(o);
    const db = nodeOf(d, 'db');
    db.id = 'db2';
    db.params = { ...db.params, replicas: 0, readMs: { mean: 0.1, cv: 1 }, writeMs: { mean: 0.1, cv: 1 } };
    d.edges = d.edges.map((e) => (e.to === 'db' ? { ...e, to: 'db2' } : e));
    expect(givenParts.check(d, o)).not.toEqual([]);
  });
  it('the shipped design keeps the given speeds', () => {
    const o = design('url-shortener');
    expect(givenParts.check(clone(o), o)).toEqual([]);
  });
});
