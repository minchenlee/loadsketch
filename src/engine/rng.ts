// Seeded random numbers. Every stream is derived from (seed, label), so two designs run with the
// same scenario see the same arrivals, request classes and keys ("common random numbers").

export type Rng = () => number; // uniform in [0, 1)

/** 32-bit FNV-1a with a salt; used only to derive seeds. */
function fnv1a(str: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** sfc32: small, fast, passes PractRand for the lengths we need. */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number, label: string): Rng {
  const s = `${seed}:${label}`;
  const r = sfc32(fnv1a(s, 1), fnv1a(s, 2), fnv1a(s, 3), fnv1a(s, 4));
  for (let i = 0; i < 15; i++) r(); // warm up the state
  return r;
}

/** Exponential with the given mean. */
export function sampleExp(r: Rng, mean: number): number {
  return -Math.log(1 - r()) * mean;
}

/** Standard normal (Box–Muller, no caching to keep streams simple). */
function sampleNormal(r: Rng): number {
  const u = 1 - r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape k, scale 1) by Marsaglia–Tsang. */
function sampleGammaShape(r: Rng, k: number): number {
  if (k < 1) {
    // Boost: Gamma(k) = Gamma(k + 1) * U^(1/k)
    const g = sampleGammaShape(r, k + 1);
    return g * Math.pow(1 - r(), 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - r();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * A positive duration with the given mean and coefficient of variation (cv = sd / mean).
 * cv = 0: always the mean. cv = 1: exponential. Otherwise gamma with shape 1/cv².
 */
export function sampleDuration(r: Rng, mean: number, cv: number): number {
  if (mean <= 0) return 0;
  if (cv <= 0) return mean;
  if (cv === 1) return sampleExp(r, mean);
  const k = 1 / (cv * cv);
  return sampleGammaShape(r, k) * (mean / k);
}

/**
 * Keys 0..n-1 with P(k) ∝ 1 / (k + 1)^s. s = 0 is uniform. Key 0 is the most popular.
 * Uses a precomputed CDF (n ≤ 1e6 keeps it under 8 MB).
 */
export class KeySampler {
  private cdf: Float64Array | null = null;
  readonly n: number;
  constructor(n: number, s: number) {
    this.n = Math.max(1, Math.floor(n));
    if (s > 0 && this.n > 1) {
      const cdf = new Float64Array(this.n);
      let acc = 0;
      for (let k = 0; k < this.n; k++) {
        acc += 1 / Math.pow(k + 1, s);
        cdf[k] = acc;
      }
      for (let k = 0; k < this.n; k++) cdf[k] /= acc;
      this.cdf = cdf;
    }
  }
  sample(r: Rng): number {
    const u = r();
    if (!this.cdf) return Math.floor(u * this.n);
    const cdf = this.cdf;
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Spread keys over n buckets so popular (small) keys do not all land in bucket 0. */
export function keyBucket(key: number, n: number): number {
  if (n <= 1) return 0;
  return (Math.imul(key + 1, 0x9e3779b1) >>> 0) % n;
}
