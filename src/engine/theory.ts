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
