// #69: routing by API. The design names its APIs; an edge can carry only some of them.
import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine/index.ts';
import { apiTraffic, checkDesign, type Design, type DesignApi } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';

const APIS: DesignApi[] = [
  { name: 'feed', op: 'read', share: 7 },
  { name: 'upload', op: 'write', share: 3 },
];
const svc = (ms: number) => ({ instances: 1, concurrency: 50, queueLimit: 50, serviceMs: { mean: ms, cv: 0 } });
const run = (d: Design, events: NonNullable<Parameters<typeof scenario>[0]['events']> = []) =>
  simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 200, clientTimeoutMs: 1000 }, events }));
/** Node and edge totals count calls made in the measured time; a request sent just before its end can be one off. */
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(2);

/** users → gateway → feed service (feed only) and upload service (upload only). */
const gateway = () =>
  design(
    [
      ['u', 'client'],
      ['gw', 'api_gateway'],
      ['feed', 'service', svc(2)],
      ['up', 'service', svc(2)],
      ['db', 'database'],
      ['s3', 'object_storage'],
    ],
    [['u', 'gw'], ['gw', 'feed', { apis: ['feed'] }], ['gw', 'up', { apis: ['upload'] }], ['feed', 'db'], ['up', 's3']],
    'test',
    APIS,
  );

describe('routing by API', () => {
  it('each request calls one API, by share; the gateway sends it on the edge for that API', () => {
    const r = run(gateway());
    expect(r.apis).toBeDefined();
    const { feed, upload } = r.apis!;
    expect(feed.op).toBe('read');
    expect(upload.op).toBe('write');
    expect(feed.offered + upload.offered).toBe(r.summary.offered);
    expect(feed.offered / r.summary.offered).toBeGreaterThan(0.65);
    expect(feed.offered / r.summary.offered).toBeLessThan(0.75);
    // every feed request went to the feed service, every upload to the upload service
    near(r.edges['gw->feed@feed'].calls, feed.offered);
    near(r.edges['gw->up@upload'].calls, upload.offered);
    near(r.nodes.s3.ok, upload.offered);
  });

  it('a slow upload service does not hurt the feed API', () => {
    const r = run(gateway(), [{ type: 'slow', atS: 0, node: 'up', multiplier: 1000 }]);
    expect(r.apis!.feed.errorRate).toBe(0);
    expect(r.apis!.feed.latencyMs.p99).toBeLessThan(20);
    expect(r.apis!.upload.errorRate).toBeGreaterThan(0.9);
  });

  it('one service calls a different store per API', () => {
    const d = design(
      [['u', 'client'], ['api', 'service', svc(1)], ['db', 'database'], ['s3', 'object_storage']],
      [['u', 'api'], ['api', 'db', { apis: ['feed'] }], ['api', 's3', { apis: ['upload'] }]],
      'test',
      APIS,
    );
    const r = run(d);
    near(r.nodes.db.ok, r.apis!.feed.offered);
    near(r.nodes.s3.ok, r.apis!.upload.offered);
  });

  it('a design without APIs reports no per-API stats', () => {
    const d = gateway();
    delete d.apis;
    d.edges = d.edges.map(({ apis: _a, ...e }) => e);
    expect(run(d).apis).toBeUndefined();
  });

  it('checks: an unknown API name is an error; an API with no way on at a router is a warning', () => {
    const d = gateway();
    d.edges[1] = { ...d.edges[1], apis: ['fed'] };
    expect(checkDesign(d).filter((i) => i.level === 'error').map((i) => i.code)).toContain('unknown-api');
    // feed reaches the gateway, but no edge out of it carries feed
    const d2 = gateway();
    d2.edges[1] = { ...d2.edges[1], apis: ['upload'] };
    expect(checkDesign(d2).filter((i) => i.node === 'gw').map((i) => i.code)).toContain('api-dead-end');
    expect(checkDesign(gateway()).map((i) => i.code)).not.toContain('api-dead-end');
  });
});

describe('each client calls its own APIs', () => {
  it('a client draws only among the APIs its edges carry', () => {
    const d = design(
      [['app', 'client'], ['web', 'client'], ['api', 'service', svc(1)], ['cdn', 'cdn'], ['db', 'database'], ['s3', 'object_storage']],
      [['app', 'api', { apis: ['feed', 'upload'] }], ['web', 'cdn', { apis: ['photo'] }], ['api', 'db'], ['cdn', 's3']],
      'test',
      [...APIS, { name: 'photo', op: 'read', share: 100 }],
    );
    const r = run(d);
    // photo has the largest share, but only the web client can call it, and web calls nothing else
    expect(r.nodes.api.ok + r.nodes.api.fail).toBe(r.apis!.feed.offered + r.apis!.upload.offered);
    expect(r.apis!.feed.offered / (r.apis!.feed.offered + r.apis!.upload.offered)).toBeGreaterThan(0.65);
    expect(r.apis!.photo.offered).toBeGreaterThan(r.summary.offered * 0.4);
    expect(r.summary.errorRate).toBe(0);
    // the editor's "share of all traffic" is what the engine draws
    const share = apiTraffic(d);
    expect(share.photo).toBeCloseTo(0.5, 5);
    expect(share.feed).toBeCloseTo(0.35, 5);
    for (const [name, a] of Object.entries(r.apis!)) expect(Math.abs(a.offered / r.summary.offered - share[name]), name).toBeLessThan(0.02);
  });
});

describe('review fixes', () => {
  it('a queued message keeps its API, so the worker follows only the edges for that API', () => {
    const d = design(
      [['u', 'client'], ['q', 'queue'], ['w', 'worker', { concurrency: 16, serviceMs: { mean: 1, cv: 0 } }], ['db', 'database'], ['s3', 'object_storage']],
      [['u', 'q'], ['q', 'w'], ['w', 'db', { apis: ['post'] }], ['w', 's3', { apis: ['photo'] }]],
      'test',
      [{ name: 'post', op: 'write', share: 1 }, { name: 'photo', op: 'write', share: 1 }],
    );
    const r = simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 0, clientTimeoutMs: 1000 } }));
    const { post, photo } = r.apis!;
    // each job calls one store: the one for its API. Without the API, a job could take either edge.
    expect(Math.abs(r.edges['w->db@post'].calls - post.offered)).toBeLessThan(post.offered * 0.03);
    expect(Math.abs(r.edges['w->s3@photo'].calls - photo.offered)).toBeLessThan(photo.offered * 0.03);
  });
});

describe('review fixes: an edge with weight 0 does not make an API usable', () => {
  it('a client sends no requests for an API whose only edge has weight 0', () => {
    const d = design(
      [['u', 'client'], ['api', 'service', svc(1)], ['db', 'database'], ['s3', 'object_storage']],
      [['u', 'api', { apis: ['feed'] }], ['u', 's3', { apis: ['upload'], weight: 0 }], ['api', 'db']],
      'test',
      APIS,
    );
    const r = run(d);
    expect(r.apis!.upload.offered).toBe(0);
    expect(r.summary.errorRate).toBe(0);
    expect(apiTraffic(d)).toEqual({ feed: 1, upload: 0 });
  });
});

describe('review fixes: a client whose API edges all have weight 0 calls no API', () => {
  it('no API is offered, and the traffic table gives that client no API', () => {
    const d = design(
      [['u', 'client'], ['v', 'client'], ['api', 'service', svc(1)], ['db', 'database'], ['s3', 'object_storage']],
      [['u', 'api', { apis: ['feed'], weight: 0 }], ['u', 's3', { apis: ['upload'], weight: 0 }], ['v', 'api', { apis: ['feed'] }], ['api', 'db']],
      'test',
      APIS,
    );
    const r = run(d);
    expect(r.apis!.upload.offered).toBe(0);
    // only v's requests call feed; u's requests call no API
    expect(r.apis!.feed.offered).toBeLessThan(r.summary.offered * 0.6);
    expect(r.apis!.feed.offered).toBeGreaterThan(r.summary.offered * 0.4);
    expect(apiTraffic(d)).toEqual({ feed: 0.5, upload: 0 });
  });
});

describe('review fixes: a client with no API to call sends nothing down API edges', () => {
  it('a write-only edge does not carry requests of a client whose APIs are all reads', () => {
    const d = design(
      [['u', 'client'], ['api', 'service', svc(1)], ['db', 'database']],
      [['u', 'api', { on: 'write' }], ['api', 'db']],
      'test',
      [{ name: 'feed', op: 'read', share: 1 }],
    );
    const r = run(d);
    expect(apiTraffic(d)).toEqual({ feed: 0 });
    expect(r.apis!.feed.offered).toBe(0);
    expect(r.nodes.api.arrivals).toBe(0);
    expect(r.edges['u->api:write'].calls).toBe(0);
  });
});
