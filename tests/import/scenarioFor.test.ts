// A scenario for each check finding: every finding of the three example plans maps to a
// scenario the engine accepts, with the event on the right node, or says why there is none.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenario, type Design, type ScenarioEvent } from '../../src/core/index.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { importTerraform, runChecks, scenarioFor, type Finding, type SimFor } from '../../src/import/terraform/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const load = (name: string) => {
  const r = importTerraform(JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), 'utf8')));
  return { design: r.design, findings: runChecks(r) };
};
const ecs = load('ecs-rds');
const lambda = load('lambda-sqs-rds');
const aurora = load('aurora-cache-multiaz');
const find = (fs: Finding[], id: string) => fs.find((f) => f.id === id)!;
const sim = (fs: Finding[], id: string, d: Design) => {
  const s = scenarioFor(find(fs, id), d);
  if ('none' in s) throw new Error(`${id}: no scenario (${s.none})`);
  return s;
};
const ev = (s: Extract<SimFor, { scenario: unknown }>): ScenarioEvent => s.scenario.events![0];

describe('scenarioFor', () => {
  it('every finding of the example plans has a valid scenario or a reason, and every note has a message', () => {
    for (const { design, findings } of [ecs, lambda, aurora]) {
      for (const f of findings) {
        const s = scenarioFor(f, design);
        if ('none' in s) {
          expect(IMPORT_MESSAGE_IDS, f.id).toContain(`sim.none.${s.none}`);
          continue;
        }
        expect(parseScenario(s.scenario, design).ok, f.id).toBe(true);
        expect(IMPORT_MESSAGE_IDS, f.id).toContain(`sim.${s.note}`);
        expect(s.scenario.name).toBe(`${f.check} · ${f.node}`);
      }
    }
  });

  it('C1 / C10: traffic ramps to twice what the database can do (no max_connections in the engine)', () => {
    for (const id of ['check.C1', 'check.C10']) {
      const s = sim(ecs.findings, id, ecs.design);
      expect(s.note).toBe('connections');
      const e = ev(s);
      expect(e.type).toBe('ramp');
      // db: 8 connections / (0.9 × 3 + 0.1 × 10 = 3.7 ms) = 2162 rps; × 2 = 4324; ÷ 4 = 1081
      expect(s.scenario.traffic.rps).toBe(1081);
      expect(e.type === 'ramp' && e.toMultiplier).toBe(4);
    }
  });

  it('C3: the single-AZ database loses its primary at 20 s for 60 s', () => {
    const s = sim(ecs.findings, 'check.C3.db', ecs.design);
    expect(ev(s)).toEqual({ type: 'down', atS: 20, forS: 60, node: 'db_instance_main', instance: 0 });
    expect(s.note).toBe('down');
  });

  it('C9: one target behind the load balancer goes down', () => {
    const s = sim(ecs.findings, 'check.C9', ecs.design);
    expect(ev(s)).toEqual({ type: 'down', atS: 20, forS: 60, node: 'ecs_service_api', instance: 0 });
    expect(s.args.total).toBe(90);
  });

  it('C4.max: ramps past the estimated limit', () => {
    const s = sim(ecs.findings, 'check.C4.max', ecs.design);
    // 1.5 × 28000 = 42000; it starts at the healthy level (half the DB: 1081), not 42000 ÷ 4
    expect(s.scenario.traffic.rps).toBe(1081);
    const e = ev(s);
    expect(e.type === 'ramp' && e.toMultiplier).toBe(38.9);
    expect(s.args).toMatchObject({ max: 28000, from: 1081, to: 42051 });
  });

  it('C5.caller: the function gets slower than the caller timeout', () => {
    const s = sim(lambda.findings, 'check.C5.caller', lambda.design);
    const e = ev(s);
    expect(e).toMatchObject({ type: 'slow', node: 'lambda_function_api' });
    // 276.41 ms × multiplier > 29 s
    expect(e.type === 'slow' && e.multiplier * 276.41 > 29000).toBe(true);
  });

  it('C5.visibility: no scenario when the consumer would need to be more than 1000 times slower', () => {
    // worker 34.55 ms × 1000 = 34.6 s < visibility 120 s
    expect(scenarioFor(find(lambda.findings, 'check.C5.visibility'), lambda.design)).toEqual({ none: 'beyondEngine' });
  });

  it('C5.visibility: a slow consumer past the visibility timeout when the engine can make it', () => {
    const d = structuredClone(lambda.design);
    d.nodes.find((n) => n.id === 'lambda_function_worker')!.params!.serviceMs = 500;
    const s = sim(lambda.findings, 'check.C5.visibility', d);
    const e = ev(s);
    expect(e).toMatchObject({ type: 'slow', node: 'lambda_function_worker', multiplier: 360 });
    expect(s.args).toMatchObject({ consumer: 'lambda_function_worker', visibilityS: 120 });
  });

  it('C6 / C7.queue: the consumer fails every message', () => {
    expect(ev(sim(lambda.findings, 'check.C6', lambda.design))).toMatchObject({ type: 'errors', atS: 20, node: 'lambda_function_worker', rate: 1 });
    // the audit queue has no consumer in the plan
    expect(scenarioFor(find(lambda.findings, 'check.C7.queue'), lambda.design)).toEqual({ none: 'unknown' });
  });

  it('C8: traffic stays at the throttle rate', () => {
    const s = sim(lambda.findings, 'check.C8', lambda.design);
    expect(s.scenario.traffic.rps).toBe(5000);
    expect(s.scenario.events).toBeUndefined();
    expect(s.args).toMatchObject({ target: 'lambda_function_api', capacity: 3617 });
  });

  it('C11: ramps to three times the table throttle', () => {
    const s = sim(lambda.findings, 'check.C11', lambda.design);
    expect(s.args).toMatchObject({ limit: 150, from: 75, to: 450 });
  });

  it('the traffic before the event is healthy for the whole design, not only the finding\'s node', () => {
    // half the DB would be 1081 rps, but the DynamoDB throttle (150/s) fails most of that from the start
    for (const id of ['check.C3.db', 'check.C5.caller', 'check.C6']) {
      expect(sim(lambda.findings, id, lambda.design).scenario.traffic.rps, id).toBeLessThanOrEqual(75);
    }
  });

  describe('review fixes', () => {
    const clone = () => structuredClone(lambda.design);
    const nodeOf = (d: Design, id: string) => d.nodes.find((n) => n.id === id)!;

    it('P1: a queue scenario lasts past the visibility timeout of every failed delivery', () => {
      // visibility 120 s, maxReceiveCount 5: the 5th delivery starts at 4 × 120 s and its 0.035 s work
      // ends in the window (481 s); then one more timeout
      const s = sim(lambda.findings, 'check.C6', lambda.design);
      expect(ev(s)).toMatchObject({ type: 'errors', atS: 20, forS: 482, node: 'lambda_function_worker' });
      expect(s.scenario.durationS).toBe(20 + 482 + 120 + 30);
      expect(s.args.for).toBe(482);
    });

    it('P2: the visibility scenario slows the consumer of the finding\'s line, not the first one', () => {
      const d = clone();
      d.nodes.push({ ...structuredClone(nodeOf(d, 'lambda_function_worker')), id: 'worker2', params: { maxConcurrency: 20, serviceMs: 500 } });
      // the finding's line now goes to worker2, the queue's only consumer
      d.edges = d.edges.filter((e) => !(e.from === 'sqs_queue_jobs' && e.to === 'lambda_function_worker'));
      d.edges.push({ id: 'e-worker2', from: 'sqs_queue_jobs', to: 'worker2' } as Design['edges'][number]);
      const f = { ...find(lambda.findings, 'check.C5.visibility'), lines: [{ id: 'e-worker2', kind: 'definite' }] };
      const s = scenarioFor(f, d);
      expect('none' in s ? s.none : ev(s)).toMatchObject({ type: 'slow', node: 'worker2', multiplier: 360 });
      // with two consumers the engine gives the messages to the first; no scenario
      d.edges.push({ id: 'e-worker1', from: 'sqs_queue_jobs', to: 'lambda_function_worker' } as Design['edges'][number]);
      expect(scenarioFor(f, d)).toEqual({ none: 'sharedQueue' });
    });

    it('P2: a slowdown the engine can make is offered even when the 1.5× margin does not fit', () => {
      // 30 s / 34.55 ms = 868×: under the engine's 1000×, so 1000× rather than "beyond the engine"
      const d = clone();
      nodeOf(d, 'sqs_queue_jobs').params!.visibilityTimeoutMs = 30000;
      expect(ev(sim(lambda.findings, 'check.C5.visibility', d))).toMatchObject({ type: 'slow', multiplier: 1000 });
    });

    it('P2: no scenario for a node no traffic reaches', () => {
      const d = clone();
      d.edges = d.edges.filter((e) => !(e.from === 'lambda_function_api' && e.to === 'sqs_queue_jobs'));
      expect(scenarioFor(find(lambda.findings, 'check.C6'), d)).toEqual({ none: 'unreachable' });
    });

    it('P2: C4.max uses the service as it is on the canvas now', () => {
      const d = structuredClone(ecs.design);
      d.nodes.find((n) => n.id === 'ecs_service_api')!.params!.concurrency = 80;
      // 50 × 80 / 10 ms = 400 000; × 0.7 = 280 000
      const s = sim(ecs.findings, 'check.C4.max', d);
      expect(s.args.max).toBe(280000);
      // 1.5 × 280 000 = 420 000, from the healthy 1081 rps (× 388.5)
      expect(Math.abs(Number(s.args.to) - 420000)).toBeLessThan(100);
    });

    it('P2: C5.caller uses the caller\'s timeout as it is on the canvas now', () => {
      const d = clone();
      const f = find(lambda.findings, 'check.C5.caller');
      (d.edges.find((e) => e.id === f.lines[0].id) as unknown as Record<string, unknown>).timeoutMs = 60000;
      const s = sim(lambda.findings, 'check.C5.caller', d);
      expect(ev(s)).toMatchObject({ multiplier: Math.ceil((1.5 * 60000) / 276.41) });
      expect(s.args.upS).toBe(60);
      d.edges = d.edges.filter((e) => e.id !== f.lines[0].id);
      expect(scenarioFor(f, d)).toEqual({ none: 'changed' });
    });

    it('P2: C8 uses the throttle rate as it is on the canvas now', () => {
      const d = clone();
      nodeOf(d, 'api_gateway_rest_api_main_throttle').params!.ratePerSec = 10000;
      expect(sim(lambda.findings, 'check.C8', d).scenario.traffic.rps).toBe(10000);
    });

    it('P2: C9 with a function behind the load balancer has no scenario (no health check of functions)', () => {
      const d = structuredClone(ecs.design);
      const n = d.nodes.find((x) => x.id === 'ecs_service_api')!;
      n.kind = 'function';
      n.params = { maxConcurrency: 10, serviceMs: 10 };
      expect(scenarioFor(find(ecs.findings, 'check.C9'), d)).toEqual({ none: 'noHealthCheck' });
    });
  });

  describe('review fixes', () => {
    const clone = () => structuredClone(lambda.design);
    const nodeOf = (d: Design, id: string) => d.nodes.find((n) => n.id === id)!;

    it('C5.caller runs until the last slowed call has timed out', () => {
      const d = clone();
      const f = find(lambda.findings, 'check.C5.caller');
      (d.edges.find((e) => e.id === f.lines[0].id) as unknown as Record<string, unknown>).timeoutMs = 180000;
      nodeOf(d, 'lambda_function_api').params!.serviceMs = 200;
      const s = sim(lambda.findings, 'check.C5.caller', d);
      expect(ev(s)).toMatchObject({ multiplier: 1000 });
      expect(s.scenario.durationS).toBe(20 + 60 + 180 + 30);
    });

    it('a scenario that needs more than an hour is not cut short', () => {
      const d = clone();
      nodeOf(d, 'sqs_queue_jobs').params!.visibilityTimeoutMs = 3600000;
      nodeOf(d, 'lambda_function_worker').params!.serviceMs = 4000;
      expect(scenarioFor(find(lambda.findings, 'check.C5.visibility'), d)).toEqual({ none: 'tooLong' });
    });

    it('queue failures last for the work time too: an attempt fails when it ends', () => {
      const d = clone();
      nodeOf(d, 'sqs_queue_jobs').params!.visibilityTimeoutMs = 1000;
      nodeOf(d, 'lambda_function_worker').params!.serviceMs = 30000;
      const s = sim(lambda.findings, 'check.C6', d);
      // a slot stays busy for the 30 s work: the 5th delivery starts at 4 × 30 s, ends at 150 s
      expect(ev(s)).toMatchObject({ type: 'errors', forS: 151 });
      expect(s.scenario.durationS).toBe(20 + 151 + 30 + 30);
    });
  });

  describe('review fixes', () => {
    const clone = () => structuredClone(lambda.design);
    const nodeOf = (d: Design, id: string) => d.nodes.find((n) => n.id === id)!;

    it('queue windows overlap the visibility timer with the work: a long visibility still fits', () => {
      const d = clone();
      nodeOf(d, 'sqs_queue_jobs').params!.visibilityTimeoutMs = 1200000;
      nodeOf(d, 'lambda_function_worker').params!.serviceMs = 600000;
      const s = sim(lambda.findings, 'check.C6', d);
      // 2 deliveries: 1 × max(1200 s, 600 s) + 600 s work = 1801 s; run 20 + 1801 + 1200 + 30
      expect(ev(s)).toMatchObject({ forS: 1801 });
      expect(s.scenario.durationS).toBe(3051);
    });

    it('C5.visibility: the longer of the timeout and the slowed work, not both added', () => {
      const d = clone();
      nodeOf(d, 'sqs_queue_jobs').params!.visibilityTimeoutMs = 1200000;
      nodeOf(d, 'lambda_function_worker').params!.serviceMs = 2000;
      const s = sim(lambda.findings, 'check.C5.visibility', d);
      expect(ev(s)).toMatchObject({ multiplier: 900 });
      // slowed work 900 × 2 s = 1800 s outlasts the 1200 s timeout
      expect(s.scenario.durationS).toBe(20 + 60 + 1800 + 30);
    });

    it('a second line to the same consumer, or a control line, is not a second consumer', () => {
      const f = find(lambda.findings, 'check.C5.visibility');
      const withWorker = (extra: Design['edges']) => {
        const d = clone();
        nodeOf(d, 'lambda_function_worker').params!.serviceMs = 500;
        d.nodes.push({ ...structuredClone(nodeOf(d, 'lambda_function_worker')), id: 'monitor' });
        d.edges.push(...extra);
        return scenarioFor(f, d);
      };
      const same = withWorker([{ id: 'e-dup', from: 'sqs_queue_jobs', to: 'lambda_function_worker' } as Design['edges'][number]]);
      expect('none' in same ? same.none : ev(same)).toMatchObject({ type: 'slow', node: 'lambda_function_worker' });
      const control = withWorker([{ id: 'e-ctl', from: 'sqs_queue_jobs', to: 'monitor', on: 'control' } as unknown as Design['edges'][number]]);
      expect('none' in control ? control.none : ev(control)).toMatchObject({ type: 'slow', node: 'lambda_function_worker' });
    });
  });

  it('C5.visibility runs until the slowed work started in the window has ended', () => {
    const d = structuredClone(lambda.design);
    d.nodes.find((n) => n.id === 'sqs_queue_jobs')!.params!.visibilityTimeoutMs = 300000;
    d.nodes.find((n) => n.id === 'lambda_function_worker')!.params!.serviceMs = 1000;
    const s = sim(lambda.findings, 'check.C5.visibility', d);
    // 450 × 1 s = 450 s of work > 300 s visibility
    expect(ev(s)).toMatchObject({ multiplier: 450 });
    expect(s.scenario.durationS).toBe(20 + 60 + 450 + 30);
  });

  it('a node removed on the canvas, or an incomplete finding: no scenario', () => {
    const d = structuredClone(ecs.design);
    d.nodes = d.nodes.filter((n) => n.id !== 'db_instance_main');
    expect(scenarioFor(find(ecs.findings, 'check.C3.db'), d)).toEqual({ none: 'missingNode' });
    const inc: Finding = { ...find(ecs.findings, 'check.C3.db'), id: 'check.incomplete', certainty: 'incomplete' };
    expect(scenarioFor(inc, ecs.design)).toEqual({ none: 'incomplete' });
  });
});
