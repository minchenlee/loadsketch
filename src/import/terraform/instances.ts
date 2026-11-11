// Instance types -> size (vCPU, memory) and the performance assumptions the importer fills in
//. Size is written down by AWS (evidence `aws-default`, with a source);
// the assumptions are ours (evidence `estimate`) and the answer file overrides them.
// The table is "family x size" instead of a list: AWS sizes follow the same steps in every family
// listed here (large = 2 vCPU, xlarge = 4 …; memory per vCPU is set by the family).

export interface Size { vcpu: number; memoryGiB: number; source: string }

const EC2_DOCS = 'https://docs.aws.amazon.com/ec2/latest/instancetypes';
const CACHE_DOCS = 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html';
const RDS_DOCS = 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html';

/** GiB per vCPU, and the EC2 docs page that lists the family. */
const FAMILIES: Record<string, { perVcpu: number; page: string }> = {};
for (const f of ['m5', 'm5a', 'm6i', 'm6a', 'm6g', 'm7i', 'm7a', 'm7g', 'm8g']) FAMILIES[f] = { perVcpu: 4, page: 'gp.html' };
for (const f of ['c5', 'c5a', 'c6i', 'c6a', 'c6g', 'c7i', 'c7a', 'c7g', 'c8g']) FAMILIES[f] = { perVcpu: 2, page: 'co.html' };
for (const f of ['r5', 'r5a', 'r6i', 'r6a', 'r6g', 'r7i', 'r7a', 'r7g', 'r8g']) FAMILIES[f] = { perVcpu: 8, page: 'mo.html' };
const SIZES: Record<string, number> = { large: 2, xlarge: 4, '2xlarge': 8, '4xlarge': 16, '8xlarge': 32, '12xlarge': 48, '16xlarge': 64 };
/** Burstable (t3, t3a, t4g): vCPU and GiB per size. */
const BURSTABLE: Record<string, [number, number]> = { nano: [2, 0.5], micro: [2, 1], small: [2, 2], medium: [2, 4], large: [2, 8], xlarge: [4, 16], '2xlarge': [8, 32] };

/** `m6i.large`, `db.t3.medium` -> size; undefined for a type the table does not know. */
export function sizeOf(instanceType: string): Size | undefined {
  const db = instanceType.startsWith('db.');
  const cache = instanceType.startsWith('cache.');
  const m = /^(?:db\.|cache\.)?([a-z]+\d+[a-z]*)\.([a-z0-9]+)$/.exec(instanceType);
  if (!m) return undefined;
  const [, family, size] = m;
  if (/^t(3|3a|4g)$/.test(family)) {
    const b = BURSTABLE[size];
    return b ? { vcpu: b[0], memoryGiB: b[1], source: db ? RDS_DOCS : cache ? CACHE_DOCS : `${EC2_DOCS}/gp.html (${instanceType})` } : undefined;
  }
  const f = FAMILIES[family];
  const vcpu = SIZES[size];
  if (!f || !vcpu) return undefined;
  return { vcpu, memoryGiB: vcpu * f.perVcpu, source: db ? RDS_DOCS : cache ? CACHE_DOCS : `${EC2_DOCS}/${f.page} (${instanceType})` };
}

/** An ECS task's size from its cpu units and memory (MiB): 1024 units = 1 vCPU (written in the IaC). */
export const taskSize = (cpuUnits: number, memoryMiB: number) => ({ vcpu: cpuUnits / 1024, memoryGiB: memoryMiB / 1024 });

/** Our estimates (evidence `estimate`). Sources for the shape, not the numbers: a CPU-bound handler
 *  slows down below 1 vCPU; a database runs about 4 queries at once per vCPU. */
export const ASSUME = {
  service: (vcpu: number) => ({ concurrency: Math.max(1, Math.round(16 * vcpu)), serviceMs: round(5 * Math.max(1, 1 / vcpu)) }),
  database: (vcpu: number) => ({ connections: Math.max(1, Math.round(4 * vcpu)), readMs: round(3 * Math.max(1, 2 / vcpu)), writeMs: round(10 * Math.max(1, 2 / vcpu)) }),
  /** A function's handler time from its memory: Lambda gives a full vCPU at 1769 MB and CPU in
   *  proportion below that (https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html). */
  function: (memoryMiB: number) => ({ serviceMs: round(20 * Math.max(1, 1769 / memoryMiB)) }),
  /** A cache node: about 2 operations at once per vCPU (Redis runs commands on one thread). */
  cache: (vcpu: number) => ({ concurrency: Math.max(2, Math.round(2 * vcpu)), opMs: 0.3 }),
  /** DynamoDB is managed: many requests at once, single-digit ms. */
  dynamodb: { connections: 1000, readMs: 5, writeMs: 10 },
  /** Database connections each caller instance keeps open (its pool), when the answer file does not say. */
  poolPerInstance: 10,
  /** A function environment serves one request at a time, so it keeps about one connection. */
  poolPerFunction: 1,
  /** Attempts an AWS SDK makes for one call in the standard retry mode (https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html). */
  sdkAttempts: 3,
  /** Share of instance memory RDS keeps for the OS and the engine (our estimate; AWS does not publish it). */
  osReserve: 0.08,
};
const round = (x: number) => Math.round(x * 100) / 100;

const LIMITS = 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.MaxConnections';
/** RDS default max_connections, from DBInstanceClassMemory (bytes): PostgreSQL LEAST(m/9531392, 5000),
 *  MySQL and MariaDB m/12582880. undefined for other engines, Aurora MySQL included (its default
 *  is another formula, not checked here): the checks then say incomplete instead of a wrong number. */
export function maxConnections(engine: string, memoryBytes: number): { value: number; source: string } | undefined {
  if (/^(aurora-)?postgres/.test(engine)) return { value: Math.min(Math.floor(memoryBytes / 9531392), 5000), source: `${LIMITS} (PostgreSQL: LEAST({DBInstanceClassMemory/9531392}, 5000))` };
  if (/^(mysql|mariadb)/.test(engine)) return { value: Math.floor(memoryBytes / 12582880), source: `${LIMITS} (MySQL/MariaDB: {DBInstanceClassMemory/12582880})` };
  return undefined;
}
