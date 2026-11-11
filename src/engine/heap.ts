// Min-heap of timed callbacks. Ties are broken by insertion order, so runs are deterministic.

export interface TimedEvent {
  t: number;
  s: number;
  f: () => void;
}

export class EventQueue {
  private h: TimedEvent[] = [];
  private seq = 0;

  get size(): number {
    return this.h.length;
  }

  push(t: number, f: () => void): void {
    const e: TimedEvent = { t, s: this.seq++, f };
    const h = this.h;
    let i = h.length;
    h.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      const q = h[p];
      if (q.t < e.t || (q.t === e.t && q.s < e.s)) break;
      h[i] = q;
      i = p;
    }
    h[i] = e;
  }

  peekTime(): number {
    return this.h.length ? this.h[0].t : Infinity;
  }

  pop(): TimedEvent | undefined {
    const h = this.h;
    const n = h.length;
    if (n === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (n > 1) {
      let i = 0;
      const m = n - 1;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= m) break;
        const r = l + 1;
        let c = l;
        if (r < m) {
          const a = h[l];
          const b = h[r];
          if (b.t < a.t || (b.t === a.t && b.s < a.s)) c = r;
        }
        const x = h[c];
        if (last.t < x.t || (last.t === x.t && last.s < x.s)) break;
        h[i] = x;
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
}
