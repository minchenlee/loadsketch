import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { LANGS, setLang, t, type Lang } from '../src/i18n/index.ts';
import { localizeDesign, localizeScenario } from '../src/i18n/content.ts';
import { IMPORT_MESSAGE_IDS, importMessage } from '../src/i18n/importMessages.ts';
import { importReport } from '../src/i18n/importReport.ts';
import { importTerraform, runChecks } from '../src/import/terraform/index.ts';
import { BRIEFS, brokenGivens, judgeBrief } from '../src/learn/briefs.ts';
import { EDGE_MECHANISMS, NODE_MECHANISMS, PROBLEMS, judgeProblem } from '../src/learn/constraints.ts';
import { judge } from '../src/learn/lesson.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { FAULTS, INCIDENTS, applyPatches, judgeFix } from '../src/learn/oncall.ts';
import { checkDesign, type Design, type Scenario } from '../src/schema/design.ts';
import { CATEGORY_LABEL, EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { jsonProblem, readPasted } from '../src/app/pasteDesign.ts';

const root = join(import.meta.dirname, '..');
const read = <T,>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;

function runFull(d: Design, s: Scenario) {
  const sim = new Simulation(d, s);
  const result = sim.runToEnd();
  return { result, windows: sim.drainWindows(), allWindows: sim.allWindows() };
}

function dumpForLang(lang: Lang) {
  setLang(lang);

  // 1. Components
  const categories = Object.fromEntries(Object.entries(CATEGORY_LABEL).map(([k, v]) => [k, t(v)]));
  const dumpParams = (params: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(params).map(([pk, p]) => [
        pk,
        {
          label: t(p.label),
          help: t(p.help),
          options:
            'options' in p && Array.isArray(p.options)
              ? p.options.map((o: any) => ({
                  value: o.value,
                  label: t(o.label),
                  ...(o.hint ? { hint: t(String(o.hint)) } : {}),
                }))
              : undefined,
        },
      ]),
    );
  const kinds = Object.fromEntries(
    Object.entries(KINDS).map(([k, spec]) => [
      k,
      {
        label: t(spec.label),
        summary: t(spec.summary),
        params: dumpParams(spec.params),
      },
    ]),
  );
  const edgeParams = dumpParams(EDGE_PARAMS);

  // 2. Designs (47) + checkDesign()
  const designFiles = readdirSync(join(root, 'examples/designs'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const designs = Object.fromEntries(
    designFiles.map((f) => {
      const d = localizeDesign(read<Design>(`examples/designs/${f}`));
      return [
        f,
        {
          name: d.name,
          description: d.description ?? null,
          nodes: d.nodes.map((n) => ({ id: n.id, label: n.label ?? null })),
          notes: (d.notes ?? []).map((n) => ({ id: n.id, text: n.text })),
          issues: checkDesign(d).map((i) => ({ code: i.code, level: i.level, message: i.message })),
        },
      ];
    }),
  );

  // 3. Scenarios (39)
  const scenarioFiles = readdirSync(join(root, 'examples/scenarios'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const scenarios = Object.fromEntries(
    scenarioFiles.map((f) => {
      const sc = localizeScenario(read<Scenario>(`examples/scenarios/${f}`));
      return [f, sc.name ?? null];
    }),
  );

  // 4. Simulation text (47 designs x spike 20s)
  const spike = localizeScenario(read<Scenario>('examples/scenarios/spike.json'));
  const simulations = Object.fromEntries(
    designFiles.map((f) => {
      const d = localizeDesign(read<Design>(`examples/designs/${f}`));
      const r = simulate(d, { ...spike, durationS: 20 });
      return [
        f,
        {
          bottleneckWhy: r.bottleneck?.why ?? null,
          timeline: r.timeline.map((e) => ({ t: e.t, type: e.type, text: e.text })),
          nodeLabels: Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, n.label])),
        },
      ];
    }),
  );

  // 5. Lessons
  const lessons = Object.fromEntries(
    Object.entries(LESSONS).map(([k, l]) => {
      const orig = localizeDesign(read<Design>(`examples/designs/${l.example}.json`));
      const sc = localizeScenario(read<Scenario>(`examples/scenarios/${l.scenario}.json`));
      const full = runFull(orig, sc);
      const runData = { design: orig, scenario: sc, result: full.result, windows: full.allWindows };
      return [
        k,
        {
          intro: t(l.intro),
          questions: l.questions.map((q) => ({
            id: q.id,
            text: t(q.text),
            options: q.options.map((o) => ({ id: o.id, text: t(o.text) })),
            measured: q.measured(runData),
            explain: t(q.explain),
            explainFor: q.explainFor
              ? Object.fromEntries(Object.entries(q.explainFor).map(([ok, v]) => [ok, t(v!)]))
              : undefined,
          })),
          challenges: l.challenges.map((c) => {
            const v = judge(c, runData, orig);
            return {
              id: c.id,
              title: t(c.title),
              text: t(c.text),
              goals: c.goals.map((g) => t(g.text)),
              rules: c.rules.map((r) => ({ short: t(r.short), text: t(r.text) })),
              hint: t(c.hint),
              verdict: v,
            };
          }),
        },
      ];
    }),
  );

  // 6. Practice (17 questions: 8 incidents, 3 problems, 6 briefs)
  const fmtBroken = (bs: { text: string; vars: Record<string, string | number> }[]) =>
    bs.map((x) => t(x.text, { ...x.vars, name: t(String(x.vars.name ?? '')), what: t(String(x.vars.what ?? '')) }));

  const incidents = INCIDENTS.map((inc) => {
    const d = localizeDesign(read<Design>(`examples/designs/${inc.example}.json`));
    const sc = localizeScenario(inc.scenario);
    const baseRun = runFull(d, sc);
    const fixedD = applyPatches(d, inc.solution);
    const fixRun = runFull(fixedD, sc);
    return {
      id: inc.id,
      title: t(inc.title),
      scenarioName: t(inc.scenario.name ?? ''),
      explain: t(inc.explain),
      hint: t(inc.hint),
      baseVerdict: judgeFix(inc, d, d, baseRun.result),
      fixVerdict: judgeFix(inc, d, fixedD, fixRun.result),
    };
  });

  const problems = PROBLEMS.map((p) => {
    const baseD = applyPatches(localizeDesign(read<Design>(`examples/designs/${p.example}.json`)), p.start);
    const sc = localizeScenario(p.scenario);
    const naiveD = applyPatches(baseD, p.naive);
    const solD = applyPatches(baseD, p.solution);
    const naiveV = judgeProblem(p, naiveD, runFull(naiveD, sc), baseD);
    const solV = judgeProblem(p, solD, runFull(solD, sc), baseD);
    const fastD = applyPatches(baseD, [{ node: 'api', params: { serviceMs: { mean: 0.1, cv: 1 } } }]);
    const fastV = judgeProblem(p, fastD, runFull(fastD, sc), baseD);
    return {
      id: p.id,
      title: t(p.title),
      text: t(p.text),
      scenarioName: t(p.scenario.name ?? ''),
      hint: t(p.hint),
      naive: {
        passed: naiveV.passed,
        points: naiveV.points.items.map((i) => ({
          where: i.where,
          text: KINDS[i.text] ? t(KINDS[i.text].label) : t(i.text),
          points: i.points,
        })),
        broken: fmtBroken(naiveV.broken),
      },
      solution: {
        passed: solV.passed,
        points: solV.points.items.map((i) => ({
          where: i.where,
          text: KINDS[i.text] ? t(KINDS[i.text].label) : t(i.text),
          points: i.points,
        })),
        broken: fmtBroken(solV.broken),
      },
      fastBroken: fmtBroken(fastV.broken),
    };
  });

  const briefs = BRIEFS.map((b) => {
    const sc = localizeScenario(b.scenario);
    const startD = localizeDesign(b.start);
    const refD = localizeDesign(b.reference);
    const naiveD = localizeDesign(b.naive);
    const naiveV = judgeBrief(b, naiveD, runFull(naiveD, sc));
    const refV = judgeBrief(b, refD, runFull(refD, sc));
    const fastRef: Design = {
      ...refD,
      nodes: refD.nodes.map((n) =>
        n.id === 'api' ? { ...n, params: { ...n.params, serviceMs: { mean: 0.1, cv: 1 } } } : n,
      ),
    };
    return {
      id: b.id,
      title: t(b.title),
      text: t(b.text),
      functional: b.functional.map((s) => t(s)),
      load: b.load.map((s) => t(s)),
      given: b.given.map((s) => t(s)),
      outOfScope: b.outOfScope.map((s) => t(s)),
      hint: t(b.hint),
      scenarioName: t(b.scenario.name ?? ''),
      needs: b.needs.map((n) => ({ id: n.id, text: t(n.text) })),
      start: { name: startD.name, nodes: startD.nodes.map((n) => ({ id: n.id, label: n.label ?? null })) },
      reference: { name: refD.name, nodes: refD.nodes.map((n) => ({ id: n.id, label: n.label ?? null })) },
      naive: { name: naiveD.name, nodes: naiveD.nodes.map((n) => ({ id: n.id, label: n.label ?? null })) },
      naiveVerdict: {
        passed: naiveV.passed,
        needs: naiveV.needs.map((n) => ({ id: n.id, text: t(n.text), ok: n.ok })),
        broken: fmtBroken(naiveV.broken),
      },
      refVerdict: {
        passed: refV.passed,
        needs: refV.needs.map((n) => ({ id: n.id, text: t(n.text), ok: n.ok })),
        broken: fmtBroken(refV.broken),
      },
      fastBroken: fmtBroken(brokenGivens(b, fastRef)),
    };
  });

  const practice = {
    faults: FAULTS.map((f) => ({ id: f.id, text: t(f.text) })),
    mechanisms: {
      node: NODE_MECHANISMS.map((m) => t(m.text)),
      edge: EDGE_MECHANISMS.map((m) => t(m.text)),
    },
    incidents,
    problems,
    briefs,
  };

  // 7. Import reports (3 fixtures) + all importMessages
  const fixtures = ['ecs-rds', 'lambda-sqs-rds', 'aurora-cache-multiaz'];
  const importReports = Object.fromEntries(
    fixtures.map((fx) => {
      const plan = read<unknown>(`tests/import/fixtures/${fx}.plan.json`);
      const res = importTerraform(plan);
      const findings = runChecks(res);
      return [fx, importReport(res, findings)];
    }),
  );
  const sampleArgs = {
    version: '0.1',
    address: 'aws_lb.x',
    desired: 2,
    min: 1,
    target: 60,
    n: 3,
    used: 'tg1',
    metric: 'ALBRequestCount',
    from: 'a',
    to: 'b',
    type: 'm5.large',
    issues: 'bad',
    name: 'api',
    formula: '2 * 10',
    total: 20,
    limit: 15,
    high: 18,
    zone: 'us-east-1a',
    rps: 500,
    peak: 1000,
    interval: 30,
    threshold: 3,
    max: 100,
    check: 'C1',
    missing: 'x',
    param: 'instances',
    value: 2000,
    rcu: 10,
    wcu: 5,
    pct: 80,
    caller: 'gw',
    upS: 10,
    downS: 30,
    visibility: 30,
    timeout: 10,
    need: 60,
    rate: 1000,
    capacity: 500,
    p99: 120,
    failed: 5,
    offered: 100,
    expired: 1,
    done: 95,
    drainS: 120,
    unfinished: 3,
    events: 500000,
    holds: 400,
    fail: 800,
    node: 'db',
    passes: '1600',
    why: 'x',
    kind: 'definite',
    at: 20,
    for: 30,
    multiplier: 5,
    consumer: 'fn',
    visibilityS: 30,
  };
  const allImportMessages = Object.fromEntries(IMPORT_MESSAGE_IDS.map((id) => [id, importMessage(id, sampleArgs)]));

  // 8. Paste design errors
  const baseThreeTier = read<Design>('examples/designs/three-tier.json');
  const editThreeTier = (fn: (d: any) => void) => {
    const copy = structuredClone(baseThreeTier) as any;
    copy.name = t(copy.name);
    if (copy.description) copy.description = t(copy.description);
    for (const n of copy.nodes) if (n.label) n.label = t(n.label);
    fn(copy);
    return JSON.stringify(copy, null, 2);
  };
  const pasteErrorInputs: [string, string][] = [
    ['empty', '   '],
    ['array', '[1, 2]'],
    ['trailing-comma', '{\n  "name": "x",\n}'],
    ['single-quote', "{'name': 'x'}"],
    ['unquoted-key', '{name: 1}'],
    ['comment', '{\n  // the name\n  "name": "x"\n}'],
    ['no-schema', editThreeTier((d) => delete d.schema)],
    ['bad-type', editThreeTier((d) => (d.nodes[2].params.instances = '3'))],
    ['too-small', editThreeTier((d) => (d.nodes[2].params.instances = 0))],
    ['typo-param', editThreeTier((d) => (d.nodes[2].params.instanecs = 3))],
    ['param-outside', editThreeTier((d) => (d.nodes[2].instances = 3))],
    ['missing-pos', editThreeTier((d) => delete d.nodes[0].pos)],
    ['typo-kind', editThreeTier((d) => (d.nodes[1].kind = 'loadbalancer'))],
    ['unknown-kind', editThreeTier((d) => (d.nodes[1].kind = 'spaceship'))],
    ['bad-id', editThreeTier((d) => (d.nodes[0].id = 'my users'))],
    ['typo-edge', editThreeTier((d) => (d.edges[0].timeout = 5))],
    ['bad-enum', editThreeTier((d) => (d.apis = [{ name: 'a', op: 'get' }]))],
    ['bad-dist', editThreeTier((d) => (d.nodes[2].params.serviceMs = { mean: 'x' }))],
    ['unknown-top', editThreeTier((d) => (d.foo = 1))],
    ['nested-typo', editThreeTier((d) => (d.nodes[2].params.serviceMs = { mean: 10, cvv: 1 }))],
    ['nested-unknown', editThreeTier((d) => (d.nodes[2].params.serviceMs = { mean: 10, instances: 1 }))],
    ['note-typo', editThreeTier((d) => (d.notes = [{ id: 'n1', text: 'x', pos: [0, 0], widht: 200 }]))],
    ['dangling-edge', editThreeTier((d) => d.edges.push({ from: 'api', to: 'nowhere' }))],
  ];
  const pasteErrors = Object.fromEntries(
    pasteErrorInputs.map(([k, s]) => {
      const r = readPasted(s);
      return [k, r.ok ? [] : r.problems];
    }),
  );
  const jsonProblemSamples = {
    firefox: jsonProblem('{\n}', 'JSON.parse: expected property name at line 2 column 1 of the JSON data'),
    v8Pos: jsonProblem('ab\ncd', 'Unexpected token in JSON at position 4'),
    safari: jsonProblem('{', "JSON Parse error: Expected '}'"),
  };

  return {
    components: { categories, kinds, edgeParams },
    designs,
    scenarios,
    simulations,
    lessons,
    practice,
    imports: { importReports, allImportMessages },
    pasteDesign: { pasteErrors, jsonProblemSamples },
  };
}

// Acceptance only: runs when DUMP_OUT is set (DUMP_OUT=<file> npx vitest run tests/zz-text-dump.test.ts).
describe('text dump for source-language flip verification', () => {
  it.skipIf(!process.env.DUMP_OUT)('dumps zh-TW and en text', () => {
    const out: Record<string, unknown> = {};
    for (const l of LANGS) {
      out[l] = dumpForLang(l);
    }
    setLang('zh-TW');
    const outPath = process.env.DUMP_OUT;
    if (outPath) {
      writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    }
    expect(Object.keys(out)).toEqual(['zh-TW', 'en']);
  }, 600_000);
});
