// M2: the settings panel. Groups, which fields show, "0 means off" switches, units and help text.
import { describe, expect, it } from 'vitest';
import { EDGE, GROUPS, TOGGLES, isPercent, isVisible, layout, specsOf, splitHelp, toggleOn } from '../src/app/paramLayout.ts';
import { EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { jsonSchemas } from '../src/schema/design.ts';

const keys = (kind: string, values: Record<string, unknown> = {}) => Object.fromEntries(layout(kind, values).map((g) => [g.key, g.params]));

describe('groups', () => {
  it('every parameter of every kind and of an edge has a group (none in "other")', () => {
    for (const kind of [EDGE, ...Object.keys(KINDS)]) {
      const listed = new Set((GROUPS[kind] ?? []).flatMap((g) => g.params));
      const missing = Object.keys(specsOf(kind)).filter((p) => !listed.has(p));
      expect(missing, kind).toEqual([]);
    }
  });

  it('an edge: route, network, retry, protect, fan-out, connections; the last four start folded with "off"', () => {
    const gs = layout(EDGE, {});
    expect(gs.map((g) => g.key)).toEqual(['route', 'network', 'retry', 'protect', 'fanout', 'conn']);
    expect(gs.filter((g) => g.folded).map((g) => g.key)).toEqual(['retry', 'protect', 'fanout', 'conn']);
    // no fan-out: the quorum does not show
    expect(keys(EDGE).fanout).toEqual(['fanout']);
    // no retries: the backoff and the budget do not show
    expect(keys(EDGE).retry).toEqual(['retries']);
  });

  it('retries on: backoff and budget show, and the group opens with what is set', () => {
    const gs = layout(EDGE, { retries: 2 });
    const retry = gs.find((g) => g.key === 'retry')!;
    expect(retry.params).toEqual(['retries', 'backoffMs', 'retryBudget']);
    expect(retry.folded).toBe(false);
    expect(retry.changed).toEqual([EDGE_PARAMS.retries.label]);
  });

  it('hedging is for reads: a write-only edge does not show it', () => {
    expect(keys(EDGE).protect).toContain('hedgeMs');
    expect(keys(EDGE, { on: 'write' }).protect).not.toContain('hedgeMs');
  });

  it('a database without read replicas shows only the replica count; with replicas, the replica settings', () => {
    expect(keys('database').replicas).toEqual(['replicas']);
    expect(keys('database', { replicas: 2 }).replicas).toEqual(['replicas', 'readFrom', 'replicaApplyRatio', 'replicaDelayMs', 'maxLagMs', 'localReplicas', 'failover', 'readYourWrites']);
    expect(keys('database', { replicas: 2, failover: 'auto' }).replicas).toContain('failoverS');
    expect(keys('database', { replicas: 2, failover: 'auto' }).replicas).toContain('fencing');
    expect(keys('database', { replicas: 2, readYourWrites: 'primary' }).replicas).toContain('rywWindowMs');
    // row locks: their own folded group; the hold time only with locks on
    expect(keys('database').locks).toEqual(['locks']);
    expect(keys('database', { locks: 'row' }).locks).toEqual(['locks', 'lockHoldMs']);
  });

  it('a value set away from its default still shows, so nothing set is hidden', () => {
    expect(isVisible('database', { maxLagMs: 500 }, 'maxLagMs')).toBe(true);
    expect(isVisible(EDGE, { backoffMs: 200 }, 'backoffMs')).toBe(true);
  });

  it('autoscaling off: only the switch shows, folded', () => {
    const scale = layout('service', {}).find((g) => g.key === 'scale')!;
    expect(scale.params).toEqual(['autoscale']);
    expect(scale.folded).toBe(true);
    expect(layout('service', { autoscale: 'on' }).find((g) => g.key === 'scale')!.params).toContain('bootS');
  });
});

describe('"0 means off" becomes a switch', () => {
  const ZERO_OFF = ['timeoutMs', 'retryBudget', 'throttleK', 'bulkhead', 'hedgeMs', 'codelTargetMs', 'shedAt', 'maxLagMs', 'cache.ttlS', 'messageTtlS', 'maxReceives', 'fanout', 'quorum'];

  it('covers the 11 fields from the UI review, and fan-out', () => {
    expect(Object.keys(TOGGLES).sort()).toEqual([...ZERO_OFF].sort());
  });

  it('each one defaults to 0, says so in its help, and turns on to a value in range', () => {
    for (const key of ZERO_OFF) {
      const [kind, name] = key.includes('.') ? key.split('.') : [undefined, key];
      const kinds = kind ? [kind] : [EDGE, ...Object.keys(KINDS)].filter((k) => name in specsOf(k));
      expect(kinds.length, key).toBeGreaterThan(0);
      for (const k of kinds) {
        const spec = specsOf(k)[name];
        expect(spec.default, `${k}.${name}`).toBe(0);
        expect(spec.help, `${k}.${name}`).toMatch(/0 表示/);
        const on = toggleOn(k, name)!;
        if (spec.type === 'ratio') expect(on > 0 && on <= 1).toBe(true);
        else if (spec.type === 'int' || spec.type === 'number') expect(on > 0 && on <= spec.max, `${k}.${name}`).toBe(true);
      }
    }
    // the DNS TTL is not a switch: 0 there means "do not cache"
    expect(toggleOn('dns', 'ttlS')).toBeUndefined();
  });
});

describe('units and help text', () => {
  it('labels carry no unit: the unit sits in the field', () => {
    for (const kind of [EDGE, ...Object.keys(KINDS)]) {
      for (const [name, p] of Object.entries(specsOf(kind))) expect(p.label, `${kind}.${name}`).not.toMatch(/（(ms|秒)/);
    }
  });

  it('the JSON form of a time is not in the inspector help, but stays in the schema', () => {
    const help = Object.values(KINDS).flatMap((k) => Object.values(k.params)).map((p) => p.help);
    expect(help.some((h) => h.includes('{ mean, cv }'))).toBe(false);
    const schema = JSON.stringify(jsonSchemas());
    expect(schema).toContain('{ mean, cv }');
    // and the schema still names the unit
    expect(schema).toContain('逾時（ms）');
    expect(schema).toContain('開機時間（秒）');
  });

  it('percent fields: every ratio, and the retry budget', () => {
    expect(isPercent('errorRate', KINDS.service.params.errorRate)).toBe(true);
    expect(isPercent('retryBudget', EDGE_PARAMS.retryBudget)).toBe(true);
    expect(isPercent('retries', EDGE_PARAMS.retries)).toBe(false);
  });

  it('splitHelp: the first sentence, then the rest', () => {
    expect(splitHelp('同時跑幾台。流量平均分給每一台。')).toEqual(['同時跑幾台。', '流量平均分給每一台。']);
    expect(splitHelp('One sentence only.')).toEqual(['One sentence only.', '']);
    expect(splitHelp('Use 0.5 here. Then more.')).toEqual(['Use 0.5 here.', 'Then more.']);
  });
});
