// Where an imported value came from: the label in the settings panel, and which values are
// guesses (the canvas draws a node with a guessed performance value in a dashed frame).
import type { DesignNode, Evidence, ParamSource } from '../schema/design.ts';
import { tx } from '../i18n/index.ts';
import { paramRole } from '../import/terraform/fill.ts';

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  iac: tx('IaC'),
  'aws-default': tx('AWS 預設'),
  estimate: tx('猜的'),
  answer: tx('使用者填'),
  'loadsketch-default': tx('預設值'),
};

/** A performance assumption nobody gave: our estimate, or the kind's default. */
export const isGuess = (s: ParamSource | undefined) => !!s && s.role === 'assumption' && (s.evidence === 'estimate' || s.evidence === 'loadsketch-default');

/** The params of a node whose value is a guess. */
export const guessedParams = (n: DesignNode) => Object.entries(n.source?.params ?? {}).filter(([, s]) => isGuess(s)).map(([k]) => k);

/**
 * Where an edited value comes from now (M29, Q21): a value typed in the panel is the user's (`answer`,
 * like the answer file); "use default" makes it the kind's default (`loadsketch-default`). The role stays
 * (a param with no source yet gets the importer's role for it).
 * The source lives in the node, so undo and redo bring the old source back with the old value.
 */
export function editedSources(sources: Record<string, ParamSource> | undefined, patch: Record<string, unknown>): Record<string, ParamSource> {
  const out: Record<string, ParamSource> = { ...(sources ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'label' || k === 'apis') continue;
    // a param with no source yet: classed like the importer does
    const role = out[k]?.role ?? paramRole(k);
    out[k] = v === undefined ? { evidence: 'loadsketch-default', role } : { evidence: 'answer', role };
  }
  return out;
}
