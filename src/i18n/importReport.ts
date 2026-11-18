// The import report: Markdown, in the current language. Findings first (most severe
// first, with how sure each one is, the formula's inputs and their evidence), then the guessed
// values, the approximations, and what the import left out. src/import/ returns ids; text is here.
import type { Evidence } from '../schema/design.ts';
import { assumptionsOf, type Certainty, type Finding, type ImportResult, type LimitResult, type Severity, type SimulateResult, type Verdict } from '../import/terraform/index.ts';
import { importMessage } from './importMessages.ts';
import { t, tx } from './index.ts';

export const SEVERITY: Record<Severity, string> = { high: tx('high'), medium: tx('medium'), low: tx('low'), info: tx('info') };
export const CERTAINTY: Record<Certainty, string> = { definite: tx('definite'), user: tx('user-provided'), assumption: tx('assumption'), incomplete: tx('incomplete') };
const EVIDENCE: Record<Evidence, string> = { iac: tx('written in the IaC'), 'aws-default': tx('AWS default'), estimate: tx('estimate'), answer: tx('answer file'), 'loadsketch-default': tx('loadsketch default') };
const LINE: Record<string, string> = { definite: tx('definite line'), presumed: tx('presumed line'), candidate: tx('candidate line'), generated: tx('generated'), answer: tx('answer-file line') };

/** `|` and new lines would break a Markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const VERDICT: Record<Verdict, string> = { pass: tx('Holds'), fail: tx('Does not hold'), insufficient: tx('Insufficient data') };

/** The --simulate section: the verdict, each limit, and the timing. Every result is an assumption. */
export function simulateSection(s: SimulateResult): string[] {
  const L: string[] = [];
  L.push(`## ${t('Simulation ({rps} rps)', { rps: s.scenario.traffic.rps })}`, '');
  L.push(`**${t(VERDICT[s.verdict])}**（${t('an assumption: it uses estimates and loadsketch defaults, see "Guessed values"')}）`, '');
  if (s.insufficient) L.push(importMessage(s.insufficient.id, s.insufficient.args), '');
  for (const c of s.criteria) L.push(`- ${c.ok ? '✓' : '✗'} ${importMessage(c.id, c.args)}`);
  L.push('');
  if (s.bottleneck) L.push(t('Busiest component: {node} (utilization {pct}%)', { node: s.bottleneck.node, pct: Math.round(s.bottleneck.utilization * 100) }), '');
  L.push(t('Time: {warm} s warm-up, measured until {load} s, then {drain} s drain ({total} s in all).', { warm: s.timing.warmS, load: s.timing.loadS, drain: s.timing.drainS, total: s.timing.durationS }), '');
  return L;
}

/** The --find-limit conclusion, one line each: never "the limit is X". */
export function limitSummary(l: LimitResult, nAssumptions: number): string[] {
  return [...limitConclusion(l), importMessage('limit.assumptions', { n: nAssumptions })];
}

/** What the search found, without the estimates line (the app lists them itself); `name` shows a node. */
export function limitConclusion(l: LimitResult, name: (id: string) => string = (id) => id): string[] {
  const L: string[] = [];
  const node = l.bottleneck ? name(l.bottleneck) : '?';
  if (l.firstFailRps !== undefined && l.holdsRps !== undefined) L.push(importMessage('limit.holds', { holds: l.holdsRps, fail: l.firstFailRps, node }));
  else if (l.firstFailRps !== undefined) L.push(importMessage('limit.failsAtStart', { fail: l.firstFailRps, node }));
  else if (!l.stopped) L.push(importMessage('limit.noFail', { rps: Math.max(...l.steps.map((s) => s.rps)) }));
  if (l.nonMonotonic) L.push(importMessage('limit.nonMonotonic', { fail: l.firstFailRps!, passes: l.steps.filter((s) => s.verdict === 'pass' && s.rps > l.firstFailRps!).map((s) => s.rps).join(', ') }));
  if (l.stopped) L.push(importMessage('limit.stopped', { rps: l.stopped.rps, why: importMessage(l.stopped.id, {}) }));
  return L;
}

/** The --find-limit section of the report: the conclusion, every step, and the estimates it rests on. */
export function limitSection(l: LimitResult, assumptions: { node: string; param: string; value: string; from?: string }[]): string[] {
  const L: string[] = [`## ${t('Limit search (no peak given)')}`, '', ...limitSummary(l, assumptions.length).flatMap((x) => [x, '']), t('| rps | Result | Missed | Busiest component |'), '|---|---|---|---|'];
  for (const s of l.steps) L.push(`| ${s.rps} | ${t(VERDICT[s.verdict])} | ${s.failed.join(', ')} | ${s.bottleneck ?? ''} |`);
  L.push('');
  if (assumptions.length) {
    L.push(t('Estimated values used:'), '');
    for (const a of assumptions) L.push(`- \`${a.node}.${a.param}\` = ${a.value}${a.from ? `（${a.from}）` : ''}`);
    L.push('');
  }
  return L;
}

export function importReport(res: ImportResult, findings: Finding[], sim?: SimulateResult, limit?: LimitResult): string {
  const L: string[] = [];
  L.push(`# ${t('Import report: {name}', { name: res.design.name })}`, '');
  L.push(t('{n} components, {e} lines, {f} findings.', { n: res.design.nodes.length, e: res.design.edges.length, f: findings.length }), '');
  if (sim) L.push(...simulateSection(sim));
  if (limit) L.push(...limitSection(limit, assumptionsOf(res)));

  L.push(`## ${t('Findings')}`, '');
  if (!findings.length) L.push(t('No findings.'), '');
  else {
    L.push(`| ${t('Severity')} | ${t('Certainty')} | ${t('Check')} | ${t('Component')} | ${t('Finding')} |`, '|---|---|---|---|---|');
    for (const f of findings) L.push(`| ${t(SEVERITY[f.severity])} | ${t(CERTAINTY[f.certainty])} | ${f.check} | ${f.node} | ${cell(importMessage(f.id, f.args))} |`);
    L.push('');
    for (const f of findings) {
      L.push(`### ${f.check} · ${f.node}`, '', importMessage(f.id, f.args), '');
      if (f.inputs.length) {
        L.push(`${t('Inputs:')}`, '');
        for (const i of f.inputs) L.push(`- \`${i.name}\` = ${i.value}（${t(EVIDENCE[i.origin.evidence])}${i.origin.measured ? t(', measured') : ''}${i.origin.from ? `，${i.origin.from}` : ''}${i.origin.source ? `，${i.origin.source}` : ''}）`);
        L.push('');
      }
      if (f.lines.length) L.push(`${t('Lines used: ')}${f.lines.map((l) => `\`${l.id}\`（${t(LINE[l.kind] ?? l.kind)}${l.confirmed ? t(', confirmed by the answer file') : ''}）`).join('、')}`, '');
      if (f.resources.length) L.push(`${t('Resources: ')}${f.resources.map((r) => `\`${r}\``).join('、')}`, '');
      L.push(`${t('Advice: ')}${importMessage(f.advice)}`, '');
    }
  }

  L.push(`## ${t('Guessed values')}`, '', t('These values are not in the IaC; they are estimates or loadsketch defaults. Override them in the answer file.'), '');
  const guessed = Object.entries(res.origins).flatMap(([node, ps]) => Object.entries(ps).filter(([, o]) => o.evidence === 'estimate').map(([p, o]) => ({ node, p, o })));
  if (!guessed.length) L.push(t('None.'), '');
  else {
    L.push(`| ${t('Component')} | ${t('Param')} | ${t('Value')} | ${t('Based on')} |`, '|---|---|---|---|');
    for (const g of guessed) {
      const v = res.design.nodes.find((n) => n.id === g.node)?.params?.[g.p];
      L.push(`| ${g.node} | ${g.p} | ${cell(typeof v === 'object' ? JSON.stringify(v) : String(v))} | ${cell(g.o.from ?? '')} |`);
    }
    L.push('');
  }

  L.push(`## ${t('Lines')}`, '');
  for (const e of res.design.edges) {
    const k = res.edges[e.id!];
    L.push(`- \`${e.from}\` → \`${e.to}\`：${t(LINE[k.kind] ?? k.kind)}${k.confirmed ? t(', confirmed by the answer file') : ''}${k.via.length ? `（${k.via.join('、')}）` : ''}`);
  }
  for (const c of res.candidates) L.push(`- \`${c.from}\` → \`${c.to}\`：${t('candidate line, not drawn (drawn after the answer file confirms it)')}`);
  L.push('');

  const notes = res.notes;
  if (notes.length) {
    L.push(`## ${t('Approximations and notes')}`, '');
    for (const n of notes) L.push(`- ${n.node ? `\`${n.node}\`：` : ''}${importMessage(n.id, n.args)}`);
    L.push('');
  }
  if (res.unmapped.length) {
    L.push(`## ${t('Not converted yet')}`, '');
    for (const u of res.unmapped) L.push(`- \`${u.address}\``);
    L.push('');
  }
  if (res.folded.length) {
    L.push(`## ${t('Folded into other components or skipped')}`, '');
    for (const f of res.folded) L.push(`- \`${f.address}\`${f.into ? ` → \`${f.into}\`` : ''}：${importMessage(f.why)}`);
    L.push('');
  }
  return L.join('\n');
}
