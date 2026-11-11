// Guess log: every guess made before a run, with what the run measured, kept in this browser
// (Q13=A). The review (Q14=A) lists the guesses and counts the misses by topic and direction, so
// the learner sees a blind spot ("I keep guessing retries amplify less than they do").
// Pure functions; the store does the storage.

import type { Lesson, Question } from './lesson.ts';
import type { RunData } from './metrics.ts';
import { LANGS, getLang, setLang, t, tx, type Lang } from '../i18n/index.ts';

export const GUESS_LOG_SCHEMA = 'loadsketch/guess-log@1';
export const GUESS_LOG_KEY = 'loadsketch-guess-log';
/** Oldest entries go when the log is longer. */
export const GUESS_LOG_MAX = 2000;

/** Topics of the questions (message ids). */
export const TOPICS: Record<string, string> = {
  retry: tx('重試放大'),
  queueing: tx('排隊'),
  cache: tx('快取'),
  capacity: tx('容量'),
  recovery: tx('恢復'),
  other: tx('其他'),
};

export interface GuessEntry {
  /** Unique: run time + question. */
  id: string;
  /** ISO time the run ended. */
  at: string;
  example: string;
  question: string;
  topic: string;
  /** Option ids, and their place in the question's order (options run from low to high). */
  guess: string;
  answer: string;
  guessIdx: number;
  answerIdx: number;
  /** What the run measured, as shown with the answer (in the language of the run). */
  measured: string;
  /** The same in each language, so the log follows a language change. */
  measuredIn?: Partial<Record<Lang, string>>;
}

/** What the run measured, in the current language when the entry has it. */
export const measuredText = (e: Pick<GuessEntry, 'measured' | 'measuredIn'>): string => e.measuredIn?.[getLang()] ?? e.measured;

/** `f()` in each language (the current one is restored after). */
function inEachLang(f: () => string): Partial<Record<Lang, string>> {
  const cur = getLang();
  const out: Partial<Record<Lang, string>> = {};
  try {
    for (const l of LANGS) {
      setLang(l);
      out[l] = f();
    }
  } finally {
    setLang(cur);
  }
  return out;
}

export interface GuessLogFile {
  schema: typeof GUESS_LOG_SCHEMA;
  entries: GuessEntry[];
}

/** How far off a guess was: 0 right; above 0 the guess was higher than the answer, below 0 lower. */
export const gap = (e: Pick<GuessEntry, 'guessIdx' | 'answerIdx'>): number => e.guessIdx - e.answerIdx;

/** The entries for one finished run: one per question the learner answered. */
export function entriesForRun(lesson: Lesson, guesses: Record<string, string>, run: RunData, at: Date): GuessEntry[] {
  const out: GuessEntry[] = [];
  for (const q of lesson.questions) {
    const guess = guesses[q.id];
    if (guess === undefined) continue;
    const answer = q.answer(run);
    const idx = (id: string) => q.options.findIndex((o) => o.id === id);
    out.push({
      id: `${at.toISOString()}/${lesson.example}/${q.id}`,
      at: at.toISOString(),
      example: lesson.example,
      question: q.id,
      topic: topicOf(q),
      guess,
      answer,
      guessIdx: idx(guess),
      answerIdx: idx(answer),
      measured: q.measured(run),
      measuredIn: inEachLang(() => q.measured(run)),
    });
  }
  return out;
}

const topicOf = (q: Question): string => (q.topic && TOPICS[q.topic] ? q.topic : 'other');

/** The log with new entries added (same id: kept once), oldest first, at most GUESS_LOG_MAX. */
export function addEntries(log: GuessEntry[], add: GuessEntry[]): GuessEntry[] {
  const byId = new Map(log.map((e) => [e.id, e]));
  for (const e of add) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return all.slice(Math.max(0, all.length - GUESS_LOG_MAX));
}

const isEntry = (x: unknown): x is GuessEntry => {
  const e = x as Record<string, unknown>;
  return (
    !!e && typeof e === 'object' &&
    ['id', 'at', 'example', 'question', 'topic', 'guess', 'answer', 'measured'].every((k) => typeof e[k] === 'string') &&
    Number.isInteger(e.guessIdx) && Number.isInteger(e.answerIdx) &&
    !Number.isNaN(Date.parse(e.at as string)) &&
    (e.measuredIn === undefined || (typeof e.measuredIn === 'object' && e.measuredIn !== null && Object.values(e.measuredIn).every((v) => typeof v === 'string')))
  );
};

/** The entry fits the lesson's question: the option ids exist and sit at the places it says. */
function fitsLesson(e: GuessEntry, lessons: Record<string, Lesson>): boolean {
  // own keys only: an example named like an Object member ("constructor") is not a lesson
  const q = Object.hasOwn(lessons, e.example) ? lessons[e.example].questions.find((x) => x.id === e.question) : undefined;
  if (!q) return false;
  const at = (id: string) => q.options.findIndex((o) => o.id === id);
  return at(e.guess) === e.guessIdx && at(e.answer) === e.answerIdx && e.guessIdx >= 0 && e.answerIdx >= 0;
}

/** Entries from stored or imported JSON; anything else gives an error message. */
/** With `lessons` (an import): every entry must fit a question of these lessons. */
export function parseLog(text: string, lessons?: Record<string, Lesson>): { ok: true; entries: GuessEntry[] } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: t('不是 JSON。') };
  }
  const f = v as Partial<GuessLogFile>;
  if (!f || f.schema !== GUESS_LOG_SCHEMA || !Array.isArray(f.entries)) return { ok: false, error: t('不是先猜紀錄檔（schema 應該是 {s}）。', { s: GUESS_LOG_SCHEMA }) };
  const bad = f.entries.findIndex((e) => !isEntry(e));
  if (bad >= 0) return { ok: false, error: t('第 {n} 筆紀錄格式不對。', { n: bad + 1 }) };
  if (lessons) {
    const off = (f.entries as GuessEntry[]).findIndex((e) => !fitsLesson(e, lessons));
    if (off >= 0) return { ok: false, error: t('第 {n} 筆紀錄對不上現有的題目或選項。', { n: off + 1 }) };
  }
  return { ok: true, entries: f.entries as GuessEntry[] };
}

export function logFile(entries: GuessEntry[]): string {
  const f: GuessLogFile = { schema: GUESS_LOG_SCHEMA, entries };
  return JSON.stringify(f, null, 2) + '\n';
}

export interface TopicStat {
  topic: string;
  total: number;
  right: number;
  /** Misses where the guess was higher (overestimate) or lower (underestimate) than the answer. */
  high: number;
  low: number;
}

/** Counts by topic, the topics with the most misses first. */
export function topicStats(entries: GuessEntry[]): TopicStat[] {
  const m = new Map<string, TopicStat>();
  for (const e of entries) {
    const s = m.get(e.topic) ?? { topic: e.topic, total: 0, right: 0, high: 0, low: 0 };
    s.total++;
    const g = gap(e);
    if (g === 0) s.right++;
    else if (g > 0) s.high++;
    else s.low++;
    m.set(e.topic, s);
  }
  return [...m.values()].sort((a, b) => b.total - b.right - (a.total - a.right) || b.total - a.total || (a.topic < b.topic ? -1 : 1));
}

/**
 * The patterns worth a sentence: a topic missed at least twice, mostly in one direction (two
 * thirds of its misses or more). Message text, translated.
 */
export function patterns(entries: GuessEntry[]): string[] {
  const out: string[] = [];
  for (const s of topicStats(entries)) {
    const miss = s.high + s.low;
    if (miss < 2) continue;
    const topic = t(TOPICS[s.topic] ?? TOPICS.other);
    if (s.low * 3 >= miss * 2) out.push(t('「{topic}」常猜得太小：{n} 次猜錯裡有 {k} 次低估。', { topic, n: miss, k: s.low }));
    else if (s.high * 3 >= miss * 2) out.push(t('「{topic}」常猜得太大：{n} 次猜錯裡有 {k} 次高估。', { topic, n: miss, k: s.high }));
    else out.push(t('「{topic}」常猜錯：{total} 次裡錯 {n} 次，高估、低估都有。', { topic, total: s.total, n: miss }));
  }
  return out;
}
