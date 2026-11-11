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
import { pickLang, setLang, t } from '../src/i18n/index.ts';
import { localizeDesign, localizeScenario } from '../src/i18n/content.ts';
import { importMessage } from '../src/i18n/importMessages.ts';
import { ANSWERS_SCHEMA, assumptionsOf, blocking, findLimit, importTerraform, parseAnswers, PlanError, runChecks, simulateImport, type Answers } from '../src/import/terraform/index.ts';
import { importReport, limitSummary, simulateSection } from '../src/i18n/importReport.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(code = 0): never {
  console.log(
    [
      t('用法：'),
      '  loadsketch run <design.json> [--scenario <scenario.json>] [--rps N] [--duration ' + t('秒') + '] [--seed N] [--json]',
      '  loadsketch validate <file.json>...      ' + t('檢查設計檔或情境檔'),
      '  loadsketch fmt <file.json>... [--write | --check]   ' + t('用標準格式重排（--check：格式不對就回傳 1）'),
      '  loadsketch schema [--write]             ' + t('印出（或寫入 schema/）JSON Schema'),
      '  loadsketch import terraform <plan.json> [--answers <answers.json>] [--out <design.json>] [--report <report.md>] [--strict] [--simulate] [--find-limit] [--name <name>] [--json]   ' + t('把 Terraform plan（terraform show -json）轉成設計檔'),
      '  --lang zh-TW|en                     ' + t('輸出語言（也可以用環境變數 LOADSKETCH_LANG）'),
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
    fail(t('讀不到檔案 {path}：{why}', { path, why: (e as Error).message }));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(t('{path} 不是合法的 JSON：{why}', { path, why: (e as Error).message }));
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printIssues(path: string, issues: Issue[]): void {
  for (const i of issues) {
    const where = i.node ? `［${i.node}］` : i.edge ? `［${i.edge}］` : i.path ? `［${i.path}］` : '';
    console.error(`${path}: ${i.level === 'error' ? t('錯誤') : t('提醒')} ${i.code}${where} ${i.message}`);
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
  out.push(t('設計：{design}　情境：{scenario}（{rps} rps，{dur} 秒，讀取 {read}，種子 {seed}）', { design: r.design, scenario: sc.name, rps: fmtN(sc.rps), dur: sc.durationS, read: pct(sc.readRatio), seed: sc.seed }));
  if (r.scale) out.push(t('模擬 1/{k}，數字已換算：流量和容量都除以 {k}，請求數、rps、錯誤數乘回 {k}。', { k: r.scale }));
  out.push(
    t('量測區間：{from}–{to} 秒（前面是暖機）。模擬了 {n} 個事件', { from: r.measuredFromS, to: +(r.measuredFromS + r.measuredS).toFixed(3), n: fmtN(r.events) }) +
      (r.truncated ? t('，事件數到上限，提早停止') : '') +
      (r.unfinished ? t('；結束時還有 {n} 件背景工作沒做完', { n: fmtN(r.unfinished) }) : '') +
      t('。'),
  );
  out.push('');
  const failTotal = FAIL_REASONS.reduce((a, k) => a + s.fail[k], 0);
  out.push(t('請求：送出 {offered}，成功 {ok}，失敗 {fail}（錯誤率 {err}%）', { offered: fmtN(s.offered), ok: fmtN(s.ok), fail: fmtN(failTotal), err: (s.errorRate * 100).toFixed(2) }));
  if (failTotal) {
    out.push('  ' + t('失敗原因：') + FAIL_REASONS.filter((k) => s.fail[k]).map((k) => `${t(FAIL_LABEL[k])} ${fmtN(s.fail[k])}`).join(t('，')));
  }
  const l = s.latencyMs;
  out.push(t('成功請求的延遲（ms）：平均 {mean}，p50 {p50}，p95 {p95}，p99 {p99}，p99.9 {p999}，最大 {max}', { mean: fmtMs(l.mean), p50: fmtMs(l.p50), p95: fmtMs(l.p95), p99: fmtMs(l.p99), p999: fmtMs(l.p999), max: fmtMs(l.max) }));
  if (s.degraded) out.push('  ' + t('降級回應：{n} 個成功的請求用了備用回應（fallback）', { n: fmtN(s.degraded) }));
  out.push(t('吞吐量：{rps} rps 成功', { rps: fmtN(s.throughputRps) }));
  if (s.asyncLatencyMs.count) {
    const a = s.asyncLatencyMs;
    out.push(t('非同步工作（進佇列到處理完）：{n} 件，p50 {p50} ms，p99 {p99} ms', { n: fmtN(a.count), p50: fmtMs(a.p50), p99: fmtMs(a.p99) }));
  }
  out.push('');
  if (r.bottleneck) out.push(t('瓶頸：{why}', { why: r.bottleneck.why }));
  // the newer mechanisms: autoscaling, deadline propagation, retry budget, queue delivery
  const extra: string[] = [];
  for (const [id, n] of Object.entries(r.nodes)) {
    const a = n.autoscale;
    if (a) extra.push(t('自動擴充 {id}：{min}–{max} 台，最多同時 {peak} 台，結束時 {end} 台（加 {add} 台、減 {del} 台）', { id, min: a.min, max: a.max, peak: a.peakActive, end: a.endActive, add: a.launches, del: a.retires }) + (a.bootFails ? t('，開機失敗 {n} 次', { n: a.bootFails }) : ''));
    const isQueue = n.queueDepthEnd !== undefined;
    if (n.expired && isQueue) extra.push(t('訊息過期 {id}：{n} 則訊息放太久，被丟掉', { id, n: fmtN(n.expired) }));
    else if (n.expired) extra.push(t('Deadline {id}：{n} 個請求排隊時已過期，直接丟掉沒有做', { id, n: fmtN(n.expired) }));
    if (n.redelivered !== undefined)
      extra.push(t('至少一次 {id}：重送 {re} 次，重複處理 {dup} 次，移到 DLQ {dlq} 則', { id, re: fmtN(n.redelivered), dup: fmtN(n.duplicates ?? 0), dlq: fmtN(n.dlq ?? 0) }));
    if (n.holBlocked) extra.push(t('FIFO {id}：{n} 則訊息排在同組前一則後面等', { id, n: fmtN(n.holBlocked) }));
    if (n.dualWriteGaps) extra.push(t('Dual write {id}：{n} 筆寫入的 DB 和 queue 一個成功一個失敗（資料和訊息不一致）', { id, n: fmtN(n.dualWriteGaps) }));
    if (n.outboxRetries) extra.push(t('Outbox {id}：relay 重送 {n} 次', { id, n: fmtN(n.outboxRetries) }));
    if (n.coalesced) extra.push(t('合併查詢 {id}：{n} 次沒命中等別人的查詢結果，沒有自己查 DB', { id, n: fmtN(n.coalesced) }));
    if (n.leaseWaits) extra.push(t('Lease {id}：{n} 次沒拿到 lease，稍後再問快取', { id, n: fmtN(n.leaseWaits) }));
    if (n.hcRemoved !== undefined) extra.push(t('Health check {id}：移出實例 {n} 次', { id, n: fmtN(n.hcRemoved) }));
    if (n.blindChecks) extra.push(t('控制面 {id}：看不到監控、沒有動作 {n} 次', { id, n: fmtN(n.blindChecks) }));
    if (n.ejections !== undefined) extra.push(t('自動剔除 {id}：剔除實例 {n} 次', { id, n: fmtN(n.ejections) }));
    if (n.replicaReads !== undefined && (n.staleReads || (n.maxReplLagMs ?? 0) >= 100)) {
      const share = n.replicaReads ? ` (${((100 * (n.staleReads ?? 0)) / n.replicaReads).toFixed(1)}%)` : '';
      extra.push(t('複製延遲 {id}：讀副本 {reads} 次，讀到舊資料 {stale} 次{share}，最大延遲 {lag} ms', { id, reads: fmtN(n.replicaReads), stale: fmtN(n.staleReads ?? 0), share, lag: Math.round(n.maxReplLagMs ?? 0) }));
    }
    if (n.rywMisses) extra.push(t('Read-your-writes {id}：{n} 次寫入後馬上讀，沒看到自己的寫入', { id, n: fmtN(n.rywMisses) }));
    if (n.lockWaits) extra.push(t('列鎖 {id}：{n} 筆寫入等別人的鎖', { id, n: fmtN(n.lockWaits) }));
    if (n.divergentWrites) extra.push(t('Split brain {id}：舊主庫收了 {n} 筆新主庫沒有的寫入', { id, n: fmtN(n.divergentWrites) }));
  }
  // several clients (request classes, tenants): how each one fared
  const clients = Object.entries(r.nodes).filter(([, n]) => n.kind === 'client');
  if (clients.length > 1 && clients.some(([, n]) => n.fail > 0)) {
    extra.push(
      t('各使用者：') +
        clients
          .map(([id, n]) =>
            t('{who} 失敗 {fail}／{total}（{p}%）', {
              who: n.label === id ? id : t('{id}（{label}）', { id, label: n.label }),
              fail: fmtN(n.fail),
              total: fmtN(n.arrivals),
              p: n.arrivals ? ((100 * n.fail) / n.arrivals).toFixed(1) : '0.0',
            }),
          )
          .join(t('，')),
    );
  }
  for (const [id, e] of Object.entries(r.edges)) {
    if (e.denied) extra.push(t('重試預算 {id}：擋下 {n} 次重試（實際重試 {k} 次）', { id, n: fmtN(e.denied), k: fmtN(e.retries) }));
    if (e.throttled) extra.push(t('自我限流 {id}：呼叫端擋下 {n} 次呼叫，沒有送出（實際送出 {k} 次）', { id, n: fmtN(e.throttled), k: fmtN(e.calls) }));
    if (e.bulkhead) extra.push(t('隔艙 {id}：同時呼叫名額滿了，擋下 {n} 次呼叫', { id, n: fmtN(e.bulkhead) }));
    if (e.fallbacks) extra.push(t('降級回應 {id}：{n} 次呼叫失敗，改用備用回應', { id, n: fmtN(e.fallbacks) }));
    if (e.connects) extra.push(t('連線 {id}：新開 {n} 條連線（呼叫 {k} 次；其他的重用留著的連線）', { id, n: fmtN(e.connects), k: fmtN(e.calls) }));
    if (e.hedges) extra.push(t('對沖請求 {id}：多送 {n} 份（{k} 份比原本的先成功）', { id, n: fmtN(e.hedges), k: fmtN(e.hedgeWins ?? 0) }));
  }
  if (extra.length) out.push(...extra);
  out.push('');
  const head = [t('元件'), 'rps', t('忙碌'), t('最忙'), t('平均排隊'), t('等待ms'), t('理論等待ms'), t('命中率'), t('自己造成的失敗')];
  const rows: string[][] = [];
  for (const [id, n] of Object.entries(r.nodes)) {
    const th = n.theory;
    const own = FAIL_REASONS.filter((k) => n.origin[k]).map((k) => `${t(FAIL_LABEL[k])} ${fmtN(n.origin[k])}`).join(t('，'));
    rows.push([
      t('{id}（{label}）', { id, label: n.label }),
      fmtN(n.rps),
      pct(n.utilization),
      n.instances ? pct(n.maxInstanceUtilization) : '',
      n.avgQueue !== undefined ? n.avgQueue.toFixed(1) : n.queueDepthAvg !== undefined ? t('{n} 則', { n: n.queueDepthAvg.toFixed(0) }) : '',
      n.waitMs !== undefined ? fmtMs(n.waitMs) : '',
      th ? (th.waitMs === null ? t('不穩定') : fmtMs(th.waitMs)) : '',
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
    out.push(t('事件：'));
    for (const e of r.timeline.slice(0, 40)) out.push('  ' + t('{s} 秒　{text}', { s: e.t.toFixed(1), text: e.text }));
    if (r.timeline.length > 40) out.push('  ' + t('……另外 {n} 個', { n: r.timeline.length - 40 }));
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
    if (!Number.isFinite(x)) fail(t('--{k} 要是數字', { k }));
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
    console.log('\n' + t('（花了 {s} 秒）', { s: (ms / 1000).toFixed(2) }));
  }
}

function cmdValidate(a: Args): void {
  if (!a.pos.length) usage(1);
  let bad = false;
  for (const path of a.pos) {
    const v = readJson(path) as { schema?: unknown };
    const r = v?.schema === DESIGN_SCHEMA ? parseDesign(v) : v?.schema === SCENARIO_SCHEMA ? parseScenario(v) : null;
    if (!r) {
      console.error(`${path}: ` + t('錯誤 schema 欄位要是 "{a}" 或 "{b}"', { a: DESIGN_SCHEMA, b: SCENARIO_SCHEMA }));
      bad = true;
      continue;
    }
    printIssues(path, r.issues);
    if (!r.ok) bad = true;
    else console.log(`${path}: ` + t('OK（{n} 個提醒）', { n: r.issues.length }));
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
    else if (a.flags.has('check')) console.error(`${path}: ` + t('不是標準格式'));
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
      console.log(t('寫入 {path}', { path: `schema/${name}` }));
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
  const kinds = { definite: t('確定'), presumed: t('推定'), candidate: t('候選'), generated: t('自動加上'), answer: t('答案檔') } as Record<string, string>;
  console.error(t('匯入 {n} 個元件、{e} 條線：', { n: r.design.nodes.length, e: r.design.edges.length }));
  for (const [id, e] of Object.entries(r.edges)) console.error(`  ${id}  ${kinds[e.kind] ?? e.kind}${e.confirmed ? t('（答案檔確認）') : ''}${e.via.length ? `  ← ${e.via.join(', ')}` : ''}`);
  if (r.candidates.length) console.error(t('候選線（只靠安全群組，答案檔確認後才畫）：{n} 條', { n: r.candidates.length }));
  for (const u of r.unmapped) console.error(`  ${t('還不會轉換：')}${u.address}`);
  for (const n of r.notes) console.error(`  ${n.node ? `［${n.node}］` : ''}${importMessage(n.id, n.args)}`);
  console.error(t('發現 {n} 個：', { n: findings.length }));
  for (const f of findings) console.error(`  ${f.severity} ${f.check} [${f.certainty}] ${f.node}：${importMessage(f.id, f.args)}`);
  if (a.flags.has('simulate') && !sim && check.ok) console.error(importMessage('simulate.noTraffic'));
  if (sim) for (const line of simulateSection(sim)) if (line) console.error(line.replace(/^## /, ''));
  if (limit) for (const line of limitSummary(limit, assumptionsOf(r).length)) console.error(line);
  if (typeof out === 'string') console.error(t('寫入 {path}', { path: out }));
  if (typeof report === 'string') console.error(t('寫入 {path}', { path: report }));
  if (!check.ok) process.exit(1);
  // --strict (Q10): fail only on definite high findings; assumptions never block.
  const blocked = blocking(findings);
  if (a.flags.has('strict') && blocked.length) {
    console.error(t('--strict：{n} 個確定的高嚴重度發現。', { n: blocked.length }));
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
    console.error(t('不認得的指令：{cmd}', { cmd }));
    usage(1);
}
