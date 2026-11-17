// Course progress, kept in this browser (localStorage). Every read and write is guarded: a private
// window or full storage leaves the progress for this page only, and a broken saved value reads as
// no progress.
export const PROGRESS_KEY = 'loadsketch-course';

export interface LessonProgress {
  /** Index of the step the learner is on. */
  step: number;
  /** The furthest step reached. */
  reached: number;
  /** Guesses by question id. Locked once a run has answered them. */
  guesses: Record<string, string>;
  /** A run has answered the guesses. */
  answered: boolean;
  /** Ids of the challenges passed. */
  passed: string[];
  /** The last step was reached. */
  done: boolean;
}

export type Progress = Record<string, LessonProgress>;

export const EMPTY: LessonProgress = { step: 0, reached: 0, guesses: {}, answered: false, passed: [], done: false };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const nat = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : 0);

/** One lesson's saved progress; anything malformed reads as the empty default. */
function clean(x: unknown): LessonProgress {
  if (!isObj(x)) return { ...EMPTY };
  const guesses: Record<string, string> = {};
  if (isObj(x.guesses)) for (const [k, v] of Object.entries(x.guesses)) if (typeof v === 'string') guesses[k] = v;
  const step = nat(x.step);
  return {
    step,
    reached: Math.max(step, nat(x.reached)),
    guesses,
    answered: x.answered === true,
    passed: Array.isArray(x.passed) ? x.passed.filter((p): p is string => typeof p === 'string') : [],
    done: x.done === true,
  };
}

export function parseProgress(text: string | null): Progress {
  if (!text) return {};
  try {
    const j = JSON.parse(text) as unknown;
    if (!isObj(j) || j.format !== 'loadsketch/course-progress@1' || !isObj(j.lessons)) return {};
    return Object.fromEntries(Object.entries(j.lessons).map(([k, v]) => [k, clean(v)]));
  } catch {
    return {};
  }
}

export function loadProgress(): Progress {
  try {
    return parseProgress(localStorage.getItem(PROGRESS_KEY));
  } catch {
    return {};
  }
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ format: 'loadsketch/course-progress@1', lessons: p }));
  } catch {
    // private window or full storage: the progress lives until the page closes
  }
}
