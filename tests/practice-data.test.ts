// Validation and loading tests for data-driven practice files (no simulations run here, so fast).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIEF_SCHEMA, INCIDENT_SCHEMA, PROBLEM_SCHEMA, loadPracticeList, parseIncident, parseProblem } from '../src/learn/practiceData.ts';
import { INCIDENTS } from '../src/learn/oncall.ts';
import { parseBrief } from '../src/learn/briefs.ts';

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
    expect(msg).toContain('examples/practice/oncall/01-sample-incident.json');
    expect(msg).toContain('title');
  });

  it('reports extra unknown field with filename and field path', () => {
    const bad = { ...validProblem(), answer: { node: 'api', fault: 'slow' } };
    const msg = catchMessage(() => parseProblem('examples/practice/constraints/01-sample-problem.json', bad));
    expect(msg).toContain('examples/practice/constraints/01-sample-problem.json');
    expect(msg).toContain('answer');
  });

  it('reports unknown needs kind with filename and field path', () => {
    const bad = validBrief();
    bad.needs = [{ kind: 'unknown-need' } as never];
    const msg = catchMessage(() => parseBrief('examples/practice/briefs/01-sample-brief.json', bad));
    expect(msg).toContain('examples/practice/briefs/01-sample-brief.json');
    expect(msg).toContain('needs.0.kind');
  });

  it('reports filename and id mismatch with filename and field path', () => {
    const msg = catchMessage(() => parseIncident('examples/practice/oncall/01-wrong-id.json', validIncident()));
    expect(msg).toContain('examples/practice/oncall/01-wrong-id.json');
    expect(msg).toContain('id');
  });

  it('reports duplicate ids across files with filename and field path', () => {
    const files = {
      'examples/practice/oncall/01-sample-incident.json': validIncident(),
      'examples/practice/oncall/02-sample-incident.json': validIncident(),
    };
    const msg = catchMessage(() => loadPracticeList(files, parseIncident));
    expect(msg).toContain('examples/practice/oncall/02-sample-incident.json');
    expect(msg).toContain('id');
    expect(msg).toContain('sample-incident');
  });

  it('reports all problems when one file has multiple errors', () => {
    const bad = validIncident() as Record<string, unknown>;
    delete bad.explain;
    bad.answer = { node: 'api', fault: 'bogus' };
    bad.extraKey = true;
    const msg = catchMessage(() => parseIncident('examples/practice/oncall/01-wrong-name.json', bad));
    expect(msg).toContain('answer.fault');
    expect(msg).toContain('explain');
    expect(msg).toContain('extraKey');
    expect(msg).toContain('id');
  });
});

describe('practice data files', () => {
  it('validates all oncall incident files and preserves order', () => {
    const entries = readPracticeDir('examples/practice/oncall');
    expect(entries.length).toBe(8);
    for (const [file, raw] of entries) expect(() => parseIncident(file, raw)).not.toThrow();
    expect(INCIDENTS.map((i) => i.id)).toEqual([
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
});
