// noMoreCapacity (src/learn/lesson.ts): a processing time is shorter whether it is written as a
// number (the mean) or as a distribution object.
import { describe, expect, it } from 'vitest';
import { noMoreCapacity } from '../../src/learn/lesson.ts';
import type { Design, ParamValue } from '../../src/schema/design.ts';
import { design } from './run.ts';

const withApi = (d: Design, serviceMs: ParamValue): Design => ({
  ...d,
  nodes: d.nodes.map((n) => (n.id === 'api' ? { ...n, params: { ...n.params, serviceMs } } : n)),
});

describe('noMoreCapacity and the cache operation time', () => {
  it('a faster cache (opMs) breaks the rule', () => {
    const o = design('three-tier');
    const d: Design = { ...o, nodes: o.nodes.map((n) => (n.id === 'cache' ? { ...n, params: { ...n.params, opMs: 0.01 } } : n)) };
    expect(noMoreCapacity.check(d, o)).not.toEqual([]);
  });
});

describe('noMoreCapacity and processing times', () => {
  const o = design('retry-storm');
  it('a faster time written as a number breaks the rule', () => {
    expect(noMoreCapacity.check(withApi(o, 0.1), o)).not.toEqual([]);
  });
  it('a faster time written as a distribution breaks the rule', () => {
    expect(noMoreCapacity.check(withApi(o, { mean: 0.1, cv: 1 } as ParamValue), o)).not.toEqual([]);
  });
  it('the same time written either way keeps it', () => {
    const was = o.nodes.find((n) => n.id === 'api')!.params?.serviceMs;
    const m = typeof was === 'number' ? was : (was as { mean: number }).mean;
    expect(noMoreCapacity.check(withApi(o, m), o)).toEqual([]);
    expect(noMoreCapacity.check(withApi(o, { mean: m, cv: 1 } as ParamValue), o)).toEqual([]);
  });
});
