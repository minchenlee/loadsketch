// The stable entry point for code outside the app: the CLI, the IaC importer (src/import/) and
// agent-written tools. Import from here, not from engine or schema internals. It must not reach
// src/app/, React or DOM globals, and from src/learn/ only cost.ts (tests/boundary.test.ts).
export * from '../schema/design.ts';
export * from '../schema/kinds.ts';
export * from '../engine/index.ts';
export * from '../engine/theory.ts';
export * from '../engine/scale.ts';
export { costOf } from '../learn/cost.ts';
export type { Cost, CostItem } from '../learn/cost.ts';
