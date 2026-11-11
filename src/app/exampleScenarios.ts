// The scenario each example opens with, when its name differs from the example's (no imports:
// the golden test reads it too). Others open with the scenario of the same name, else steady.
/** Which scenario fits each example best (the README table). */
export const EXAMPLE_SCENARIO: Record<string, string> = {
  'three-tier': 'spike',
  'serverless-db': 'spike',
  'async-queue': 'steady',
  resilience: 'slow-payments',
  sharded: 'hot-keys',
  'retry-storm': 'retry-storm',
  'retry-budget': 'retry-storm',
  autoscale: 'flash-crowd',
  'async-reliable': 'worker-crash',
  'replica-lag': 'read-after-write',
  'priority-shedding': 'spike',
  'tenant-limits': 'steady',
  periodic: 'daily-cycle',
  'cache-stampede': 'hot-key-expiry',
  'cache-lease': 'hot-key-expiry',
  'adaptive-throttle': 'retry-storm',
  'gray-failure': 'gray-failure',
  'gray-failure-outlier': 'gray-failure',
  'slow-dependency': 'slow-dependency',
  'bulkhead-fallback': 'slow-dependency',
  'hedged-reads': 'slow-instance',
  'scatter-gather': 'slow-shard',
  quorum: 'slow-replica',
  'lifo-codel': 'overload',
};
