// The answer file (`<name>.answers.json`): the values the IaC cannot give. The user
// fills only what they want to set; the import applies it every time it runs. Node keys and edge
// ends are design node ids (`ecs_service_api`) or resource addresses (`aws_ecs_service.api`).
//
//   { "schema": "loadsketch/answers@1",
//     "traffic": { "peakRps": 2000, "readRatio": 0.8 },
//     "slo": { "p99Ms": 500, "errorRate": 0.001, "asyncP99Ms": 60000, "asyncFailRate": 0, "drainS": 300 },
//     "entry": ["aws_lb.web"],
//     "nodes": { "ecs_service_api": { "serviceMs": 12, "concurrency": { "value": 20, "evidence": "measured" } } },
//     "edges": [{ "from": "ecs_service_api", "to": "db_instance_main", "bulkhead": 10 }] }
import { z } from 'zod';
import type { ParamValue } from '../../core/index.ts';
import { PlanError } from './plan.ts';

export const ANSWERS_SCHEMA = 'loadsketch/answers@1';

const Name = z.string().min(1).max(300);
const Value = z.union([z.number(), z.string().max(100), z.strictObject({ mean: z.number(), cv: z.number().optional() })]);
const Answer = z.union([Value, z.strictObject({ value: Value, evidence: z.literal('measured').optional() })]);

export const AnswersSchema = z.strictObject({
  schema: z.literal(ANSWERS_SCHEMA),
  /** Used by --simulate: the peak, and how many seconds of it to measure after the warm-up. */
  traffic: z.strictObject({ peakRps: z.number().positive().max(10_000_000), readRatio: z.number().min(0).max(1).optional(), measureS: z.number().min(10).max(3000).optional() }).optional(),
  /** What "holds" means (Q18 B); each limit left out is the default (simulate.ts DEFAULT_SLO). */
  slo: z.strictObject({
    /** Front-end p99 in ms, and the share of failed front-end requests. */
    p99Ms: z.number().positive().max(600_000).optional(),
    errorRate: z.number().min(0).max(1).optional(),
    /** Background (queue) p99 in ms, of the messages that succeed; no limit unless set. */
    asyncP99Ms: z.number().positive().max(86_400_000).optional(),
    /** Share of background messages that fail (DLQ, retries used up, TTL). */
    asyncFailRate: z.number().min(0).max(1).optional(),
    /** Seconds after the traffic stops for the backlog to clear. */
    drainS: z.number().min(0).max(3000).optional(),
  }).optional(),
  /** Where outside traffic comes in, when no internet-facing load balancer says so. */
  entry: z.array(Name).min(1).max(20).optional(),
  nodes: z.record(Name, z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,47}$/), Answer)).optional(),
  /** Confirms a presumed or candidate line, or adds one the IaC does not show. */
  edges: z.array(z.strictObject({
    from: Name,
    to: Name,
    evidence: z.literal('measured').optional(),
    /** Connections (or calls) each caller instance keeps open on this line: its pool size (C1, C10). */
    bulkhead: Answer.optional(),
  })).max(500).optional(),
});
export type Answers = z.infer<typeof AnswersSchema>;

export interface AnswerValue { value: ParamValue; measured: boolean }
export const answerValue = (a: z.infer<typeof Answer>): AnswerValue =>
  typeof a === 'object' && 'value' in a ? { value: a.value, measured: a.evidence === 'measured' } : { value: a, measured: false };

/** Parse an answer file; problems are a PlanError with the paths, not a stack trace. */
export function parseAnswers(json: unknown): Answers {
  const r = AnswersSchema.safeParse(json);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`).join('; ');
  throw new PlanError('import.answers.invalid', { issues });
}
