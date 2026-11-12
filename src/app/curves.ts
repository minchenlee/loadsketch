// The charts of runs this tab finished (roadmap-next M14 B): the compare view uses them instead of
// running those versions again. Kept in memory only: not in localStorage, not in an exported file or
// a share link. A curve belongs to one version (by id) and to the run it came from (design and
// scenario); a curve whose version is gone, or whose run is not the version's run, is not used.
import type { Design, Scenario } from '../schema/design.ts';
import type { Again, CompareItem, RunSeries } from './compare.ts';

/** At most this many curves; a new one beyond it drops the oldest. */
export const MAX_CURVES = 8;

type Run = { design: Design; scenario: Scenario };
type Kept = { id: string; run: string; series: RunSeries };

/** The same text for the same run (sameRun() in versions.ts compares the same way). */
const runKey = (r: Run) => `${JSON.stringify(r.design)}\n${JSON.stringify(r.scenario)}`;

export class Curves {
  /** Newest first. */
  private list: Kept[] = [];

  /** Keeps the curve of version `id`, made by the run `run`. */
  put(id: string, run: Run, series: RunSeries): void {
    const key = runKey(run);
    this.list = [{ id, run: key, series }, ...this.list.filter((k) => k.id !== id && k.run !== key)].slice(0, MAX_CURVES);
  }

  /** The curve of version `id`, when it came from the run `run`; else undefined (run it again). */
  get(id: string, run: Run): RunSeries | undefined {
    const k = this.list.find((x) => x.id === id);
    return k && k.run === runKey(run) ? k.series : undefined;
  }

  /**
   * Follows the version list after a change: a curve goes with its run when the version got another
   * id (a version of the same run, a new id on a replay); a curve with no version of its run goes.
   */
  follow(versions: (Run & { id: string })[]): void {
    if (!this.list.length) return;
    const byId = new Map(versions.map((v) => [v.id, v]));
    let keys: Map<string, string> | undefined;
    this.list = this.list.flatMap((k) => {
      const v = byId.get(k.id);
      if (v && runKey(v) === k.run) return [k];
      keys ??= new Map(versions.map((x) => [runKey(x), x.id]));
      const id = keys.get(k.run);
      return id === undefined ? [] : [{ ...k, id }];
    });
  }

  /** The version ids with a curve, newest first. */
  ids(): string[] {
    return this.list.map((k) => k.id);
  }

  clear(): void {
    this.list = [];
  }
}

/** This tab's curves. */
export const curves = new Curves();

/**
 * What the compare view has without a run again: for each item, its saved summary with the curve this
 * tab kept for it; undefined where the item runs again (no curve, another run, or no summary).
 */
export function keptRuns(items: CompareItem[], c: Curves = curves): (Again | undefined)[] {
  return items.map((x) => {
    const series = x.summary ? c.get(x.key, x) : undefined;
    return series && x.summary ? { summary: x.summary, series } : undefined;
  });
}
