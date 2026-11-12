---
name: loadsketch
description: "Edit or create a system design for loadsketch (https://loadsketch.mclee.dev), a simulator for system designs. Use when the user wants to change, build or fix a loadsketch design (a JSON file whose schema is loadsketch/design@1), or asks for an architecture they will paste into loadsketch."
---

# loadsketch

loadsketch simulates a system design: components, the calls between them, and the traffic sent through them. The user works on the canvas of the web app; you work on the design JSON.

## Steps

1. Get the design JSON. If the user has not given it, ask for it: in loadsketch, File → "Paste design JSON" → "Copy only the design JSON", or File → "Save as JSON". A path to a saved `.json` file works too. To start from nothing, write a new design.
2. Change the design as the user asks, following the format guide below. Change only what was asked. Keep the ids and the `source` fields of everything you keep.
3. Check your answer against the guide: every field is allowed, every edge points to existing node ids, and every parameter is inside the limits.
4. Give back the whole design as one ```json code block (or write it to the file the user named). Say in a few lines what you changed and why.
5. Tell the user to paste it back: in loadsketch, File → "Paste design JSON", paste, look at the list of changes, and click "Replace the canvas". If the app says something is wrong, fix what it names and give the whole design again.

# loadsketch design format

loadsketch (https://loadsketch.mclee.dev) is a simulator for system designs: components (nodes), the calls between them (edges), and the traffic sent through them. This page tells an AI model how to read and write a design. It is made from the component catalog of the app, so it matches the app.

## How to answer

- Give back the whole design as one JSON object, in one ```json code block. No comments, no trailing commas.
- Change only what you were asked to change. Keep the ids of the components you keep: the app compares the two designs by id and shows the user every change before it replaces the canvas.
- New ids: letters, digits, `_` and `-`, starting with a letter or digit, at most 48 characters, no spaces.
- Give each new component a position `pos` [x, y] in pixels. Traffic goes left to right: put a component about 300 px right of its caller, and spread components that share a caller about 120–240 px apart vertically.
- A design made by the Terraform import has `source` fields on its components and edges. Copy each `source` unchanged onto every component and edge you keep, also when you change one of its values: the app marks the changed values itself. Leave it out on a new one.
- Leave out a parameter to use its default. Times are in milliseconds unless the unit says otherwise.
- The traffic (requests per second, read share, faults) is the scenario, not the design: set it in the app.
- The user pastes the answer with File → "Paste design JSON". If something is wrong, the app says what and where.

## The design

- `schema` (required) — always "loadsketch/design@1".
- `name` (required) — 1–120 characters.
- `description` — what the design is, up to 8000 characters.
- `nodes` (required) — the components, up to 300.
- `edges` (required) — the calls, up to 2000.
- `apis` — The APIs users call, with their share of the traffic. When set, every request calls one of them and the scenario's readRatio is not used: each API says whether it reads or writes. An edge with `apis` carries only those; a client calls only the APIs its edges carry, by their shares. Each API: `name` (an id), `op` ("read" or "write"), `share` (a weight, default 1), `label`.
- `interRegionMs` — One-way latency of a call between nodes in different regions, ms (default 35). An edge's own latencyMs wins.
- `notes` — sticky notes on the canvas. Each note: `id`, `text`, `pos` ([x, y]), `width` (pixels, optional).

No other fields are allowed, at any level.

## A node (component)

- `id` (required) — unique among the nodes.
- `kind` (required) — one of "client", "dns", "cdn", "api_gateway", "load_balancer", "rate_limiter", "service", "circuit_breaker", "cache", "database", "sharded_db", "queue", "worker", "function", "custom", "object_storage".
- `pos` (required) — [x, y] on the canvas, in pixels.
- `label` — the name shown on the canvas, up to 60 characters.
- `region` — the region (data center) it runs in, an id like "us-east". A call between two regions adds `interRegionMs`.
- `replicaRegion` — database and sharded_db only: the region of the read replicas when it differs.
- `params` — the settings of its kind (below). Parameters go inside `params`, never next to `id` and `kind`.
- `source` — written by the Terraform import (`loadsketch import`): where the component or edge and its values came from. Keep it exactly as it is on everything you keep, also when you change a value (the app marks changed values itself); do not write one on a new component or edge.

## An edge (call)

An edge is a call from `from` to `to` (node ids). The caller waits for the answer: a slow callee keeps the caller busy. Optional `id`; optional `apis` (a list of API names: only requests to those APIs take this edge).

- `source` — written by the Terraform import (`loadsketch import`): where the component or edge and its values came from. Keep it exactly as it is on everything you keep, also when you change a value (the app marks changed values itself); do not write one on a new component or edge.

The first edge from a client is the internet: its `latencyMs` defaults to 20 ms. Other edges default to 0.5 ms (one data center); between regions add 35 ms by default.

Edge parameters, written on the edge itself (not in `params`):

- `on` — Which requests it carries: one of "all" (All), "read" (Reads only), "write" (Writes only), "boot" (Only at boot), "control" (Control plane (metrics, coordination)); default "all". This edge carries reads only, writes only, or both. "Only at boot": a new autoscaled instance calls it once while booting (get config, register, pull the image) and goes live only when every such call succeeds; requests do not take it. "Control plane": the autoscaler, automatic database failover and DNS failover call it before each decision (get metrics, ask a coordination service); when it fails they are blind and do not act this time. Requests do not take it either.
- `weight` — Weight: number 0–1000, default 1. When a node picks one of several edges, it picks by weight.
- `latencyMs` — Network latency (one way): number 0–60000 ms, default 0.5. Edges from Users default to 20 ms (internet), other edges to 0.5 ms (same data center).
- `timeoutMs` — Timeout: number 0–600000 ms, default 0. How long the caller waits at most. 0 means no limit. After a timeout the downstream still finishes the work (wasted).
- `retries` — Retry count: integer 0–10, default 0. Max retries after a failure. Rate limits (429) and an open circuit breaker are not retried.
- `backoffMs` — Retry backoff base: number 0–60000 ms, default 50. Before retry n, wait a random 0 to base × 2^(n−1) ms (full jitter).
- `retryBudget` — Retry budget: number 0–10, default 0. In the last 10 s, how many times the first-call count the retries on this edge can reach (Google suggests 0.1 = 10%). Above that, no retry and the call reports failure right away. 0 means no limit.
- `throttleK` — Adaptive throttling K: number 0–10, default 0. Client-side throttling (Google SRE adaptive throttling). Over the last 10 s the caller counts requests sent and accepts (successes). A new call fails locally, without being sent, with probability max(0, (requests − K × accepts) ÷ (requests + 1)). K = 2 is the book's suggestion; a smaller K rejects earlier. 0 turns it off.
- `bulkhead` — Bulkhead (max concurrent calls): integer 0–100000, default 0. How many calls over this connection each caller instance may have in flight at the same time (a bulkhead). When it is full, the call fails at once (bulkhead full) instead of tying up more threads. So a slow dependency can hold only these slots, not the whole instance. 0 = no limit.
- `hedgeMs` — Hedged request: number 0–600000 ms, default 0. When a read has no reply after this long, send a second copy (hedged request); the first success counts. Usually set to the p95 latency: about 5% more requests cut the tail latency. The losing copy still runs to the end downstream. Reads only (sending a write twice is not safe). 0 means off.
- `fanout` — Fan-out (copies sent at once): integer 0–256, default 0. Send each call to this many copies of the target at once; the call is done when they are back (scatter-gather). Sharded database: this many shards (a search asks every shard). Database: this many of the primary and replicas (a write goes to each copy itself). Other nodes: this many different instances. More than there are means all of them. The more copies, the more likely one is slow, so the tail latency grows. 0 means one copy.
- `quorum` — Quorum (copies to wait for): integer 0–256, default 0. With fan-out, answer as soon as this many copies succeed, without waiting for the rest (a quorum, as in Cassandra or DynamoDB: 2 of 3 copies). When too many fail to reach this number, the call fails. The copies not waited for still run to the end. 0 means wait for all.
- `connectMs` — Connection setup: number 0–60000 ms, default 0. How long opening a new connection takes (TCP + TLS handshakes; across regions often several round trips). A connection stays open for the next call (keep-alive) and closes when idle too long; more calls at once, or the first call after an idle spell, pay this first. 0: not modelled.
- `keepAlive` — Connection reuse (keep-alive): one of "on" (On (keep connections open)), "off" (Off (a new connection per call)); default "on". Off: every call pays the connection setup time. Only works when "Connection setup" is above 0.
- `idleS` — Idle close after: number 0–3600 s, default 60. A connection idle this long is closed; the next call opens a new one. Only works when "Connection setup" is above 0.
- `fallback` — Fallback (degraded response): one of "off" (Off (report the failure upstream)), "on" (On (use a fallback response on failure)); default "off". When a call over this connection finally fails (retries used up, timeout, circuit open, bulkhead full), the caller answers with a fallback response instead (for example a default recommendation list): the request still succeeds, but counts as a degraded response. Use it for dependencies that are not essential.

## How requests flow

- Every request starts at a `client` node and is a read or a write (or a call to one of the `apis`).
- A component with instances (a "station") gives each instance `concurrency` slots. A request takes a free slot or waits in the queue; above `queueLimit` it is rejected. A request keeps its slot while it waits for its downstream calls.
- A `service`, `custom`, `worker` or `function` connected to both a `cache` and a store (`database`, `sharded_db`, `object_storage`) reads cache-aside: the cache first, the store only on a miss; a write goes to the store, then invalidates the cache.
- An edge from a `cache` straight to a store makes it read-through / write-through: on a miss the cache reads the store itself; on a write it writes the store first.
- A `queue` answers its caller at once; `worker` nodes connected after it process the messages and may call stores.
- Use the edge parameter `on` ("read" or "write") to send only reads or only writes along an edge, or `apis` when the design has APIs.

## Components

### `client` — Client

Generates traffic. Set the traffic size in the scenario. With several Users, traffic is split by weight.

Category: Traffic. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `weight` — Traffic weight: number 0–1000, default 1. With several Users nodes, split the scenario total traffic by weight.
- `deadline` — Deadline propagation: one of "off" (Off (each edge keeps its own deadline)), "propagate" (Pass down (like gRPC deadline)); default "off". Pass down: the request carries the time when the user gives up. Each hop waits only until then; a request that has expired is dropped in the queue, so no wasted work; no retries after it expires.
- `priority` — Request priority: one of "critical" (Critical (checkout, login)), "normal" (Normal), "batch" (Batch (batch jobs, crawlers, bots)); default "normal". Which class the requests from this user are. Under overload, a component with a load-shedding threshold drops batch requests first; a rate limiter can also limit batch requests only.

### `dns` — DNS

Turns a domain name into an IP address. Clients cache the answer, so only a few requests wait for a lookup. With several outgoing edges it splits traffic by weight (for example across two regions). With failover on, it removes failed targets from its answer.

Category: Ingress and network. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `lookupMs` — Query time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 20, "cv": 0.5}. Extra query time on a cache miss.
- `resolverCacheHit` — Client cache hit rate: ratio 0–1, default 0.95. Share of requests that do not need a re-query.
- `failover` — DNS failover: one of "off" (Off (always split by weight)), "on" (On (health checks remove failed targets)); default "off". When on, the DNS checks each target (for example each region's load balancer) every second. A target that stays down for the detection time leaves the answer; when it stays up as long, it comes back. Clients cache the old answer, so the move is complete only after the TTL.
- `detectS` — Detection time: number 1–600 s, default 10. How long a target must stay down (or up) before the DNS changes its answer. Only with failover = "on".
- `ttlS` — TTL: number 0–86400 s, default 60. How long clients cache the DNS answer. After the DNS changes its answer, clients that still hold the old one keep sending to the failed target; within the TTL they move to the new answer one by one (a request that misses the client cache looks the name up and gets the new answer at once). A short TTL moves traffic sooner. How many requests look the name up is set by the client cache hit ratio, not by the TTL here. Only with failover = "on".

### `cdn` — CDN

A cache close to users. A read hit is answered right away; only a miss goes to the origin behind it. Writes always go to the origin. Capacity is unlimited.

Category: Ingress and network. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `hitRatio` — Hit rate: ratio 0–1, default 0.8. Share of read requests that hit the CDN.
- `edgeMs` — Edge latency: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 10, "cv": 0.5}. Processing time of the CDN node itself.

### `api_gateway` — API gateway

Front door: validates and routes reads and writes to the backend. It is a proxy, so it holds a slot while it waits for the backend.

Category: Ingress and network. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `instances` — Instances: integer 1–1000, default 2. How many instances run at once. Traffic splits evenly across them.
- `concurrency` — Concurrency per instance: integer 1–100000, default 256. How many requests each instance handles at once (threads, connections or workers). When full, they queue.
- `serviceMs` — Process time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 1, "cv": 0.5}. Time spent on validation and routing.
- `queueLimit` — Max queue: integer 0–10000000, default 1000. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `shedAt` — Load-shedding threshold (drop batch): ratio 0–1, default 0. When one instance's queue reaches "queue limit × this ratio", new "batch" requests are rejected outright (shed), leaving room for normal and critical requests. 0 means no priority split.
- `queueOrder` — Queue order: one of "fifo" (First in, first out (FIFO)), "lifo" (Last in, first out (LIFO)), "adaptive_lifo" (Newest first when congested (adaptive LIFO)); default "fifo". Which queued request to take first. Under overload, the client of the oldest request has usually given up already; serving the newest request first means someone receives the result. Adaptive LIFO: FIFO normally, LIFO when the queue has not emptied for 100 ms.
- `codelTargetMs` — CoDel queue target: number 0–60000 ms, default 0. Controls queueing delay (CoDel, as Facebook does it). If the queue emptied in the last 100 ms, a request may wait at most 100 ms; if it has not (congestion), at most this long. A request over the limit is dropped when its turn comes (CoDel), so no work is wasted. Facebook uses 5 ms. 0 means off.
- `autoscale` — Autoscaling: one of "off" (Off (fixed instances)), "on" (On (scale on busy rate)); default "off". When on, "Instances" is the minimum count. Every so often it checks the average busy rate: too busy adds machines, too idle removes machines. A new machine takes requests only after its boot time, and it is slower right after it comes up (cold start).
- `maxInstances` — Max instances: integer 1–1000, default 10. Upper limit for autoscaling. Only with autoscale = "on".
- `targetUtil` — Target utilization: ratio 0–1, default 0.6. Target average utilization per instance. Instances needed = current instances × utilization ÷ target (no change if within 10%). Only with autoscale = "on".
- `scaleEveryS` — Check interval: number 1–3600 s, default 60. How often to check how busy it is and decide to add or remove. Cloud autoscaling on 1-minute metrics checks about once a minute; the Kubernetes HPA every 15 seconds. Only with autoscale = "on".
- `scaleDownS` — Scale-down window: number 0–3600 s, default 300. To remove instances, every check in this window must need fewer; it then removes down to the most any check in the window needed. Like the Kubernetes HPA scale-down stabilization window (300 seconds by default): it keeps a short dip from removing instances that are needed again right away. 0 means remove as soon as they are not needed. Only with autoscale = "on".
- `bootS` — Boot time: number 0–3600 s, default 120. After deciding to add an instance, how long until it takes requests (start a VM, pull the image, pass the health check). A new VM takes about 1–3 minutes; a container on an existing node only seconds. Only with autoscale = "on".
- `warmS` — Warm-up time: number 0–3600 s, default 20. After a new machine comes up, how long the processing time takes to fall linearly from the cold-start multiplier back to normal (JIT, connection pool, local cache). 0 means no warm-up. Only with autoscale = "on".
- `coldFactor` — Cold start factor: number 1–100, default 3. How many times normal the processing time is when a new machine just comes up. Only with autoscale = "on".

### `load_balancer` — Load balancer

Spreads requests across all instances of all downstream nodes. You can pick a distribution policy. It skips instances it thinks are unhealthy: by default it knows at once which instance is down; you can also use periodic health checks, or eject failing instances from their replies (outlier detection). Capacity is unlimited.

Category: Ingress and network. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `policy` — Distribution policy: one of "round_robin" (Round robin), "least_conn" (Least connections), "p2c" (Pick two at random, take the less busy (power of two)), "random" (Random); default "round_robin". How to pick the next instance.
- `latencyMs` — Forward latency: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 0.3, "cv": 0.3}. Processing time of the LB itself.
- `healthCheck` — Health check: one of "instant" (Instant (idealized)), "liveness" (Liveness (is the process up?)), "deep" (Deep (runs a real request)); default "instant". How the load balancer finds out that an instance is broken. "Instant" is the ideal case. A liveness check only finds crashes; it misses an instance that is alive but slow or failing (a gray failure). A deep check finds failing and too-slow instances.
- `hcIntervalS` — Check interval: number 0.1–600 s, default 5. How often each instance is checked. Only with healthCheck = "liveness" or "deep".
- `hcThreshold` — Checks in a row to switch: integer 1–100, default 2. Failed checks in a row to take an instance out; passed checks in a row to put it back. Only with healthCheck = "liveness" or "deep".
- `hcTimeoutMs` — Check timeout: number 1–600000 ms, default 1000. A deep check with no reply within this time counts as a failure. Only with healthCheck = "deep".
- `outlier` — Outlier detection: one of "off" (Off), "on" (On (outlier detection)); default "off". Watches the replies to real requests: when an instance fails (error, timeout, down) this many times in a row, stop sending to it for a while. At most half of the instances are ejected at the same time.
- `outlierErrors` — Failures in a row to eject: integer 1–1000, default 5. Eject an instance after this many failed requests in a row. Only with outlier = "on".
- `ejectS` — Ejection time: number 0.1–3600 s, default 30. How long until an ejected instance is tried again. Only with outlier = "on".

### `rate_limiter` — Rate limiter

Rate limiting. Token bucket: a fixed number of tokens refills each second, up to the burst allowance; it can also limit the number of requests in flight. Requests over the limit get an immediate 429 (rate_limited). All requests can share one allowance, or each user (tenant) gets its own.

Category: Protection. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `limit` — What it limits: one of "rate" (Requests per second (token bucket)), "concurrency" (Requests being processed at the same time), "both" (Limit both); default "rate". Requests per second blocks traffic that comes too fast; concurrent requests block requests that hold on (like Stripe's concurrency limit), and it blocks first when the downstream slows down.
- `ratePerSec` — Limit per second: number 0–10000000 req/s, default 1000. Requests let through per second, averaged over time.
- `burst` — Burst allowance: integer 1–10000000, default 100. How many tokens the bucket holds, that is how many can pass at one time.
- `maxConcurrent` — Max concurrent: integer 1–10000000, default 100. Max requests that passed the limit and have no response yet.
- `scope` — How the allowance is split: one of "global" (All share one), "per_client" (One per user (tenant)); default "global". One per user: a big customer that uses up its own quota does not eat into anyone else's.
- `appliesTo` — Which requests it limits: one of "all" (All), "batch" (Batch requests only (bot, batch)); default "all". With batch requests only, normal and critical requests pass through.

### `service` — API server

Handles requests, then calls downstream. It keeps its slot while it waits on downstream (like a thread pool), so a slow downstream also makes it queue. When it connects to both the cache and the DB, reads use cache-aside.

Category: Compute. Outgoing edges: Calls its downstreams itself, in order: on a read, a cache and a store together mean cache-aside (cache first, the store only on a miss); on a write, the store first, then the cache is invalidated; other downstreams are called after.

Parameters (in `params`):

- `instances` — Instances: integer 1–1000, default 2. How many instances run at once. Traffic splits evenly across them.
- `concurrency` — Concurrency per instance: integer 1–100000, default 32. How many requests each instance handles at once (threads, connections or workers). When full, they queue.
- `serviceMs` — Process time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 5, "cv": 1}. Own compute time, not counting the wait on downstream.
- `queueLimit` — Max queue: integer 0–10000000, default 500. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `shedAt` — Load-shedding threshold (drop batch): ratio 0–1, default 0. When one instance's queue reaches "queue limit × this ratio", new "batch" requests are rejected outright (shed), leaving room for normal and critical requests. 0 means no priority split.
- `queueOrder` — Queue order: one of "fifo" (First in, first out (FIFO)), "lifo" (Last in, first out (LIFO)), "adaptive_lifo" (Newest first when congested (adaptive LIFO)); default "fifo". Which queued request to take first. Under overload, the client of the oldest request has usually given up already; serving the newest request first means someone receives the result. Adaptive LIFO: FIFO normally, LIFO when the queue has not emptied for 100 ms.
- `codelTargetMs` — CoDel queue target: number 0–60000 ms, default 0. Controls queueing delay (CoDel, as Facebook does it). If the queue emptied in the last 100 ms, a request may wait at most 100 ms; if it has not (congestion), at most this long. A request over the limit is dropped when its turn comes (CoDel), so no work is wasted. Facebook uses 5 ms. 0 means off.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `calls` — How to call the downstream: one of "sequential" (In order (finish one before the next)), "parallel" (Parallel (send at once, wait for all)); default "sequential". With several downstreams, call them in sequence or in parallel.
- `outbox` — Message after write (outbox): one of "off" (Off (save to the database, then send to the queue, as two calls)), "on" (On (transactional outbox)); default "off". When a write saves to a database and sends a message to a queue: off, the two are separate calls, and when one succeeds and the other fails they disagree (dual write). On, the message is written to an outbox table in the same transaction as the data; a relay then sends it to the queue and retries until it gets there. The request succeeds when the database write does.
- `outboxRetryMs` — Outbox retry interval: number 1–600000 ms, default 1000. How long the relay waits after a failed send before it sends again. Only with outbox = "on".
- `autoscale` — Autoscaling: one of "off" (Off (fixed instances)), "on" (On (scale on busy rate)); default "off". When on, "Instances" is the minimum count. Every so often it checks the average busy rate: too busy adds machines, too idle removes machines. A new machine takes requests only after its boot time, and it is slower right after it comes up (cold start).
- `maxInstances` — Max instances: integer 1–1000, default 10. Upper limit for autoscaling. Only with autoscale = "on".
- `targetUtil` — Target utilization: ratio 0–1, default 0.6. Target average utilization per instance. Instances needed = current instances × utilization ÷ target (no change if within 10%). Only with autoscale = "on".
- `scaleEveryS` — Check interval: number 1–3600 s, default 60. How often to check how busy it is and decide to add or remove. Cloud autoscaling on 1-minute metrics checks about once a minute; the Kubernetes HPA every 15 seconds. Only with autoscale = "on".
- `scaleDownS` — Scale-down window: number 0–3600 s, default 300. To remove instances, every check in this window must need fewer; it then removes down to the most any check in the window needed. Like the Kubernetes HPA scale-down stabilization window (300 seconds by default): it keeps a short dip from removing instances that are needed again right away. 0 means remove as soon as they are not needed. Only with autoscale = "on".
- `bootS` — Boot time: number 0–3600 s, default 120. After deciding to add an instance, how long until it takes requests (start a VM, pull the image, pass the health check). A new VM takes about 1–3 minutes; a container on an existing node only seconds. Only with autoscale = "on".
- `warmS` — Warm-up time: number 0–3600 s, default 20. After a new machine comes up, how long the processing time takes to fall linearly from the cold-start multiplier back to normal (JIT, connection pool, local cache). 0 means no warm-up. Only with autoscale = "on".
- `coldFactor` — Cold start factor: number 1–100, default 3. How many times normal the processing time is when a new machine just comes up. Only with autoscale = "on".

### `circuit_breaker` — Circuit breaker

Circuit breaker. If downstream fails too much over a recent window, it opens and later requests fail at once (circuit_open) instead of waiting for downstream. After a while it lets a few requests through as a half-open probe and recovers if they succeed. Usually paired with a timeout on the outgoing edge.

Category: Protection. Outgoing edges: Forwards each request to one of its outgoing edges (by weight; a load balancer picks an instance behind them).

Parameters (in `params`):

- `failureRatio` — Trip threshold: ratio 0–1, default 0.5. The circuit breaker opens when the failure ratio in the stats window is above this value.
- `minCalls` — Min calls: integer 1–100000, default 20. Needs at least this many calls in the window before it decides.
- `windowS` — Stats window: number 1–600 s, default 10. See successes and failures in the last few seconds.
- `openMs` — Open time: number 1–600000 ms, default 5000. How long to wait after it trips before the half-open probe starts.
- `halfOpenCalls` — Probe requests: integer 1–1000, default 5. How many requests to let through in the half-open probe; if all succeed, it closes.

### `cache` — Cache

In-memory cache (like Redis). A hit means no DB query. You can use a fixed hit rate, or let LRU compute the hit rate from the capacity and how hot the keys are. Keys are spread over the instances by hash.

Category: Data. Outgoing edges: Only to stores (database, sharded_db, object_storage), as read-through / write-through: on a miss it reads the store itself and fills the cache; on a write it writes the store first. Without such an edge, a cache calls nothing: a caller that also has a store handles the misses (cache-aside).

Parameters (in `params`):

- `mode` — Hit rate mode: one of "fixed" (Fixed hit rate), "lru" (LRU (computed from capacity and key distribution)); default "fixed". Fixed: each read is decided at random by the hit rate. LRU: it really remembers keys and evicts the least recently used one when full; it starts cold.
- `hitRatio` — Hit rate (fixed mode): ratio 0–1, default 0.9. Share of reads that hit. Only with mode = "fixed".
- `capacityKeys` — Capacity (keys, LRU): integer 1–10000000, default 10000. Max keys stored across all instances. Only with mode = "lru".
- `ttlS` — TTL (LRU): number 0–86400 s, default 0. How long before it expires. 0 means it never expires. Only with mode = "lru".
- `ttlJitter` — TTL jitter: ratio 0–1, default 0. On each write, the TTL is cut by a random share from 0 to this value (0.2 = up to 20% shorter). Keys written at the same time then do not expire and hit the DB at the same time. Only with mode = "lru".
- `stampede` — Stampede protection: one of "none" (None), "coalesce" (Coalesce (read-through)), "lease" (Lease (cache-aside)); default "none". When a hot key expires, many requests miss at once and all read the DB. Coalesce: when the cache reads the DB itself, each key is read once and the other requests wait for the result. Lease: when the service reads the DB, the first miss gets a lease and reads; the others wait a moment and ask the cache again. Only with mode = "lru".
- `leaseMs` — Lease lifetime: number 10–60000 ms, default 2000. The request that holds the lease must write the value back within this time. If it does not, the next miss gets a new lease. Only with stampede = "lease".
- `leaseWaitMs` — Wait before asking again: number 1–5000 ms, default 20. How long a request without the lease waits before it asks the cache again. Only with stampede = "lease".
- `instances` — Instances: integer 1–1000, default 1. How many instances run at once. Traffic splits evenly across them.
- `concurrency` — Concurrency per instance: integer 1–100000, default 8. How many operations each instance handles at once (threads, connections or workers). When full, they queue.
- `opMs` — Operation time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 0.3, "cv": 0.5}. Time for one get/set.
- `queueLimit` — Max queue: integer 0–10000000, default 10000. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.

### `database` — Database

Relational database: one primary plus optional read replicas. Writes go only to the primary; reads go to replicas or the primary as configured. A machine's connection count is how many queries it can handle at once.

Category: Data. Outgoing edges: Ends the request: no outgoing edges.

Parameters (in `params`):

- `replicas` — Replica reads: integer 0–15, default 0. A read-only replica outside the primary. Reads can go to replicas; writes only go to the primary.
- `connections` — Concurrency per instance: integer 1–100000, default 50. How many queries each instance handles at once (threads, connections or workers). When full, they queue.
- `readMs` — Read time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 3, "cv": 1}. Processing time for one read query.
- `writeMs` — Write time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 10, "cv": 1}. Processing time for one write.
- `queueLimit` — Max queue: integer 0–10000000, default 500. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `readFrom` — Read source: one of "replicas" (Replica only (read the primary if there is no replica)), "primary" (Primary only), "any" (Round-robin primary and replica); default "replicas". Where read queries go.
- `replicaApplyRatio` — Replica applies write cost: ratio 0–1, default 0.3. For each write to the primary, every replica also spends "write time × this ratio" applying it. So replicas cannot save write volume. 0 means not counted (and stale reads are not computed).
- `replicaDelayMs` — Replication lag: number 0–600000 ms, default 0. After the primary writes, how long the write takes to reach a replica (network, batched sends). This time plus the replica queue and apply time is the replication lag. Reading a replica during this window gives a stale read.
- `maxLagMs` — Max replication lag: integer 0–3600000 ms, default 0. Reads skip a replica that lags more than this (like a proxy max replication lag check). If all replicas lag too much, read the primary. 0 means no check.
- `localReplicas` — Replicas in the primary's region: integer 0–15, default 0. With a replica region, the first replicas stay in the primary's region and the others go to the replica region. A read goes to a replica in the caller's region first.
- `failover` — Automatic failover: one of "off" (Off (no writes while the primary is down)), "auto" (Automatic (a replica becomes the primary)); default "off". When the primary fails, the replica that is furthest along becomes the primary. Replication is asynchronous: writes the primary acknowledged but had not sent to this replica yet are lost. Needs read replicas and a replica apply cost above 0 (to track replication).
- `failoverS` — Failover time: number 0–3600 s, default 90. How long from a primary failure until a replica takes over: detect, confirm, pick the new primary, reconnect. All writes fail in that time. RDS Multi-AZ instances take about 60–120 seconds; Multi-AZ clusters about 20–35 seconds. Only with failover = "auto".
- `fencing` — Fence the old primary: one of "off" (Off (the old primary still takes writes)), "on" (On (the old primary refuses writes)); default "off". In a network partition, the replicas' side thinks the primary is down and promotes a new one. The old primary still runs, and users on its side still write to it: both sides take writes (split brain), and the data diverges when the partition ends. With fencing (like STONITH or an epoch token), the old primary refuses writes as soon as the new one is up. Only with failover = "auto".
- `readYourWrites` — Read your writes: one of "off" (Off (use the read source)), "primary" (Read the primary for a while after a write); default "off". A user who reads right after writing, from a replica that has not received the write yet, does not see their own write (read-your-writes fails). When on, reads within the window after a write go to the primary. Cost: more reads on the primary.
- `rywWindowMs` — Primary-read window: integer 0–3600000 ms, default 2000. How long after a write the reads go to the primary. Make it longer than the usual replication lag. Only with readYourWrites = "primary".
- `locks` — Row locks: one of "off" (Off (writes never wait for each other)), "row" (Row locks (writes to the same key wait in line)); default "off". A write to a row (a key) must first take that row's lock. Writes to a hot key run one at a time: writes waiting for the lock hold a connection, and latency and queues grow. That key takes at most 1 ÷ (write time + lock hold) writes per second.
- `lockHoldMs` — Lock held after the write: number 0–600000 ms, default 0. How long the transaction keeps the lock after the write before it commits (other queries in the transaction, or the application calls another service inside it). Only with locks = "row".

### `sharded_db` — Sharded database

Data is split over several shards by the hash of the key, and each shard is a primary plus replicas. A hot key makes one shard extra busy (hot spot).

Category: Data. Outgoing edges: Ends the request: no outgoing edges.

Parameters (in `params`):

- `shards` — Shards: integer 1–256, default 4. How many shards the data is split into.
- `replicas` — Replica reads: integer 0–15, default 0. A read-only replica outside the primary. Reads can go to replicas; writes only go to the primary.
- `connections` — Concurrency per instance: integer 1–100000, default 50. How many queries each instance handles at once (threads, connections or workers). When full, they queue.
- `readMs` — Read time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 3, "cv": 1}. Processing time for one read query.
- `writeMs` — Write time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 10, "cv": 1}. Processing time for one write.
- `queueLimit` — Max queue: integer 0–10000000, default 500. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `readFrom` — Read source: one of "replicas" (Replica only (read the primary if there is no replica)), "primary" (Primary only), "any" (Round-robin primary and replica); default "replicas". Where read queries go.
- `replicaApplyRatio` — Replica applies write cost: ratio 0–1, default 0.3. For each write to the primary, every replica also spends "write time × this ratio" applying it. So replicas cannot save write volume. 0 means not counted (and stale reads are not computed).
- `replicaDelayMs` — Replication lag: number 0–600000 ms, default 0. After the primary writes, how long the write takes to reach a replica (network, batched sends). This time plus the replica queue and apply time is the replication lag. Reading a replica during this window gives a stale read.
- `maxLagMs` — Max replication lag: integer 0–3600000 ms, default 0. Reads skip a replica that lags more than this (like a proxy max replication lag check). If all replicas lag too much, read the primary. 0 means no check.
- `localReplicas` — Replicas in the primary's region: integer 0–15, default 0. With a replica region, the first replicas stay in the primary's region and the others go to the replica region. A read goes to a replica in the caller's region first.
- `failover` — Automatic failover: one of "off" (Off (no writes while the primary is down)), "auto" (Automatic (a replica becomes the primary)); default "off". When the primary fails, the replica that is furthest along becomes the primary. Replication is asynchronous: writes the primary acknowledged but had not sent to this replica yet are lost. Needs read replicas and a replica apply cost above 0 (to track replication).
- `failoverS` — Failover time: number 0–3600 s, default 90. How long from a primary failure until a replica takes over: detect, confirm, pick the new primary, reconnect. All writes fail in that time. RDS Multi-AZ instances take about 60–120 seconds; Multi-AZ clusters about 20–35 seconds. Only with failover = "auto".
- `fencing` — Fence the old primary: one of "off" (Off (the old primary still takes writes)), "on" (On (the old primary refuses writes)); default "off". In a network partition, the replicas' side thinks the primary is down and promotes a new one. The old primary still runs, and users on its side still write to it: both sides take writes (split brain), and the data diverges when the partition ends. With fencing (like STONITH or an epoch token), the old primary refuses writes as soon as the new one is up. Only with failover = "auto".
- `readYourWrites` — Read your writes: one of "off" (Off (use the read source)), "primary" (Read the primary for a while after a write); default "off". A user who reads right after writing, from a replica that has not received the write yet, does not see their own write (read-your-writes fails). When on, reads within the window after a write go to the primary. Cost: more reads on the primary.
- `rywWindowMs` — Primary-read window: integer 0–3600000 ms, default 2000. How long after a write the reads go to the primary. Make it longer than the usual replication lag. Only with readYourWrites = "primary".
- `locks` — Row locks: one of "off" (Off (writes never wait for each other)), "row" (Row locks (writes to the same key wait in line)); default "off". A write to a row (a key) must first take that row's lock. Writes to a hot key run one at a time: writes waiting for the lock hold a connection, and latency and queues grow. That key takes at most 1 ÷ (write time + lock hold) writes per second.
- `lockHoldMs` — Lock held after the write: number 0–600000 ms, default 0. How long the transaction keeps the lock after the write before it commits (other queries in the transaction, or the application calls another service inside it). Only with locks = "row".

### `queue` — Queue

Message queue (like SQS, Kafka). It answers as soon as it gets a message, and messages wait in line for workers to take. All workers behind it share the messages.

Category: Async. Outgoing edges: Answers at once and keeps the message; every worker connected after it shares the messages.

Parameters (in `params`):

- `maxDepth` — Max depth: integer 1–100000000, default 100000. How many messages it can hold. When full, writes are rejected (queue_full).
- `enqueueMs` — Write latency: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 2, "cv": 0.5}. Time to write and get an ack.
- `delivery` — Delivery mode: one of "at_most_once" (Delete on delivery (at most once)), "at_least_once" (Delete after done (at-least-once)); default "at_most_once". At most once: if the worker fails or crashes, the message is lost. At least once (like SQS): delete only when the worker succeeds; if it fails or is too slow, the message comes back after the visibility timeout and may be processed twice.
- `visibilityTimeoutMs` — Visibility timeout: integer 1–43200000 ms, default 30000. How long a message stays hidden after it is handed to a worker. If it is not done (or it fails) in that time, the message shows up again for another worker. If this is shorter than the process time, messages get processed twice. Only with delivery = "at_least_once".
- `maxReceives` — Max receive count (DLQ): integer 0–1000, default 0. When a message is taken this many times without success, it moves to the dead-letter queue (DLQ) and is not retried. 0 means no DLQ, so it retries forever. Only with delivery = "at_least_once".
- `messageTtlS` — Message retention: number 0–1209600 s, default 0. Drop a message (expire it) if it is still not processed after this long. 0 means keep it forever.
- `ordering` — Ordering: one of "standard" (Standard (no order)), "fifo" (FIFO (in order per group)); default "standard". FIFO (like SQS FIFO or a Kafka partition): messages of one group (one key) are handed out one at a time; the next one goes only when the previous one is done, dropped or moved to the DLQ. When one is stuck (slow, or a poison message retried again and again), its whole group waits (head-of-line blocking).
- `groups` — Message groups: integer 1–100000, default 16. With FIFO, messages are split into this many groups by key (like message groups or partitions). Fewer groups block each other more often, and also limit how many messages are worked on at once. Only with ordering = "fifo".

### `worker` — Worker

Background worker. It takes messages from the queue in front of it and can call the DB or object storage in turn. Its speed decides whether the queue keeps piling up.

Category: Compute. Outgoing edges: Calls its downstreams itself, in order: on a read, a cache and a store together mean cache-aside (cache first, the store only on a miss); on a write, the store first, then the cache is invalidated; other downstreams are called after.

Parameters (in `params`):

- `instances` — Instances: integer 1–1000, default 2. How many instances run at once. Traffic splits evenly across them.
- `concurrency` — Concurrency per instance: integer 1–100000, default 4. How many messages each instance handles at once (threads, connections or workers). When full, they queue.
- `serviceMs` — Process time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 50, "cv": 1}. Compute time to process one message, not counting the wait on downstream.
- `queueLimit` — Max queue: integer 0–10000000, default 100. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `poisonRate` — Poison message ratio: ratio 0–1, default 0. Share of messages with bad content that fail on every attempt. Use it with the queue's at-least-once setting and the DLQ to see the effect.
- `calls` — How to call the downstream: one of "sequential" (In order), "parallel" (Parallel); default "sequential". With several downstreams, call them in sequence or in parallel.
- `outbox` — Message after write (outbox): one of "off" (Off (save to the database, then send to the queue, as two calls)), "on" (On (transactional outbox)); default "off". When a write saves to a database and sends a message to a queue: off, the two are separate calls, and when one succeeds and the other fails they disagree (dual write). On, the message is written to an outbox table in the same transaction as the data; a relay then sends it to the queue and retries until it gets there. The request succeeds when the database write does.
- `outboxRetryMs` — Outbox retry interval: number 1–600000 ms, default 1000. How long the relay waits after a failed send before it sends again. Only with outbox = "on".
- `autoscale` — Autoscaling: one of "off" (Off (fixed instances)), "on" (On (scale on busy rate)); default "off". When on, "Instances" is the minimum count. Every so often it checks the average busy rate: too busy adds machines, too idle removes machines. A new machine takes requests only after its boot time, and it is slower right after it comes up (cold start).
- `maxInstances` — Max instances: integer 1–1000, default 10. Upper limit for autoscaling. Only with autoscale = "on".
- `targetUtil` — Target utilization: ratio 0–1, default 0.6. Target average utilization per instance. Instances needed = current instances × utilization ÷ target (no change if within 10%). Only with autoscale = "on".
- `scaleEveryS` — Check interval: number 1–3600 s, default 60. How often to check how busy it is and decide to add or remove. Cloud autoscaling on 1-minute metrics checks about once a minute; the Kubernetes HPA every 15 seconds. Only with autoscale = "on".
- `scaleDownS` — Scale-down window: number 0–3600 s, default 300. To remove instances, every check in this window must need fewer; it then removes down to the most any check in the window needed. Like the Kubernetes HPA scale-down stabilization window (300 seconds by default): it keeps a short dip from removing instances that are needed again right away. 0 means remove as soon as they are not needed. Only with autoscale = "on".
- `bootS` — Boot time: number 0–3600 s, default 120. After deciding to add an instance, how long until it takes requests (start a VM, pull the image, pass the health check). A new VM takes about 1–3 minutes; a container on an existing node only seconds. Only with autoscale = "on".
- `warmS` — Warm-up time: number 0–3600 s, default 20. After a new machine comes up, how long the processing time takes to fall linearly from the cold-start multiplier back to normal (JIT, connection pool, local cache). 0 means no warm-up. Only with autoscale = "on".
- `coldFactor` — Cold start factor: number 1–100, default 3. How many times normal the processing time is when a new machine just comes up. Only with autoscale = "on".

### `function` — Function

A serverless function (like AWS Lambda). Each execution environment handles one request at a time. With no free environment it starts a new one (a cold start: that request waits longer); an environment idle for a while is reclaimed. When the environments reach the limit, or new ones would start faster than the scaling rate, new requests are rejected (throttled, 429); messages from a queue stay in the queue.

Category: Compute. Outgoing edges: Calls its downstreams itself, in order: on a read, a cache and a store together mean cache-aside (cache first, the store only on a miss); on a write, the store first, then the cache is invalidated; other downstreams are called after.

Parameters (in `params`):

- `maxConcurrency` — Concurrency limit: integer 1–100000, default 1000. The most execution environments at once (one request each). Past the limit, synchronous calls are rejected (429). An AWS account has 1000 per region by default; reserved concurrency can set it lower.
- `provisioned` — Provisioned environments: integer 0–100000, default 0. Environments ready from the start and never reclaimed (provisioned concurrency). Requests that use them have no cold start. They count toward the concurrency limit.
- `serviceMs` — Process time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 50, "cv": 1}. Its own compute time per request, not counting waits for downstream calls.
- `coldStartMs` — Cold start time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 300, "cv": 0.5}. How long a new environment takes to start (download the code, start the runtime, run the init code). It is part of the latency of the request that started it. Node.js and Python take about 100–500 ms; Java without SnapStart often takes over 1 second.
- `idleS` — Idle reclaim time: number 1–7200 s, default 600. An environment with no request for this long is reclaimed; the next request has a cold start again. AWS does not publish it; in practice about 5–15 minutes.
- `scalePer10s` — Scaling rate (per 10 s): integer 1–100000, default 1000. The most new environments started per 10 seconds. Requests past it are rejected (429). AWS Lambda allows 1000 per function every 10 seconds.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `calls` — How to call the downstream: one of "sequential" (In order), "parallel" (Parallel); default "sequential". With several downstreams, call them in sequence or in parallel.

### `custom` — Custom service

A service the catalog does not have (search, payments, email, an AI model…): you give its name, icon, processing time, capacity, error rate and price. It handles requests, then calls its downstreams, like an API server (connected to both a cache and a DB, reads are cache-aside), but without autoscaling or overload protection. Not allowed in practice problems.

Category: Compute. Outgoing edges: Calls its downstreams itself, in order: on a read, a cache and a store together mean cache-aside (cache first, the store only on a miss); on a write, the store first, then the cache is invalidated; other downstreams are called after.

Parameters (in `params`):

- `icon` — Icon: one of "Box" (Box), "Search" (Search), "CreditCard" (Payment), "Mail" (Email), "Bell" (Notification), "Image" (Image), "ShieldCheck" (Auth), "Bot" (AI model), "Cpu" (Compute), "Workflow" (Workflow); default "Box". The icon on the canvas. Looks only: it does not change the simulation.
- `instances` — Instances: integer 1–1000, default 2. How many instances run at once. Traffic splits evenly across them.
- `concurrency` — Concurrency per instance: integer 1–100000, default 32. How many requests each instance handles at once (threads, connections or workers). When full, they queue.
- `serviceMs` — Process time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 5, "cv": 1}. Own compute time, not counting the wait on downstream.
- `queueLimit` — Max queue: integer 0–10000000, default 500. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.
- `calls` — How to call the downstream: one of "sequential" (In order (finish one before the next)), "parallel" (Parallel (send at once, wait for all)); default "sequential". With several downstreams, call them in sequence or in parallel.
- `pricePerHour` — Price per instance per hour (USD): number 0–1000, default 0.08. For the cost estimate: US dollars for one instance running one hour. The default is the API server's.

### `object_storage` — Object storage

Object storage (like S3). Capacity is huge, but each access is slower. Reads are GET, writes are PUT.

Category: Data. Outgoing edges: Ends the request: no outgoing edges.

Parameters (in `params`):

- `getMs` — GET time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 30, "cv": 0.6}. Time to read one object up to the first byte.
- `putMs` — PUT time: ms: a number (the mean) or {"mean": ms, "cv": 0–4} (cv 0 fixed, 1 exponential), mean up to 600000, default {"mean": 60, "cv": 0.6}. Time to write one object.
- `concurrency` — Concurrency per instance: integer 1–100000, default 2000. How many requests each instance handles at once (threads, connections or workers). When full, they queue.
- `queueLimit` — Max queue: integer 0–10000000, default 10000. How many requests each instance queues. When full, reject right away (queue_full). 0 means no queueing.
- `errorRate` — Error rate: ratio 0–1, default 0. Share of messages that fail at random after processing.

## Example

A complete, valid design:

```json
{
  "schema": "loadsketch/design@1",
  "name": "Web app with a cache",
  "description": "Users call a load balancer; three API servers read through a cache (cache-aside) and write to the database.",
  "nodes": [
    { "id": "users", "kind": "client", "pos": [0, 200] },
    {
      "id": "lb",
      "kind": "load_balancer",
      "label": "Load balancer",
      "pos": [300, 200],
      "params": { "policy": "least_conn" }
    },
    {
      "id": "api",
      "kind": "service",
      "label": "API",
      "pos": [600, 200],
      "params": { "instances": 3, "concurrency": 8, "serviceMs": { "mean": 6, "cv": 1 } }
    },
    {
      "id": "cache",
      "kind": "cache",
      "label": "Redis",
      "pos": [900, 80],
      "params": { "hitRatio": 0.85 }
    },
    {
      "id": "db",
      "kind": "database",
      "label": "Postgres",
      "pos": [900, 320],
      "params": { "connections": 50 }
    }
  ],
  "edges": [
    { "from": "users", "to": "lb" },
    { "from": "lb", "to": "api" },
    { "from": "api", "to": "cache", "timeoutMs": 50 },
    { "from": "api", "to": "db", "timeoutMs": 500, "retries": 1 }
  ]
}

```
