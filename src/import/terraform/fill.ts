// Step 4 of the import: fill the values the IaC does not give. Order: answer
// file > IaC > instance table > loadsketch default. Every value keeps where it came from; at the end the
// origins are written into the design's optional `source` fields (G2, Q7).
import type { DesignNode, ParamSource } from '../../core/index.ts';
import { answerValue, type Answers } from './answers.ts';
import { ASSUME, maxConnections, sizeOf, taskSize } from './instances.ts';
import { MAX_SOURCE_FROM } from '../../core/index.ts';
import { PlanError, stripLastKey } from './plan.ts';
import type { ImportResult, Origin } from './result.ts';

const TABLE = 'src/import/terraform/instances.ts (ASSUME)';
/** Params that are performance assumptions; the rest are settings and limits. */
const ASSUMPTIONS = new Set(['serviceMs', 'concurrency', 'readMs', 'writeMs', 'connections', 'latencyMs', 'coldFactor', 'bootS', 'warmS', 'errorRate', 'opMs', 'coldStartMs', 'hitRatio', 'readFrom']);
/** A param's role in a source: a performance assumption, or a setting / limit. */
export const paramRole = (param: string): 'assumption' | 'setting' => (ASSUMPTIONS.has(param) ? 'assumption' : 'setting');

function setParam(res: ImportResult, n: DesignNode, param: string, value: number, origin: Origin): void {
  n.params ??= {};
  n.params[param] = value;
  (res.origins[n.id] ??= {})[param] = origin;
}
const has = (n: DesignNode, param: string) => n.params?.[param] !== undefined;

/** Size facts and assumptions from the instance table, for params the IaC did not set. */
export function fillFromTable(res: ImportResult): void {
  for (const n of res.design.nodes) {
    const facts = (res.facts[n.id] ??= {});
    // cpu 0 or unset (EC2 launch type without task-level cpu): no CPU-based estimates.
    const cpu = facts.cpu?.value;
    if (n.kind === 'service' && typeof cpu === 'number' && Number.isFinite(cpu) && cpu > 0 && typeof facts.memory?.value === 'number') {
      const size = taskSize(cpu, facts.memory.value);
      facts.vcpu = { value: size.vcpu, origin: facts.cpu!.origin };
      const a = ASSUME.service(size.vcpu);
      for (const [k, v] of Object.entries(a)) if (!has(n, k)) setParam(res, n, k, v, { evidence: 'estimate', from: facts.cpu!.origin.from, source: TABLE });
    }
    // EC2 (Auto Scaling group): the instance type from the launch template.
    if (n.kind === 'service' && typeof facts.instanceType?.value === 'string' && facts.vcpu === undefined) {
      const size = sizeOf(facts.instanceType.value);
      if (!size) res.notes.push({ id: 'import.unknownInstanceType', args: { type: facts.instanceType.value }, node: n.id });
      else {
        const from = facts.instanceType.origin.from;
        facts.vcpu = { value: size.vcpu, origin: { evidence: 'aws-default', from, source: size.source } };
        for (const [k, v] of Object.entries(ASSUME.service(size.vcpu))) if (!has(n, k)) setParam(res, n, k, v, { evidence: 'estimate', from, source: TABLE });
      }
    }
    if (n.kind === 'function' && typeof facts.memoryMiB?.value === 'number') {
      for (const [k, v] of Object.entries(ASSUME.function(facts.memoryMiB.value))) if (!has(n, k)) setParam(res, n, k, v, { evidence: 'estimate', from: facts.memoryMiB.origin.from, source: TABLE });
    }
    if (n.kind === 'cache' && typeof facts.nodeType?.value === 'string') {
      const size = sizeOf(facts.nodeType.value);
      if (!size) res.notes.push({ id: 'import.unknownInstanceType', args: { type: facts.nodeType.value }, node: n.id });
      else {
        const from = facts.nodeType.origin.from;
        facts.vcpu = { value: size.vcpu, origin: { evidence: 'aws-default', from, source: size.source } };
        facts.memoryGiB = { value: size.memoryGiB, origin: { evidence: 'aws-default', from, source: size.source } };
        for (const [k, v] of Object.entries(ASSUME.cache(size.vcpu))) if (!has(n, k)) setParam(res, n, k, v, { evidence: 'estimate', from, source: TABLE });
      }
    }
    // A custom parameter group's max_connections is the limit (both bounds), whatever the instance
    // class; one the plan cannot tell (a formula, unknown until apply) leaves C1 incomplete.
    const set = n.kind === 'database' ? facts.maxConnections : undefined;
    if (set && typeof set.value === 'number') facts.maxConnectionsAllMemory = facts.maxConnectionsAfterReserve = { value: set.value, origin: set.origin };
    if (n.kind === 'database' && typeof facts.instanceClass?.value === 'string') {
      const size = sizeOf(facts.instanceClass.value);
      if (!size) {
        res.notes.push({ id: 'import.unknownInstanceType', args: { type: facts.instanceClass.value }, node: n.id });
        continue;
      }
      const from = facts.instanceClass.origin.from;
      facts.vcpu = { value: size.vcpu, origin: { evidence: 'aws-default', from, source: size.source } };
      facts.memoryGiB = { value: size.memoryGiB, origin: { evidence: 'aws-default', from, source: size.source } };
      const engine = typeof facts.engine?.value === 'string' ? facts.engine.value : '';
      // C1 uses both bounds: all memory (AWS formula, definite) and after our OS reserve (estimate).
      const high = maxConnections(engine, size.memoryGiB * 2 ** 30);
      const low = maxConnections(engine, size.memoryGiB * 2 ** 30 * (1 - ASSUME.osReserve));
      if (!set && high && low) {
        facts.maxConnectionsAllMemory = { value: high.value, origin: { evidence: 'aws-default', from, source: high.source } };
        facts.maxConnectionsAfterReserve = { value: low.value, origin: { evidence: 'estimate', from, source: `${low.source}; OS reserve ${ASSUME.osReserve * 100}% (${TABLE})` } };
      }
      for (const [k, v] of Object.entries(ASSUME.database(size.vcpu))) if (!has(n, k)) setParam(res, n, k, v, { evidence: 'estimate', from, source: TABLE });
    }
  }
}

/** The design node an answer-file name means: a node id, a resource address it stands for, or a
 *  resource folded into it (an RDS Proxy, an Aurora instance, a cache cluster: M29b #6). */
export function resolveName(res: ImportResult, name: string): string | undefined {
  if (res.design.nodes.some((n) => n.id === name)) return name;
  return Object.entries(res.nodeFrom).find(([, from]) => from.includes(name))?.[0] ?? res.folded.find((f) => f.address === name && f.into)?.into;
}

/** Params whose value the checks read from a fact: `kind.param` -> the fact and its unit. Not a
 *  service's `instances`: that is the start, and `minInstances` the real floor. */
const MIRROR: Record<string, { fact: string; from: (v: number) => number; always?: true }> = {
  'queue.visibilityTimeoutMs': { fact: 'visibilityS', from: (v) => v / 1000 },
  // C6 reads it only when there is a redrive; an answer fills it in when the plan did not have it.
  'queue.maxReceives': { fact: 'maxReceiveCount', from: (v) => v, always: true },
  'cache.instances': { fact: 'numCacheClusters', from: (v) => v },
};

/** Answer-file values replace whatever the IaC or the table gave. */
export function applyNodeAnswers(res: ImportResult, answers: Answers): void {
  for (const [name, params] of Object.entries(answers.nodes ?? {})) {
    const id = resolveName(res, name);
    if (!id) throw new PlanError('import.answers.unknownNode', { name });
    const n = res.design.nodes.find((x) => x.id === id)!;
    for (const [param, a] of Object.entries(params)) {
      const { value, measured } = answerValue(a);
      n.params ??= {};
      n.params[param] = value;
      const origin = { evidence: 'answer' as const, ...(measured ? { measured: true as const } : {}) };
      (res.origins[id] ??= {})[param] = origin;
      // The checks read some values as facts: the answer replaces those too.
      const m = MIRROR[`${n.kind}.${param}`];
      // Only a fact the import wrote (a cluster-mode cache's instances are shards, not numCacheClusters).
      if (m && typeof value === 'number' && (m.always || res.facts[id]?.[m.fact])) (res.facts[id] ??= {})[m.fact] = { value: m.from(value), origin };
    }
  }
}

/** Resource addresses for `source.from`; past the schema's limit, one `block[*]` per count/for_each block. */
function sourceFrom(addresses: string[]): string[] {
  if (addresses.length <= MAX_SOURCE_FROM) return addresses;
  return [...new Set(addresses.map((a) => `${stripLastKey(a)}[*]`))].slice(0, MAX_SOURCE_FROM);
}

/** Origins and line kinds into the design's `source` fields. */
export function writeSources(res: ImportResult): void {
  for (const n of res.design.nodes) {
    const params: Record<string, ParamSource> = {};
    for (const [k, o] of Object.entries(res.origins[n.id] ?? {})) {
      params[k] = { evidence: o.evidence, role: paramRole(k), ...(o.from ? { from: o.from } : {}), ...(o.source ? { ref: o.source } : {}), ...(o.measured ? { measured: true } : {}) };
    }
    n.source = { from: sourceFrom(res.nodeFrom[n.id] ?? []), ...(Object.keys(params).length ? { params } : {}) };
  }
  for (const e of res.design.edges) {
    const k = res.edges[e.id!];
    const params: Record<string, ParamSource> = {};
    for (const [p, o] of Object.entries(res.edgeOrigins[e.id!] ?? {})) params[p] = { evidence: o.evidence, role: 'assumption', ...(o.measured ? { measured: true } : {}) };
    e.source = { line: k.kind, ...(k.confirmed ? { confirmed: true } : {}), ...(k.via.length ? { via: k.via.slice(0, 20) } : {}), ...(Object.keys(params).length ? { params } : {}) };
  }
}
