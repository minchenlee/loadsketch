// Validation and loading tests for data-driven practice files (no simulations run here, so fast).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIEF_SCHEMA, FAULT_VALUES, INCIDENT_SCHEMA, PROBLEM_SCHEMA, loadPracticeList, parseIncident, parseProblem } from '../src/learn/practiceData.ts';
import { FAULTS, INCIDENTS } from '../src/learn/oncall.ts';
import { PROBLEMS } from '../src/learn/constraints.ts';
import { BRIEFS, parseBrief } from '../src/learn/briefs.ts';

const ROOT = join(import.meta.dirname, '..');
const readPracticeDir = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [`${dir}/${f}`, JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8'))] as const);

const baseScenario = {
  schema: 'loadsketch/scenario@1',
  name: 'test',
  seed: 1,
  durationS: 30,
  warmupS: 5,
  traffic: { rps: 100, readRatio: 0.9 },
};

const baseDesign = {
  schema: 'loadsketch/design@1',
  name: 'test',
  nodes: [{ id: 'users', kind: 'client', pos: [0, 0] }],
  edges: [],
};

const validIncident = () => ({
  schema: INCIDENT_SCHEMA,
  id: 'sample-incident',
  title: 'Sample incident',
  example: 'three-tier',
  scenario: baseScenario,
  answer: { node: 'api', fault: 'slow' },
  explain: 'Because it slowed down.',
  hint: 'Add timeout.',
  solution: [{ node: 'api', params: { instances: 4 } }],
  fixGoal: { maxErrorRate: 0.01 },
});

const validProblem = () => ({
  schema: PROBLEM_SCHEMA,
  id: 'sample-problem',
  title: 'Sample problem',
  text: 'Meet targets.',
  example: 'three-tier',
  scenario: baseScenario,
  start: [],
  limits: { maxErrorRate: 0.01, maxP99Ms: 300, budgetPerMonth: 1000, maxPoints: 6 },
  hint: 'Scale out.',
  solution: [{ node: 'api', params: { instances: 3 } }],
  naive: [{ node: 'api', params: { instances: 8 } }],
});

const validBrief = () => ({
  schema: BRIEF_SCHEMA,
  id: 'sample-brief',
  title: 'Sample brief',
  text: 'Build a service.',
  functional: ['Serve requests'],
  load: ['100 rps'],
  given: ['5 ms'],
  outOfScope: ['Auth'],
  scenario: baseScenario,
  limits: { maxErrorRate: 0.01, maxP99Ms: 200, budgetPerMonth: 1000, maxPoints: 6 },
  start: baseDesign,
  fixed: [],
  needs: [{ kind: 'stored' }],
  hint: 'Add API and DB.',
  reference: baseDesign,
  naive: baseDesign,
});

function catchMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('Expected function to throw');
}

describe('practice data validation errors', () => {
  it('reports missing required field with filename and field path', () => {
    const bad = validIncident() as Record<string, unknown>;
    delete bad.title;
    const msg = catchMessage(() => parseIncident('examples/practice/oncall/01-sample-incident.json', bad));
    expect(msg).toContain('examples/practice/oncall/01-sample-incident.json: title:');
  });

  it('reports extra unknown field with filename and field path', () => {
    const bad = { ...validProblem(), answer: { node: 'api', fault: 'slow' } };
    const msg = catchMessage(() => parseProblem('examples/practice/constraints/01-sample-problem.json', bad));
    expect(msg).toContain('examples/practice/constraints/01-sample-problem.json: answer: Unrecognized key');
  });

  it('reports unknown needs kind with filename and field path', () => {
    const bad = validBrief();
    bad.needs = [{ kind: 'unknown-need' } as never];
    const msg = catchMessage(() => parseBrief('examples/practice/briefs/01-sample-brief.json', bad));
    expect(msg).toContain('examples/practice/briefs/01-sample-brief.json: needs.0.kind:');
  });

  it('reports filename and id mismatch with filename and field path', () => {
    const msg = catchMessage(() => parseIncident('examples/practice/oncall/01-wrong-id.json', validIncident()));
    expect(msg).toContain('examples/practice/oncall/01-wrong-id.json: id: filename "01-wrong-id.json" does not match id "sample-incident"');
  });

  it('reports duplicate ids across files with filename and field path', () => {
    const files = {
      'examples/practice/oncall/01-sample-incident.json': validIncident(),
      'examples/practice/oncall/02-sample-incident.json': validIncident(),
    };
    const msg = catchMessage(() => loadPracticeList(files, parseIncident));
    expect(msg).toContain('examples/practice/oncall/02-sample-incident.json: id: duplicate id "sample-incident"');
  });

  it('reports all problems when one file has multiple errors', () => {
    const bad = validIncident() as Record<string, unknown>;
    delete bad.explain;
    bad.answer = { node: 'api', fault: 'bogus' };
    bad.extraKey = true;
    const msg = catchMessage(() => parseIncident('examples/practice/oncall/01-wrong-name.json', bad));
    expect(msg).toContain('examples/practice/oncall/01-wrong-name.json: explain:');
    expect(msg).toContain('examples/practice/oncall/01-wrong-name.json: answer.fault:');
    expect(msg).toContain('examples/practice/oncall/01-wrong-name.json: extraKey: Unrecognized key');
    expect(msg).toContain('examples/practice/oncall/01-wrong-name.json: id: filename "01-wrong-name.json" does not match id "sample-incident"');
  });
});

describe('practice data files', () => {
  it('every Fault value has a label in FAULTS', () => {
    expect(FAULTS.length).toBe(FAULT_VALUES.length);
    expect(new Set(FAULTS.map((f) => f.id))).toEqual(new Set(FAULT_VALUES));
  });

  it('validates all oncall incident files and preserves order', () => {
    const entries = readPracticeDir('examples/practice/oncall');
    const fileIds = entries.map(([, raw]) => (raw as { id: string }).id);
    for (const [file, raw] of entries) expect(() => parseIncident(file, raw)).not.toThrow();
    const ids = INCIDENTS.map((i) => i.id);
    expect(ids).toEqual(fileIds);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids.slice(0, 8)).toEqual([
      'gray-errors',
      'slow-dependency',
      'db-slow',
      'gray-slow',
      'gc-pause',
      'traffic-spike',
      'db-errors',
      'cache-down',
    ]);
  });

  it('validates all constraint problem files and preserves order', () => {
    const entries = readPracticeDir('examples/practice/constraints');
    const fileIds = entries.map(([, raw]) => (raw as { id: string }).id);
    for (const [file, raw] of entries) expect(() => parseProblem(file, raw)).not.toThrow();
    const ids = PROBLEMS.map((p) => p.id);
    expect(ids).toEqual(fileIds);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids.slice(0, 3)).toEqual(['spike-budget', 'retry-budget', 'solo-shortener']);
  });

  it('validates all brief files and preserves order', () => {
    const entries = readPracticeDir('examples/practice/briefs');
    const fileIds = entries.map(([, raw]) => (raw as { id: string }).id);
    for (const [file, raw] of entries) expect(() => parseBrief(file, raw)).not.toThrow();
    const ids = BRIEFS.map((b) => b.id);
    expect(ids).toEqual(fileIds);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.slice(0, 6)).toEqual([
      'brief-shortener',
      'brief-sale',
      'brief-notify',
      'brief-checkout',
      'brief-geocode',
      'brief-catalog',
    ]);
  });

  it('validates all three practice templates without CJK or app loading', () => {
    const readTemplate = (name: string) => {
      const path = `examples/practice/templates/${name}`;
      const text = readFileSync(join(ROOT, path), 'utf8');
      expect(text).not.toMatch(/[　-〿一-鿿＀-￯]/);
      return [path, JSON.parse(text)] as const;
    };
    const [incPath, incRaw] = readTemplate('incident.json');
    const [probPath, probRaw] = readTemplate('problem.json');
    const [briefPath, briefRaw] = readTemplate('brief.json');
    const inc = parseIncident(incPath, incRaw, { checkFilename: false });
    const prob = parseProblem(probPath, probRaw, { checkFilename: false });
    const brief = parseBrief(briefPath, briefRaw, { checkFilename: false });
    expect(INCIDENTS.map((i) => i.id)).not.toContain(inc.id);
    expect(PROBLEMS.map((p) => p.id)).not.toContain(prob.id);
    expect(BRIEFS.map((b) => b.id)).not.toContain(brief.id);
  });
});
