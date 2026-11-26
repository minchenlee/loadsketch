#!/usr/bin/env node
// loadsketch: run, check and format system-design files from the terminal.
//
//   loadsketch run <design.json> [--scenario <scenario.json>] [--rps N] [--duration S] [--seed N] [--json]
//   loadsketch validate <file.json>...
//   loadsketch fmt <file.json>... [--write | --check]
//   loadsketch schema [--write]
//   loadsketch import terraform <plan.json> [--answers <answers.json>] [--out <design.json>] [--report <report.md>] [--strict] [--simulate] [--find-limit] [--name <name>] [--json]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESIGN_SCHEMA,
  SCENARIO_SCHEMA,
  formatJson,
  jsonSchemas,
  parseDesign,
  parseScenario,
  type Design,
  type Issue,
  type Scenario,
} from '../src/schema/design.ts';
import { FAIL_LABEL, FAIL_REASONS, simulate, type SimResult } from '../src/engine/index.ts';
import { LANGS, pickLang, setLang, t } from '../src/i18n/index.ts';
import { localizeDesign, localizeScenario } from '../src/i18n/content.ts';
import { importMessage } from '../src/i18n/importMessages.ts';
import { ANSWERS_SCHEMA, assumptionsOf, blocking, findLimit, importTerraform, parseAnswers, PlanError, runChecks, simulateImport, type Answers } from '../src/import/terraform/index.ts';
import { importReport, limitSummary, simulateSection } from '../src/i18n/importReport.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(code = 0): never {
  console.log(
    [
      t('Usage: '),
      '  loadsketch run <design.json> [--scenario <scenario.json>] [--rps N] [--duration ' + t('s') + '] [--seed N] [--json]',
      '  loadsketch validate <file.json>...      ' + t('Check the design file or scenario file'),
      '  loadsketch fmt <file.json>... [--write | --check]   ' + t('Rewrite in canonical format (--check: exit 1 if the format is off)'),
      '  loadsketch schema [--write]             ' + t('Print (or write to schema/) the JSON Schema'),
      '  loadsketch import terraform <plan.json> [--answers <answers.json>] [--out <design.json>] [--report <report.md>] [--strict] [--simulate] [--find-limit] [--name <name>] [--json]   ' + t('Turn a Terraform plan (terraform show -json) into a design file'),
      `${`  --lang ${LANGS.join('|')}`.padEnd(37)} ` + t('Output language (you can also use the LOADSKETCH_LANG environment variable)'),
    ].join('\n'),
  );
  process.exit(code);
}

interface Args {
  pos: string[];
  flags: Map<string, string | true>;
}
function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags.set(k, v);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(k)) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else pos.push(a);
  }
  return { pos, flags };
}
const VALUE_FLAGS = new Set(['scenario', 'rps', 'duration', 'seed', 'warmup', 'read-ratio', 'lang', 'out', 'name', 'answers', 'report']);

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    fail(t('Cannot read file {path}: {why}', { path, why: (e as Error).message }));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(t('{path} is not valid JSON: {why}', { path, why: (e as Error).message }));
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printIssues(path: string, issues: Issue[]): void {
  for (const i of issues) {
    const where = i.node ? `［${i.node}］` : i.edge ? `［${i.edge}］` : i.path ? `［${i.path}］` : '';
    console.error(`${path}: ${i.level === 'error' ? t('error') : t('warning')} ${i.code}${where} ${i.message}`);
  }
}

function loadDesign(path: string): Design {
  const r = parseDesign(readJson(path));
  printIssues(path, r.issues);
  if (!r.ok) process.exit(1);
  return r.value;
}

function loadScenario(path: string, d: Design): Scenario {
  const r = parseScenario(readJson(path), d);
  printIssues(path, r.issues);
  if (!r.ok) process.exit(1);
  return r.value;
}

const fmtN = (x: number): string => x.toLocaleString('en-US');
const fmtMs = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const pct = (x: number | undefined): string => (x === undefined ? '' : `${Math.round(x * 100)}%`);
const width = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, n: number, right = false): string => {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
};

function report(r: SimResult): string {
  const out: string[] = [];
  const s = r.summary;
  const sc = r.scenario;
  out.push(t('Design: {design}  Scenario: {scenario} ({rps} rps, {dur} s, read {read}, seed {seed})', { design: r.design, scenario: sc.name, rps: fmtN(sc.rps), dur: sc.durationS, read: pct(sc.readRatio), seed: sc.seed }));
  if (r.scale) out.push(t('Simulated at 1/{k}; numbers scaled back: traffic and capacity are divided by {k}, and requests, rps and errors are multiplied by {k}.', { k: r.scale }));
  out.push(
    t('Measurement window: {from}–{to} s (the start is warm-up). Simulated {n} events', { from: r.measuredFromS, to: +(r.measuredFromS + r.measuredS).toFixed(3), n: fmtN(r.events) }) +
      (r.truncated ? t(', event limit reached, stopped early') : '') +
      (r.unfinished ? t('; {n} background jobs still unfinished at the end', { n: fmtN(r.unfinished) }) : '') +
      t('.'),
  );
  out.push('');
  const failTotal = FAIL_REASONS.reduce((a, k) => a + s.fail[k], 0);
  out.push(t('Requests: {offered} offered, {ok} ok, {fail} failed (error rate {err}%)', { offered: fmtN(s.offered), ok: fmtN(s.ok), fail: fmtN(failTotal), err: (s.errorRate * 100).toFixed(2) }));
  if (failTotal) {
    out.push('  ' + t('Failure reasons: ') + FAIL_REASONS.filter((k) => s.fail[k]).map((k) => `${t(FAIL_LABEL[k])} ${fmtN(s.fail[k])}`).join(t(', ')));
  }
  const l = s.latencyMs;
  out.push(t('Latency of successful requests (ms): mean {mean}, p50 {p50}, p95 {p95}, p99 {p99}, p99.9 {p999}, max {max}', { mean: fmtMs(l.mean), p50: fmtMs(l.p50), p95: fmtMs(l.p95), p99: fmtMs(l.p99), p999: fmtMs(l.p999), max: fmtMs(l.max) }));
  if (s.degraded) out.push('  ' + t('Degraded: {n} successful requests used a fallback response', { n: fmtN(s.degraded) }));
  out.push(t('Throughput: {rps} rps success', { rps: fmtN(s.throughputRps) }));
  if (s.asyncLatencyMs.count) {
    const a = s.asyncLatencyMs;
    out.push(t('Async jobs (queued to done): {n} jobs, p50 {p50} ms, p99 {p99} ms', { n: fmtN(a.count), p50: fmtMs(a.p50), p99: fmtMs(a.p99) }));
  }
  out.push('');
  if (r.bottleneck) out.push(t('Bottleneck: {why}', { why: r.bottleneck.why }));
  // the newer mechanisms: autoscaling, deadline propagation, retry budget, queue delivery
  const extra: string[] = [];
  for (const [id, n] of Object.entries(r.nodes)) {
    const a = n.autoscale;
    if (a) extra.push(t('Autoscaling {id}: {min}–{max} instances, up to {peak} at once, {end} at the end (added {add}, removed {del})', { id, min: a.min, max: a.max, peak: a.peakActive, end: a.endActive, add: a.launches, del: a.retires }) + (a.bootFails ? t(', {n} boot failures', { n: a.bootFails }) : ''));
    const isQueue = n.queueDepthEnd !== undefined;
    if (n.expired && isQueue) extra.push(t('Message expired {id}: {n} messages sat too long and were dropped', { id, n: fmtN(n.expired) }));
    else if (n.expired) extra.push(t('Deadline {id}: {n} requests expired in the queue and were dropped without work', { id, n: fmtN(n.expired) }));
    if (n.redelivered !== undefined)
      extra.push(t('At-least-once {id}: {re} redeliveries, {dup} duplicate processings, {dlq} messages moved to the DLQ', { id, re: fmtN(n.redelivered), dup: fmtN(n.duplicates ?? 0), dlq: fmtN(n.dlq ?? 0) }));
    if (n.holBlocked) extra.push(t('FIFO {id}: {n} messages waited behind an earlier message of their group', { id, n: fmtN(n.holBlocked) }));
    if (n.dualWriteGaps) extra.push(t('Dual write {id}: {n} writes where the database and the queue disagree (one succeeded, the other failed)', { id, n: fmtN(n.dualWriteGaps) }));
    if (n.outboxRetries) extra.push(t('Outbox {id}: the relay sent again {n} times', { id, n: fmtN(n.outboxRetries) }));
    if (n.coalesced) extra.push(t('Coalescing {id}: {n} misses waited for another request\'s read instead of reading the DB', { id, n: fmtN(n.coalesced) }));
    if (n.leaseWaits) extra.push(t('Lease {id}: {n} times a request had no lease and asked the cache again later', { id, n: fmtN(n.leaseWaits) }));
    if (n.hcRemoved !== undefined) extra.push(t('Health check {id}: took an instance out {n} times', { id, n: fmtN(n.hcRemoved) }));
    if (n.blindChecks) extra.push(t('Control plane {id}: blind, did not act {n} times', { id, n: fmtN(n.blindChecks) }));
    if (n.ejections !== undefined) extra.push(t('Outlier detection {id}: ejected an instance {n} times', { id, n: fmtN(n.ejections) }));
    if (n.replicaReads !== undefined && (n.staleReads || (n.maxReplLagMs ?? 0) >= 100)) {
      const share = n.replicaReads ? ` (${((100 * (n.staleReads ?? 0)) / n.replicaReads).toFixed(1)}%)` : '';
      extra.push(t('Replication lag {id}: {reads} replica reads, {stale} stale reads{share}, max lag {lag} ms', { id, reads: fmtN(n.replicaReads), stale: fmtN(n.staleReads ?? 0), share, lag: Math.round(n.maxReplLagMs ?? 0) }));
    }
    if (n.rywMisses) extra.push(t('Read-your-writes {id}: {n} reads right after the user\'s own write did not see it', { id, n: fmtN(n.rywMisses) }));
    if (n.lockWaits) extra.push(t('Row locks {id}: {n} writes waited for another write\'s lock', { id, n: fmtN(n.lockWaits) }));
    if (n.divergentWrites) extra.push(t('Split brain {id}: the old primary took {n} writes the new primary does not have', { id, n: fmtN(n.divergentWrites) }));
  }
  // several clients (request classes, tenants): how each one fared
  const clients = Object.entries(r.nodes).filter(([, n]) => n.kind === 'client');
  if (clients.length > 1 && clients.some(([, n]) => n.fail > 0)) {
    extra.push(
      t('Per user:') +
        clients
          .map(([id, n]) =>
            t('{who} failed {fail}/{total} ({p}%)', {
              who: n.label === id ? id : t('{id} ({label})', { id, label: n.label }),
              fail: fmtN(n.fail),
              total: fmtN(n.arrivals),
              p: n.arrivals ? ((100 * n.fail) / n.arrivals).toFixed(1) : '0.0',
            }),
          )
          .join(t(', ')),
    );
  }
  for (const [id, e] of Object.entries(r.edges)) {
    if (e.denied) extra.push(t('Retry budget {id}: {n} retries blocked ({k} actual retries)', { id, n: fmtN(e.denied), k: fmtN(e.retries) }));
    if (e.throttled) extra.push(t('Adaptive throttling {id}: the caller rejected {n} calls without sending them ({k} sent)', { id, n: fmtN(e.throttled), k: fmtN(e.calls) }));
    if (e.bulkhead) extra.push(t('Bulkhead {id}: rejected {n} calls because the concurrent-call slots were full', { id, n: fmtN(e.bulkhead) }));
    if (e.fallbacks) extra.push(t('Fallback {id}: {n} failed calls answered with a fallback response', { id, n: fmtN(e.fallbacks) }));
    if (e.connects) extra.push(t('Connections {id}: {n} new connections opened ({k} calls; the others reused an open connection)', { id, n: fmtN(e.connects), k: fmtN(e.calls) }));
    if (e.hedges) extra.push(t('Hedged requests {id}: {n} extra copies sent ({k} succeeded before the original)', { id, n: fmtN(e.hedges), k: fmtN(e.hedgeWins ?? 0) }));
  }
  if (extra.length) out.push(...extra);
  out.push('');
  const head = [t('Component'), 'rps', t('Busy'), t('Busiest'), t('Avg queued'), t('Wait ms'), t('Theory wait ms'), t('Hit rate'), t('Its own failures')];
  const rows: string[][] = [];
  for (const [id, n] of Object.entries(r.nodes)) {
    const th = n.theory;
    const own = FAIL_REASONS.filter((k) => n.origin[k]).map((k) => `${t(FAIL_LABEL[k])} ${fmtN(n.origin[k])}`).join(t(', '));
    rows.push([
      t('{id} ({label})', { id, label: n.label }),
      fmtN(n.rps),
      pct(n.utilization),
      n.instances ? pct(n.maxInstanceUtilization) : '',
      n.avgQueue !== undefined ? n.avgQueue.toFixed(1) : n.queueDepthAvg !== undefined ? t('{n} messages', { n: n.queueDepthAvg.toFixed(0) }) : '',
      n.waitMs !== undefined ? fmtMs(n.waitMs) : '',
      th ? (th.waitMs === null ? t('Unstable') : fmtMs(th.waitMs)) : '',
      n.hitRatio !== undefined ? pct(n.hitRatio) : '',
      own,
    ]);
  }
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((row) => width(row[i]))));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i], i > 0 && i < 8)).join('  ').trimEnd();
  out.push(line(head));
  for (const row of rows) out.push(line(row));
  if (r.timeline.length) {
    out.push('');
    out.push(t('Events:'));
    for (const e of r.timeline.slice(0, 40)) out.push('  ' + t('{s} s  {text}', { s: e.t.toFixed(1), text: e.text }));
    if (r.timeline.length > 40) out.push('  ' + t('…and {n} more', { n: r.timeline.length - 40 }));
  }
  return out.join('\n');
}

function cmdRun(a: Args): void {
  const path = a.pos[0];
  if (!path) usage(1);
  const d = loadDesign(path);
  const scPath = a.flags.get('scenario');
  let sc: Scenario = typeof scPath === 'string' ? loadScenario(scPath, d) : { schema: SCENARIO_SCHEMA, name: 'default', traffic: { rps: 100 } };
  sc = structuredClone(sc);
  const num = (k: string): number | undefined => {
    const v = a.flags.get(k);
    if (v === undefined) return undefined;
    const x = Number(v);
    if (!Number.isFinite(x)) fail(t('--{k} must be a number', { k }));
    return x;
  };
  const rps = num('rps');
  if (rps !== undefined) sc.traffic.rps = rps;
  const rr = num('read-ratio');
  if (rr !== undefined) sc.traffic.readRatio = rr;
  const dur = num('duration');
  if (dur !== undefined) sc.durationS = dur;
  const wu = num('warmup');
  if (wu !== undefined) sc.warmupS = wu;
  const seed = num('seed');
  if (seed !== undefined) sc.seed = seed;
  const t0 = performance.now();
  const r = simulate(localizeDesign(d), localizeScenario(sc));
  const ms = performance.now() - t0;
  if (a.flags.has('json')) process.stdout.write(formatJson(r));
  else {
    console.log(report(r));
    console.log('\n' + t('(took {s} s)', { s: (ms / 1000).toFixed(2) }));
  }
}

function cmdValidate(a: Args): void {
  if (!a.pos.length) usage(1);
  let bad = false;
  for (const path of a.pos) {
    const v = readJson(path) as { schema?: unknown };
    const r = v?.schema === DESIGN_SCHEMA ? parseDesign(v) : v?.schema === SCENARIO_SCHEMA ? parseScenario(v) : null;
    if (!r) {
      console.error(`${path}: ` + t('error: the schema field must be "{a}" or "{b}"', { a: DESIGN_SCHEMA, b: SCENARIO_SCHEMA }));
      bad = true;
      continue;
    }
    printIssues(path, r.issues);
    if (!r.ok) bad = true;
    else console.log(`${path}: ` + t('OK ({n} warnings)', { n: r.issues.length }));
  }
  process.exit(bad ? 1 : 0);
}

function cmdFmt(a: Args): void {
  if (!a.pos.length) usage(1);
  let changed = 0;
  for (const path of a.pos) {
    const text = readFileSync(path, 'utf8');
    const out = formatJson(JSON.parse(text));
    if (out === text) continue;
    changed++;
    if (a.flags.has('write')) writeFileSync(path, out);
    else if (a.flags.has('check')) console.error(`${path}: ` + t('not in canonical format'));
    else process.stdout.write(out);
  }
  if (a.flags.has('check') && changed) process.exit(1);
}

function cmdSchema(a: Args): void {
  const schemas = jsonSchemas();
  if (a.flags.has('write')) {
    const dir = join(ROOT, 'schema');
    mkdirSync(dir, { recursive: true });
    for (const [name, s] of Object.entries(schemas)) {
      writeFileSync(join(dir, name), formatJson(s));
      console.log(t('Write to {path}', { path: `schema/${name}` }));
    }
  } else process.stdout.write(formatJson(schemas));
}

// The design goes to --out (or stdout); what the import found goes to stderr, or with --json the whole
// result (design, line kinds, origins, facts, notes) goes to stdout.
function cmdImport(a: Args): void {
  const [source, path] = a.pos;
  if (source !== 'terraform' || !path) usage(1);
  const name = a.flags.get('name');
  const answersPath = a.flags.get('answers');
  let r;
  let at = path;
  let answers: Answers | undefined;
  try {
    if (typeof answersPath === 'string') {
      at = answersPath;
      answers = parseAnswers(readJson(answersPath));
      at = path;
    }
    r = importTerraform(readJson(path), { name: typeof name === 'string' ? name : undefined, answers });
  } catch (e) {
    if (e instanceof PlanError) fail(`${e.id.startsWith('import.answers.') && typeof answersPath === 'string' ? answersPath : at}: ` + importMessage(e.id, e.args));
    throw e;
  }
  const check = parseDesign(r.design);
  printIssues(path, check.issues);
  const peak = answers?.traffic?.peakRps;
  const findings = runChecks(r, peak ? { peakRps: { value: peak, origin: { evidence: 'answer' } } } : {});
  // --simulate: only with traffic in the answer file; without it, the static checks only.
  // --find-limit (M28, Q11 C): with a peak in the answer file, that peak is simulated instead.
  const peakGiven = !!answers?.traffic;
  const wantLimit = a.flags.has('find-limit') && check.ok;
  if (wantLimit && peakGiven) console.error(importMessage('limit.useSimulate'));
  const sim = (a.flags.has('simulate') || wantLimit) && check.ok && answers ? simulateImport(r.design, answers) : undefined;
  const limit = wantLimit && !peakGiven
    ? findLimit(r.design, answers ?? parseAnswers({ schema: ANSWERS_SCHEMA }), (s) => console.error(`  ${s.rps} rps: ${s.verdict}${s.failed.length ? ` (${s.failed.join(', ')})` : ''}${s.bottleneck ? ` · ${s.bottleneck}` : ''}`))
    : undefined;
  const out = a.flags.get('out');
  if (typeof out === 'string') writeFileSync(out, formatJson(r.design));
  const report = a.flags.get('report');
  if (typeof report === 'string') writeFileSync(report, importReport(r, findings, sim, limit));
  const simJson = sim && { verdict: sim.verdict, insufficient: sim.insufficient, criteria: sim.criteria, bottleneck: sim.bottleneck, timing: sim.timing, slo: sim.slo, scenario: sim.scenario };
  if (a.flags.has('json')) process.stdout.write(formatJson({ ...r, findings, ...(simJson ? { simulation: simJson } : {}), ...(limit ? { limit, assumptions: assumptionsOf(r) } : {}) }));
  else if (typeof out !== 'string') process.stdout.write(formatJson(r.design));
  const kinds = { definite: t('definite'), presumed: t('presumed'), candidate: t('candidate'), generated: t('generated'), answer: t('answer file') } as Record<string, string>;
  console.error(t('Imported {n} components and {e} lines:', { n: r.design.nodes.length, e: r.design.edges.length }));
  for (const [id, e] of Object.entries(r.edges)) console.error(`  ${id}  ${kinds[e.kind] ?? e.kind}${e.confirmed ? t(' (confirmed by the answer file)') : ''}${e.via.length ? `  ← ${e.via.join(', ')}` : ''}`);
  if (r.candidates.length) console.error(t('Candidate lines (from security groups only; drawn after an answer file confirms them): {n}', { n: r.candidates.length }));
  for (const u of r.unmapped) console.error(`  ${t('Not converted yet: ')}${u.address}`);
  for (const n of r.notes) console.error(`  ${n.node ? `［${n.node}］` : ''}${importMessage(n.id, n.args)}`);
  console.error(t('{n} findings:', { n: findings.length }));
  for (const f of findings) console.error(`  ${f.severity} ${f.check} [${f.certainty}] ${f.node}：${importMessage(f.id, f.args)}`);
  if (a.flags.has('simulate') && !sim && check.ok) console.error(importMessage('simulate.noTraffic'));
  if (sim) for (const line of simulateSection(sim)) if (line) console.error(line.replace(/^## /, ''));
  if (limit) for (const line of limitSummary(limit, assumptionsOf(r).length)) console.error(line);
  if (typeof out === 'string') console.error(t('Write to {path}', { path: out }));
  if (typeof report === 'string') console.error(t('Write to {path}', { path: report }));
  if (!check.ok) process.exit(1);
  // --strict (Q10): fail only on definite high findings; assumptions never block.
  const blocked = blocking(findings);
  if (a.flags.has('strict') && blocked.length) {
    console.error(t('--strict: {n} definite high-severity findings.', { n: blocked.length }));
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const langArg = args.flags.get('lang');
setLang(pickLang(typeof langArg === 'string' ? langArg : (process.env.LOADSKETCH_LANG ?? 'zh-TW')));
switch (cmd) {
  case 'run':
    cmdRun(args);
    break;
  case 'validate':
    cmdValidate(args);
    break;
  case 'fmt':
    cmdFmt(args);
    break;
  case 'schema':
    cmdSchema(args);
    break;
  case 'import':
    cmdImport(args);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    usage(0);
    break;
  default:
    console.error(t('Unknown command: {cmd}', { cmd }));
    usage(1);
}
