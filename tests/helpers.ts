import { DESIGN_SCHEMA, SCENARIO_SCHEMA, parseDesign, type Design, type DesignApi, type DesignEdge, type DesignNode, type Scenario } from '../src/schema/design.ts';

export type NodeSpec = [id: string, kind: string, params?: DesignNode['params']];
export type EdgeSpec = [from: string, to: string, extra?: Omit<DesignEdge, 'from' | 'to'>];

/** Build a design from short specs. All edges have zero network latency unless given. */
export function design(nodes: NodeSpec[], edges: EdgeSpec[], name = 'test', apis?: DesignApi[]): Design {
  const d: Design = {
    schema: DESIGN_SCHEMA,
    name,
    ...(apis ? { apis } : {}),
    nodes: nodes.map(([id, kind, params], i) => ({ id, kind, pos: [i * 200, 0], ...(params ? { params } : {}) })),
    edges: edges.map(([from, to, extra]) => ({ from, to, latencyMs: 0, ...extra })),
  };
  const r = parseDesign(d);
  if (!r.ok) throw new Error('bad test design: ' + JSON.stringify(r.issues));
  return d;
}

export function scenario(s: Partial<Omit<Scenario, 'schema' | 'traffic'>> & { traffic: Scenario['traffic'] }): Scenario {
  return { schema: SCENARIO_SCHEMA, ...s };
}

export const within = (actual: number, expected: number, rel: number): boolean => Math.abs(actual - expected) <= rel * Math.abs(expected);

/** Least-squares slope of y over x. */
export function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

/**
 * CPU time of this test process in ms while fn runs (user + system). A speed budget checks this,
 * not the wall clock: on a busy machine the wall clock grows, the work does not. Each test file
 * runs in its own process (vitest forks), so other files do not count.
 */
export function cpuMs(fn: () => void): number {
  const c0 = process.cpuUsage();
  fn();
  const c = process.cpuUsage(c0);
  return (c.user + c.system) / 1000;
}
