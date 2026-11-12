---
name: loadsketch
description: "Edit or create a system design for loadsketch (https://loadsketch.mclee.dev), a simulator for system designs. Use when the user wants to change, build or fix a loadsketch design (a JSON file whose schema is loadsketch/design@1), or asks for an architecture they will paste into loadsketch."
---

# loadsketch

loadsketch simulates a system design: components, the calls between them, and the traffic sent through them. The user works on the canvas of the web app; you work on the design JSON.

## Steps

1. Get the design JSON. If the user has not given it, ask for it: in loadsketch, File → "Paste design JSON" → "Copy only the design JSON", or File → "Save as JSON". A path to a saved `.json` file works too. To start from nothing, write a new design.
2. Before you set or add a component of a kind, read that kind's section in reference.md in this folder: the section whose heading names the kind (for example the one for `cache`). It lists the parameters, their limits and defaults. If reference.md is not there, read https://loadsketch.mclee.dev/skills/loadsketch/reference.md.
3. Change the design as the user asks, following the rules below. Change only what was asked. Keep the ids and the `source` fields of everything you keep.
4. Check your answer: every field is allowed, every edge points to existing node ids, and every parameter is inside the limits in reference.md.
5. Give back the whole design as one ```json code block (or write it to the file the user named). Say in a few lines what you changed and why.
6. Tell the user to paste it back: in loadsketch, File → "Paste design JSON", paste, look at the list of changes, and click "Replace the canvas". If the app says something is wrong, fix what it names and give the whole design again.

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

The kinds, with what each does. Their parameters (inside `params`) are in reference.md, one section per kind (also at https://loadsketch.mclee.dev/skills/loadsketch/reference.md).

- `client` — Client: Generates traffic. Set the traffic size in the scenario. With several Users, traffic is split by weight.
- `dns` — DNS: Turns a domain name into an IP address. Clients cache the answer, so only a few requests wait for a lookup. With several outgoing edges it splits traffic by weight (for example across two regions). With failover on, it removes failed targets from its answer.
- `cdn` — CDN: A cache close to users. A read hit is answered right away; only a miss goes to the origin behind it. Writes always go to the origin. Capacity is unlimited.
- `api_gateway` — API gateway: Front door: validates and routes reads and writes to the backend. It is a proxy, so it holds a slot while it waits for the backend.
- `load_balancer` — Load balancer: Spreads requests across all instances of all downstream nodes. You can pick a distribution policy. It skips instances it thinks are unhealthy: by default it knows at once which instance is down; you can also use periodic health checks, or eject failing instances from their replies (outlier detection). Capacity is unlimited.
- `rate_limiter` — Rate limiter: Rate limiting. Token bucket: a fixed number of tokens refills each second, up to the burst allowance; it can also limit the number of requests in flight. Requests over the limit get an immediate 429 (rate_limited). All requests can share one allowance, or each user (tenant) gets its own.
- `service` — API server: Handles requests, then calls downstream. It keeps its slot while it waits on downstream (like a thread pool), so a slow downstream also makes it queue. When it connects to both the cache and the DB, reads use cache-aside.
- `circuit_breaker` — Circuit breaker: Circuit breaker. If downstream fails too much over a recent window, it opens and later requests fail at once (circuit_open) instead of waiting for downstream. After a while it lets a few requests through as a half-open probe and recovers if they succeed. Usually paired with a timeout on the outgoing edge.
- `cache` — Cache: In-memory cache (like Redis). A hit means no DB query. You can use a fixed hit rate, or let LRU compute the hit rate from the capacity and how hot the keys are. Keys are spread over the instances by hash.
- `database` — Database: Relational database: one primary plus optional read replicas. Writes go only to the primary; reads go to replicas or the primary as configured. A machine's connection count is how many queries it can handle at once.
- `sharded_db` — Sharded database: Data is split over several shards by the hash of the key, and each shard is a primary plus replicas. A hot key makes one shard extra busy (hot spot).
- `queue` — Queue: Message queue (like SQS, Kafka). It answers as soon as it gets a message, and messages wait in line for workers to take. All workers behind it share the messages.
- `worker` — Worker: Background worker. It takes messages from the queue in front of it and can call the DB or object storage in turn. Its speed decides whether the queue keeps piling up.
- `function` — Function: A serverless function (like AWS Lambda). Each execution environment handles one request at a time. With no free environment it starts a new one (a cold start: that request waits longer); an environment idle for a while is reclaimed. When the environments reach the limit, or new ones would start faster than the scaling rate, new requests are rejected (throttled, 429); messages from a queue stay in the queue.
- `custom` — Custom service: A service the catalog does not have (search, payments, email, an AI model…): you give its name, icon, processing time, capacity, error rate and price. It handles requests, then calls its downstreams, like an API server (connected to both a cache and a DB, reads are cache-aside), but without autoscaling or overload protection. Not allowed in practice problems.
- `object_storage` — Object storage: Object storage (like S3). Capacity is huge, but each access is slower. Reads are GET, writes are PUT.

## Example

A small, valid design:

```json
{
  "schema": "loadsketch/design@1",
  "name": "API with a database",
  "nodes": [
    { "id": "users", "kind": "client", "pos": [0, 200] },
    {
      "id": "api",
      "kind": "service",
      "label": "API",
      "pos": [300, 200],
      "params": { "instances": 1, "concurrency": 16, "serviceMs": { "mean": 8, "cv": 1 } }
    },
    { "id": "db", "kind": "database", "label": "Postgres", "pos": [600, 200] }
  ],
  "edges": [{ "from": "users", "to": "api" }, { "from": "api", "to": "db", "timeoutMs": 500 }]
}

```
