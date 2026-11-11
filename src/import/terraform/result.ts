// What an import returns besides the design: where each value came from, which lines are only
// presumed, what was folded into something else, and the approximations. Text is message ids with
// arguments (the CLI and the UI translate them).
import type { Design, Evidence, ParamValue } from '../../core/index.ts';
import type { Line, LineKind } from './graph.ts';

/** Where a value comes from: `iac` = written in the IaC, `aws-default` = an AWS or provider default
 *  with a source, `estimate` = ours, `answer` = the user's, `loadsketch-default` = no value, the kind's default. */
export type { Evidence };

export interface Origin {
  evidence: Evidence;
  /** The resource attribute it came from, e.g. `aws_appautoscaling_target.api.max_capacity`. */
  from?: string;
  /** For aws-default: where the default is written down. */
  source?: string;
  /** For answer: the answer file says it was measured. */
  measured?: true;
  /** Written in the configuration but not in the plan (unknown until apply, or sensitive): the value is
   *  the AWS default standing in for it, so the evidence is `estimate` (M29b #24–#29). */
  unknown?: 'apply' | 'sensitive';
}
export interface Note { id: string; args?: Record<string, string | number>; node?: string }
/** A value the design has no field for, kept for the checks, e.g. instance class, multi-AZ. */
export interface Fact { value: string | number | boolean; origin: Origin }

export interface ImportResult {
  design: Design;
  /** Design node id -> the resource addresses it stands for. */
  nodeFrom: Record<string, string[]>;
  /** Design node id -> param -> where the value came from (params the rules did not set are absent). */
  origins: Record<string, Record<string, Origin>>;
  facts: Record<string, Record<string, Fact>>;
  /** Design edge id -> the kind of graph line it came from. */
  /** `through`: the line ends at a member that sits in between (an RDS Proxy address); `routes`:
   *  every such member when the caller reaches it through more than one (two proxies). */
  edges: Record<string, { kind: LineKind | 'generated' | 'answer'; via: string[]; agrees?: string[]; confirmed?: boolean; measured?: boolean; through?: string; routes?: string[] }>;
  /** Design edge id -> param -> where it came from (the answer file's `bulkhead`). */
  edgeOrigins: Record<string, Record<string, Origin>>;
  /** Candidate lines (security groups only) the answer file has not confirmed: not drawn. */
  candidates: Line[];
  /** Resources that became part of another node, with a reason id. */
  folded: { address: string; into?: string; why: string }[];
  /** Resources no rule knows yet. */
  unmapped: { address: string; type: string }[];
  /** Approximations and other things to say in the report. */
  notes: Note[];
}

export type Params = Record<string, ParamValue>;
