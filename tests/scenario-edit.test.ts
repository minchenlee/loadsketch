// M4: the scenario editor's tables. Every new event is valid; changing an event's type keeps its
// time and target; the charts mark event times inside the run.
import { describe, expect, it } from 'vitest';
import { checkScenario, ScenarioSchema, SCENARIO_SCHEMA, type Scenario, type ScenarioEvent } from '../src/schema/design.ts';
import { EVENT_SPEC, EVENT_SPECS, eventMarks, eventNodes, instanceCount, newEvent, retype, usableTypes } from '../src/app/scenarioEdit.ts';
import { simulate } from '../src/engine/index.ts';
import { design, scenario } from './helpers.ts';

const d = design(
  [
    ['u', 'client'],
    ['api', 'service', { instances: 3 }],
    ['q', 'queue'],
    ['db', 'database', { replicas: 2 }],
  ],
  [['u', 'api'], ['api', 'db'], ['api', 'q']],
);
d.nodes[1].region = 'us-east';

describe('scenario editor', () => {
  it('has a form for each of the 13 event kinds', () => {
    expect(EVENT_SPECS.map((s) => s.type).sort()).toEqual(['cron', 'down', 'errors', 'partition', 'pause', 'ramp', 'region_down', 'reshard', 'rollout', 'shift', 'slow', 'spike', 'wave']);
  });

  it('every new event is a valid scenario event aimed at a real target', () => {
    // a partition needs two regions
    const d2 = { ...d, nodes: d.nodes.map((n) => (n.id === 'db' ? { ...n, region: 'us-west' } : n)) };
    expect(usableTypes(d).map((s) => s.type)).not.toContain('partition');
    expect(usableTypes(d2).map((s) => s.type)).toContain('partition');
    // a reshard needs a sharded database
    const d3 = { ...d, nodes: [...d.nodes, { id: 'sdb', kind: 'sharded_db', pos: [0, 400] as [number, number] }] };
    expect(usableTypes(d).map((s) => s.type)).not.toContain('reshard');
    expect(usableTypes(d3).map((s) => s.type)).toContain('reshard');
    for (const s of EVENT_SPECS) {
      const dd = s.type === 'partition' ? d2 : s.type === 'reshard' ? d3 : d;
      const ev = newEvent(s.type, dd, 60);
      const sc: Scenario = { schema: SCENARIO_SCHEMA, durationS: 60, traffic: { rps: 100 }, events: [ev] };
      expect(ScenarioSchema.safeParse(sc).success, s.type).toBe(true);
      expect(checkScenario(sc, dd).filter((i) => i.level === 'error'), s.type).toEqual([]);
      // inside the run
      expect(ev.atS).toBeLessThan(60);
    }
  });

  it('a GC pause aims only at components that process requests; clients are never targets', () => {
    expect(eventNodes(d, 'pause').map((n) => n.id)).toEqual(['api', 'db']);
    expect(eventNodes(d, 'down').map((n) => n.id)).toEqual(['api', 'q', 'db']);
  });

  it('instances to pick: a service has its instances, a database its primary and replicas, a queue none', () => {
    expect(instanceCount(d, 'api')).toBe(3);
    expect(instanceCount(d, 'db')).toBe(3);
    expect(instanceCount(d, 'q')).toBe(0);
  });

  it('changing the type keeps the time, the length and the target', () => {
    const ev: ScenarioEvent = { type: 'down', atS: 12, forS: 7, node: 'db' };
    expect(retype(ev, 'slow', d, 60)).toEqual({ type: 'slow', atS: 12, forS: 7, node: 'db', multiplier: 5 });
    // a GC pause cannot aim at the queue: it takes the first component it can
    expect(retype({ type: 'down', atS: 3, node: 'q' }, 'pause', d, 60)).toMatchObject({ type: 'pause', atS: 3, node: 'api' });
    expect(retype({ type: 'down', atS: 3, node: 'q' }, 'pause', d, 60)).not.toHaveProperty('forS');
    // a ramp needs a length
    expect((retype({ type: 'spike', atS: 5, multiplier: 2 }, 'ramp', d, 60) as { forS?: number }).forS).toBeGreaterThan(0);
  });

  it('the charts mark each event start, and its end when it has one; events after the end are left out', () => {
    const marks = eventMarks(
      [
        { type: 'spike', atS: 10, forS: 100, multiplier: 2 },
        { type: 'down', atS: 30, node: 'api' },
        { type: 'down', atS: 90, node: 'api' },
      ],
      60,
      (ev) => ev.type,
    );
    expect(marks).toEqual([
      { t: 10, t1: 60, label: 'spike' },
      { t: 30, t1: undefined, label: 'down' },
    ]);
  });
});

describe('review fixes', () => {
  const sc = (ev: ScenarioEvent): Scenario => ({ schema: SCENARIO_SCHEMA, durationS: 60, traffic: { rps: 100 }, events: [ev] });
  const errors = (s: Scenario) => checkScenario(s, d).filter((i) => i.level === 'error').map((i) => i.code);

  it('a GC pause as long as its period, or cron bursts longer than their interval, are errors the editor shows', () => {
    expect(errors(sc({ type: 'pause', atS: 0, node: 'api', everyS: 0.1, pauseMs: 60000 }))).toContain('event-pause');
    expect(errors(sc({ type: 'pause', atS: 0, node: 'api', everyS: 5, pauseMs: 200 }))).toEqual([]);
    expect(errors(sc({ type: 'cron', atS: 0, everyS: 1, burstS: 2, multiplier: 5 }))).toContain('event-cron');
    expect(errors(sc({ type: 'cron', atS: 0, everyS: 2, burstS: 1, jitterS: 1, multiplier: 5 }))).toEqual([]);
  });

  it('the engine does not hang on a pause as long as its period: the node just stays stopped', () => {
    const t0 = performance.now();
    const r = simulate(
      design([['u', 'client'], ['s', 'service']], [['u', 's']]),
      scenario({ durationS: 5, warmupS: 0, traffic: { rps: 50, clientTimeoutMs: 1000 }, events: [{ type: 'pause', atS: 1, node: 's', everyS: 0.1, pauseMs: 60000 }] }),
    );
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.summary.fail.timeout).toBeGreaterThan(0);
  });

  it('a sharded database offers all its instances: shards × (1 + replicas)', () => {
    const sd = design([['u', 'client'], ['idx', 'sharded_db', { shards: 4, replicas: 1 }]], [['u', 'idx']]);
    expect(instanceCount(sd, 'idx')).toBe(8);
  });

  it('changing the type among down, slow and errors keeps the instance', () => {
    const slow = retype({ type: 'down', atS: 5, forS: 10, node: 'api', instance: 2 }, 'slow', d, 60);
    expect(slow).toMatchObject({ type: 'slow', node: 'api', instance: 2 });
    // a pause has no instance
    expect(retype(slow, 'pause', d, 60)).not.toHaveProperty('instance');
  });

  it('only event types with something to aim at are offered', () => {
    const noStation = design([['u', 'client'], ['lb', 'load_balancer']], [['u', 'lb']]);
    const types = usableTypes(noStation).map((s) => s.type);
    expect(types).not.toContain('pause');
    expect(types).not.toContain('region_down');
    expect(types).toContain('down');
    expect(usableTypes(d).map((s) => s.type)).toContain('region_down');
  });
});

describe('review fixes', () => {
  it('the rollout form has the crash switch', () => {
    expect(EVENT_SPEC.rollout.flags?.map((f) => f.key)).toEqual(['crash']);
  });
});
