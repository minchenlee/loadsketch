// Queueing-theory reference values, shown next to simulated numbers and used in tests.

/** Erlang C: probability that an arrival must wait in an M/M/c queue with offered load a = λ/μ. */
export function erlangC(c: number, a: number): number {
  if (c <= 0) return 1;
  const rho = a / c;
  if (rho >= 1) return 1;
  // Erlang B by the stable recurrence, then convert to C.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b / (1 - rho + rho * b);
}

export interface QueueTheory {
  /** Utilisation per server: λ·E[S] / c. */
  rho: number;
  /** Probability of waiting (Erlang C). 1 when unstable. */
  pWait: number;
  /** Mean wait in queue (ms), M/M/c. Infinity when unstable. */
  waitMsMMc: number;
  /** Mean wait in queue (ms), Allen–Cunneen correction for general service times. */
  waitMs: number;
  /** Mean time in system (ms) = wait + service. */
  sojournMs: number;
  stable: boolean;
}

/**
 * M/G/c approximation.
 * @param lambdaPerMs arrival rate per millisecond
 * @param meanServiceMs mean service (or hold) time in ms
 * @param c servers
 * @param cs2 squared coefficient of variation of service time (1 for exponential)
 * @param ca2 squared coefficient of variation of inter-arrival time (1 for Poisson)
 */
export function mgc(lambdaPerMs: number, meanServiceMs: number, c: number, cs2 = 1, ca2 = 1): QueueTheory {
  const a = lambdaPerMs * meanServiceMs;
  const rho = c > 0 ? a / c : Infinity;
  if (!(rho < 1)) {
    return { rho, pWait: 1, waitMsMMc: Infinity, waitMs: Infinity, sojournMs: Infinity, stable: false };
  }
  const pWait = erlangC(c, a);
  const waitMsMMc = (pWait * meanServiceMs) / (c * (1 - rho));
  const waitMs = waitMsMMc * ((ca2 + cs2) / 2);
  return { rho, pWait, waitMsMMc, waitMs, sojournMs: waitMs + meanServiceMs, stable: true };
}

/** M/M/1 time in system is exponential with rate μ − λ. */
export function mm1SojournQuantileMs(lambdaPerMs: number, muPerMs: number, p: number): number {
  if (lambdaPerMs >= muPerMs) return Infinity;
  return -Math.log(1 - p) / (muPerMs - lambdaPerMs);
}

/** M/M/1 timeout probability when timeout is t ms (sojourn time ~ Exp(μ − λ)). */
export function mm1TimeoutProb(lambdaPerMs: number, muPerMs: number, timeoutMs: number): number {
  if (timeoutMs <= 0) return 1;
  if (lambdaPerMs >= muPerMs) return 1;
  return Math.exp(-(muPerMs - lambdaPerMs) * timeoutMs);
}

/** M/M/c/K blocking probability P(K in system) for c servers, total capacity K = c + queueLimit, offered load a = λ/μ. */
export function mmckBlocking(c: number, K: number, a: number): number {
  if (c <= 0 || K < c) return 1;
  if (a <= 0) return 0;
  let w = 1;
  let sum = 1;
  for (let n = 1; n <= K; n++) {
    w *= a / Math.min(n, c);
    sum += w;
    if (w > 1e100 || sum > 1e100) {
      w /= 1e100;
      sum /= 1e100;
    }
  }
  return w / sum;
}

/** Expected total attempts per request when each attempt fails independently with probability p and up to maxRetries retries are sent. */
export function retryAmplification(p: number, maxRetries: number): number {
  if (maxRetries <= 0 || p <= 0) return 1;
  if (p >= 1) return maxRetries + 1;
  return (1 - Math.pow(p, maxRetries + 1)) / (1 - p);
}

/** End-to-end failure probability when each attempt fails independently with probability p and up to maxRetries retries are sent. */
export function retryFailureRate(p: number, maxRetries: number): number {
  return Math.pow(Math.max(0, Math.min(1, p)), maxRetries + 1);
}

function bisectRoot(fn: (x: number) => number, lo: number, hi: number, label: string): number {
  const fLo = fn(lo);
  if (fLo === 0) return lo;
  const fHi = fn(hi);
  if (fHi === 0) return hi;
  if (!(fLo < 0 && fHi > 0)) throw new Error(`${label}: failed to bracket root (${lo}..${hi})`);
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi || hi - lo <= 1e-15 * mid) return mid;
    const v = fn(mid);
    if (v === 0) return mid;
    if (v < 0) lo = mid;
    else hi = mid;
  }
  throw new Error(`${label}: bisection did not converge (${lo}..${hi})`);
}

/**
 * Exact E_k/M/1 queueing probability and mean wait (ms) for Erlang-k arrivals (e.g. round-robin
 * splitting of a Poisson stream across k servers) with exponential service rate μ.
 */
export function ekm1Wait(k: number, lambdaPerMs: number, muPerMs: number): { pWait: number; waitMs: number } {
  if (!(k >= 1) || !(muPerMs > 0) || lambdaPerMs < 0) {
    throw new Error(`ekm1Wait: invalid parameters (k=${k}, lambda=${lambdaPerMs}, mu=${muPerMs})`);
  }
  const rho = lambdaPerMs / muPerMs;
  if (rho >= 1) return { pWait: 1, waitMs: Infinity };
  if (rho <= 0) return { pWait: 0, waitMs: 0 };
  if (k === 1) return { pWait: rho, waitMs: rho / (muPerMs * (1 - rho)) };

  // Split at sigma = 0.5 so small pWait keeps full relative precision in sigma in [0, 0.5]
  // while near-saturated rho -> 1 keeps full precision in u = 1 - sigma in (0, 0.5].
  const f = (s: number): number => Math.exp(-k * Math.log1p((1 - s) / (k * rho)));
  const fHalf = f(0.5);
  if (fHalf === 0.5) return { pWait: 0.5, waitMs: 1 / muPerMs };

  if (fHalf < 0.5) {
    const g0 = f(0);
    if (g0 === 0) return { pWait: 0, waitMs: 0 };
    const negG = (s: number): number => s - f(s);
    let lo = 0;
    let hi = g0;
    if (negG(hi) < 0) {
      lo = hi;
      hi = Math.min(0.5, hi * 2);
      while (hi < 0.5 && negG(hi) < 0) {
        lo = hi;
        hi = Math.min(0.5, hi * 2);
      }
    }
    const sigma = bisectRoot(negG, lo, hi, `ekm1Wait(k=${k}, rho=${rho})`);
    return { pWait: sigma, waitMs: sigma / (muPerMs * (1 - sigma)) };
  }

  const h = (u: number): number => Math.expm1(-k * Math.log1p(u / (k * rho))) + u;
  let lo = Math.min(0.25, (1 - rho) * 0.5);
  for (let i = 0; i < 60 && h(lo) > 0; i++) lo *= 0.5;
  const u = bisectRoot(h, lo, 0.5, `ekm1Wait(k=${k}, rho=${rho})`);
  const sigma = 1 - u;
  return { pWait: sigma, waitMs: sigma / (muPerMs * u) };
}
