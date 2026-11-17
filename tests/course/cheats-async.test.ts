// Every challenge of every course lesson rejects the usual cheats (lead's rule after the second
// Codex review): removing or renaming a component of the original design, a worker so slow that no
// message finishes, and messages that expire at once. An empty latency histogram is not p99 = 0.
import { describe, expect, it } from 'vitest';
import type { Design } from '../../src/schema/design.ts';
import { judge, runOf as runOfLesson, type Challenge, type Lesson } from '../../src/learn/lesson.ts';
import { COURSE } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design, runOf, setParam, SLOW, type Change } from './run.ts';

const clone = (d: Design): Design => JSON.parse(JSON.stringify(d));
const without = (d: Design, id: string): Design => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from !== id && e.to !== id) });
const renamed = (d: Design, id: string): Design => {
  const x = clone(d);
  for (const n of x.nodes) if (n.id === id) n.id = id + '-2';
  for (const e of x.edges) {
    if (e.from === id) e.from = id + '-2';
    if (e.to === id) e.to = id + '-2';
  }
  return x;
};
const all: [Lesson, Challenge][] = COURSE.flatMap((l) => l.challenges.map((c) => [l, c] as [Lesson, Challenge]));

describe('removing or renaming a component of the original design breaks every challenge', () => {
  for (const [l, c] of all) {
    it(`${l.id} ${c.id}`, () => {
      const r = runOfLesson(l, c);
      const original = design(r.example);
      const base = runOf(r.example, r.scenario);
      for (const n of original.nodes) {
        if (c.mayRemove?.includes(n.id)) continue;
        for (const d of [without(original, n.id), renamed(original, n.id)]) {
          const v = judge(c, { ...base, design: d } as RunData, original);
          expect(v.broken.length, `${n.id}`).toBeGreaterThan(0);
        }
      }
    }, SLOW);
  }
});

/** A change that passes each challenge with queued work, to put the async cheats on top of. */
const PASSING: Record<string, Change[]> = {
  'async-queue/ready-in-1s': [setParam('thumb', 'concurrency', 5)],
  'async-reliable/crash-safe': [setParam('thumb', 'instances', 3)],
  'saas-slack/break-the-loop': [setParam('bootlimit', 'ratePerSec', 600), setParam('bootlimit', 'burst', 600)],
};
/** Share of queued messages neither done nor in a DLQ. */
const unfinished = (run: RunData) => {
  let n = 0;
  let done = 0;
  for (const q of run.design.nodes.filter((x) => x.kind === 'queue')) {
    const s = run.result.nodes[q.id] as { arrivals?: number; asyncOk?: number; dlq?: number } | undefined;
    n += s?.arrivals ?? 0;
    done += (s?.asyncOk ?? 0) + (s?.dlq ?? 0);
  }
  return n > 0 ? (n - done) / n : 0;
};
const kindIds = (d: Design, kind: string) => d.nodes.filter((n) => n.kind === kind).map((n) => n.id);

describe('async work that never finishes or expires fails', () => {
  for (const [l, c] of all) {
    const fix = PASSING[c.id];
    if (!fix) continue;
    it(`${l.id} ${c.id}`, () => {
      const r = runOfLesson(l, c);
      const original = design(r.example);
      const ok = runOf(r.example, r.scenario, ...fix);
      expect(judge(c, ok, original).passed, 'the fix passes').toBe(true);
      const slow = kindIds(original, 'worker').map((id) => setParam(id, 'serviceMs', { mean: 1e6, cv: 0 }));
      const expire = kindIds(original, 'queue').map((id) => setParam(id, 'messageTtlS', 0.001));
      // A cheat that leaves work unfinished or expired must fail. TTL can have no effect when no
      // message waits long (saas-slack), so it only counts where it bites; at least one cheat must.
      let bites = 0;
      for (const cheat of [slow, expire]) {
        const x = runOf(r.example, r.scenario, ...fix, ...cheat);
        if (unfinished(x) <= 0.01) continue;
        bites++;
        expect(judge(c, x, original).passed).toBe(false);
      }
      expect(bites).toBeGreaterThan(0);
    }, 4 * SLOW);
  }
});

it('every challenge with queued work in its design is in PASSING', () => {
  for (const [l, c] of all) if (kindIds(design(runOfLesson(l, c).example), 'queue').length) expect(PASSING[c.id], c.id).toBeDefined();
});
