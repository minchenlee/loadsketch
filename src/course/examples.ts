// The example designs and scenarios a lesson needs, loaded on demand: the challenges are judged
// against the example as it ships (the simulator does the same, src/app/store.ts EXAMPLES).
import type { Design, Scenario } from '../schema/design.ts';

const designs = import.meta.glob<Design>('../../examples/designs/*.json', { import: 'default' });
const scenarios = import.meta.glob<Scenario>('../../examples/scenarios/*.json', { import: 'default' });

export async function loadExample(name: string): Promise<Design | undefined> {
  return designs[`../../examples/designs/${name}.json`]?.();
}
export async function loadScenario(name: string): Promise<Scenario | undefined> {
  return scenarios[`../../examples/scenarios/${name}.json`]?.();
}
