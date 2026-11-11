// M5: the guess log. Each guess is kept with what the run measured; the review counts misses by
// topic and direction and names the patterns; the log goes out and comes back as JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLang, setLang } from '../src/i18n/index.ts';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import type { RunData } from '../src/learn/metrics.ts';
import {
  GUESS_LOG_MAX, GUESS_LOG_SCHEMA, addEntries, entriesForRun, gap, logFile, measuredText, parseLog, patterns, topicStats, type GuessEntry,
} from '../src/learn/guessLog.ts';

const root = join(import.meta.dirname, '..');
const read = <T,>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;

/** One entry: topic, guess index and answer index (options run from low to high). */
const e = (n: number, topic: string, guessIdx: number, answerIdx: number): GuessEntry => ({
  id: `2026-11-09T00:00:${String(n).padStart(2, '0')}.000Z/x/q${n}`,
  at: `2026-11-09T00:00:${String(n).padStart(2, '0')}.000Z`,
  example: 'x',
  question: `q${n}`,
  topic,
  guess: `o${guessIdx}`,
  answer: `o${answerIdx}`,
  guessIdx,
  answerIdx,
  measured: '',
});

describe('guess log', () => {
  it('a retry-storm run logs each answered question with the guess, the answer and what was measured', () => {
    const design = read<Design>('examples/designs/retry-storm.json');
    const scenario = read<Scenario>('examples/scenarios/retry-storm.json');
    const sim = new Simulation(design, scenario);
    const result = sim.runToEnd();
    const run: RunData = { design, scenario, result, windows: sim.allWindows() };
    const lesson = LESSONS['retry-storm'];
    const at = new Date('2026-11-09T01:00:00Z');
    // only the questions with a guess
    const entries = entriesForRun(lesson, { amp: 'x3' }, run, at);
    expect(entries).toHaveLength(1);
    const [x] = entries;
    expect(x).toMatchObject({ example: 'retry-storm', question: 'amp', topic: 'retry', guess: 'x3', guessIdx: 0, at: at.toISOString() });
    // the retry storm amplifies more than 10×: the guess was 2 steps low
    expect(x.answer).toBe('x10');
    expect(gap(x)).toBe(-2);
    expect(x.measured).toBe(lesson.questions.find((q) => q.id === 'amp')!.measured(run));
  });

  it('adding keeps each entry once, oldest first, and drops the oldest past the cap', () => {
    const log = addEntries([e(2, 'retry', 0, 1)], [e(1, 'retry', 0, 0), e(2, 'retry', 0, 1)]);
    expect(log.map((x) => x.question)).toEqual(['q1', 'q2']);
    const many = Array.from({ length: GUESS_LOG_MAX + 5 }, (_, i) => ({ ...e(0, 'cache', 0, 0), id: `id${String(i).padStart(5, '0')}` }));
    const capped = addEntries([], many);
    expect(capped).toHaveLength(GUESS_LOG_MAX);
    expect(capped[0].id).toBe('id00005');
  });

  it('counts by topic, the most missed topic first, misses split into over- and underestimates', () => {
    const log = [e(1, 'cache', 1, 1), e(2, 'retry', 0, 2), e(3, 'retry', 0, 1), e(4, 'retry', 2, 2), e(5, 'queueing', 2, 0)];
    expect(topicStats(log)).toEqual([
      { topic: 'retry', total: 3, right: 1, high: 0, low: 2 },
      { topic: 'queueing', total: 1, right: 0, high: 1, low: 0 },
      { topic: 'cache', total: 1, right: 1, high: 0, low: 0 },
    ]);
  });

  it('names a pattern for a topic missed at least twice, by its main direction', () => {
    expect(patterns([e(1, 'retry', 0, 2), e(2, 'retry', 1, 2), e(3, 'retry', 2, 2)])).toEqual(['「重試放大」常猜得太小：2 次猜錯裡有 2 次低估。']);
    expect(patterns([e(1, 'queueing', 2, 0), e(2, 'queueing', 2, 1)])).toEqual(['「排隊」常猜得太大：2 次猜錯裡有 2 次高估。']);
    expect(patterns([e(1, 'cache', 2, 0), e(2, 'cache', 0, 1)])).toEqual(['「快取」常猜錯：2 次裡錯 2 次，高估、低估都有。']);
    // one miss is not a pattern
    expect(patterns([e(1, 'cache', 2, 0), e(2, 'cache', 1, 1)])).toEqual([]);
  });

  it('exports and imports as JSON; anything else is refused with a reason', () => {
    const log = [e(1, 'retry', 0, 2), e(2, 'cache', 1, 1)];
    const text = logFile(log);
    expect(JSON.parse(text).schema).toBe(GUESS_LOG_SCHEMA);
    expect(parseLog(text)).toEqual({ ok: true, entries: log });
    expect(parseLog('{').ok).toBe(false);
    expect(parseLog(JSON.stringify({ schema: 'other', entries: [] }))).toMatchObject({ ok: false, error: expect.stringContaining(GUESS_LOG_SCHEMA) });
    const broken = JSON.stringify({ schema: GUESS_LOG_SCHEMA, entries: [log[0], { ...log[1], guessIdx: 'x' }] });
    expect(parseLog(broken)).toMatchObject({ ok: false, error: expect.stringContaining('2') });
  });
});

describe('review fixes', () => {
  const design = read<Design>('examples/designs/retry-storm.json');
  const scenario = read<Scenario>('examples/scenarios/retry-storm.json');
  const sim = new Simulation(design, scenario);
  const result = sim.runToEnd();
  const run: RunData = { design, scenario, result, windows: sim.allWindows() };
  const [x] = entriesForRun(LESSONS['retry-storm'], { amp: 'x3' }, run, new Date('2026-11-09T01:00:00Z'));

  it('what the run measured is kept in both languages and shown in the current one', () => {
    expect(x.measuredIn?.['zh-TW']).toMatch(/倍/);
    expect(x.measuredIn?.en).not.toMatch(/[一-鿿]/);
    try {
      setLang('en');
      expect(measuredText(x)).toBe(x.measuredIn!.en);
    } finally {
      setLang('zh-TW');
    }
    expect(getLang()).toBe('zh-TW');
    // an old entry without it shows what it has
    expect(measuredText({ measured: '舊的' })).toBe('舊的');
  });

  it('an import must fit the lesson: option places out of range or wrong are refused', () => {
    const file = (en: GuessEntry) => logFile([en]);
    expect(parseLog(file(x), LESSONS).ok).toBe(true);
    expect(parseLog(file({ ...x, guessIdx: 300 }), LESSONS)).toMatchObject({ ok: false, error: expect.stringContaining('1') });
    expect(parseLog(file({ ...x, answerIdx: x.guessIdx }), LESSONS).ok).toBe(false);
    // an example named like an Object member is refused with a reason, not a crash
    for (const name of ['constructor', 'toString', '__proto__']) expect(parseLog(file({ ...x, example: name }), LESSONS)).toMatchObject({ ok: false });
    expect(parseLog(file({ ...x, question: 'nope' }), LESSONS).ok).toBe(false);
  });
});
