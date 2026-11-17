// Schemas and pure loaders for data-driven practice problems (on-call incidents, constraint
// problems, and design briefs). Pure functions: no React, no DOM, no Node fs/path.
import { z } from 'zod';
import { DesignSchema, ID_RE, ScenarioSchema, type Design, type Scenario } from '../schema/design.ts';

export const INCIDENT_SCHEMA = 'loadsketch/incident@1';
export const PROBLEM_SCHEMA = 'loadsketch/problem@1';
export const BRIEF_SCHEMA = 'loadsketch/brief@1';

export const FAULT_VALUES = ['down', 'slow', 'errors', 'gray', 'pause', 'traffic'] as const;
export type FaultValue = (typeof FAULT_VALUES)[number];

const IdSchema = z.string().regex(ID_RE);
const EdgeRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}->[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);

const PatchSchema = z.union([
  z.strictObject({
    node: IdSchema,
    params: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    edge: EdgeRefSchema,
    set: z.record(z.string(), z.unknown()),
  }),
]);

const FixGoalSchema = z.strictObject({
  maxErrorRate: z.number().min(0).max(1),
  maxP99Ms: z.number().gt(0).optional(),
});

const LimitsSchema = z.strictObject({
  maxErrorRate: z.number().min(0).max(1),
  maxP99Ms: z.number().gt(0),
  budgetPerMonth: z.number().min(0),
  maxPoints: z.int().min(0),
});

export const IncidentSchema = z.strictObject({
  schema: z.literal(INCIDENT_SCHEMA),
  id: IdSchema,
  title: z.string().min(1),
  example: IdSchema,
  scenario: ScenarioSchema,
  answer: z.strictObject({
    node: IdSchema,
    fault: z.enum(FAULT_VALUES),
  }),
  explain: z.string().min(1),
  hint: z.string().min(1),
  solution: z.array(PatchSchema),
  fixGoal: FixGoalSchema,
});

export const ProblemSchema = z.strictObject({
  schema: z.literal(PROBLEM_SCHEMA),
  id: IdSchema,
  title: z.string().min(1),
  text: z.string().min(1),
  example: IdSchema,
  scenario: ScenarioSchema,
  start: z.array(PatchSchema),
  limits: LimitsSchema,
  hint: z.string().min(1),
  solution: z.array(PatchSchema),
  naive: z.array(PatchSchema),
});

export const NeedSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stored') }),
  z.strictObject({ kind: z.literal('looked') }),
  z.strictObject({ kind: z.literal('finished') }),
  z.strictObject({ kind: z.literal('not-degraded') }),
  z.strictObject({
    kind: z.literal('reaches-node'),
    node: IdSchema,
    text: z.string().min(1),
    op: z.enum(['read', 'write', 'calls']).optional(),
    share: z.number().min(0).max(1).optional(),
  }),
]);

export type NeedSpec = z.infer<typeof NeedSpecSchema>;

export const BriefSchema = z.strictObject({
  schema: z.literal(BRIEF_SCHEMA),
  id: IdSchema,
  title: z.string().min(1),
  text: z.string().min(1),
  functional: z.array(z.string().min(1)).min(1),
  load: z.array(z.string().min(1)).min(1),
  given: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)).min(1),
  scenario: ScenarioSchema,
  limits: LimitsSchema,
  start: DesignSchema,
  fixed: z.array(IdSchema),
  needs: z.array(NeedSpecSchema).min(1),
  floors: z.record(z.string().min(1), z.record(z.string().min(1), z.number().min(0))).optional(),
  hint: z.string().min(1),
  reference: DesignSchema,
  naive: DesignSchema,
});

export type IncidentData = Omit<z.infer<typeof IncidentSchema>, 'schema'>;
export type ProblemData = Omit<z.infer<typeof ProblemSchema>, 'schema'>;
export interface BriefSpecData extends Omit<z.infer<typeof BriefSchema>, 'schema' | 'start' | 'reference' | 'naive' | 'scenario'> {
  scenario: Scenario;
  start: Design;
  reference: Design;
  naive: Design;
}

export interface ParseOptions {
  checkFilename?: boolean;
}

const FILENAME_RE = /^\d{2}-(.+)\.json$/;

function displayFile(file: string): string {
  return file.replace(/^(\.\.\/)+/, '');
}

function formatIssuePath(i: z.core.$ZodIssue): string {
  if (i.code === 'unrecognized_keys') {
    const keys = (i as { keys?: string[] }).keys ?? [];
    return [...i.path, keys.join(', ')].filter((p) => p !== '').join('.') || '(root)';
  }
  return i.path.join('.') || '(root)';
}

// Returns the original input object (minus `schema`) after Zod validation so key order matches the source JSON.
function parseWithSchema<T extends { schema: string; id: string }>(
  file: string,
  raw: unknown,
  schema: z.ZodType<T>,
  opts?: ParseOptions,
): Omit<T, 'schema'> {
  const label = displayFile(file);
  const errors: string[] = [];
  const r = schema.safeParse(raw);
  if (!r.success) {
    for (const i of r.error.issues) {
      errors.push(`${label}: ${formatIssuePath(i)}: ${i.message}`);
    }
  }
  if (opts?.checkFilename !== false) {
    const base = label.split('/').pop() ?? label;
    const m = FILENAME_RE.exec(base);
    const rawId = raw && typeof raw === 'object' && !Array.isArray(raw) && 'id' in raw ? (raw as { id: unknown }).id : undefined;
    if (!m) {
      errors.push(`${label}: id: filename "${base}" must match NN-<id>.json`);
    } else if (typeof rawId === 'string' && m[1] !== rawId) {
      errors.push(`${label}: id: filename "${base}" does not match id "${rawId}"`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const { schema: _s, ...rest } = raw as T;
  return rest;
}

export function parseIncident(file: string, raw: unknown, opts?: ParseOptions): IncidentData {
  return parseWithSchema(file, raw, IncidentSchema, opts);
}

export function parseProblem(file: string, raw: unknown, opts?: ParseOptions): ProblemData {
  return parseWithSchema(file, raw, ProblemSchema, opts);
}

export function parseBriefSpec(file: string, raw: unknown, opts?: ParseOptions): BriefSpecData {
  return parseWithSchema(file, raw, BriefSchema, opts) as unknown as BriefSpecData;
}

export function loadPracticeList<T extends { id: string }>(
  files: Record<string, unknown>,
  parse: (file: string, raw: unknown) => T,
): T[] {
  const sorted = Object.entries(files).sort(([a], [b]) => {
    const ba = a.split('/').pop() ?? a;
    const bb = b.split('/').pop() ?? b;
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });
  const out: T[] = [];
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const [file, raw] of sorted) {
    const label = displayFile(file);
    try {
      const item = parse(file, raw);
      const prev = seen.get(item.id);
      if (prev) {
        errors.push(`${label}: id: duplicate id "${item.id}" (already defined in ${prev})`);
      } else {
        seen.set(item.id, label);
        out.push(item);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return out;
}
