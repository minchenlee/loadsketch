// Display text that lives in design and scenario files (example names, descriptions, node labels,
// notes). The bundled examples are written in Chinese, so their text is a message id too; a
// user's own text has no catalog entry and stays as written.
import type { Design, Scenario } from '../schema/design.ts';
import { t } from './index.ts';

export function localizeDesign(d: Design): Design {
  return {
    ...d,
    name: t(d.name),
    description: d.description && t(d.description),
    nodes: d.nodes.map((n) => (n.label ? { ...n, label: t(n.label) } : n)),
    notes: d.notes?.map((n) => ({ ...n, text: t(n.text) })),
  };
}

export function localizeScenario(s: Scenario): Scenario {
  return s.name ? { ...s, name: t(s.name) } : s;
}
