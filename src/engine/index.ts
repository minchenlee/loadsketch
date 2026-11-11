export { Simulation, simulate, FAIL_REASONS, FAIL_LABEL, edgeFailShare } from './sim.ts';
export type { FailReason, SimResult, SimOptions, WindowStat, NodeWindow, NodeResult, TheoryRow, Trace, TraceHop, TimelineEvent, LiveNode } from './sim.ts';
export { erlangC, mgc, mm1SojournQuantileMs } from './theory.ts';
export { Histogram } from './histogram.ts';
export type { LatencySummary } from './histogram.ts';
