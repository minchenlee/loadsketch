// Design briefs: a problem that starts from requirements and an almost empty canvas.
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import { parseDesign, parseScenario, type Design } from '../src/schema/design.ts';
import { BRIEFS, BRIEF_BY_ID, brokenGivens, judgeBrief, reachable, type Brief } from '../src/learn/briefs.ts';

function verdict(b: Brief, d: Design) {
  const sim = new Simulation(d, b.scenario);
  const result = sim.runToEnd();
  return judgeBrief(b, d, { result, windows: sim.drainWindows() });
}

const failed = (v: ReturnType<typeof verdict>) => [...v.checks.filter((c) => !c.ok).map((c) => c.id), ...v.needs.filter((n) => !n.ok).map((n) => n.id), ...v.broken.map((x) => x.text)];
const edit = (d: Design, id: string, params: Record<string, unknown>): Design => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ...params } as Design['nodes'][number]['params'] } : n)) });

describe('briefs', () => {
  it('there are some; each starts from the given nodes only, with valid designs and a valid scenario', () => {
    expect(BRIEFS.length).toBeGreaterThanOrEqual(3);
    for (const b of BRIEFS) {
      for (const d of [b.reference, b.naive]) {
        expect(parseDesign(d).ok).toBe(true);
        expect(parseScenario(b.scenario, d).ok).toBe(true);
      }
      // the start is not a design that runs yet: the only things wrong are the missing connections
      const start = parseDesign(b.start);
      expect(start.ok).toBe(false);
      expect([...new Set((start.ok ? [] : start.issues).map((i) => i.code))].sort()).toEqual(b.fixed.length ? ['client-no-edge', 'unreachable'] : ['client-no-edge']);
      // the canvas at the start: the users and what the brief gives, not connected
      expect(b.start.edges).toEqual([]);
      expect(b.start.nodes.map((n) => n.id).sort()).toEqual(['users', ...b.fixed].sort());
      // the reference and the naive design keep the given nodes as they are
      expect(brokenGivens(b, b.reference)).toEqual([]);
      expect(brokenGivens(b, b.naive)).toEqual([]);
      expect(b.functional.length).toBeGreaterThan(0);
      expect(b.outOfScope.length).toBeGreaterThan(0);
    }
  });

  it.each(BRIEFS.map((b) => [b.id, b] as const))('%s: the first design most people draw fails, the reference passes', (_, b) => {
    const naive = verdict(b, b.naive);
    expect(naive.passed).toBe(false);
    expect(naive.score).toBe(0);
    // it fails on what the run measured, not on a rule
    expect(naive.broken).toEqual([]);
    expect(naive.checks.some((c) => !c.ok && (c.id === 'errors' || c.id === 'p99'))).toBe(true);
    const ref = verdict(b, b.reference);
    expect(failed(ref)).toEqual([]);
    expect(ref.passed).toBe(true);
    expect(ref.score).toBeGreaterThanOrEqual(50);
    expect(ref.score).toBeLessThanOrEqual(100);
  }, 120_000);

  it('the start alone does not pass: nothing is stored', () => {
    const b = BRIEF_BY_ID['brief-shortener'];
    const d: Design = { ...b.start, nodes: [...b.start.nodes, { id: 'api', kind: 'service', pos: [200, 0], params: { instances: 8 } }], edges: [{ from: 'users', to: 'api' }] };
    const v = verdict(b, d);
    expect(v.needs.find((n) => n.id === 'stored')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 60_000);
});

describe('givens', () => {
  const b = BRIEF_BY_ID['brief-shortener'];

  it('a part cannot be faster than the brief says', () => {
    expect(brokenGivens(b, edit(b.reference, 'api', { serviceMs: { mean: 1, cv: 1 } })).map((x) => x.vars.name)).toEqual(['轉址 API']);
    expect(brokenGivens(b, edit(b.reference, 'db', { readMs: { mean: 1, cv: 1 } }))).toHaveLength(1);
    expect(brokenGivens(b, edit(b.reference, 'cache', { hitRatio: 0.99 }))).toHaveLength(1);
    // slower, or more of them, is the learner's choice
    expect(brokenGivens(b, edit(b.reference, 'api', { serviceMs: { mean: 9, cv: 1 }, instances: 20 }))).toEqual([]);
    expect(brokenGivens(b, edit(b.reference, 'cache', { hitRatio: 0.5 }))).toEqual([]);
  });

  it('a time written as a plain number is checked the same way', () => {
    expect(brokenGivens(b, edit(b.reference, 'api', { serviceMs: 1 }))).toHaveLength(1);
    expect(brokenGivens(b, edit(b.reference, 'api', { serviceMs: 5 }))).toEqual([]);
  });

  it('a given node set back to what it was is not changed: a default written out is the default', () => {
    const sale = BRIEF_BY_ID['brief-sale'];
    expect(brokenGivens(sale, edit(sale.reference, 'db', { connections: 50 }))).toEqual([]);
    const notify = BRIEF_BY_ID['brief-notify'];
    expect(brokenGivens(notify, edit(notify.reference, 'sms', { queueLimit: 2000, serviceMs: { cv: 0.5, mean: 200 }, concurrency: 400, instances: 1 }))).toEqual([]);
    expect(brokenGivens(notify, edit(notify.reference, 'sms', { serviceMs: { mean: 20, cv: 0.5 } }))).toHaveLength(1);
  });

  it('APIs cannot replace the read and write shares the brief gives', () => {
    const sale = BRIEF_BY_ID['brief-sale'];
    const d: Design = { ...sale.naive, apis: [{ name: 'view', op: 'read', share: 1 }] };
    expect(brokenGivens(sale, d)).toHaveLength(1);
    const v = verdict(sale, d);
    expect(v.passed).toBe(false);
  }, 60_000);

  it('a brief can give a part its own speed', () => {
    const sale = BRIEF_BY_ID['brief-sale'];
    expect(brokenGivens(sale, sale.reference)).toEqual([]);
    expect(brokenGivens(sale, edit(sale.reference, 'writer', { serviceMs: { mean: 1, cv: 1 } }))).toHaveLength(1);
  });

  it('a given node cannot be changed or removed, and a faster part makes a passing design fail', () => {
    const sale = BRIEF_BY_ID['brief-sale'];
    expect(brokenGivens(sale, edit(sale.reference, 'db', { connections: 200 }))).toHaveLength(1);
    expect(brokenGivens(sale, { ...sale.reference, nodes: sale.reference.nodes.filter((n) => n.id !== 'db'), edges: sale.reference.edges.filter((e) => e.to !== 'db') })).toHaveLength(1);
    const v = verdict(sale, edit(sale.naive, 'db', { connections: 200 }));
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
  }, 60_000);
});

describe('needs', () => {
  it('reachable follows the connections from the users', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    expect([...reachable(b.start)]).toEqual(['users']);
    expect(reachable(b.reference).has('sms')).toBe(true);
  });

  it('a queue nobody empties accepts every request, and does not pass', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    // one worker slot: the API answers fast, the messages wait
    const v = verdict(b, edit(b.reference, 'sender', { instances: 1, concurrency: 4 }));
    expect(v.checks.find((c) => c.id === 'errors')?.ok).toBe(true);
    expect(v.needs.find((n) => n.id === 'finished')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 60_000);

  it('messages the queue throws away are not finished work', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    const v = verdict(b, edit(edit(b.reference, 'sender', { instances: 1, concurrency: 4 }), 'outbox', { messageTtlS: 0.01 }));
    expect(v.needs.find((n) => n.id === 'finished')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 60_000);

  it('a line that carries no writes does not deliver them', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    const d: Design = { ...b.reference, edges: b.reference.edges.map((e) => (e.to === 'sms' ? { ...e, on: 'read' as const } : e)) };
    const v = verdict(b, d);
    expect(v.needs.find((n) => n.id === 'reaches-sms')?.ok).toBe(false);
    expect(v.passed).toBe(false);
    // the sale: reads go to the database, orders stop at the API
    const sale = BRIEF_BY_ID['brief-sale'];
    const lost: Design = { ...sale.naive, edges: sale.naive.edges.map((e) => (e.to === 'db' ? { ...e, on: 'read' as const } : e)) };
    const w = verdict(sale, lost);
    expect(w.needs.find((n) => n.id === 'reaches-db')?.ok).toBe(false);
    expect(w.passed).toBe(false);
  }, 120_000);

  it('reads with no store behind them are not answered', () => {
    const b = BRIEF_BY_ID['brief-shortener'];
    const d: Design = { ...b.naive, nodes: b.naive.nodes.map((n) => (n.id === 'api' ? { ...n, params: { instances: 5 } } : n)), edges: b.naive.edges.map((e) => (e.to === 'db' ? { ...e, on: 'write' as const } : e)) };
    const v = verdict(b, d);
    expect(v.needs.find((n) => n.id === 'stored')?.ok).toBe(true);
    expect(v.needs.find((n) => n.id === 'looked')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 60_000);

  it('a read put on a queue is not answered', () => {
    const sale = BRIEF_BY_ID['brief-sale'];
    // every request goes on the queue; the worker reads and writes the database later
    const d: Design = { ...sale.reference, edges: sale.reference.edges.filter((e) => !(e.from === 'api' && e.to === 'db')).map((e) => (e.to === 'orders' ? { from: e.from, to: e.to } : e)) };
    const v = verdict(sale, d);
    expect(v.needs.find((n) => n.id === 'looked')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 120_000);

  it('background work that fell back is degraded work', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    // the provider drops 5% of the calls, and the worker's call has a fallback: no user sees it
    const d: Design = { ...b.reference, nodes: [...b.reference.nodes, { id: 'relay', kind: 'service', pos: [900, 400], params: { instances: 4, errorRate: 0.05 } }], edges: [...b.reference.edges.filter((e) => e.to !== 'sms'), { from: 'sender', to: 'relay', fallback: 'on' as const }, { from: 'relay', to: 'sms' }] };
    const v = verdict(b, d);
    expect(v.needs.find((n) => n.id === 'not-degraded')?.ok).toBe(false);
    expect(v.passed).toBe(false);
  }, 60_000);

  it('a degraded answer does not count as done', () => {
    const b = BRIEF_BY_ID['brief-shortener'];
    // enough API Servers, a database far too small: its failed calls get a fallback answer
    const small = edit(edit(b.naive, 'api', { instances: 8 }), 'db', { connections: 5, queueLimit: 10 });
    const d: Design = { ...small, edges: small.edges.map((e) => (e.to === 'db' ? { ...e, fallback: 'on' as const } : e)) };
    const v = verdict(b, d);
    expect(v.checks.find((c) => c.id === 'errors')?.ok).toBe(true);
    expect(v.needs.find((n) => n.id === 'not-degraded')?.ok).toBe(false);
  }, 60_000);

  it('past the gates, a cheaper design scores higher', () => {
    const b = BRIEF_BY_ID['brief-notify'];
    const a = verdict(b, b.reference);
    const more = verdict(b, edit(b.reference, 'api', { instances: 4 }));
    expect(a.passed && more.passed).toBe(true);
    expect(a.score).toBeGreaterThan(more.score);
  }, 60_000);
});
