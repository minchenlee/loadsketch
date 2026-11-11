// The design format: what an agent or a person reads and writes.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDesign, DESIGN_SCHEMA, SCENARIO_SCHEMA, instanceRoles, formatJson, jsonSchemas, parseDesign, parseScenario, type Design } from '../src/schema/design.ts';
import { simulate } from '../src/engine/index.ts';

const root = join(import.meta.dirname, '..');
const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
const designs = files('examples/designs');
const scenarios = files('examples/scenarios');

describe('examples', () => {
  it('there are examples to check', () => {
    expect(designs.length).toBeGreaterThanOrEqual(4);
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of [...designs, ...scenarios]) {
    it(`${f}: load → save gives the same bytes`, () => {
      const text = readFileSync(join(root, f), 'utf8');
      const value = JSON.parse(text);
      const r = f.includes('designs') ? parseDesign(value) : parseScenario(value);
      expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(formatJson(r.value)).toBe(text);
    });
  }

  for (const f of designs) {
    it(`${f}: runs with every example scenario without crashing`, () => {
      const d = JSON.parse(readFileSync(join(root, f), 'utf8')) as Design;
      for (const s of scenarios) {
        const sc = JSON.parse(readFileSync(join(root, s), 'utf8'));
        if (sc.events?.some((e: { node?: string }) => e.node && !d.nodes.some((n) => n.id === e.node))) continue;
        const r = simulate(d, { ...sc, durationS: 15, warmupS: 2 });
        const failed = Object.values(r.summary.fail).reduce((a, b) => a + b, 0);
        expect(r.summary.ok + failed).toBe(r.summary.offered);
        expect(r.truncated).toBe(false);
      }
      // every example scenario in turn: several seconds when the whole suite runs in parallel
    }, 30000);
  }
});

describe('formatJson', () => {
  it('keeps short arrays and objects on one line and long ones expanded', () => {
    const out = formatJson({ a: [1, 2], b: { c: 'x'.repeat(200) }, d: [] });
    expect(out).toBe(`{\n  "a": [1, 2],\n  "b": {\n    "c": "${'x'.repeat(200)}"\n  },\n  "d": []\n}\n`);
  });

  it('round-trips arbitrary nested data', () => {
    const v = { s: DESIGN_SCHEMA, n: [{ id: 'a', p: [0, -1.5], q: { mean: 3, cv: 0.5 } }], e: [], t: 'line\n"quoted"', u: null, b: true };
    expect(JSON.parse(formatJson(v))).toEqual(v);
    expect(formatJson(JSON.parse(formatJson(v)))).toBe(formatJson(v));
  });
});

describe('validation', () => {
  const base = (): Design => ({
    schema: DESIGN_SCHEMA,
    name: 'x',
    nodes: [
      { id: 'u', kind: 'client', pos: [0, 0] },
      { id: 'a', kind: 'service', pos: [1, 0] },
    ],
    edges: [{ from: 'u', to: 'a' }],
  });
  const codes = (v: unknown) => parseDesign(v).issues.map((i) => i.code);

  it('accepts a minimal design', () => {
    expect(parseDesign(base()).ok).toBe(true);
  });

  it('rejects an unknown kind, an unknown parameter and a bad value', () => {
    const d1 = base();
    (d1.nodes[1] as { kind: string }).kind = 'mainframe';
    expect(parseDesign(d1).ok).toBe(false);
    const d2 = base();
    d2.nodes[1].params = { instancez: 3 };
    expect(parseDesign(d2).ok).toBe(false);
    const d3 = base();
    d3.nodes[1].params = { instances: 0 };
    expect(parseDesign(d3).ok).toBe(false);
    expect(codes(d3)).toContain('schema');
  });

  it('finds structural mistakes', () => {
    const cyc = base();
    cyc.nodes.push({ id: 'b', kind: 'service', pos: [2, 0] });
    cyc.edges.push({ from: 'a', to: 'b' }, { from: 'b', to: 'a' });
    expect(codes(cyc)).toContain('cycle');

    const dangling = base();
    dangling.edges.push({ from: 'a', to: 'nope' });
    expect(codes(dangling)).toContain('unknown-node');

    const dup = base();
    dup.nodes.push({ id: 'a', kind: 'cache', pos: [0, 0] });
    expect(codes(dup)).toContain('duplicate-node');

    const noClient = base();
    noClient.nodes = noClient.nodes.filter((n) => n.kind !== 'client');
    noClient.edges = [];
    expect(codes(noClient)).toContain('no-client');

    const self = base();
    self.edges.push({ from: 'a', to: 'a' });
    expect(codes(self)).toContain('self-loop');
  });

  it('warns about risky but valid designs', () => {
    const d = base();
    d.nodes.push({ id: 'cb', kind: 'circuit_breaker', pos: [0, 0] }, { id: 'p', kind: 'service', pos: [0, 0] }, { id: 'lonely', kind: 'cache', pos: [0, 0] });
    d.edges.push({ from: 'a', to: 'cb' }, { from: 'cb', to: 'p' });
    const r = parseDesign(d);
    expect(r.ok).toBe(true);
    const warn = r.issues.filter((i) => i.level === 'warning').map((i) => i.code);
    expect(warn).toContain('cb-no-timeout');
    expect(warn).toContain('unreachable');
  });

  it('checks scenario events against the design', () => {
    const r = parseScenario({ schema: 'loadsketch/scenario@1', traffic: { rps: 10 }, events: [{ type: 'down', atS: 1, node: 'ghost' }] }, base());
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('event-node');
  });
});

describe('JSON Schema files', () => {
  it('schema/*.schema.json are up to date (run `npm run schema` after changing the catalog)', () => {
    for (const [name, s] of Object.entries(jsonSchemas())) {
      expect(readFileSync(join(root, 'schema', name), 'utf8')).toBe(formatJson(s));
    }
  });

  it('every component kind is described in the schema', () => {
    const text = readFileSync(join(root, 'schema', 'design.schema.json'), 'utf8');
    for (const kind of ['client', 'dns', 'cdn', 'api_gateway', 'load_balancer', 'rate_limiter', 'service', 'circuit_breaker', 'cache', 'database', 'sharded_db', 'queue', 'worker', 'object_storage']) {
      expect(text).toContain(`"const": "${kind}"`);
    }
  });
});

describe('review fixes: format and checks', () => {
  it('formatJson always writes valid JSON', () => {
    expect(JSON.parse(formatJson([undefined, 1, { a: undefined, b: 2 }]))).toEqual([null, 1, { b: 2 }]);
    expect(() => formatJson(undefined)).toThrow();
  });

  it('warns that queue edges ignore timeouts and retries', () => {
    const d = { schema: 'loadsketch/design@1', name: 'q', nodes: [{ id: 'u', kind: 'client', pos: [0, 0] }, { id: 'q', kind: 'queue', pos: [1, 0] }, { id: 'w', kind: 'worker', pos: [2, 0] }], edges: [{ from: 'u', to: 'q' }, { from: 'q', to: 'w', timeoutMs: 5, retries: 2 }] };
    const r = parseDesign(d);
    expect(r.ok).toBe(true);
    expect(checkDesign(r.ok ? r.value : (null as never)).some((i) => i.code === 'queue-edge-timeout')).toBe(true);
  });

  it('warns when autoscale max is below the minimum', () => {
    const d = { schema: 'loadsketch/design@1', name: 'a', nodes: [{ id: 'u', kind: 'client', pos: [0, 0] }, { id: 'api', kind: 'service', pos: [1, 0], params: { instances: 4, autoscale: 'on', maxInstances: 2 } }], edges: [{ from: 'u', to: 'api' }] };
    const r = parseDesign(d);
    expect(r.ok).toBe(true);
    expect(checkDesign(r.ok ? r.value : (null as never)).some((i) => i.code === 'autoscale-max')).toBe(true);
  });
});

describe('instance names in the UI', () => {
  it('instanceRoles matches the engine for every example', () => {
    const dir = join(import.meta.dirname, '..', 'examples', 'designs');
    for (const f of readdirSync(dir)) {
      const r = parseDesign(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!r.ok) throw new Error(f);
      const res = simulate(r.value, { schema: SCENARIO_SCHEMA, durationS: 2, warmupS: 0, traffic: { rps: 10 } });
      for (const n of r.value.nodes) {
        const roles = instanceRoles(n);
        const eng = res.nodes[n.id]?.instances?.map((x) => x.role);
        if (eng) expect(roles, `${f} ${n.id}`).toEqual(eng);
        else expect(roles.length, `${f} ${n.id}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('queue warnings', () => {
  const d = (q: Record<string, unknown>, w: Record<string, unknown>) => {
    const r = parseDesign({ schema: 'loadsketch/design@1', name: 'q', nodes: [{ id: 'u', kind: 'client', pos: [0, 0] }, { id: 'q', kind: 'queue', pos: [1, 0], params: q }, { id: 'w', kind: 'worker', pos: [2, 0], params: w }], edges: [{ from: 'u', to: 'q' }, { from: 'q', to: 'w' }] });
    if (!r.ok) throw new Error('bad');
    return checkDesign(r.value).map((i) => i.code);
  };
  it('warns about a short visibility timeout and poison without a DLQ', () => {
    expect(d({ delivery: 'at_least_once', visibilityTimeoutMs: 10 }, { serviceMs: 50 })).toContain('visibility-short');
    expect(d({ delivery: 'at_least_once' }, { poisonRate: 0.1 })).toContain('poison-no-dlq');
    expect(d({ delivery: 'at_least_once', maxReceives: 3 }, { poisonRate: 0.1 })).not.toContain('poison-no-dlq');
    expect(d({}, { poisonRate: 0.1, serviceMs: 50 })).not.toContain('visibility-short');
  });
});

describe('priority warnings', () => {
  const d = (clientP: Record<string, unknown>, apiP: Record<string, unknown>) => {
    const r = parseDesign({ schema: 'loadsketch/design@1', name: 'p', nodes: [{ id: 'u', kind: 'client', pos: [0, 0], params: clientP }, { id: 'api', kind: 'service', pos: [1, 0], params: apiP }], edges: [{ from: 'u', to: 'api' }] });
    if (!r.ok) throw new Error('bad');
    return checkDesign(r.value).map((i) => i.code);
  };
  it('warns when shedding is on but no client sends batch requests', () => {
    expect(d({}, { shedAt: 0.5 })).toContain('priority-no-batch');
    expect(d({ priority: 'batch' }, { shedAt: 0.5 })).not.toContain('priority-no-batch');
    expect(d({}, {})).not.toContain('priority-no-batch');
  });
});

describe('load balancer warning', () => {
  const codes = (apiP: Record<string, unknown>, lb: boolean) => {
    const nodes: Record<string, unknown>[] = [{ id: 'u', kind: 'client', pos: [0, 0] }, { id: 'api', kind: 'service', pos: [2, 0], params: apiP }];
    const edges = lb ? [{ from: 'u', to: 'lb' }, { from: 'lb', to: 'api' }] : [{ from: 'u', to: 'api' }];
    if (lb) nodes.push({ id: 'lb', kind: 'load_balancer', pos: [1, 0] });
    const r = parseDesign({ schema: 'loadsketch/design@1', name: 'lb', nodes, edges });
    if (!r.ok) throw new Error('bad');
    return checkDesign(r.value).map((i) => i.code);
  };
  it('warns when the client calls several machines with no load balancer between', () => {
    expect(codes({ instances: 3 }, false)).toContain('no-lb');
    expect(codes({ instances: 3 }, true)).not.toContain('no-lb');
    expect(codes({ instances: 1 }, false)).not.toContain('no-lb');
  });
  it('counts the machines autoscaling can add; an API gateway is the entry point itself', () => {
    expect(codes({ instances: 1, autoscale: 'on', maxInstances: 3 }, false)).toContain('no-lb');
    const r = parseDesign({ schema: 'loadsketch/design@1', name: 'gw', nodes: [{ id: 'u', kind: 'client', pos: [0, 0] }, { id: 'gw', kind: 'api_gateway', pos: [1, 0], params: { instances: 3 } }], edges: [{ from: 'u', to: 'gw' }] });
    if (!r.ok) throw new Error('bad');
    expect(checkDesign(r.value).map((i) => i.code)).not.toContain('no-lb');
  });
  it('no example ships with the warning', () => {
    const dir = join(import.meta.dirname, '..', 'examples/designs');
    for (const f of readdirSync(dir)) {
      const r = parseDesign(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!r.ok) throw new Error(f);
      expect(checkDesign(r.value).filter((i) => i.code === 'no-lb').map((i) => `${f} ${i.edge}`)).toEqual([]);
    }
  });
});
