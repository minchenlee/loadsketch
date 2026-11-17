// The three file formats (design, scenario, result) and their validation.
// Agents write designs and scenarios as JSON; the JSON Schema files in /schema are generated from here.

import { z } from 'zod';
import { stripContext, t } from '../i18n/index.ts';
import { CLIENT_EDGE_LATENCY_MS, EDGE_PARAMS, INTER_REGION_MS, KINDS, KIND_NAMES, fanoutApplies, resolveParams, type ParamSpec } from './kinds.ts';

export { INTER_REGION_MS };
export const DESIGN_SCHEMA = 'loadsketch/design@1';
export const SCENARIO_SCHEMA = 'loadsketch/scenario@1';
export const RESULT_SCHEMA = 'loadsketch/result@1';

/** An id: node, edge and API names. The editor checks names with the same rule. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const Id = z
  .string()
  .regex(ID_RE, { error: () => t('id: start with a letter or digit; use only letters, digits, underscore and hyphen; at most 48 characters') })
  .describe('Unique id. Letters, digits, _ and -. Max 48 chars.');
const Pos = z.tuple([z.number(), z.number()]).describe('Canvas position [x, y] in pixels.');
const DistSchema = z.union([
  z.number().min(0).describe('Mean in ms (cv keeps its default).'),
  z.strictObject({
    mean: z.number().min(0).describe('Mean in ms.'),
    cv: z.number().min(0).max(4).optional().describe('Coefficient of variation: 0 fixed, 1 exponential.'),
  }),
]);

// Where values came from (G2, Q7): written by the IaC importer, optional, absent from hand-made designs.
/** Terraform addresses can hold long for_each keys. */
const Address = z.string().min(1).max(2000);
/** As many as a node can have instances (KINDS `instances` max). */
export const MAX_SOURCE_FROM = 1000;
/** iac = written in the IaC; aws-default = an AWS or provider default (with `ref`); estimate = the
 *  importer's guess; answer = the user's answer file; loadsketch-default = not set, the kind's default. */
export const EVIDENCE = ['iac', 'aws-default', 'estimate', 'answer', 'loadsketch-default'] as const;
const ParamSourceSchema = z.strictObject({
  evidence: z.enum(EVIDENCE),
  role: z.enum(['setting', 'assumption']).describe('setting: a configured value or limit; assumption: a performance assumption (time, concurrency).'),
  from: Address.optional().describe('Resource attribute it came from, e.g. aws_appautoscaling_target.api.max_capacity.'),
  ref: z.string().min(1).max(500).optional().describe('Where an aws-default or a table value is written down.'),
  measured: z.literal(true).optional().describe('The answer file says the value was measured.'),
});
const NodeSourceSchema = z
  .strictObject({
    from: z.array(Address).max(MAX_SOURCE_FROM).describe('Resource addresses this node stands for (empty for a generated node; `x[*]` for a whole count/for_each block when there are more).'),
    params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,47}$/), ParamSourceSchema).optional(),
  })
  .optional()
  .describe('Set by `loadsketch import`: where the node and its params came from.');
const EdgeSourceSchema = z
  .strictObject({
    line: z.enum(['definite', 'presumed', 'candidate', 'generated', 'answer']).describe('definite: explicit wiring; presumed: an environment variable references it; candidate: only a security group allows it; generated: the client; answer: added by the answer file.'),
    confirmed: z.literal(true).optional().describe('The answer file confirms this line.'),
    via: z.array(Address).max(20).optional(),
    params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,47}$/), ParamSourceSchema).optional(),
  })
  .optional()
  .describe('Set by `loadsketch import`: what the line is based on.');

function paramSchema(p: ParamSpec): z.ZodType {
  // the inspector shows the unit next to the field; the schema puts it in the label
  const unit = p.type === 'dist' ? 'ms' : 'unit' in p && p.unit ? p.unit : '';
  const d = `${stripContext(p.label)}${unit ? ` (${unit})` : ''}. ${p.help}${p.type === 'dist' ? ' Write a number (mean in ms), or { mean, cv }; cv is the coefficient of variation, 1 = exponential, 0 = fixed.' : ''}`;
  switch (p.type) {
    case 'int':
      return z.int().min(p.min).max(p.max).optional().describe(`${d} (default ${p.default})`);
    case 'number':
      return z.number().min(p.min).max(p.max).optional().describe(`${d} (default ${p.default})`);
    case 'ratio':
      return z.number().min(0).max(1).optional().describe(`${d} (0–1, default ${p.default})`);
    case 'dist':
      return DistSchema.optional().describe(`${d} (default mean ${p.default.mean} ms, cv ${p.default.cv})`);
    case 'enum':
      return z
        .enum(p.options.map((o) => o.value) as [string, ...string[]])
        .optional()
        .describe(`${d} (default ${p.default})`);
  }
}

const nodeSchemas = KIND_NAMES.map((kind) => {
  const spec = KINDS[kind];
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(spec.params)) shape[name] = paramSchema(p);
  return z
    .strictObject({
      id: Id,
      kind: z.literal(kind),
      label: z.string().max(60).optional().describe('Display name.'),
      region: Id.optional().describe('Region (data center) the node runs in, for example "us-east". A call between two regions takes interRegionMs; a region_down event takes the whole region down.'),
      ...(kind === 'database' || kind === 'sharded_db'
        ? { replicaRegion: Id.optional().describe('Region of the read replicas when it differs from the primary\'s region. Replication to them takes interRegionMs longer; a region_down there takes only the replicas down.') }
        : {}),
      pos: Pos,
      params: z.strictObject(shape).optional(),
      source: NodeSourceSchema,
    })
    .describe(`${spec.labelEn}: ${spec.summary}`);
});

export const NodeSchema = z.discriminatedUnion('kind', nodeSchemas as unknown as [z.ZodObject, ...z.ZodObject[]]);

const edgeShape: Record<string, z.ZodType> = {
  id: Id.optional().describe('Optional. Default: "<from>-><to>", plus ":read", ":write" or ":boot" when filtered.'),
  from: Id,
  to: Id,
};
for (const [name, p] of Object.entries(EDGE_PARAMS)) edgeShape[name] = paramSchema(p);
edgeShape.source = EdgeSourceSchema;
edgeShape.apis = z.array(Id).min(1).max(20).optional()
  .describe('Only requests to these APIs (names from the design\'s `apis`) take this edge. Omit: every API. Like path-based routing in a gateway or a service that calls different stores per endpoint.');
export const EdgeSchema = z.strictObject(edgeShape);

export const ApiSchema = z.strictObject({
  name: Id.describe('A short name, like "feed" or "upload". Edges list it in their `apis`.'),
  op: z.enum(['read', 'write']).describe('Whether a call to this API reads or writes.'),
  share: z.number().min(0).max(1000).optional().describe('Its weight in the traffic mix (default 1). Shares are relative: 7 and 3 mean 70% and 30%.'),
  label: z.string().max(120).optional(),
});

export const NoteSchema = z.strictObject({
  id: Id,
  text: z.string().max(4000),
  pos: Pos,
  width: z.number().min(80).max(2000).optional(),
});

export const DesignSchema = z
  .strictObject({
    schema: z.literal(DESIGN_SCHEMA),
    name: z.string().min(1).max(120),
    description: z.string().max(8000).optional(),
    interRegionMs: z.number().min(0).max(1000).optional().describe(`One-way latency of a call between nodes in different regions, ms (default ${INTER_REGION_MS}). An edge's own latencyMs wins.`),
    apis: z.array(ApiSchema).min(1).max(20).optional()
      .describe('The APIs users call, with their share of the traffic. When set, every request calls one of them and the scenario\'s readRatio is not used: each API says whether it reads or writes. An edge with `apis` carries only those; a client calls only the APIs its edges carry, by their shares.'),
    nodes: z.array(NodeSchema).max(300),
    edges: z.array(EdgeSchema).max(2000),
    notes: z.array(NoteSchema).max(200).optional(),
  })
  .describe('A system design: components (nodes) and the calls between them (edges).');

const atS = z.number().min(0).describe('Start time in seconds.');
const forS = z.number().min(0).describe('Duration in seconds. Omit for "until the end".');
export const ScenarioEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('spike'), atS, forS: forS.optional(), multiplier: z.number().min(0).max(1000) })
    .describe('Multiply traffic by `multiplier` during the window.'),
  z.strictObject({ type: z.literal('ramp'), atS, forS, toMultiplier: z.number().min(0).max(1000) })
    .describe('Raise traffic linearly from 1× to `toMultiplier` over forS seconds, then hold.'),
  z.strictObject({ type: z.literal('down'), atS, forS: forS.optional(), node: Id, instance: z.int().min(0).optional() })
    .describe('Take a node (or one instance; for databases 0 is the primary, 1.. replicas) down.'),
  z.strictObject({ type: z.literal('region_down'), atS, forS: forS.optional(), region: Id })
    .describe('Take every node of a region down (a whole data center fails). Clients are users and stay up.'),
  z.strictObject({ type: z.literal('slow'), atS, forS: forS.optional(), node: Id, instance: z.int().min(0).optional(), multiplier: z.number().min(0).max(1000) })
    .describe('Multiply the node\'s processing times (or one instance\'s: a gray failure).'),
  z.strictObject({ type: z.literal('errors'), atS, forS: forS.optional(), node: Id, instance: z.int().min(0).optional(), rate: z.number().min(0).max(1) })
    .describe('Override the node\'s error rate (or one instance\'s: a gray failure).'),
  z.strictObject({
    type: z.literal('wave'),
    atS,
    forS: forS.optional(),
    periodS: z.number().min(1).max(86400).describe('Seconds per cycle (a compressed day).'),
    amplitude: z.number().min(0).max(1).describe('Swing around 1×: 0.5 means 0.5× to 1.5×.'),
  }).describe('Daily (diurnal) traffic: multiply by 1 + amplitude × sin(2π(t − atS) / periodS).'),
  z.strictObject({
    type: z.literal('cron'),
    atS,
    forS: forS.optional(),
    everyS: z.number().min(1).max(86400).describe('Seconds between bursts.'),
    burstS: z.number().min(0.01).max(3600).describe('Seconds the burst lasts when every client fires at once.'),
    multiplier: z.number().min(1).max(1000).describe('Traffic multiplier during an unjittered burst.'),
    jitterS: z.number().min(0).max(3600).optional().describe('Spread each burst over burstS + jitterS seconds; same extra requests, lower peak.'),
  }).refine((e) => e.burstS + (e.jitterS ?? 0) <= e.everyS, { message: 'burstS + jitterS must not exceed everyS' })
    .describe('Scheduled jobs that all fire at the same time (for example every hour).'),
  z.strictObject({
    type: z.literal('shift'),
    atS,
    forS: forS.optional().describe('Seconds the weight takes to move, linearly (a gradual rollout). Omit or 0: at once.'),
    from: Id,
    to: Id,
    weight: z.number().min(0).max(1000).describe('The new weight of the edge (every edge from → to).'),
  }).describe('Move traffic: change the weight of the edge from → to. A client, DNS, load balancer or router splits its traffic by the weights of its edges, so this is a canary, a blue-green cutover or a region evacuation. The weight stays after forS.'),
  z.strictObject({
    type: z.literal('rollout'),
    atS,
    node: Id.optional().describe('The component to update. Omit: a global push to every API gateway, API server and worker at once (like a config file pushed everywhere).'),
    waves: z.int().min(1).max(20).optional().describe('Waves of the staged rollout (default 1: every instance at once). Wave w updates the first ceil(w / waves) of each target\'s instances.'),
    waveS: z.number().min(1).max(3600).optional().describe('Seconds each wave bakes before the next one (and before the halt check; default 60).'),
    slow: z.number().min(1).max(1000).optional().describe('The new version is this many times slower (default 1).'),
    errorRate: z.number().min(0).max(1).optional().describe('Extra error rate of the new version (default 0).'),
    crash: z.boolean().optional().describe('The new version crashes at start: updated instances go down.'),
    haltAt: z.number().min(0).max(1).optional().describe('Automatic rollback: after a wave bakes, if the updated instances failed more than this share of their requests (a crash always counts), every update is rolled back and the rollout stops. Omit: no check.'),
  }).describe('Deploy a new version (code or config), wave by wave. A bad version is slower, fails more, or crashes. Staged waves with a halt check limit the blast radius; one wave to everything is a global push.'),
  z.strictObject({
    type: z.literal('reshard'),
    atS,
    forS: z.number().min(0).max(86400).optional().describe('Seconds the data copy to the new layout takes (default 60). Keys move at the end (the cutover).'),
    node: Id.describe('A sharded database.'),
    toShards: z.int().min(1).max(256).describe('Shards after the cutover.'),
    copyLoad: z.number().min(0).max(10).optional().describe('Extra work of the copy while it runs: every shard is this much slower (0.5: 1.5 times the time; default 0.5).'),
  }).describe('Resharding: split or merge the shards of a sharded database while it serves. The copy makes every shard slower for forS; then the keys are spread over toShards shards (a key goes to key mod toShards).'),
  z.strictObject({
    type: z.literal('partition'),
    atS,
    forS: forS.optional(),
    regions: z.tuple([Id, Id]).describe('The two regions the network between is cut.'),
  }).describe('Network partition: calls and replication between the two regions are lost (callers time out); users reach both sides. A database with automatic failover and replicas on the other side promotes one there after failoverS while the old primary keeps taking writes from its side (split brain), unless its fencing is on.'),
  z.strictObject({
    type: z.literal('pause'),
    atS,
    forS: forS.optional(),
    node: Id,
    everyS: z.number().min(0.1).max(3600).describe('Seconds between pauses.'),
    pauseMs: z.number().min(1).max(60000).describe('Length of each stop-the-world pause.'),
  }).refine((e) => e.pauseMs < e.everyS * 1000, { message: 'pauseMs must be shorter than everyS' })
    .describe('Periodic stop-the-world pauses (garbage collection): the node does no work while paused.'),
]);

export const ScenarioSchema = z
  .strictObject({
    schema: z.literal(SCENARIO_SCHEMA),
    name: z.string().max(120).optional(),
    seed: z.int().min(0).max(2 ** 31).optional().describe('Random seed (default 1). Same seed + same design = same result.'),
    durationS: z.number().min(1).max(3600).optional().describe('Seconds of traffic (default 60).'),
    warmupS: z.number().min(0).max(3600).optional().describe('Seconds excluded from summary stats (default 5).'),
    windowS: z.number().min(0.1).max(60).optional().describe('Seconds per time-series window (default 1).'),
    traffic: z.strictObject({
      rps: z.number().min(0).max(1000000).describe('Requests per second across all clients.'),
      readRatio: z.number().min(0).max(1).optional().describe('Share of reads (default 0.9).'),
      clientTimeoutMs: z.number().min(1).max(600000).optional().describe('End-to-end timeout per request (default 3000).'),
      arrivals: z.enum(['poisson', 'constant']).optional().describe('Random (default) or evenly spaced arrivals.'),
      followReads: z.number().min(0).max(1).optional().describe('Share of successful writes the same user follows with a read of the same key (read-your-writes check; default 0). With APIs, the read calls the first read API in the client\'s mix.'),
      followAfterMs: z.number().min(0).max(600000).optional().describe('How long after its write the follow-up read is sent (default 100).'),
    }),
    keys: z
      .strictObject({
        count: z.int().min(1).max(1000000).describe('Number of distinct keys (default 100000).'),
        zipf: z.number().min(0).max(3).optional().describe('Popularity skew: 0 uniform, ~1 a few keys are very hot (default 0.8).'),
      })
      .optional(),
    events: z.array(ScenarioEventSchema).max(200).optional(),
    scale: z
      .union([z.number().min(1).max(1000), z.literal('auto')])
      .optional()
      .describe('Simulate 1/k of the traffic on 1/k of the capacity, then multiply the counts by k. auto (default): pick k so the run has about 300 000 requests. k stops where slots per instance reach 32, then instances reach 10. 1: full size.'),
  })
  .describe('Traffic and events to run a design against.');

// The node and edge shapes are built from the catalog at runtime, so their static types are written out here.
export type ParamValue = number | string | { mean: number; cv?: number };
export interface DesignNode {
  id: string;
  kind: string;
  label?: string;
  region?: string;
  /** Database: region of the read replicas, when not the node's region. */
  replicaRegion?: string;
  pos: [number, number];
  params?: Record<string, ParamValue>;
  /** Set by `loadsketch import`: where the node and its params came from. */
  source?: NodeSource;
}
export type Evidence = (typeof EVIDENCE)[number];
export interface ParamSource { evidence: Evidence; role: 'setting' | 'assumption'; from?: string; ref?: string; measured?: true }
export interface NodeSource { from: string[]; params?: Record<string, ParamSource> }
export interface EdgeSource { line: 'definite' | 'presumed' | 'candidate' | 'generated' | 'answer'; confirmed?: true; via?: string[]; params?: Record<string, ParamSource> }
export interface DesignEdge {
  id?: string;
  from: string;
  to: string;
  on?: 'all' | 'read' | 'write' | 'boot' | 'control';
  weight?: number;
  latencyMs?: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  retryBudget?: number;
  throttleK?: number;
  bulkhead?: number;
  fallback?: 'off' | 'on';
  hedgeMs?: number;
  /** Time to open a new connection (TCP + TLS handshakes), ms; reused while keepAlive is on. */
  connectMs?: number;
  keepAlive?: 'on' | 'off';
  idleS?: number;
  /** Send each call to this many shards or instances of the target at once (0: one). */
  fanout?: number;
  /** With fanout: answer when this many copies succeeded (0: all of them). */
  quorum?: number;
  /** Only requests to these APIs take this edge. */
  apis?: string[];
  /** Set by `loadsketch import`: what the line is based on. */
  source?: EdgeSource;
}
export interface DesignApi {
  name: string;
  op: 'read' | 'write';
  share?: number;
  label?: string;
}
export interface DesignNote {
  id: string;
  text: string;
  pos: [number, number];
  width?: number;
}
export interface Design {
  schema: typeof DESIGN_SCHEMA;
  name: string;
  description?: string;
  interRegionMs?: number;
  apis?: DesignApi[];
  nodes: DesignNode[];
  edges: DesignEdge[];
  notes?: DesignNote[];
}
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioEvent = z.infer<typeof ScenarioEventSchema>;

export interface ResolvedScenario {
  name: string;
  seed: number;
  durationS: number;
  warmupS: number;
  windowS: number;
  rps: number;
  readRatio: number;
  clientTimeoutMs: number;
  arrivals: 'poisson' | 'constant';
  followReads: number;
  followAfterMs: number;
  keyCount: number;
  zipf: number;
  events: ScenarioEvent[];
}

export function resolveScenario(s: Scenario): ResolvedScenario {
  const durationS = s.durationS ?? 60;
  const warmupS = Math.min(s.warmupS ?? 5, durationS / 2);
  // Stats are summed over whole windows after the warm-up (rounded up to a window boundary).
  // At least one whole window must fit before the traffic ends; otherwise use a shorter window.
  // warmupS ≤ durationS / 2, so a window of warmupS (or durationS without warm-up) always fits.
  let windowS = s.windowS ?? 1;
  if (Math.ceil(warmupS / windowS - 1e-9) * windowS + windowS > durationS + 1e-9) windowS = warmupS > 0 ? warmupS : durationS;
  return {
    name: s.name ?? '',
    seed: s.seed ?? 1,
    durationS,
    warmupS,
    windowS,
    rps: s.traffic.rps,
    readRatio: s.traffic.readRatio ?? 0.9,
    clientTimeoutMs: s.traffic.clientTimeoutMs ?? 3000,
    arrivals: s.traffic.arrivals ?? 'poisson',
    followReads: s.traffic.followReads ?? 0,
    followAfterMs: s.traffic.followAfterMs ?? 100,
    keyCount: s.keys?.count ?? 100000,
    zipf: s.keys?.zipf ?? 0.8,
    events: s.events ?? [],
  };
}

/**
 * The share of all traffic that calls each API, as the engine draws it: a client is picked by its
 * weight, then one of the APIs its edges with a positive weight carry, by their shares (none: no API).
 */
export function apiTraffic(d: Pick<Design, 'apis' | 'nodes' | 'edges'>): Record<string, number> {
  const apis = (d.apis ?? []).filter((a) => (a.share ?? 1) > 0);
  const out: Record<string, number> = Object.fromEntries((d.apis ?? []).map((a) => [a.name, 0]));
  const clients = d.nodes.filter((n) => n.kind === 'client');
  const weight = (n: DesignNode) => Number(n.params?.weight ?? 1);
  const total = clients.reduce((t, c) => t + weight(c), 0);
  if (!apis.length || !total) return out;
  for (const c of clients) {
    const edges = d.edges.filter((e) => e.from === c.id);
    const takes = (a: DesignApi) => edges.some((e) => Number(e.weight ?? 1) > 0 && !sideEdge(e) && (!e.apis?.length || e.apis.includes(a.name)) && (e.on ?? 'all') !== (a.op === 'read' ? 'write' : 'read'));
    const list = apis.filter(takes);
    if (!list.length) continue;
    const sum = list.reduce((t, a) => t + (a.share ?? 1), 0);
    for (const a of list) out[a.name] += (weight(c) / total) * ((a.share ?? 1) / sum);
  }
  return out;
}

/** A boot or control edge: only the node's own boot or control calls take it, never requests. */
export const sideEdge = (e: { on?: string }): boolean => e.on === 'boot' || e.on === 'control';

export function edgeId(e: { id?: string; from: string; to: string; on?: string; apis?: string[] }): string {
  if (e.id) return e.id;
  return `${e.from}->${e.to}${e.on && e.on !== 'all' ? `:${e.on}` : ''}${e.apis?.length ? `@${e.apis.join('+')}` : ''}`;
}

/** Nodes in two different regions (a client is a user, not in a region). */
export function crossRegion(from: { kind: string; region?: string }, to: { region?: string }): boolean {
  return from.kind !== 'client' && !!from.region && !!to.region && from.region !== to.region;
}

/**
 * One-way latency of an edge: its own latencyMs; else the inter-region latency when it joins two
 * regions; else the default (more from a client: the internet).
 */
export function edgeLatencyMs(e: { latencyMs?: number }, from: { kind: string; region?: string }, to: { region?: string } = {}, interRegionMs = INTER_REGION_MS): number {
  if (e.latencyMs !== undefined) return e.latencyMs;
  if (crossRegion(from, to)) return interRegionMs;
  return from.kind === 'client' ? CLIENT_EDGE_LATENCY_MS : (EDGE_PARAMS.latencyMs.default as number);
}

/** The regions the nodes are in, in order of first use. */
export function regionsOf(d: { nodes: { region?: string; replicaRegion?: string }[] }): string[] {
  return [...new Set(d.nodes.flatMap((n) => [n.region, n.replicaRegion]).filter((r): r is string => !!r))];
}

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  node?: string;
  edge?: string;
  path?: string;
}

/** Instances a node has at run time (for databases: primary + replicas, per shard). */
/**
 * Display name of each instance of a node, in the engine's instance order (must match
 * Simulation.makeInstances; a test checks this). Empty for nodes without instances.
 */
export function instanceRoles(n: DesignNode): string[] {
  const spec = KINDS[n.kind];
  if (!spec?.station) return [];
  const p = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
  if (n.kind === 'database' || n.kind === 'sharded_db') {
    const shards = n.kind === 'sharded_db' ? (p.shards as number) : 1;
    const per = 1 + (p.replicas as number);
    const out: string[] = [];
    for (let sh = 0; sh < shards; sh++) {
      for (let r = 0; r < per; r++) {
        const role = r === 0 ? t('Primary') : t('Replica {r}', { r });
        out.push(shards > 1 ? t('Shard {s} {role}', { s: sh, role }) : role);
      }
    }
    return out;
  }
  const base = n.kind === 'object_storage' ? 1 : (p.instances as number);
  // an autoscaled node has room for all its possible instances (the extra ones start off)
  const count = p.autoscale === 'on' ? Math.max(base, p.maxInstances as number) : base;
  return Array.from({ length: count }, (_, i) => (count > 1 ? `#${i}` : ''));
}

export function instanceCount(n: DesignNode): number {
  return KINDS[n.kind]?.station ? Math.max(1, instanceRoles(n).length) : 1;
}

/**
 * Semantic checks that JSON Schema cannot express. Errors block a run; warnings are advice.
 * Messages are in Traditional Chinese because the user reads them.
 */
export function checkDesign(d: Design): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, DesignNode>();
  for (const n of d.nodes) {
    if (byId.has(n.id)) issues.push({ level: 'error', code: 'duplicate-node', node: n.id, message: t('Duplicate node id "{id}".', { id: n.id }) });
    byId.set(n.id, n);
    const rp = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
    if (n.replicaRegion && !rp.replicas)
      issues.push({ level: 'warning', code: 'replica-region', node: n.id, message: t('"{name}" has a replica region but no read replicas.', { name: n.label ?? n.id }) });
    if (rp.failover === 'auto' && (!rp.replicas || !Number(rp.replicaApplyRatio)))
      issues.push({ level: 'warning', code: 'failover-no-replica', node: n.id, message: t('"{name}" has automatic failover on but no read replicas (or a replica apply cost of 0), so no replica can become the primary.', { name: n.label ?? n.id }) });
    if (rp.autoscale === 'on' && Number(rp.maxInstances) < Number(rp.instances))
      issues.push({ level: 'warning', code: 'autoscale-max', node: n.id, message: t('The max instances of "{name}" ({max}) is less than its min instances ({min}), so it will not scale.', { name: n.label ?? n.id, max: String(rp.maxInstances), min: String(rp.instances) }) });
  }
  const apiNames = new Set<string>();
  for (const a of d.apis ?? []) {
    if (apiNames.has(a.name)) issues.push({ level: 'error', code: 'duplicate-api', message: t('API "{name}" is listed twice.', { name: a.name }) });
    apiNames.add(a.name);
  }
  if (d.apis?.length && !d.apis.some((a) => (a.share ?? 1) > 0)) issues.push({ level: 'error', code: 'api-no-share', message: t('Every API has a share of 0: there is no traffic to run.') });
  const edgeIds = new Set<string>();
  const out = new Map<string, DesignEdge[]>();
  const inc = new Map<string, DesignEdge[]>();
  for (const e of d.edges as DesignEdge[]) {
    const id = edgeId(e);
    if (edgeIds.has(id)) issues.push({ level: 'error', code: 'duplicate-edge', edge: id, message: t('Edge "{id}" is a duplicate.', { id }) });
    edgeIds.add(id);
    if (!byId.has(e.from)) issues.push({ level: 'error', code: 'unknown-node', edge: id, message: t('Edge "{id}" has no start node "{from}".', { id, from: e.from }) });
    if (!byId.has(e.to)) issues.push({ level: 'error', code: 'unknown-node', edge: id, message: t('Edge "{id}" has no end node "{to}".', { id, to: e.to }) });
    if (e.from === e.to) issues.push({ level: 'error', code: 'self-loop', edge: id, message: t('Edge "{id}" connects to itself.', { id }) });
    for (const a of e.apis ?? []) {
      if (!apiNames.has(a)) issues.push({ level: 'error', code: 'unknown-api', edge: id, message: t('Edge "{id}" carries API "{api}", but the design has no such API.', { id, api: a }) });
    }
    if (e.apis?.length && byId.get(e.from)?.kind === 'queue')
      issues.push({ level: 'warning', code: 'queue-edge-api', edge: id, message: t('Edge "{id}" leaves a queue: the queue gives each message to any worker, whatever its API. Split by API on the edge into the queue.', { id }) });
    if (byId.get(e.from)?.kind === 'queue' && (e.timeoutMs || e.retries || e.throttleK || e.bulkhead || e.fallback === 'on' || e.hedgeMs)) {
      issues.push({ level: 'warning', code: 'queue-edge-timeout', edge: id, message: t('Connection "{id}" starts at a queue: the queue hands messages to the worker and ignores this connection\'s timeout, retries, adaptive throttling, bulkhead, fallback and hedged requests.', { id }) });
    }
    if (e.on === 'boot' && byId.get(e.from)?.params?.autoscale !== 'on') {
      issues.push({ level: 'warning', code: 'boot-no-autoscale', edge: id, message: t('Edge "{id}" is used only at boot, but "{from}" does not autoscale: it starts no new instances, so this edge has no effect.', { id, from: e.from }) });
    }
    if (e.on === 'control') {
      const f = byId.get(e.from);
      const p = f?.params ?? {};
      const controls = p.autoscale === 'on' || ((f?.kind === 'database' || f?.kind === 'sharded_db') && p.failover === 'auto') || (f?.kind === 'dns' && p.failover === 'on');
      if (f && !controls) issues.push({ level: 'warning', code: 'control-no-controller', edge: id, message: t('Edge "{id}" is a control edge, but "{from}" has no autoscaling, automatic database failover or DNS failover: nothing calls it, so it has no effect.', { id, from: e.from }) });
    }
    if (sideEdge(e) && !e.timeoutMs) {
      issues.push({ level: 'warning', code: 'side-no-timeout', edge: id, message: t('Edge "{id}" has no timeout: when a network partition cuts its target off, the call never gets an answer and the boot or control action hangs.', { id }) });
    }
    const fan = e.fanout ?? 0;
    const toKind = byId.get(e.to)?.kind ?? '';
    const fromKind = byId.get(e.from)?.kind ?? '';
    if (fan > 1 && KINDS[toKind] && !KINDS[toKind].station)
      issues.push({ level: 'warning', code: 'fanout-target', edge: id, message: t('Edge "{id}" has a fan-out, but its target has no instances or shards to send copies to: the fan-out does nothing.', { id }) });
    else if (fan > 1 && fromKind === 'queue')
      issues.push({ level: 'warning', code: 'fanout-queue', edge: id, message: t('Edge "{id}" leaves a queue: a queue hands each message to one worker, so fan-out has no effect.', { id }) });
    else if (fan > 1 && fromKind === 'load_balancer')
      issues.push({ level: 'warning', code: 'fanout-lb', edge: id, message: t('Edge "{id}" leaves a load balancer: a load balancer picks one backend each time, so fan-out has no effect. To send to several, connect the caller straight to the target and set fan-out there.', { id }) });
    // a fan-out that has no effect (warned above): quorum and hedging behave as without one
    const ignored = fan > 1 && !fanoutApplies(fromKind, toKind);
    if (ignored) {
      /* the warning above says it all */
    } else if ((e.quorum ?? 0) > 0 && fan <= 1)
      issues.push({ level: 'warning', code: 'quorum-no-fanout', edge: id, message: t('Edge "{id}" has a quorum but no fan-out (one copy): the quorum does nothing.', { id }) });
    else if ((e.quorum ?? 0) > fan)
      issues.push({ level: 'warning', code: 'quorum-gt-fanout', edge: id, message: t('Edge "{id}" has a quorum ({q}) larger than its fan-out ({n}): it waits for all {n} copies.', { id, q: e.quorum ?? 0, n: fan }) });
    if (fan > 1 && !ignored && e.hedgeMs)
      issues.push({ level: 'warning', code: 'fanout-hedge', edge: id, message: t('Edge "{id}" has both fan-out and hedged requests: a fan-out sends no hedges. To tolerate slow copies, use a quorum.', { id }) });
    // cache-aside only: the caller also reads a store, so a failed lookup falls through to it
    if (e.fallback === 'on' && byId.get(e.to)?.kind === 'cache' && byId.get(e.from)?.kind !== 'cache'
      && (d.edges as DesignEdge[]).some((x) => x.from === e.from && STORE_KINDS.has(byId.get(x.to)?.kind ?? '') && x.on !== 'write' && !sideEdge(x))) {
      issues.push({ level: 'warning', code: 'fallback-cache', edge: id, message: t('Connection "{id}" goes to a cache: when the cache misses or fails, the request already reads the database, so a fallback has no effect.', { id }) });
    }
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e);
  }
  if (issues.some((i) => i.level === 'error')) return issues;

  // Each API: a router (gateway, load balancer, DNS…) it reaches must have a way on for it;
  // otherwise the request ends there and counts as a success without doing any work.
  for (const api of d.apis ?? []) {
    const seen = new Set<string>();
    const todo = d.nodes.filter((n) => n.kind === 'client').map((n) => n.id);
    const takes = (e: DesignEdge) => !sideEdge(e) && (!e.apis?.length || e.apis.includes(api.name)) && (e.on ?? 'all') !== (api.op === 'read' ? 'write' : 'read');
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      const outs = out.get(id) ?? [];
      const next = outs.filter(takes);
      if (n && n.kind !== 'client' && KINDS[n.kind]?.routing === 'one' && outs.length && !next.length)
        issues.push({ level: 'warning', code: 'api-dead-end', node: id, message: t('API "{api}" reaches "{name}" and has no edge to go on: the request stops there and counts as a success.', { api: api.name, name: n.label ?? id }) });
      for (const e of next) todo.push(e.to);
    }
  }
  // Cycles: a request could loop forever. A cache → cache edge carries no requests (it copies
  // the cache's changes to another region, and a copy is not copied on), so it makes no loop.
  // A boot edge carries only the boot calls of new instances, which do not go on from there either.
  const replication = (e: DesignEdge) => sideEdge(e) || (byId.get(e.from)?.kind === 'cache' && byId.get(e.to)?.kind === 'cache');
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): boolean => {
    color.set(id, 1);
    stack.push(id);
    for (const e of out.get(id) ?? []) {
      if (replication(e)) continue;
      const c = color.get(e.to) ?? 0;
      if (c === 1) {
        const loop = stack.slice(stack.indexOf(e.to)).concat(e.to).join(' → ');
        issues.push({ level: 'error', code: 'cycle', node: e.to, message: t('There is a loop: {loop}. Requests keep going around, so remove one of the edges.', { loop }) });
        return true;
      }
      if (c === 0 && visit(e.to)) return true;
    }
    stack.pop();
    color.set(id, 2);
    return false;
  };
  for (const n of d.nodes) if ((color.get(n.id) ?? 0) === 0 && visit(n.id)) break;

  const clients = d.nodes.filter((n) => n.kind === 'client');
  if (clients.length === 0) issues.push({ level: 'error', code: 'no-client', message: t('There is no Users node, so there is no traffic to run.') });
  for (const c of clients) {
    if ((inc.get(c.id) ?? []).length) issues.push({ level: 'error', code: 'client-incoming', node: c.id, message: t('"{name}" is the traffic source and cannot have incoming edges.', { name: c.label ?? c.id }) });
    if (!(out.get(c.id) ?? []).length) issues.push({ level: 'error', code: 'client-no-edge', node: c.id, message: t('"{name}" has no outgoing edges.', { name: c.label ?? c.id }) });
    // several machines called straight from the client: the engine still spreads the calls evenly
    // and skips a machine that is down, which in real life is the load balancer's job. An API
    // gateway is the entry point itself (a managed gateway balances over its own fleet).
    for (const e of out.get(c.id) ?? []) {
      const dst = byId.get(e.to)!;
      if (!KINDS[dst.kind]?.station || dst.kind === 'api_gateway' || dst.kind === 'cache' || STORE_KINDS.has(dst.kind)) continue;
      // with autoscaling, the most machines it can have
      if (instanceCount(dst) > 1)
        issues.push({ level: 'warning', code: 'no-lb', edge: edgeId(e), message: t('"{name}" has several machines, but "{client}" calls it directly, with no load balancer between. The simulation still spreads the traffic evenly and skips a machine that is down; in real life that is the job of a load balancer (or DNS, or client-side balancing).', { name: dst.label ?? t(KINDS[dst.kind].label), client: c.label ?? t(KINDS.client.label) }) });
    }
  }
  for (const n of d.nodes) {
    const spec = KINDS[n.kind];
    const outs = out.get(n.id) ?? [];
    if (spec.routing === 'leaf' && outs.length) {
      issues.push({ level: 'warning', code: 'leaf-out', node: n.id, message: t('"{name}" is a storage endpoint and does not call others; its outgoing edges carry no traffic.', { name: n.label ?? n.id }) });
    }
    if (n.kind === 'queue') {
      if (!outs.length) issues.push({ level: 'warning', code: 'queue-no-consumer', node: n.id, message: t('"{name}" has no worker, so messages only pile up.', { name: n.label ?? n.id }) });
      for (const e of outs) {
        const dst = byId.get(e.to)!;
        if (KINDS[dst.kind].routing !== 'plan') {
          issues.push({ level: 'error', code: 'queue-consumer-kind', edge: edgeId(e), message: t('A queue can only feed a Worker or API Server (they pull messages), not a "{kind}".', { kind: t(KINDS[dst.kind].label) }) });
        }
      }
      const qp = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
      if (qp.delivery === 'at_least_once') {
        for (const e of outs) {
          const dst = byId.get(e.to)!;
          const tp = resolveParams(dst.kind, dst.params as Record<string, unknown> | undefined);
          const svc = tp.serviceMs as { mean: number } | undefined;
          if (svc && Number(qp.visibilityTimeoutMs) < svc.mean)
            issues.push({ level: 'warning', code: 'visibility-short', node: n.id, message: t('"{name}" has a visibility timeout ({vis} ms) shorter than the average processing time of "{target}" ({ms} ms): the message reappears before it finishes and is processed twice.', { name: n.label ?? n.id, vis: String(qp.visibilityTimeoutMs), target: dst.label ?? dst.id, ms: svc.mean }) });
          if (Number(tp.poisonRate) > 0 && Number(qp.maxReceives) === 0)
            issues.push({ level: 'warning', code: 'poison-no-dlq', node: n.id, message: t('"{target}" produces a poison message, but "{name}" has no DLQ (max receives 0): the poison message retries forever and ties up a worker.', { target: dst.label ?? dst.id, name: n.label ?? n.id }) });
        }
      }
    }
    {
      const np = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
      const byPriority = Number(np.shedAt) > 0 || (n.kind === 'rate_limiter' && np.appliesTo === 'batch');
      const anyBatch = d.nodes.some((c) => c.kind === 'client' && resolveParams('client', c.params as Record<string, unknown> | undefined).priority === 'batch');
      if (byPriority && !anyBatch)
        issues.push({ level: 'warning', code: 'priority-no-batch', node: n.id, message: t('"{name}" only acts on "batch" requests, but no user sets the request priority to "batch": this setting has no effect.', { name: n.label ?? n.id }) });
    }
    if (n.kind === 'load_balancer') {
      // the engine checks health per instance only behind instance targets; a database, cache or a
      // non-station node is one logical target that the load balancer skips at once when it is down
      const lp = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
      if (lp.healthCheck !== 'instant' || lp.outlier === 'on') {
        for (const e of d.edges) {
          const dst = e.from === n.id ? byId.get(e.to) : undefined;
          if (!dst || (KINDS[dst.kind]?.station && dst.kind !== 'database' && dst.kind !== 'sharded_db' && dst.kind !== 'cache')) continue;
          issues.push({ level: 'warning', code: 'lb-health-logical', node: n.id, message: t('The health check and outlier detection of "{name}" only work on components with instances, such as API servers and workers; "{target}" is treated as one unit and is skipped at once when it is down.', { name: n.label ?? n.id, target: dst.label ?? dst.id }) });
        }
      }
    }
    if (n.kind === 'cache') {
      const cp = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
      const name = n.label ?? n.id;
      if (cp.mode !== 'lru' && (Number(cp.ttlJitter) > 0 || cp.stampede !== 'none')) {
        issues.push({ level: 'warning', code: 'cache-lru-only', node: n.id, message: t('"{name}" uses a fixed hit ratio: TTL jitter and stampede protection only work in LRU mode.', { name }) });
      } else if (Number(cp.ttlJitter) > 0 && !(Number(cp.ttlS) > 0)) {
        issues.push({ level: 'warning', code: 'jitter-no-ttl', node: n.id, message: t('"{name}" has no TTL, so TTL jitter has no effect.', { name }) });
      }
      // the engine reads through to a store only over edges to a store that carry reads
      const readStores = outs.filter((e) => STORE_KINDS.has(byId.get(e.to)?.kind ?? '') && (e.on ?? 'all') !== 'write' && !sideEdge(e));
      if (cp.mode === 'lru' && cp.stampede === 'coalesce' && !readStores.length) {
        issues.push({ level: 'warning', code: 'coalesce-no-store', node: n.id, message: t('"{name}" has no DB behind it: coalescing only works when the cache reads the DB itself (read-through). When the service reads the DB (cache-aside), use a lease.', { name }) });
      }
      if (cp.mode === 'lru' && cp.stampede === 'lease' && readStores.length) {
        issues.push({ level: 'warning', code: 'lease-read-through', node: n.id, message: t('"{name}" reads the DB itself (read-through): a lease only works when the service reads the DB (cache-aside). For read-through, use coalescing.', { name }) });
      }
    }
    if (n.kind === 'worker' && !(inc.get(n.id) ?? []).some((e) => byId.get(e.from)?.kind === 'queue')) {
      issues.push({ level: 'warning', code: 'worker-no-queue', node: n.id, message: t('"{name}" has no queue in front; it only works when called directly.', { name: n.label ?? n.id }) });
    }
    if (n.kind === 'circuit_breaker') {
      const timeouts = outs.some((e) => (e.timeoutMs ?? 0) > 0);
      if (outs.length && !timeouts) issues.push({ level: 'warning', code: 'cb-no-timeout', node: n.id, message: t('An outgoing edge of "{name}" has no timeout; when downstream only slows down, the circuit breaker sees no failures.', { name: n.label ?? n.id }) });
    }
    if (n.kind !== 'client' && !(inc.get(n.id) ?? []).length) {
      issues.push({ level: 'warning', code: 'unreachable', node: n.id, message: t('"{name}" has no incoming edges, so it gets no traffic.', { name: n.label ?? n.id }) });
    }
  }
  return issues;
}

/** Components that run their own work (stations); a GC pause only stalls these. */
/** Kinds a cache reads through to (must match the engine's STORE_KINDS). */
export const STORE_KINDS = new Set(['database', 'sharded_db', 'object_storage']);
const PAUSABLE = new Set(['service', 'custom', 'worker', 'function', 'api_gateway', 'cache', 'database', 'sharded_db', 'object_storage']);

export function checkScenario(s: Scenario, d?: Design): Issue[] {
  const issues: Issue[] = [];
  const r = resolveScenario(s);
  if ((s.warmupS ?? 5) >= r.durationS) issues.push({ level: 'warning', code: 'warmup', message: t('Warm-up time is not shorter than the total duration, so it was changed to half the total duration.') });
  if (r.windowS !== (s.windowS ?? 1)) {
    issues.push({ level: 'warning', code: 'window', message: t('The stats window is too long to fit a full window after warm-up, so it was changed to {s} s.', { s: r.windowS }) });
  }
  // relations between fields of one event (the file schema checks them too; the editor needs the words)
  for (const ev of r.events) {
    if (ev.type === 'cron' && ev.burstS + (ev.jitterS ?? 0) > ev.everyS) {
      issues.push({ level: 'error', code: 'event-cron', message: t('The scheduled job\'s burst plus spread ({b} s) is longer than its interval ({e} s): a burst starts before the last one ends.', { b: ev.burstS + (ev.jitterS ?? 0), e: ev.everyS }) });
    }
    if (ev.type === 'pause' && ev.pauseMs >= ev.everyS * 1000) {
      issues.push({ level: 'error', code: 'event-pause', message: t('Each GC pause lasts {p} ms, not shorter than its interval of {e} s: the component would stay stopped.', { p: ev.pauseMs, e: ev.everyS }) });
    }
  }
  if (d) {
    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    const regions = new Set(regionsOf(d));
    for (const ev of r.events) {
      if (ev.type === 'region_down' && !regions.has(ev.region)) {
        issues.push({ level: 'error', code: 'event-region', message: t('The event names region "{region}", but no node is in it.', { region: ev.region }) });
      }
      if (ev.type === 'rollout' && ev.node !== undefined) {
        // a missing node is reported below with the other events aimed at a node
        const n = byId.get(ev.node);
        if (n && !KINDS[n.kind]?.station) issues.push({ level: 'error', code: 'event-rollout-kind', message: t('"{node}" has no instances: a new version cannot be deployed to it.', { node: ev.node }) });
      }
      if (ev.type === 'reshard') {
        const n = byId.get(ev.node);
        if (n && n.kind !== 'sharded_db') issues.push({ level: 'error', code: 'event-reshard-kind', message: t('"{node}" is not a sharded database: it cannot be resharded.', { node: ev.node }) });
      }
      if (ev.type === 'partition') {
        const [a, b] = ev.regions;
        if (a === b) issues.push({ level: 'error', code: 'event-partition', message: t('A network partition needs two different regions.') });
        for (const x of new Set(ev.regions)) {
          if (!regions.has(x)) issues.push({ level: 'error', code: 'event-region', message: t('The event names region "{region}", but no node is in it.', { region: x }) });
        }
      }
      if (ev.type === 'shift') {
        const n = byId.get(ev.from);
        if (!d.edges.some((e) => e.from === ev.from && e.to === ev.to)) {
          issues.push({ level: 'error', code: 'event-edge', message: t('The traffic shift points to an edge that does not exist: “{from} → {to}”.', { from: ev.from, to: ev.to }) });
        } else if (n && KINDS[n.kind]?.routing !== 'one') {
          issues.push({ level: 'warning', code: 'event-shift-kind', message: t('“{node}” calls all of its downstreams and does not split by weight: a traffic shift does nothing there.', { node: ev.from }) });
        }
      }
      if ('node' in ev && ev.node !== undefined) {
        const n = byId.get(ev.node);
        if (!n) issues.push({ level: 'error', code: 'event-node', message: t('The event points to a node that does not exist: "{node}".', { node: ev.node }) });
        else if (ev.type === 'pause' && !PAUSABLE.has(n.kind)) {
          issues.push({ level: 'warning', code: 'event-pause-kind', message: t('"{node}" does not process requests, so a GC pause has no effect on it.', { node: ev.node }) });
        }
        else if ((ev.type === 'down' || ev.type === 'slow' || ev.type === 'errors') && ev.instance !== undefined && !KINDS[n.kind]?.station) {
          issues.push({ level: 'error', code: 'event-instance', message: t('"{node}" has no separate instances, so an event cannot name an instance.', { node: ev.node }) });
        }
        else if ((ev.type === 'down' || ev.type === 'slow' || ev.type === 'errors') && ev.instance !== undefined && ev.instance >= instanceCount(n)) {
          issues.push({ level: 'error', code: 'event-instance', message: t('"{node}" has only {k} instances, so there is no #{i} (counting from 0).', { node: ev.node, k: instanceCount(n), i: ev.instance }) });
        }
      }
    }
  }
  return issues;
}

export type ParseResult<T> = { ok: true; value: T; issues: Issue[] } | { ok: false; issues: Issue[] };

function zodIssues(err: z.ZodError): Issue[] {
  return err.issues.map((i) => ({
    level: 'error' as const,
    code: 'schema',
    path: i.path.join('.'),
    message: `${i.path.join('.') || t('(root)')}：${i.message}`,
  }));
}

/** Validate an already-parsed JSON value. The returned value is the input object itself (key order kept). */
export function parseDesign(value: unknown): ParseResult<Design> {
  const r = DesignSchema.safeParse(value);
  if (!r.success) return { ok: false, issues: zodIssues(r.error) };
  const d = value as Design;
  const issues = checkDesign(d);
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
  return { ok: true, value: d, issues };
}

export function parseScenario(value: unknown, d?: Design): ParseResult<Scenario> {
  const r = ScenarioSchema.safeParse(value);
  if (!r.success) return { ok: false, issues: zodIssues(r.error) };
  const s = value as Scenario;
  const issues = checkScenario(s, d);
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
  return { ok: true, value: s, issues };
}

/**
 * Canonical JSON text: 2-space indent; any array or object that fits in `width` columns on one line
 * is written on one line. Loading a file and saving it again gives the same bytes when the file was
 * written by this function.
 */
export function formatJson(value: unknown, width = 100): string {
  // Follow JSON.stringify's rules first (undefined in an array becomes null, functions are dropped, …),
  // so the output is always valid JSON.
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('formatJson: the value is not representable as JSON');
  value = JSON.parse(text);
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
    if (v && typeof v === 'object') {
      const ents = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      return ents.length ? `{ ${ents.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
    }
    return JSON.stringify(v);
  };
  const block = (v: unknown, indent: string, prefixLen: number, isRoot: boolean): string => {
    const one = inline(v);
    if (!isRoot && (typeof v !== 'object' || v === null || indent.length + prefixLen + one.length <= width)) return one;
    if (typeof v !== 'object' || v === null) return one;
    const inner = indent + '  ';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return `[\n${v.map((x) => inner + block(x, inner, 1, false)).join(',\n')}\n${indent}]`;
    }
    const ents = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!ents.length) return '{}';
    return `{\n${ents
      .map(([k, x]) => {
        const key = `${JSON.stringify(k)}: `;
        return inner + key + block(x, inner, key.length + 1, false);
      })
      .join(',\n')}\n${indent}}`;
  };
  return block(value, '', 0, true) + '\n';
}

export function jsonSchemas(): Record<string, unknown> {
  const opts = { target: 'draft-2020-12' as const, unrepresentable: 'any' as const };
  return {
    'design.schema.json': { $id: DESIGN_SCHEMA, ...z.toJSONSchema(DesignSchema, opts) },
    'scenario.schema.json': { $id: SCENARIO_SCHEMA, ...z.toJSONSchema(ScenarioSchema, opts) },
  };
}
