// Component catalog: one entry per node kind. The engine, the JSON Schema, the canvas palette and
// the inspector all read this table, so a kind's parameters are defined in exactly one place.

export type Category = 'traffic' | 'edge' | 'compute' | 'resilience' | 'data' | 'messaging';

/** Show a parameter only when another enum parameter has this value, or one of these values (the inspector hides it otherwise). */
export interface ParamWhen {
  param: string;
  value: string | string[];
}

/** Does `when` hold for this value of its enum parameter? */
export const whenHolds = (w: ParamWhen, v: unknown): boolean => (Array.isArray(w.value) ? w.value.includes(v as string) : v === w.value);

export type ParamSpec = (
  | { type: 'int'; default: number; min: number; max: number; unit?: string; label: string; help: string }
  | { type: 'number'; default: number; min: number; max: number; unit?: string; label: string; help: string }
  | { type: 'ratio'; default: number; label: string; help: string }
  | { type: 'dist'; default: { mean: number; cv: number }; max: number; label: string; help: string }
  | { type: 'enum'; default: string; options: { value: string; label: string }[]; label: string; help: string }
) & { when?: ParamWhen };

export interface KindSpec {
  kind: string;
  label: string;
  labelEn: string;
  category: Category;
  icon: string; // lucide-react icon name
  /** Has instances with slots and a FIFO queue (requests can wait here). */
  station: boolean;
  /** How it routes: 'one' forwards each request to one downstream edge; 'plan' calls downstreams itself. */
  routing: 'one' | 'plan' | 'leaf' | 'queue';
  summary: string;
  params: Record<string, ParamSpec>;
}

const instances = (d: number): ParamSpec => ({
  type: 'int', default: d, min: 1, max: 1000, label: 'Instances', help: 'How many instances run at once. Traffic splits evenly across them.',
});
const concurrency = (d: number, what = 'requests'): ParamSpec => ({
  type: 'int', default: d, min: 1, max: 100000, label: 'Concurrency per instance', help: `How many ${what} each instance handles at once (threads, connections or workers). When full, they queue.`,
});
const queueLimit = (d: number): ParamSpec => ({
  type: 'int', default: d, min: 0, max: 10000000, label: 'Max queue', help: 'How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.',
});
const AUTO: ParamWhen = { param: 'autoscale', value: 'on' };
const LRU: ParamWhen = { param: 'mode', value: 'lru' };
const PROBE: ParamWhen = { param: 'healthCheck', value: ['liveness', 'deep'] };
const OUTLIER: ParamWhen = { param: 'outlier', value: 'on' };
const DNS_FAILOVER: ParamWhen = { param: 'failover', value: 'on' };
/** Queue order and CoDel for request queues of front-end servers (Facebook, "Fail at Scale"). */
const queueing = (): Record<string, ParamSpec> => ({
  queueOrder: {
    type: 'enum', default: 'fifo', label: 'Queue order',
    options: [
      { value: 'fifo', label: 'First in, first out (FIFO)' },
      { value: 'lifo', label: 'Last in, first out (LIFO)' },
      { value: 'adaptive_lifo', label: 'Newest first when congested (adaptive LIFO)' },
    ],
    help: 'Which queued request to take first. Under overload, the client of the oldest request has usually given up already; serving the newest request first means someone receives the result. Adaptive LIFO: FIFO normally, LIFO when the queue has not emptied for 100 ms.',
  },
  codelTargetMs: {
    type: 'number', default: 0, min: 0, max: 60000, unit: 'ms', label: 'CoDel queue target',
    help: 'Controls queueing delay (CoDel, as Facebook does it). If the queue emptied in the last 100 ms, a request may wait at most 100 ms; if it has not (congestion), at most this long. A request over the limit is dropped when its turn comes (CoDel), so no work is wasted. Facebook uses 5 ms. 0 means off.',
  },
});
/** Autoscaling (like a Kubernetes HPA): "instances" becomes the minimum. */
const autoscale = (max: number): Record<string, ParamSpec> => ({
  autoscale: {
    type: 'enum', default: 'off', label: 'Autoscaling',
    options: [
      { value: 'off', label: 'Off (fixed instances)' },
      { value: 'on', label: 'On (scale on busy rate)' },
    ],
    help: 'When on, "Instances" is the minimum count. Every so often it checks the average busy rate: too busy adds machines, too idle removes machines. A new machine takes requests only after its boot time, and it is slower right after it comes up (cold start).',
  },
  maxInstances: { type: 'int', default: max, min: 1, max: 1000, label: 'Max instances', help: 'Upper limit for autoscaling.', when: AUTO },
  targetUtil: {
    type: 'ratio', default: 0.6, label: 'Target utilization', when: AUTO,
    help: 'Target average utilization per instance. Instances needed = current instances × utilization ÷ target (no change if within 10%).',
  },
  scaleEveryS: { type: 'number', default: 60, min: 1, max: 3600, unit: 's', label: 'Check interval', help: 'How often to check how busy it is and decide to add or remove. Cloud autoscaling on 1-minute metrics checks about once a minute; the Kubernetes HPA every 15 seconds.', when: AUTO },
  scaleDownS: {
    type: 'number', default: 300, min: 0, max: 3600, unit: 's', label: 'Scale-down window', when: AUTO,
    help: 'To remove instances, every check in this window must need fewer; it then removes down to the most any check in the window needed. Like the Kubernetes HPA scale-down stabilization window (300 seconds by default): it keeps a short dip from removing instances that are needed again right away. 0 means remove as soon as they are not needed.',
  },
  bootS: {
    type: 'number', default: 120, min: 0, max: 3600, unit: 's', label: 'Boot time', when: AUTO,
    help: 'After deciding to add an instance, how long until it takes requests (start a VM, pull the image, pass the health check). A new VM takes about 1–3 minutes; a container on an existing node only seconds.',
  },
  warmS: {
    type: 'number', default: 20, min: 0, max: 3600, unit: 's', label: 'Warm-up time', when: AUTO,
    help: 'After a new machine comes up, how long the processing time takes to fall linearly from the cold-start multiplier back to normal (JIT, connection pool, local cache). 0 means no warm-up.',
  },
  coldFactor: { type: 'number', default: 3, min: 1, max: 100, label: 'Cold start factor', help: 'How many times normal the processing time is when a new machine just comes up.', when: AUTO },
});
const errorRate: ParamSpec = { type: 'ratio', default: 0, label: 'Error rate', help: 'Share of messages that fail at random after processing.' };
const dist = (mean: number, cv: number, label: string, help: string, max = 600000): ParamSpec => ({
  type: 'dist', default: { mean, cv }, max, label, help,
});

const dbParams = (): Record<string, ParamSpec> => ({
  replicas: { type: 'int', default: 0, min: 0, max: 15, label: 'Replica reads', help: 'A read-only replica outside the primary. Reads can go to replicas; writes only go to the primary.' },
  connections: concurrency(50, 'queries'),
  readMs: dist(3, 1, 'Read time', 'Processing time for one read query.'),
  writeMs: dist(10, 1, 'Write time', 'Processing time for one write.'),
  queueLimit: queueLimit(500),
  errorRate,
  readFrom: {
    type: 'enum', default: 'replicas', label: 'Read source',
    options: [
      { value: 'replicas', label: 'Replica only (read the primary if there is no replica)' },
      { value: 'primary', label: 'Primary only' },
      { value: 'any', label: 'Round-robin primary and replica' },
    ],
    help: 'Where read queries go.',
  },
  replicaApplyRatio: {
    type: 'ratio', default: 0.3, label: 'Replica applies write cost',
    help: 'For each write to the primary, every replica also spends "write time × this ratio" applying it. So replicas cannot save write volume. 0 means not counted (and stale reads are not computed).',
  },
  replicaDelayMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: 'Replication lag',
    help: 'After the primary writes, how long the write takes to reach a replica (network, batched sends). This time plus the replica queue and apply time is the replication lag. Reading a replica during this window gives a stale read.',
  },
  maxLagMs: {
    type: 'int', default: 0, min: 0, max: 3600000, unit: 'ms', label: 'Max replication lag',
    help: 'Reads skip a replica that lags more than this (like a proxy max replication lag check). If all replicas lag too much, read the primary. 0 means no check.',
  },
  localReplicas: {
    type: 'int', default: 0, min: 0, max: 15, label: 'Replicas in the primary\'s region',
    help: 'With a replica region, the first replicas stay in the primary\'s region and the others go to the replica region. A read goes to a replica in the caller\'s region first.',
  },
  failover: {
    type: 'enum', default: 'off', label: 'Automatic failover',
    options: [
      { value: 'off', label: 'Off (no writes while the primary is down)' },
      { value: 'auto', label: 'Automatic (a replica becomes the primary)' },
    ],
    help: 'When the primary fails, the replica that is furthest along becomes the primary. Replication is asynchronous: writes the primary acknowledged but had not sent to this replica yet are lost. Needs read replicas and a replica apply cost above 0 (to track replication).',
  },
  failoverS: {
    type: 'number', default: 90, min: 0, max: 3600, unit: 's', label: 'Failover time', when: { param: 'failover', value: 'auto' },
    help: 'How long from a primary failure until a replica takes over: detect, confirm, pick the new primary, reconnect. All writes fail in that time. RDS Multi-AZ instances take about 60–120 seconds; Multi-AZ clusters about 20–35 seconds.',
  },
  fencing: {
    type: 'enum', default: 'off', label: 'Fence the old primary', when: { param: 'failover', value: 'auto' },
    options: [
      { value: 'off', label: 'Off (the old primary still takes writes)' },
      { value: 'on', label: 'On (the old primary refuses writes)' },
    ],
    help: 'In a network partition, the replicas\' side thinks the primary is down and promotes a new one. The old primary still runs, and users on its side still write to it: both sides take writes (split brain), and the data diverges when the partition ends. With fencing (like STONITH or an epoch token), the old primary refuses writes as soon as the new one is up.',
  },
  readYourWrites: {
    type: 'enum', default: 'off', label: 'Read your writes',
    options: [
      { value: 'off', label: 'Off (use the read source)' },
      { value: 'primary', label: 'Read the primary for a while after a write' },
    ],
    help: 'A user who reads right after writing, from a replica that has not received the write yet, does not see their own write (read-your-writes fails). When on, reads within the window after a write go to the primary. Cost: more reads on the primary.',
  },
  rywWindowMs: {
    type: 'int', default: 2000, min: 0, max: 3600000, unit: 'ms', label: 'Primary-read window', when: { param: 'readYourWrites', value: 'primary' },
    help: 'How long after a write the reads go to the primary. Make it longer than the usual replication lag.',
  },
  locks: {
    type: 'enum', default: 'off', label: 'Row locks',
    options: [
      { value: 'off', label: 'Off (writes never wait for each other)' },
      { value: 'row', label: 'Row locks (writes to the same key wait in line)' },
    ],
    help: 'A write to a row (a key) must first take that row\'s lock. Writes to a hot key run one at a time: writes waiting for the lock hold a connection, and latency and queues grow. That key takes at most 1 ÷ (write time + lock hold) writes per second.',
  },
  lockHoldMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: 'Lock held after the write', when: { param: 'locks', value: 'row' },
    help: 'How long the transaction keeps the lock after the write before it commits (other queries in the transaction, or the application calls another service inside it).',
  },
});

export const KINDS: Record<string, KindSpec> = {
  client: {
    kind: 'client', label: 'Users', labelEn: 'Client', category: 'traffic', icon: 'Users', station: false, routing: 'one',
    summary: 'Generates traffic. Set the traffic size in the scenario. With several Users, traffic is split by weight.',
    params: {
      weight: { type: 'number', default: 1, min: 0, max: 1000, label: 'Traffic weight', help: 'With several Users nodes, split the scenario total traffic by weight.' },
      deadline: {
        type: 'enum', default: 'off', label: 'Deadline propagation',
        options: [
          { value: 'off', label: 'Off (each edge keeps its own deadline)' },
          { value: 'propagate', label: 'Pass down (like gRPC deadline)' },
        ],
        help: 'Pass down: the request carries the time when the user gives up. Each hop waits only until then; a request that has expired is dropped in the queue, so no wasted work; no retries after it expires.',
      },
      priority: {
        type: 'enum', default: 'normal', label: 'Request priority',
        options: [
          { value: 'critical', label: 'Critical (checkout, login)' },
          { value: 'normal', label: 'Normal' },
          { value: 'batch', label: 'Batch (batch jobs, crawlers, bots)' },
        ],
        help: 'Which class the requests from this user are. Under overload, a component with a load-shedding threshold drops batch requests first; a rate limiter can also limit batch requests only.',
      },
    },
  },
  dns: {
    kind: 'dns', label: 'DNS', labelEn: 'DNS', category: 'edge', icon: 'Globe', station: false, routing: 'one',
    summary: 'Turns a domain name into an IP address. Clients cache the answer, so only a few requests wait for a lookup. With several outgoing edges it splits traffic by weight (for example across two regions). With failover on, it removes failed targets from its answer.',
    params: {
      lookupMs: dist(20, 0.5, 'Query time', 'Extra query time on a cache miss.'),
      resolverCacheHit: { type: 'ratio', default: 0.95, label: 'Client cache hit rate', help: 'Share of requests that do not need a re-query.' },
      failover: {
        type: 'enum', default: 'off', label: 'DNS failover',
        options: [
          { value: 'off', label: 'Off (always split by weight)' },
          { value: 'on', label: 'On (health checks remove failed targets)' },
        ],
        help: 'When on, the DNS checks each target (for example each region\'s load balancer) every second. A target that stays down for the detection time leaves the answer; when it stays up as long, it comes back. Clients cache the old answer, so the move is complete only after the TTL.',
      },
      detectS: { type: 'number', default: 10, min: 1, max: 600, unit: 's', label: 'Detection time', help: 'How long a target must stay down (or up) before the DNS changes its answer.', when: DNS_FAILOVER },
      ttlS: {
        type: 'number', default: 60, min: 0, max: 86400, unit: 's', label: 'TTL', when: DNS_FAILOVER,
        help: 'How long clients cache the DNS answer. After the DNS changes its answer, clients that still hold the old one keep sending to the failed target; within the TTL they move to the new answer one by one (a request that misses the client cache looks the name up and gets the new answer at once). A short TTL moves traffic sooner. How many requests look the name up is set by the client cache hit ratio, not by the TTL here.',
      },
    },
  },
  cdn: {
    kind: 'cdn', label: 'CDN', labelEn: 'CDN', category: 'edge', icon: 'Cloud', station: false, routing: 'one',
    summary: 'A cache close to users. A read hit is answered right away; only a miss goes to the origin behind it. Writes always go to the origin. Capacity is unlimited.',
    params: {
      hitRatio: { type: 'ratio', default: 0.8, label: 'Hit rate', help: 'Share of read requests that hit the CDN.' },
      edgeMs: dist(10, 0.5, 'Edge latency', 'Processing time of the CDN node itself.'),
    },
  },
  api_gateway: {
    kind: 'api_gateway', label: 'API Gateway', labelEn: 'API gateway', category: 'edge', icon: 'DoorOpen', station: true, routing: 'one',
    summary: 'Front door: validates and routes reads and writes to the backend. It is a proxy, so it holds a slot while it waits for the backend.',
    params: {
      instances: instances(2),
      concurrency: concurrency(256),
      serviceMs: dist(1, 0.5, 'Process time', 'Time spent on validation and routing.'),
      queueLimit: queueLimit(1000),
      shedAt: {
        type: 'ratio', default: 0, label: 'Load-shedding threshold (drop batch)',
        help: 'When one instance\'s queue reaches "queue limit × this ratio", new "batch" requests are rejected outright (shed), leaving room for normal and critical requests. 0 means no priority split.',
      },
      ...queueing(),
      ...autoscale(10),
    },
  },
  load_balancer: {
    kind: 'load_balancer', label: 'Load Balancer', labelEn: 'Load balancer', category: 'edge', icon: 'Split', station: false, routing: 'one',
    summary: 'Spreads requests across all instances of all downstream nodes. You can pick a distribution policy. It skips instances it thinks are unhealthy: by default it knows at once which instance is down; you can also use periodic health checks, or eject failing instances from their replies (outlier detection). Capacity is unlimited.',
    params: {
      policy: {
        type: 'enum', default: 'round_robin', label: 'Distribution policy',
        options: [
          { value: 'round_robin', label: 'Round robin' },
          { value: 'least_conn', label: 'Least connections' },
          { value: 'p2c', label: 'Pick two at random, take the less busy (power of two)' },
          { value: 'random', label: 'Random' },
        ],
        help: 'How to pick the next instance.',
      },
      latencyMs: dist(0.3, 0.3, 'Forward latency', 'Processing time of the LB itself.'),
      healthCheck: {
        type: 'enum', default: 'instant', label: 'Health check',
        options: [
          { value: 'instant', label: 'Instant (idealized)' },
          { value: 'liveness', label: 'Liveness (is the process up?)' },
          { value: 'deep', label: 'Deep (runs a real request)' },
        ],
        help: 'How the load balancer finds out that an instance is broken. "Instant" is the ideal case. A liveness check only finds crashes; it misses an instance that is alive but slow or failing (a gray failure). A deep check finds failing and too-slow instances.',
      },
      hcIntervalS: { type: 'number', default: 5, min: 0.1, max: 600, unit: 's', label: 'Check interval@@probe', help: 'How often each instance is checked.', when: PROBE },
      hcThreshold: { type: 'int', default: 2, min: 1, max: 100, label: 'Checks in a row to switch', help: 'Failed checks in a row to take an instance out; passed checks in a row to put it back.', when: PROBE },
      hcTimeoutMs: {
        type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: 'Check timeout', when: { param: 'healthCheck', value: 'deep' },
        help: 'A deep check with no reply within this time counts as a failure.',
      },
      outlier: {
        type: 'enum', default: 'off', label: 'Outlier detection',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On (outlier detection)' },
        ],
        help: 'Watches the replies to real requests: when an instance fails (error, timeout, down) this many times in a row, stop sending to it for a while. At most half of the instances are ejected at the same time.',
      },
      outlierErrors: { type: 'int', default: 5, min: 1, max: 1000, label: 'Failures in a row to eject', help: 'Eject an instance after this many failed requests in a row.', when: OUTLIER },
      ejectS: { type: 'number', default: 30, min: 0.1, max: 3600, unit: 's', label: 'Ejection time', help: 'How long until an ejected instance is tried again.', when: OUTLIER },
    },
  },
  rate_limiter: {
    kind: 'rate_limiter', label: 'Rate Limiter', labelEn: 'Rate limiter', category: 'resilience', icon: 'Gauge', station: false, routing: 'one',
    summary: 'Rate limiting. Token bucket: a fixed number of tokens refills each second, up to the burst allowance; it can also limit the number of requests in flight. Requests over the limit get an immediate 429 (rate_limited). All requests can share one allowance, or each user (tenant) gets its own.',
    params: {
      limit: {
        type: 'enum', default: 'rate', label: 'What it limits',
        options: [
          { value: 'rate', label: 'Requests per second (token bucket)' },
          { value: 'concurrency', label: 'Requests being processed at the same time' },
          { value: 'both', label: 'Limit both' },
        ],
        help: 'Requests per second blocks traffic that comes too fast; concurrent requests block requests that hold on (like Stripe\'s concurrency limit), and it blocks first when the downstream slows down.',
      },
      ratePerSec: { type: 'number', default: 1000, min: 0, max: 10000000, unit: 'req/s', label: 'Limit per second', help: 'Requests let through per second, averaged over time.' },
      burst: { type: 'int', default: 100, min: 1, max: 10000000, label: 'Burst allowance', help: 'How many tokens the bucket holds, that is how many can pass at one time.' },
      maxConcurrent: { type: 'int', default: 100, min: 1, max: 10000000, label: 'Max concurrent', help: 'Max requests that passed the limit and have no response yet.' },
      scope: {
        type: 'enum', default: 'global', label: 'How the allowance is split',
        options: [
          { value: 'global', label: 'All share one' },
          { value: 'per_client', label: 'One per user (tenant)' },
        ],
        help: 'One per user: a big customer that uses up its own quota does not eat into anyone else\'s.',
      },
      appliesTo: {
        type: 'enum', default: 'all', label: 'Which requests it limits',
        options: [
          { value: 'all', label: 'All' },
          { value: 'batch', label: 'Batch requests only (bot, batch)' },
        ],
        help: 'With batch requests only, normal and critical requests pass through.',
      },
    },
  },
  service: {
    kind: 'service', label: 'API Server', labelEn: 'API server', category: 'compute', icon: 'Server', station: true, routing: 'plan',
    summary: 'Handles requests, then calls downstream. It keeps its slot while it waits on downstream (like a thread pool), so a slow downstream also makes it queue. When it connects to both the cache and the DB, reads use cache-aside.',
    params: {
      instances: instances(2),
      concurrency: concurrency(32),
      serviceMs: dist(5, 1, 'Process time', 'Own compute time, not counting the wait on downstream.'),
      queueLimit: queueLimit(500),
      shedAt: {
        type: 'ratio', default: 0, label: 'Load-shedding threshold (drop batch)',
        help: 'When one instance\'s queue reaches "queue limit × this ratio", new "batch" requests are rejected outright (shed), leaving room for normal and critical requests. 0 means no priority split.',
      },
      ...queueing(),
      errorRate,
      calls: {
        type: 'enum', default: 'sequential', label: 'How to call the downstream',
        options: [
          { value: 'sequential', label: 'In order (finish one before the next)' },
          { value: 'parallel', label: 'Parallel (send at once, wait for all)' },
        ],
        help: 'With several downstreams, call them in sequence or in parallel.',
      },
      outbox: {
        type: 'enum', default: 'off', label: 'Message after write (outbox)',
        options: [
          { value: 'off', label: 'Off (save to the database, then send to the queue, as two calls)' },
          { value: 'on', label: 'On (transactional outbox)' },
        ],
        help: 'When a write saves to a database and sends a message to a queue: off, the two are separate calls, and when one succeeds and the other fails they disagree (dual write). On, the message is written to an outbox table in the same transaction as the data; a relay then sends it to the queue and retries until it gets there. The request succeeds when the database write does.',
      },
      outboxRetryMs: { type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: 'Outbox retry interval', help: 'How long the relay waits after a failed send before it sends again.', when: { param: 'outbox', value: 'on' } },
      ...autoscale(10),
    },
  },
  circuit_breaker: {
    kind: 'circuit_breaker', label: 'Circuit Breaker', labelEn: 'Circuit breaker', category: 'resilience', icon: 'Unplug', station: false, routing: 'one',
    summary: 'Circuit breaker. If downstream fails too much over a recent window, it opens and later requests fail at once (circuit_open) instead of waiting for downstream. After a while it lets a few requests through as a half-open probe and recovers if they succeed. Usually paired with a timeout on the outgoing edge.',
    params: {
      failureRatio: { type: 'ratio', default: 0.5, label: 'Trip threshold', help: 'The circuit breaker opens when the failure ratio in the stats window is above this value.' },
      minCalls: { type: 'int', default: 20, min: 1, max: 100000, label: 'Min calls', help: 'Needs at least this many calls in the window before it decides.' },
      windowS: { type: 'number', default: 10, min: 1, max: 600, unit: 's', label: 'Stats window', help: 'See successes and failures in the last few seconds.' },
      openMs: { type: 'number', default: 5000, min: 1, max: 600000, unit: 'ms', label: 'Open time', help: 'How long to wait after it trips before the half-open probe starts.' },
      halfOpenCalls: { type: 'int', default: 5, min: 1, max: 1000, label: 'Probe requests', help: 'How many requests to let through in the half-open probe; if all succeed, it closes.' },
    },
  },
  cache: {
    kind: 'cache', label: 'Cache', labelEn: 'Cache', category: 'data', icon: 'MemoryStick', station: true, routing: 'plan',
    summary: 'In-memory cache (like Redis). A hit means no DB query. You can use a fixed hit rate, or let LRU compute the hit rate from the capacity and how hot the keys are. Keys are spread over the instances by hash.',
    params: {
      mode: {
        type: 'enum', default: 'fixed', label: 'Hit rate mode',
        options: [
          { value: 'fixed', label: 'Fixed hit rate' },
          { value: 'lru', label: 'LRU (computed from capacity and key distribution)' },
        ],
        help: 'Fixed: each read is decided at random by the hit rate. LRU: it really remembers keys and evicts the least recently used one when full; it starts cold.',
      },
      hitRatio: { type: 'ratio', default: 0.9, label: 'Hit rate (fixed mode)', help: 'Share of reads that hit.', when: { param: 'mode', value: 'fixed' } },
      capacityKeys: { type: 'int', default: 10000, min: 1, max: 10000000, label: 'Capacity (keys, LRU)', help: 'Max keys stored across all instances.', when: LRU },
      ttlS: { type: 'number', default: 0, min: 0, max: 86400, unit: 's', label: 'TTL (LRU)', help: 'How long before it expires. 0 means it never expires.', when: LRU },
      ttlJitter: {
        type: 'ratio', default: 0, label: 'TTL jitter', when: LRU,
        help: 'On each write, the TTL is cut by a random share from 0 to this value (0.2 = up to 20% shorter). Keys written at the same time then do not expire and hit the DB at the same time.',
      },
      stampede: {
        type: 'enum', default: 'none', label: 'Stampede protection', when: LRU,
        options: [
          { value: 'none', label: 'None' },
          { value: 'coalesce', label: 'Coalesce (read-through)' },
          { value: 'lease', label: 'Lease (cache-aside)' },
        ],
        help: 'When a hot key expires, many requests miss at once and all read the DB. Coalesce: when the cache reads the DB itself, each key is read once and the other requests wait for the result. Lease: when the service reads the DB, the first miss gets a lease and reads; the others wait a moment and ask the cache again.',
      },
      leaseMs: {
        type: 'number', default: 2000, min: 10, max: 60000, unit: 'ms', label: 'Lease lifetime', when: { param: 'stampede', value: 'lease' },
        help: 'The request that holds the lease must write the value back within this time. If it does not, the next miss gets a new lease.',
      },
      leaseWaitMs: {
        type: 'number', default: 20, min: 1, max: 5000, unit: 'ms', label: 'Wait before asking again', when: { param: 'stampede', value: 'lease' },
        help: 'How long a request without the lease waits before it asks the cache again.',
      },
      instances: instances(1),
      concurrency: concurrency(8, 'operations'),
      opMs: dist(0.3, 0.5, 'Operation time', 'Time for one get/set.'),
      queueLimit: queueLimit(10000),
    },
  },
  database: {
    kind: 'database', label: 'Database@@kind', labelEn: 'Database', category: 'data', icon: 'Database', station: true, routing: 'leaf',
    summary: 'Relational database: one primary plus optional read replicas. Writes go only to the primary; reads go to replicas or the primary as configured. A machine\'s connection count is how many queries it can handle at once.',
    params: dbParams(),
  },
  sharded_db: {
    kind: 'sharded_db', label: 'Sharded DB', labelEn: 'Sharded database', category: 'data', icon: 'Layers', station: true, routing: 'leaf',
    summary: 'Data is split over several shards by the hash of the key, and each shard is a primary plus replicas. A hot key makes one shard extra busy (hot spot).',
    params: {
      shards: { type: 'int', default: 4, min: 1, max: 256, label: 'Shards', help: 'How many shards the data is split into.' },
      ...dbParams(),
    },
  },
  queue: {
    kind: 'queue', label: 'Queue@@kind', labelEn: 'Queue', category: 'messaging', icon: 'ListOrdered', station: false, routing: 'queue',
    summary: 'Message queue (like SQS, Kafka). It answers as soon as it gets a message, and messages wait in line for workers to take. All workers behind it share the messages.',
    params: {
      maxDepth: { type: 'int', default: 100000, min: 1, max: 100000000, label: 'Max depth', help: 'How many messages it can hold. When full, writes are rejected (queue_full).' },
      enqueueMs: dist(2, 0.5, 'Write latency', 'Time to write and get an ack.'),
      delivery: {
        type: 'enum', default: 'at_most_once', label: 'Delivery mode',
        options: [
          { value: 'at_most_once', label: 'Delete on delivery (at most once)' },
          { value: 'at_least_once', label: 'Delete after done (at-least-once)' },
        ],
        help: 'At most once: if the worker fails or crashes, the message is lost. At least once (like SQS): delete only when the worker succeeds; if it fails or is too slow, the message comes back after the visibility timeout and may be processed twice.',
      },
      visibilityTimeoutMs: { type: 'int', default: 30000, min: 1, max: 43200000, unit: 'ms', label: 'Visibility timeout', help: 'How long a message stays hidden after it is handed to a worker. If it is not done (or it fails) in that time, the message shows up again for another worker. If this is shorter than the process time, messages get processed twice.', when: { param: 'delivery', value: 'at_least_once' } },
      maxReceives: { type: 'int', default: 0, min: 0, max: 1000, label: 'Max receive count (DLQ)', help: 'When a message is taken this many times without success, it moves to the dead-letter queue (DLQ) and is not retried. 0 means no DLQ, so it retries forever.', when: { param: 'delivery', value: 'at_least_once' } },
      messageTtlS: { type: 'number', default: 0, min: 0, max: 1209600, unit: 's', label: 'Message retention', help: 'Drop a message (expire it) if it is still not processed after this long. 0 means keep it forever.' },
      ordering: {
        type: 'enum', default: 'standard', label: 'Ordering',
        options: [
          { value: 'standard', label: 'Standard (no order)' },
          { value: 'fifo', label: 'FIFO (in order per group)' },
        ],
        help: 'FIFO (like SQS FIFO or a Kafka partition): messages of one group (one key) are handed out one at a time; the next one goes only when the previous one is done, dropped or moved to the DLQ. When one is stuck (slow, or a poison message retried again and again), its whole group waits (head-of-line blocking).',
      },
      groups: { type: 'int', default: 16, min: 1, max: 100000, label: 'Message groups', help: 'With FIFO, messages are split into this many groups by key (like message groups or partitions). Fewer groups block each other more often, and also limit how many messages are worked on at once.', when: { param: 'ordering', value: 'fifo' } },
    },
  },
  worker: {
    kind: 'worker', label: 'Worker', labelEn: 'Worker', category: 'compute', icon: 'Cog', station: true, routing: 'plan',
    summary: 'Background worker. It takes messages from the queue in front of it and can call the DB or object storage in turn. Its speed decides whether the queue keeps piling up.',
    params: {
      instances: instances(2),
      concurrency: concurrency(4, 'messages'),
      serviceMs: dist(50, 1, 'Process time', 'Compute time to process one message, not counting the wait on downstream.'),
      queueLimit: queueLimit(100),
      errorRate,
      poisonRate: { type: 'ratio', default: 0, label: 'Poison message ratio', help: 'Share of messages with bad content that fail on every attempt. Use it with the queue\'s at-least-once setting and the DLQ to see the effect.' },
      calls: {
        type: 'enum', default: 'sequential', label: 'How to call the downstream',
        options: [
          { value: 'sequential', label: 'In order' },
          { value: 'parallel', label: 'Parallel' },
        ],
        help: 'With several downstreams, call them in sequence or in parallel.',
      },
      outbox: {
        type: 'enum', default: 'off', label: 'Message after write (outbox)',
        options: [
          { value: 'off', label: 'Off (save to the database, then send to the queue, as two calls)' },
          { value: 'on', label: 'On (transactional outbox)' },
        ],
        help: 'When a write saves to a database and sends a message to a queue: off, the two are separate calls, and when one succeeds and the other fails they disagree (dual write). On, the message is written to an outbox table in the same transaction as the data; a relay then sends it to the queue and retries until it gets there. The request succeeds when the database write does.',
      },
      outboxRetryMs: { type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: 'Outbox retry interval', help: 'How long the relay waits after a failed send before it sends again.', when: { param: 'outbox', value: 'on' } },
      ...autoscale(10),
    },
  },
  function: {
    kind: 'function', label: 'Function', labelEn: 'Function', category: 'compute', icon: 'Zap', station: true, routing: 'plan',
    summary: 'A serverless function (like AWS Lambda). Each execution environment handles one request at a time. With no free environment it starts a new one (a cold start: that request waits longer); an environment idle for a while is reclaimed. When the environments reach the limit, or new ones would start faster than the scaling rate, new requests are rejected (throttled, 429); messages from a queue stay in the queue.',
    params: {
      maxConcurrency: {
        type: 'int', default: 1000, min: 1, max: 100000, label: 'Concurrency limit',
        help: 'The most execution environments at once (one request each). Past the limit, synchronous calls are rejected (429). An AWS account has 1000 per region by default; reserved concurrency can set it lower.',
      },
      provisioned: {
        type: 'int', default: 0, min: 0, max: 100000, label: 'Provisioned environments',
        help: 'Environments ready from the start and never reclaimed (provisioned concurrency). Requests that use them have no cold start. They count toward the concurrency limit.',
      },
      serviceMs: dist(50, 1, 'Process time', 'Its own compute time per request, not counting waits for downstream calls.'),
      coldStartMs: dist(300, 0.5, 'Cold start time', 'How long a new environment takes to start (download the code, start the runtime, run the init code). It is part of the latency of the request that started it. Node.js and Python take about 100–500 ms; Java without SnapStart often takes over 1 second.'),
      idleS: {
        type: 'number', default: 600, min: 1, max: 7200, unit: 's', label: 'Idle reclaim time',
        help: 'An environment with no request for this long is reclaimed; the next request has a cold start again. AWS does not publish it; in practice about 5–15 minutes.',
      },
      scalePer10s: {
        type: 'int', default: 1000, min: 1, max: 100000, label: 'Scaling rate (per 10 s)',
        help: 'The most new environments started per 10 seconds. Requests past it are rejected (429). AWS Lambda allows 1000 per function every 10 seconds.',
      },
      errorRate,
      calls: {
        type: 'enum', default: 'sequential', label: 'How to call the downstream',
        options: [
          { value: 'sequential', label: 'In order' },
          { value: 'parallel', label: 'Parallel' },
        ],
        help: 'With several downstreams, call them in sequence or in parallel.',
      },
    },
  },
  // roadmap-next M7 (Q16, Q17, Q19): a service the user describes, on the engine's shared service path
  custom: {
    kind: 'custom', label: 'Custom service', labelEn: 'Custom service', category: 'compute', icon: 'Box', station: true, routing: 'plan',
    summary: 'A service the catalog does not have (search, payments, email, an AI model…): you give its name, icon, processing time, capacity, error rate and price. It handles requests, then calls its downstreams, like an API server (connected to both a cache and a DB, reads are cache-aside), but without autoscaling or overload protection. Not allowed in practice problems.',
    params: {
      icon: {
        type: 'enum', default: 'Box', label: 'Icon',
        options: [
          { value: 'Box', label: 'Box' },
          { value: 'Search', label: 'Search' },
          { value: 'CreditCard', label: 'Payment' },
          { value: 'Mail', label: 'Email' },
          { value: 'Bell', label: 'Notification' },
          { value: 'Image', label: 'Image' },
          { value: 'ShieldCheck', label: 'Auth' },
          { value: 'Bot', label: 'AI model' },
          { value: 'Cpu', label: 'Compute' },
          { value: 'Workflow', label: 'Workflow' },
        ],
        help: 'The icon on the canvas. Looks only: it does not change the simulation.',
      },
      instances: instances(2),
      concurrency: concurrency(32),
      serviceMs: dist(5, 1, 'Process time', 'Own compute time, not counting the wait on downstream.'),
      queueLimit: queueLimit(500),
      errorRate,
      calls: {
        type: 'enum', default: 'sequential', label: 'How to call the downstream',
        options: [
          { value: 'sequential', label: 'In order (finish one before the next)' },
          { value: 'parallel', label: 'Parallel (send at once, wait for all)' },
        ],
        help: 'With several downstreams, call them in sequence or in parallel.',
      },
      pricePerHour: {
        type: 'number', default: 0.08, min: 0, max: 1000, label: 'Price per instance per hour (USD)',
        help: 'For the cost estimate: US dollars for one instance running one hour. The default is the API server\'s.',
      },
    },
  },
  object_storage: {
    kind: 'object_storage', label: 'Object Storage', labelEn: 'Object storage', category: 'data', icon: 'Archive', station: true, routing: 'leaf',
    summary: 'Object storage (like S3). Capacity is huge, but each access is slower. Reads are GET, writes are PUT.',
    params: {
      getMs: dist(30, 0.6, 'GET time', 'Time to read one object up to the first byte.'),
      putMs: dist(60, 0.6, 'PUT time', 'Time to write one object.'),
      concurrency: concurrency(2000),
      queueLimit: queueLimit(10000),
      errorRate,
    },
  },
};

export const KIND_NAMES = Object.keys(KINDS);

/** The custom service (roadmap-next M7): not allowed in practice problems (Q20). */
export const CUSTOM_KIND = 'custom';

export const CATEGORY_LABEL: Record<Category, string> = {
  traffic: 'Traffic',
  edge: 'Ingress and network',
  compute: 'Compute',
  resilience: 'Protection',
  data: 'Data',
  messaging: 'Async',
};

export const EDGE_PARAMS: Record<string, ParamSpec> = {
  on: {
    type: 'enum', default: 'all', label: 'Which requests it carries',
    options: [
      { value: 'all', label: 'All' },
      { value: 'read', label: 'Reads only' },
      { value: 'write', label: 'Writes only' },
      { value: 'boot', label: 'Only at boot' },
      { value: 'control', label: 'Control plane (metrics, coordination)' },
    ],
    help: 'This edge carries reads only, writes only, or both. "Only at boot": a new autoscaled instance calls it once while booting (get config, register, pull the image) and goes live only when every such call succeeds; requests do not take it. "Control plane": the autoscaler, automatic database failover and DNS failover call it before each decision (get metrics, ask a coordination service); when it fails they are blind and do not act this time. Requests do not take it either.',
  },
  weight: { type: 'number', default: 1, min: 0, max: 1000, label: 'Weight', help: 'When a node picks one of several edges, it picks by weight.' },
  latencyMs: { type: 'number', default: 0.5, min: 0, max: 60000, unit: 'ms', label: 'Network latency (one way)', help: 'Edges from Users default to 20 ms (internet), other edges to 0.5 ms (same data center).' },
  timeoutMs: { type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: 'Timeout', help: 'How long the caller waits at most. 0 means no limit. After a timeout the downstream still finishes the work (wasted).' },
  retries: { type: 'int', default: 0, min: 0, max: 10, label: 'Retry count', help: 'Max retries after a failure. Rate limits (429) and an open circuit breaker are not retried.' },
  backoffMs: { type: 'number', default: 50, min: 0, max: 60000, unit: 'ms', label: 'Retry backoff base', help: 'Before retry n, wait a random 0 to base × 2^(n−1) ms (full jitter).' },
  retryBudget: {
    type: 'number', default: 0, min: 0, max: 10, label: 'Retry budget',
    help: 'In the last 10 s, how many times the first-call count the retries on this edge can reach (Google suggests 0.1 = 10%). Above that, no retry and the call reports failure right away. 0 means no limit.',
  },
  throttleK: {
    type: 'number', default: 0, min: 0, max: 10, label: 'Adaptive throttling K',
    help: 'Client-side throttling (Google SRE adaptive throttling). Over the last 10 s the caller counts requests sent and accepts (successes). A new call fails locally, without being sent, with probability max(0, (requests − K × accepts) ÷ (requests + 1)). K = 2 is the book\'s suggestion; a smaller K rejects earlier. 0 turns it off.',
  },
  bulkhead: {
    type: 'int', default: 0, min: 0, max: 100000, label: 'Bulkhead (max concurrent calls)',
    help: 'How many calls over this connection each caller instance may have in flight at the same time (a bulkhead). When it is full, the call fails at once (bulkhead full) instead of tying up more threads. So a slow dependency can hold only these slots, not the whole instance. 0 = no limit.',
  },
  hedgeMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: 'Hedged request',
    help: 'When a read has no reply after this long, send a second copy (hedged request); the first success counts. Usually set to the p95 latency: about 5% more requests cut the tail latency. The losing copy still runs to the end downstream. Reads only (sending a write twice is not safe). 0 means off.',
  },
  fanout: {
    type: 'int', default: 0, min: 0, max: 256, label: 'Fan-out (copies sent at once)',
    help: 'Send each call to this many copies of the target at once; the call is done when they are back (scatter-gather). Sharded database: this many shards (a search asks every shard). Database: this many of the primary and replicas (a write goes to each copy itself). Other nodes: this many different instances. More than there are means all of them. The more copies, the more likely one is slow, so the tail latency grows. 0 means one copy.',
  },
  quorum: {
    type: 'int', default: 0, min: 0, max: 256, label: 'Quorum (copies to wait for)',
    help: 'With fan-out, answer as soon as this many copies succeed, without waiting for the rest (a quorum, as in Cassandra or DynamoDB: 2 of 3 copies). When too many fail to reach this number, the call fails. The copies not waited for still run to the end. 0 means wait for all.',
  },
  connectMs: {
    type: 'number', default: 0, min: 0, max: 60000, unit: 'ms', label: 'Connection setup',
    help: 'How long opening a new connection takes (TCP + TLS handshakes; across regions often several round trips). A connection stays open for the next call (keep-alive) and closes when idle too long; more calls at once, or the first call after an idle spell, pay this first. 0: not modelled.',
  },
  keepAlive: {
    type: 'enum', default: 'on', label: 'Connection reuse (keep-alive)',
    options: [
      { value: 'on', label: 'On (keep connections open)' },
      { value: 'off', label: 'Off (a new connection per call)' },
    ],
    help: 'Off: every call pays the connection setup time. Only works when "Connection setup" is above 0.',
  },
  idleS: {
    type: 'number', default: 60, min: 0, max: 3600, unit: 's', label: 'Idle close after',
    help: 'A connection idle this long is closed; the next call opens a new one. Only works when "Connection setup" is above 0.',
  },
  fallback: {
    type: 'enum', default: 'off', label: 'Fallback (degraded response)',
    options: [
      { value: 'off', label: 'Off (report the failure upstream)' },
      { value: 'on', label: 'On (use a fallback response on failure)' },
    ],
    help: 'When a call over this connection finally fails (retries used up, timeout, circuit open, bulkhead full), the caller answers with a fallback response instead (for example a default recommendation list): the request still succeeds, but counts as a degraded response. Use it for dependencies that are not essential.',
  },
};

export const CLIENT_EDGE_LATENCY_MS = 20;
/** Default one-way latency between two regions, ms (US east ↔ west coast: a round trip of about 70 ms). */
export const INTER_REGION_MS = 35;

export type Dist = { mean: number; cv: number };
export type ResolvedParams = Record<string, number | string | Dist>;

/** Fill defaults and normalise distributions to { mean, cv }. Does not mutate the input. */
export function resolveParams(kind: string, params: Record<string, unknown> | undefined): ResolvedParams {
  const spec = KINDS[kind];
  const out: ResolvedParams = {};
  if (!spec) return out;
  for (const [name, p] of Object.entries(spec.params)) {
    const v = params?.[name];
    if (p.type === 'dist') {
      if (typeof v === 'number') out[name] = { mean: v, cv: p.default.cv };
      else if (v && typeof v === 'object') {
        const o = v as { mean?: number; cv?: number };
        out[name] = { mean: o.mean ?? p.default.mean, cv: o.cv ?? p.default.cv };
      } else out[name] = { ...p.default };
    } else {
      out[name] = (v as number | string | undefined) ?? p.default;
    }
  }
  return out;
}

/**
 * Whether an edge's `fanout` works: the target needs instances or shards, and the edge is called
 * one call at a time. A queue hands each message to one worker; a load balancer picks one backend.
 */
export function fanoutApplies(fromKind: string, toKind: string): boolean {
  return !!KINDS[toKind]?.station && fromKind !== 'queue' && fromKind !== 'load_balancer';
}
