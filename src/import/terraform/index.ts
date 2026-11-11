// Terraform plan JSON -> loadsketch design. Steps: parse, graph, group,
// map each group with a rule, add a client wired to every entry, turn graph lines into edges, lay out.
// Definite and presumed lines become edges; candidate lines only when the answer file confirms them.
// Step 4 (fill.ts): instance table, answer file, then every origin goes into the design's `source`.
import { DESIGN_SCHEMA, ID_RE, type Design, type DesignEdge, type DesignNode } from '../../core/index.ts';
import { buildGraph, groupInstances } from './graph.ts';
import { parsePlan, PlanError, type PlanResource } from './plan.ts';
import { answerValue, type Answers } from './answers.ts';
import { applyNodeAnswers, fillFromTable, resolveName, writeSources } from './fill.ts';
import type { ImportResult, Origin } from './result.ts';
import { FOLDED, RULES } from './rules.ts';

export { PlanError } from './plan.ts';
export { ANSWERS_SCHEMA, parseAnswers, type Answers } from './answers.ts';
export { blocking, runChecks, type Certainty, type CheckOptions, type Finding, type Severity } from './checks.ts';
export type { Evidence, Fact, ImportResult, Note, Origin } from './result.ts';
export { assumptionsOf, findLimit, limitAnswers, searchLimit, stepOf, BISECT, MAX_RPS, START_RPS, type LimitResult, type LimitStep } from './limit.ts';
export { DEFAULT_SLO, importScenario, simulateImport, warmUpS, type Criterion, type SimulateResult, type Verdict } from './simulate.ts';
export { capacityOf, scenarioFor, type NoSim, type SimFor, type SimNote } from './scenarioFor.ts';

export interface ImportOptions { name?: string; answers?: Answers }

/** A design id from a resource address: `aws_db_instance.main` -> `db_instance_main` (unique, ≤ 48). */
function makeIds() {
  const used = new Set<string>(['client']);
  return (r: PlanResource): string => {
    const base = `${r.module.replace(/module\./g, '').replace(/\[[^\]]*\]/g, '')}${r.type.replace(/^aws_/, '')}_${r.name}`.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 44) || 'node';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    if (!ID_RE.test(id)) throw new PlanError('import.badId', { address: r.address });
    return id;
  };
}

export function importTerraform(json: unknown, opts: ImportOptions = {}): ImportResult {
  const plan = parsePlan(json);
  const g = buildGraph(plan);
  const a = opts.answers;
  if (a) g.named = new Set([...Object.keys(a.nodes ?? {}), ...(a.edges ?? []).flatMap((e) => [e.from, e.to]), ...(a.entry ?? [])]);
  const res: ImportResult = { design: { schema: DESIGN_SCHEMA, name: opts.name ?? 'terraform', nodes: [], edges: [] }, nodeFrom: {}, origins: {}, facts: {}, edges: {}, edgeOrigins: {}, candidates: g.lines.filter((l) => l.kind === 'candidate'), folded: [], unmapped: [], notes: [] };
  const idOf = makeIds();
  /** Address -> the node its outgoing lines start from; `inOf`: the node its incoming lines end at
   *  (a front throttle when there is one). */
  const nodeOfAddress = new Map<string, string>();
  const inOf = new Map<string, string>();
  const throughAt = new Set<string>();
  const edgeParams: { from: string; to: string; param: string; value: number; origin: import('./result.ts').Origin }[] = [];
  type Weight = { value: number; origin: import('./result.ts').Origin };
  const lineWeights = new Map<string, Weight>();
  const sourceCaps = new Map<string, NonNullable<import('./rule-kit.ts').RuleOut['sourceCap']>>();
  const entries: string[] = [];
  const fronts = new Map<string, { id: string; via: string }>();
  const used = new Map<string, string>();
  const edgeIds = new Set<string>();
  /** `from-to`, cut to fit 48 characters (ID_RE), with `_2`, `_3`… when two pairs cut to the same id. */
  const edgeId = (from: string, to: string): string => {
    const full = `${from}-${to}`;
    const base = full.length <= 44 ? full : `${from.slice(0, 21)}-${to.slice(0, 22)}`;
    let id = base;
    for (let n = 2; edgeIds.has(id); n++) id = `${base}_${n}`;
    edgeIds.add(id);
    return id;
  };

  for (const group of groupInstances(g)) {
    const rs = group.addresses.map((a) => plan.byAddress.get(a)!);
    const rule = RULES[rs[0].type];
    if (!rule) {
      if (!FOLDED[rs[0].type]) for (const r of rs) res.unmapped.push({ address: r.address, type: r.type });
      continue;
    }
    const out = rule(rs, g);
    if ('fold' in out) {
      for (const r of rs) res.folded.push({ address: r.address, why: out.fold });
      continue;
    }
    const id = idOf(rs[0]);
    const node: DesignNode = { id, kind: out.kind, label: label(rs[0].name, rs.length > 1 ? ` ×${rs.length}` : ''), pos: [0, 0], ...(Object.keys(out.params).length ? { params: out.params } : {}) };
    res.design.nodes.push(node);
    res.nodeFrom[id] = group.addresses;
    res.origins[id] = out.origins;
    if (Object.keys(out.facts).length) res.facts[id] = out.facts;
    res.notes.push(...out.notes.map((n) => ({ ...n, node: id })));
    for (const a of [...group.addresses, ...(out.members ?? [])]) if (!nodeOfAddress.has(a)) nodeOfAddress.set(a, id);
    for (const a of out.through ?? []) throughAt.add(a);
    for (const u of [...out.uses, ...(out.members ?? [])]) if (!used.has(u)) used.set(u, id);
    for (const p of out.edgeParams ?? []) edgeParams.push({ from: id, ...p });
    if (out.sourceCap) sourceCaps.set(id, out.sourceCap);
    for (const [a, w] of Object.entries(out.lineWeights ?? {})) lineWeights.set(a, w);
    let entry = id;
    if (out.front) {
      // The throttle takes the incoming lines and the outside traffic; it calls the node.
      const fid = idOf({ ...rs[0], name: `${rs[0].name}_throttle` });
      res.design.nodes.push({ id: fid, kind: out.front.kind, label: label(rs[0].name, ' throttle'), pos: [0, 0], params: out.front.params });
      res.nodeFrom[fid] = [out.front.via];
      res.origins[fid] = out.front.origins;
      fronts.set(id, { id: fid, via: out.front.via });
      for (const a of [...group.addresses, ...(out.members ?? [])]) inOf.set(a, fid);
      entry = fid;
    }
    if (out.entry) entries.push(entry);
  }
  const target = (a: string) => inOf.get(a) ?? nodeOfAddress.get(a);
  // A rule's fold that another node took as a member (a cache cluster in its replication group).
  for (const f of res.folded) if (!f.into && nodeOfAddress.has(f.address)) f.into = nodeOfAddress.get(f.address);
  for (const r of plan.resources) {
    const why = FOLDED[r.type];
    const member = nodeOfAddress.has(r.address) && !res.nodeFrom[nodeOfAddress.get(r.address)!]?.includes(r.address);
    if (why && (!nodeOfAddress.has(r.address) || member)) res.folded.push({ address: r.address, ...(used.has(r.address) ? { into: used.get(r.address) } : {}), why });
  }

  // The client: the design needs one (design.ts). Added before the answers so they can name it.
  res.design.nodes.unshift({ id: 'client', kind: 'client', pos: [0, 0] });
  res.nodeFrom.client = [];
  fillFromTable(res);
  const answers = opts.answers;
  if (answers) applyNodeAnswers(res, answers);
  const node = (name: string) => {
    const id = resolveName(res, name);
    if (!id) throw new PlanError('import.answers.unknownNode', { name });
    return id;
  };
  // A node with a throttle in front takes its lines through the throttle, from the answer file too.
  const viaFront = (from: string, to: string) => (fronts.get(to) && fronts.get(to)!.id !== from ? fronts.get(to)!.id : to);
  const answerEdges = new Map((answers?.edges ?? []).map((e) => [`${node(e.from)}->${viaFront(node(e.from), node(e.to))}`, e]));
  const confirmed = new Set(answerEdges.keys());
  // Every name the answer file gives for a pair: a direct entry and a proxy entry fold to one key.
  const answerTargets = new Map<string, string[]>();
  for (const e of answers?.edges ?? []) {
    const k = `${node(e.from)}->${viaFront(node(e.from), node(e.to))}`;
    answerTargets.set(k, [...(answerTargets.get(k) ?? []), e.to]);
  }

  // Lines between mapped resources become edges (one per pair of nodes, strongest kind first).
  const rank = { definite: 0, presumed: 1, candidate: 2 } as const;
  const edges = new Map<string, DesignEdge>();
  // A node and its throttle.
  for (const [id, f] of fronts) {
    const e: DesignEdge = { id: edgeId(f.id, id), from: f.id, to: id };
    edges.set(`${f.id}->${id}`, e);
    res.edges[e.id!] = { kind: 'definite', via: [f.via] };
  }
  const unconfirmed = new Set<(typeof g.lines)[number]>();
  for (const l of [...g.lines].sort((a, b) => rank[a.kind] - rank[b.kind])) {
    const from = nodeOfAddress.get(l.from);
    const to = target(l.to);
    if (!from || !to || from === to || fronts.get(from)?.id === to) {
      if ((!from || !to) && l.kind !== 'candidate') res.notes.push({ id: 'import.lineDropped', args: { from: l.from, to: l.to, kind: l.kind } });
      continue;
    }
    const key = `${from}->${to}`;
    if (l.kind === 'candidate' && !confirmed.has(key)) {
      if (!edges.has(key)) unconfirmed.add(l);
      continue;
    }
    if (edges.has(key)) {
      // Through a proxy only if every line of the pair is: a direct line keeps C2 (and C1) direct.
      // Every proxy of the pair is kept, so the checks see each pool.
      const info = res.edges[edges.get(key)!.id!];
      if (!throughAt.has(l.to)) {
        delete info.through;
        delete info.routes;
      } else if (info.through && !(info.routes ?? [info.through]).includes(l.to)) info.routes = [...(info.routes ?? [info.through]), l.to];
      continue;
    }
    const e: DesignEdge = { id: edgeId(from, to), from, to };
    edges.set(key, e);
    res.edges[e.id!] = { kind: l.kind, via: l.via, ...(l.agrees ? { agrees: l.agrees } : {}), ...(confirmed.has(key) ? { confirmed: true } : {}), ...(throughAt.has(l.to) ? { through: l.to } : {}) };
  }
  res.candidates = [...unconfirmed].filter((l) => !edges.has(`${nodeOfAddress.get(l.from)}->${target(l.to)}`));
  // Params a rule gives its outgoing edges (an integration timeout); the answer file still wins below.
  for (const p of edgeParams) {
    const to = target(p.to);
    const e = to ? edges.get(`${p.from}->${to}`) : undefined;
    if (!e) continue;
    (e as unknown as Record<string, unknown>)[p.param] = p.value;
    (res.edgeOrigins[e.id!] ??= {})[p.param] = p.origin;
  }
  // Lines only the answer file knows.
  for (const key of confirmed) {
    if (edges.has(key)) continue;
    const [from, to] = key.split('->');
    const e: DesignEdge = { id: edgeId(from, to), from, to };
    edges.set(key, e);
    // Named through an RDS Proxy (folded into the DB): the edge goes through it, as a graph line
    // would, but only if every entry of the pair names a proxy. A direct entry keeps C2 direct.
    // Two proxies are two routes; any direct entry makes the line direct.
    const names = [...new Set(answerTargets.get(key) ?? [])];
    const proxied = names.length > 0 && names.every((n) => throughAt.has(n));
    res.edges[e.id!] = { kind: 'answer', via: [], confirmed: true, ...(proxied ? { through: names[0], ...(names.length > 1 ? { routes: names } : {}) } : {}) };
  }
  // Answer-file details on the lines it names: measured, and the pool size.
  for (const [key, a] of answerEdges) {
    const e = edges.get(key)!;
    if (a.evidence === 'measured') res.edges[e.id!].measured = true;
    if (a.bulkhead !== undefined) {
      const { value, measured } = answerValue(a.bulkhead);
      (e as unknown as Record<string, unknown>).bulkhead = value;
      (res.edgeOrigins[e.id!] ??= {}).bulkhead = { evidence: 'answer', ...(measured ? { measured: true } : {}) };
    }
  }
  // Weights of lines from a resource (a failover record), from the graph or the answer file: the
  // largest wins when two lines become one edge (a PRIMARY and a SECONDARY with one target).
  const weighted: [string, Weight][] = [
    ...g.lines.filter((l) => lineWeights.has(l.from)).map((l): [string, Weight] => [`${nodeOfAddress.get(l.from)}->${target(l.to)}`, lineWeights.get(l.from)!]),
    ...(answers?.edges ?? []).filter((a) => lineWeights.has(a.from)).map((a): [string, Weight] => [`${node(a.from)}->${viaFront(node(a.from), node(a.to))}`, lineWeights.get(a.from)!]),
  ];
  for (const [key, w] of weighted) {
    const e = edges.get(key) as (DesignEdge & { weight?: number }) | undefined;
    if (!e || (e.weight !== undefined && e.weight >= w.value)) continue;
    e.weight = w.value;
    (res.edgeOrigins[e.id!] ??= {}).weight = w.origin;
  }
  // Wire the client to every node that takes outside traffic, unless another entry already sends to
  // it (an ALB behind CloudFront): users go through the front one. Any other caller (a line from
  // the answer file) does not hide an entry; if every entry is behind another one (a loop), all stay.
  // The answer file's entries always.
  const named = (answers?.entry ?? []).map((n) => viaFront('client', node(n)));
  // An entry with a throttle: the entry is the throttle, and the gateway behind it sends the traffic.
  const entryOf = (id: string) => entries.includes(id) || entries.includes(fronts.get(id)?.id ?? '');
  let behind = entries.filter((id) => !named.includes(id) && [...edges.values()].some((e) => e.to === id && e.from !== id && entryOf(e.from)));
  if (behind.length === entries.length) behind = [];
  for (const id of behind) res.notes.push({ id: 'import.entryBehind', node: id });
  const wired = [...entries.filter((id) => !behind.includes(id)), ...named.filter((id) => !entries.includes(id))];
  if (!wired.length) throw new PlanError('import.noEntry');
  for (const to of wired) {
    if (edges.has(`client->${to}`)) continue;
    const e: DesignEdge = { id: edgeId('client', to), from: 'client', to };
    edges.set(`client->${to}`, e);
    res.edges[e.id!] = { kind: 'generated', via: [] };
  }
  res.design.edges = [...edges.values()];
  applySourceCaps(res, sourceCaps);
  layout(res.design);
  noteUnknown(res);
  writeSources(res);
  return res;
}

/** Columns by the longest path from the client; rows in node order. */
function layout(d: Design): void {
  const depth = new Map<string, number>([['client', 0]]);
  for (let pass = 0; pass < d.nodes.length; pass++) {
    for (const e of d.edges) {
      const f = depth.get(e.from);
      if (f !== undefined && (depth.get(e.to) ?? -1) < f + 1 && f + 1 < d.nodes.length) depth.set(e.to, f + 1);
    }
  }
  const rows = new Map<number, number>();
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of d.nodes) {
    const col = depth.get(n.id) ?? maxDepth + 1;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    n.pos = [col * 260, row * 140];
  }
}

/** A function that only event source mappings call: their maximum_concurrency is its limit. Any other
 *  incoming edge (an answer-file line, the client) keeps its own limit; an answer wins. */
function applySourceCaps(res: ImportResult, caps: Map<string, { value: number; origin: Origin; via: string[] }>): void {
  for (const [id, cap] of caps) {
    if (res.origins[id]?.maxConcurrency?.evidence === 'answer') continue;
    const inbound = res.design.edges.filter((e) => e.to === id);
    const onlyEsm = inbound.length > 0 && inbound.every((e) => res.edges[e.id!]?.kind === 'definite' && res.edges[e.id!].via.some((v) => cap.via.includes(v)));
    const n = res.design.nodes.find((x) => x.id === id)!;
    if (!onlyEsm || cap.value >= Number(n.params?.maxConcurrency ?? Infinity)) continue;
    (n.params ??= {}).maxConcurrency = cap.value;
    (res.origins[id] ??= {}).maxConcurrency = cap.origin;
    res.notes.push({ id: 'import.approx.sourceConcurrency', args: { n: cap.value }, node: id });
  }
}

/** A display label within the design's 60 characters; the full address stays in nodeFrom. */
function label(name: string, suffix: string): string {
  const max = 60 - suffix.length;
  return (name.length > max ? `${name.slice(0, max - 1)}…` : name) + suffix;
}

/** One note per value that was written but is not in the plan and that the design or a check still uses
 *  (an answer-file value replaced it: no note). M29b #24–#29. */
function noteUnknown(res: ImportResult): void {
  const said = new Set(res.notes.filter((n) => n.id === 'import.unknownValue' || n.id === 'import.sensitiveValue').map((n) => String(n.args?.from)));
  const add = (o: Origin, node: string) => {
    if (!o.unknown || !o.from || said.has(o.from)) return;
    said.add(o.from);
    res.notes.push({ id: o.unknown === 'apply' ? 'import.unknownValue.default' : 'import.sensitiveValue.default', args: { from: o.from }, node });
  };
  for (const [node, ps] of Object.entries(res.origins)) for (const o of Object.values(ps)) add(o, node);
  for (const [node, fs] of Object.entries(res.facts)) for (const f of Object.values(fs)) add(f.origin, node);
  for (const [edge, ps] of Object.entries(res.edgeOrigins)) for (const o of Object.values(ps)) add(o, edge);
}
