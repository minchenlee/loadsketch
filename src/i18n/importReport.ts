// The import report: Markdown, in the current language. Findings first (most severe
// first, with how sure each one is, the formula's inputs and their evidence), then the guessed
// values, the approximations, and what the import left out. src/import/ returns ids; text is here.
import type { Evidence } from '../schema/design.ts';
import { assumptionsOf, type Certainty, type Finding, type ImportResult, type LimitResult, type Severity, type SimulateResult, type Verdict } from '../import/terraform/index.ts';
import { importMessage } from './importMessages.ts';
import { t, tx } from './index.ts';

export const SEVERITY: Record<Severity, string> = { high: tx('高'), medium: tx('中'), low: tx('低'), info: tx('資訊') };
export const CERTAINTY: Record<Certainty, string> = { definite: tx('確定'), user: tx('依使用者提供'), assumption: tx('依假設'), incomplete: tx('資料不完整') };
const EVIDENCE: Record<Evidence, string> = { iac: tx('IaC 明寫'), 'aws-default': tx('AWS 預設'), estimate: tx('估計'), answer: tx('答案檔'), 'loadsketch-default': tx('loadsketch 預設') };
const LINE: Record<string, string> = { definite: tx('確定線'), presumed: tx('推定線'), candidate: tx('候選線'), generated: tx('自動加上'), answer: tx('答案檔的線') };

/** `|` and new lines would break a Markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const VERDICT: Record<Verdict, string> = { pass: tx('撐得住'), fail: tx('撐不住'), insufficient: tx('結果不足') };

/** The --simulate section: the verdict, each limit, and the timing. Every result is an assumption. */
export function simulateSection(s: SimulateResult): string[] {
  const L: string[] = [];
  L.push(`## ${t('模擬（{rps} rps）', { rps: s.scenario.traffic.rps })}`, '');
  L.push(`**${t(VERDICT[s.verdict])}**（${t('依假設：用到估計值和 loadsketch 預設值，見「猜的值」')}）`, '');
  if (s.insufficient) L.push(importMessage(s.insufficient.id, s.insufficient.args), '');
  for (const c of s.criteria) L.push(`- ${c.ok ? '✓' : '✗'} ${importMessage(c.id, c.args)}`);
  L.push('');
  if (s.bottleneck) L.push(t('最忙的元件：{node}（忙碌率 {pct}%）', { node: s.bottleneck.node, pct: Math.round(s.bottleneck.utilization * 100) }), '');
  L.push(t('時間：暖機 {warm} 秒，量測到第 {load} 秒，之後排空 {drain} 秒（共 {total} 秒）。', { warm: s.timing.warmS, load: s.timing.loadS, drain: s.timing.drainS, total: s.timing.durationS }), '');
  return L;
}

/** The --find-limit conclusion, one line each: never "the limit is X". */
export function limitSummary(l: LimitResult, nAssumptions: number): string[] {
  const L: string[] = [];
  const node = l.bottleneck ?? '?';
  if (l.firstFailRps !== undefined && l.holdsRps !== undefined) L.push(importMessage('limit.holds', { holds: l.holdsRps, fail: l.firstFailRps, node }));
  else if (l.firstFailRps !== undefined) L.push(importMessage('limit.failsAtStart', { fail: l.firstFailRps, node }));
  else if (!l.stopped) L.push(importMessage('limit.noFail', { rps: Math.max(...l.steps.map((s) => s.rps)) }));
  if (l.nonMonotonic) L.push(importMessage('limit.nonMonotonic', { fail: l.firstFailRps!, passes: l.steps.filter((s) => s.verdict === 'pass' && s.rps > l.firstFailRps!).map((s) => s.rps).join(', ') }));
  if (l.stopped) L.push(importMessage('limit.stopped', { rps: l.stopped.rps, why: importMessage(l.stopped.id, {}) }));
  L.push(importMessage('limit.assumptions', { n: nAssumptions }));
  return L;
}

/** The --find-limit section of the report: the conclusion, every step, and the estimates it rests on. */
export function limitSection(l: LimitResult, assumptions: { node: string; param: string; value: string; from?: string }[]): string[] {
  const L: string[] = [`## ${t('找極限（沒給尖峰流量）')}`, '', ...limitSummary(l, assumptions.length).flatMap((x) => [x, '']), t('| rps | 結果 | 沒達標 | 最忙的元件 |'), '|---|---|---|---|'];
  for (const s of l.steps) L.push(`| ${s.rps} | ${t(VERDICT[s.verdict])} | ${s.failed.join(', ')} | ${s.bottleneck ?? ''} |`);
  L.push('');
  if (assumptions.length) {
    L.push(t('用到的估計值：'), '');
    for (const a of assumptions) L.push(`- \`${a.node}.${a.param}\` = ${a.value}${a.from ? `（${a.from}）` : ''}`);
    L.push('');
  }
  return L;
}

export function importReport(res: ImportResult, findings: Finding[], sim?: SimulateResult, limit?: LimitResult): string {
  const L: string[] = [];
  L.push(`# ${t('匯入報告：{name}', { name: res.design.name })}`, '');
  L.push(t('{n} 個元件、{e} 條線、{f} 個發現。', { n: res.design.nodes.length, e: res.design.edges.length, f: findings.length }), '');
  if (sim) L.push(...simulateSection(sim));
  if (limit) L.push(...limitSection(limit, assumptionsOf(res)));

  L.push(`## ${t('發現')}`, '');
  if (!findings.length) L.push(t('沒有發現。'), '');
  else {
    L.push(`| ${t('嚴重度')} | ${t('確定性')} | ${t('檢查')} | ${t('元件')} | ${t('結論')} |`, '|---|---|---|---|---|');
    for (const f of findings) L.push(`| ${t(SEVERITY[f.severity])} | ${t(CERTAINTY[f.certainty])} | ${f.check} | ${f.node} | ${cell(importMessage(f.id, f.args))} |`);
    L.push('');
    for (const f of findings) {
      L.push(`### ${f.check} · ${f.node}`, '', importMessage(f.id, f.args), '');
      if (f.inputs.length) {
        L.push(`${t('輸入：')}`, '');
        for (const i of f.inputs) L.push(`- \`${i.name}\` = ${i.value}（${t(EVIDENCE[i.origin.evidence])}${i.origin.measured ? t('，實測') : ''}${i.origin.from ? `，${i.origin.from}` : ''}${i.origin.source ? `，${i.origin.source}` : ''}）`);
        L.push('');
      }
      if (f.lines.length) L.push(`${t('用到的線：')}${f.lines.map((l) => `\`${l.id}\`（${t(LINE[l.kind] ?? l.kind)}${l.confirmed ? t('，答案檔確認') : ''}）`).join('、')}`, '');
      if (f.resources.length) L.push(`${t('資源：')}${f.resources.map((r) => `\`${r}\``).join('、')}`, '');
      L.push(`${t('建議：')}${importMessage(f.advice)}`, '');
    }
  }

  L.push(`## ${t('猜的值')}`, '', t('這些值不是 IaC 寫的，是估計或 loadsketch 的預設；用答案檔覆寫。'), '');
  const guessed = Object.entries(res.origins).flatMap(([node, ps]) => Object.entries(ps).filter(([, o]) => o.evidence === 'estimate').map(([p, o]) => ({ node, p, o })));
  if (!guessed.length) L.push(t('沒有。'), '');
  else {
    L.push(`| ${t('元件')} | ${t('參數')} | ${t('值')} | ${t('依據')} |`, '|---|---|---|---|');
    for (const g of guessed) {
      const v = res.design.nodes.find((n) => n.id === g.node)?.params?.[g.p];
      L.push(`| ${g.node} | ${g.p} | ${cell(typeof v === 'object' ? JSON.stringify(v) : String(v))} | ${cell(g.o.from ?? '')} |`);
    }
    L.push('');
  }

  L.push(`## ${t('線')}`, '');
  for (const e of res.design.edges) {
    const k = res.edges[e.id!];
    L.push(`- \`${e.from}\` → \`${e.to}\`：${t(LINE[k.kind] ?? k.kind)}${k.confirmed ? t('，答案檔確認') : ''}${k.via.length ? `（${k.via.join('、')}）` : ''}`);
  }
  for (const c of res.candidates) L.push(`- \`${c.from}\` → \`${c.to}\`：${t('候選線，沒有畫出來（答案檔確認後才畫）')}`);
  L.push('');

  const notes = res.notes;
  if (notes.length) {
    L.push(`## ${t('近似和說明')}`, '');
    for (const n of notes) L.push(`- ${n.node ? `\`${n.node}\`：` : ''}${importMessage(n.id, n.args)}`);
    L.push('');
  }
  if (res.unmapped.length) {
    L.push(`## ${t('還不會轉換')}`, '');
    for (const u of res.unmapped) L.push(`- \`${u.address}\``);
    L.push('');
  }
  if (res.folded.length) {
    L.push(`## ${t('併入其他元件或略過')}`, '');
    for (const f of res.folded) L.push(`- \`${f.address}\`${f.into ? ` → \`${f.into}\`` : ''}：${importMessage(f.why)}`);
    L.push('');
  }
  return L.join('\n');
}
