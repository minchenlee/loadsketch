// Log-bucketed latency histogram. Relative error of a reported percentile is below ~0.5%.

const MIN_MS = 0.001;
const GROWTH = 1.01;
const LOG_G = Math.log(GROWTH);
const BUCKETS = Math.ceil(Math.log(1e7 / MIN_MS) / LOG_G) + 2; // 1 µs .. ~2.8 hours

export interface LatencySummary {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

export class Histogram {
  private counts = new Uint32Array(BUCKETS);
  private lo = BUCKETS;
  private hi = -1;
  count = 0;
  sum = 0;
  max = 0;

  add(ms: number): void {
    const v = ms < MIN_MS ? MIN_MS : ms;
    let i = Math.floor(Math.log(v / MIN_MS) / LOG_G);
    if (i >= BUCKETS) i = BUCKETS - 1;
    this.counts[i]++;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  /** p in [0, 1]. Returns 0 when empty. */
  quantile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil(p * this.count));
    let acc = 0;
    for (let i = this.lo; i <= this.hi; i++) {
      acc += this.counts[i];
      if (acc >= rank) {
        // midpoint of the bucket in log space
        const v = MIN_MS * Math.pow(GROWTH, i + 0.5);
        return Math.min(v, this.max);
      }
    }
    return this.max;
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      mean: this.count ? this.sum / this.count : 0,
      p50: this.quantile(0.5),
      p90: this.quantile(0.9),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      p999: this.quantile(0.999),
      max: this.max,
    };
  }

  reset(): void {
    if (this.hi >= this.lo) this.counts.fill(0, this.lo, this.hi + 1);
    this.lo = BUCKETS;
    this.hi = -1;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
}
