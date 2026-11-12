# The simulation model (English summary)

This is a summary of [model.md](model.md) (Chinese), which is the full reference. If the two disagree, `model.md` and the code in `src/engine/` are right.

The model has one purpose: show how capacity, latency and failures move through a design. It does not try to predict the numbers of a real system.

## 1. Time and events

- The engine is a discrete-event simulation. Time is in milliseconds. Events sit in a min-heap and run in time order.
- The same design, scenario and seed always give the same result.
- Random numbers come from separate streams (arrivals, read or write, keys, each node, each edge). Two designs that run the same scenario see exactly the same traffic (common random numbers), so a comparison is fair.

## 2. Traffic

- Arrivals are Poisson by default; `constant` gives evenly spaced arrivals.
- A scenario can change the rate: `spike`, `ramp`, `wave` (a compressed day) and `cron` (everyone sends at the same moment, with optional jitter).
- Each request is a read or a write (`readRatio`) and has a key from a Zipf distribution (`zipf: 0` is uniform).
- A scenario can also inject faults and operations: a component or one instance that is down, slow or returns errors; GC pauses; a network partition between two regions; a weighted traffic shift (canary, blue-green, region evacuation); a rollout in waves with automatic rollback; a reshard.

## 3. The station: the common model of a component

API servers, API gateways, workers, caches, databases and object storage are all stations.

- A station has `instances`. Each instance has `concurrency` slots (think of threads or connections).
- A request takes a free slot, or waits in a FIFO queue. When the queue is longer than `queueLimit`, the request is rejected.
- **Blocking model.** A request keeps its slot while it waits for its downstream calls. This is how a thread pool behaves: when a dependency is slow, the callers' slots fill up and the slowness moves upstream.
- Service time has a Gamma distribution, given as a mean and a coefficient of variation (`cv: 1` is exponential, `cv: 0` is fixed).

## 4. Components

| Component | What the model does |
|---|---|
| Client | Sends the requests. A request that takes longer than `clientTimeoutMs` is a timeout. |
| DNS, CDN | DNS adds lookup time on a miss. A CDN answers reads at the edge by `hitRatio`. |
| Load balancer | `round_robin`, `least_conn`, `p2c`, `random`. Health checks: instant, liveness, deep, and passive outlier detection (like Envoy). It fails open when every instance is removed. |
| Rate limiter | Token bucket, a concurrency limit, or both; global or per client. |
| Service, API gateway | A station that calls its downstreams in sequence or in parallel. With a cache and a database it does cache-aside. Optional LIFO or adaptive LIFO queue, CoDel, priority load shedding. |
| Circuit breaker | Opens on a failure ratio in a time window, then lets probe calls through. |
| Cache | A fixed hit ratio, or a real LRU with capacity and TTL. Stampede protection: TTL jitter, coalescing (singleflight), leases. Cross-region replication between two caches. |
| Database | A primary and replicas. Replication lag, stale reads, read-your-writes, row locks, automatic failover, split brain with or without fencing. |
| Sharded database | Keys map to shards; a hot key makes one shard busy. Fan-out reads with a quorum. |
| Queue, worker | At-most-once or at-least-once delivery, visibility timeout, DLQ, message TTL, FIFO groups with head-of-line blocking, poison messages, transactional outbox. |
| Custom service | A service that is not in the catalog (search, a payment provider, email). A station with the instances, slots, service time, queue limit, error rate and call order the user gives. It takes the same path as an API server (cache-aside with a cache and a database), without autoscaling, overload protection, an outbox or rollouts. Its icon and its price per instance are the user's. Practice problems do not allow it. |
| Function | Like AWS Lambda: one request per environment, cold starts, a concurrency limit, a scaling rate. |
| Autoscaling | Like the Kubernetes HPA: target utilization, boot time, a cold period, a scale-down stabilization window. Boot and control-plane dependencies can fail. |

## 5. Edges (calls)

- An edge has a one-way network latency, a timeout, retries with full-jitter backoff, and an optional connection cost (`connectMs`, with an idle connection pool).
- **A callee does not know that its caller gave up.** It finishes the work, and the work is wasted. Deadline propagation is off by default, as in most real systems; turn it on at the client.
- Protection on an edge: retry budget, client-side adaptive throttling (the Google SRE book), bulkhead, fallback (degraded responses), hedged requests, fan-out with a quorum.

## 6. Metrics

- Data from the warm-up period is not in the summary.
- The summary follows every request that was **sent** in the measured period until it ends.
- The time series counts successes, failures and latency by **completion** time, like a monitoring dashboard.
- Latency percentiles use a log-bucketed histogram; the error is below 0.5%.
- Work that is not finished when the run stops (queued messages, pending retries) is counted in `unfinished`.
- Cost and complexity points are for the practice problems only. Prices are sample values with roughly the ratios of AWS in 2026. They are not a quote and do not change the simulation. A custom service costs its instances × the price per instance the user gives.

## 7. Checks against queueing theory

Each station shows a theory value next to the simulated one: an M/G/c approximation (Erlang C with the Allen–Cunneen correction) from the measured arrival rate and service time.

`tests/queueing.test.ts` holds the simulator to these limits for single stations:

| Case | Limit |
|---|---|
| M/M/1 at 50% and 80% load | mean latency within 5%, p99 within 10%, utilization within 3% |
| M/M/4 at 80% load | probability of waiting and mean wait within 10% of Erlang C |
| M/D/1 | mean wait within 8% of Pollaczek–Khinchine |
| Overload at 1.2× capacity | the queue grows at (arrival rate − service rate), within 10% |

Two things make a real design differ from the theory value. A load balancer spreads work more evenly than random arrivals, so queues are shorter. And the theory assumes an unlimited queue, so it is only a guide when requests are rejected.

## 8. What the model leaves out

- **Network.** No packets, bandwidth or congestion control. The network is a fixed latency plus an optional connection cost.
- **Machines.** No memory and no CPU cores. A slot is the only unit of capacity. GC exists only as a `pause` event in a scenario.
- **Caches** have a number of keys, not a size in bytes. The model does not track whether a cached value is fresh.
- **Data correctness.** The model counts stale reads, lost writes, divergent writes and dual-write gaps. It does not hold data, so it cannot merge, repair or check it. Locks are row locks only: no deadlocks, table locks or transaction retries.
- **Faults** start and end at once. How long the callers take to notice depends on the health check, outlier detection or DNS settings.
- **Autoscaling** looks only at utilization, not at queue length or latency.
- **Implementation detail.** A component is a generic model of its kind. It is not PostgreSQL, Redis or Kafka, and it has none of their specific limits or bugs.

## 9. How to read a result

- Trust the **direction** and the **mechanism**: which part saturates first, how a slow dependency fills the callers' slots, how retries multiply load, why a system does not recover after a spike.
- Trust a **comparison** of two designs under the same scenario more than a single number.
- Do not use an absolute number (a p99, an instance count, a monthly cost) to size a production system. Measure the real system for that.

If a run does not agree with a real system, a formula or a paper, please [open an issue](https://github.com/minchenlee/loadsketch/issues/new?template=sim-vs-real.yml).
