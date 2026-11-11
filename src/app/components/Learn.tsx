// The learning layer in the side panel: guess before the run, "why it broke" after it,
// and challenges judged on every run of a lesson's example.
import { useEffect, useMemo } from 'react';
import { CircleCheck, CircleX, Lightbulb, Trophy } from 'lucide-react';
import { EXAMPLES, SCENARIOS, useApp } from '../store.ts';
import { diagnose } from '../../learn/diagnose.ts';
import { judge, sameScenario, type Challenge, type Lesson } from '../../learn/lesson.ts';
import { LESSONS } from '../../learn/lessons.ts';
import type { RunData } from '../../learn/metrics.ts';
import { t } from '../../i18n/index.ts';
import { SlaSection } from './Sla.tsx';
import { CostSection } from './Constraints.tsx';
import { useCauseHidden } from './OnCall.tsx';

/** Each part of the lesson is its own block, divided by a line. */
const SECTION = 'border-t border-[var(--line)] pt-3 mt-4 first:mt-0 first:border-t-0 first:pt-0';

const sec = (s: number) => t('第 {s} 秒', { s: Math.round(s * 10) / 10 });

/** The finished run, when there is one: what ran, not what the canvas shows now. */
function useRun(): RunData | null {
  const result = useApp((s) => s.result);
  const ran = useApp((s) => s.ran);
  const windows = useApp((s) => s.windows);
  const status = useApp((s) => s.status);
  return useMemo(() => (result && ran && status === 'done' ? { design: ran.design, scenario: ran.scenario, result, windows } : null), [result, ran, windows, status]);
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="text-[15px] font-semibold">{children}</div>;
}

function Questions({ lesson, run }: { lesson: Lesson; run: RunData | null }) {
  const guesses = useApp((s) => s.guesses);
  const setGuess = useApp((s) => s.setGuess);
  const status = useApp((s) => s.status);
  // a guess is made before the first run: once one has started, the choice is locked
  const locked = useApp((s) => s.ran !== null);
  return (
    <section className={SECTION} data-testid="quiz">
      <Heading>{t('先猜，再執行')}</Heading>
      {!run && <div className="faint mt-0.5 text-[13px]">{status === 'idle' ? t('選一個答案，再按「執行」。跑完就揭曉。') : t('跑完就揭曉。')}</div>}
      {lesson.questions.map((q) => {
        const answer = run ? q.answer(run) : null;
        const mine = guesses[q.id];
        return (
          <div key={q.id} className="mt-2">
            <div className="text-[14px] leading-snug">{t(q.text)}</div>
            <div className="mt-1 flex flex-col gap-1">
              {q.options.map((o) => {
                const right = answer === o.id;
                const wrong = answer !== null && mine === o.id && !right;
                return (
                  <button
                    key={o.id}
                    className={`btn justify-start text-left text-[14px] ${mine === o.id ? 'btn-on' : ''}`}
                    onClick={() => setGuess(q.id, o.id)}
                    disabled={locked}
                    aria-pressed={mine === o.id}
                    data-testid={`guess-${q.id}-${o.id}`}
                  >
                    {right && <CircleCheck size={14} className="shrink-0" style={{ color: 'var(--ok)' }} aria-label={t('答案')} />}
                    {wrong && <CircleX size={14} className="shrink-0" style={{ color: 'var(--bad)' }} aria-label={t('你猜的')} />}
                    <span>{t(o.text)}</span>
                  </button>
                );
              })}
            </div>
            {run && (
              <div className="mt-1 text-[14px] leading-snug" data-testid={`answer-${q.id}`}>
                <div className="font-medium">
                  {mine === undefined ? t('實際：{m}', { m: q.measured(run) }) : mine === answer ? t('猜對了。實際：{m}', { m: q.measured(run) }) : t('猜錯了。實際：{m}', { m: q.measured(run) })}
                </div>
                <div className="muted mt-0.5">{t((answer !== null && q.explainFor?.[answer]) || q.explain)}</div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Why({ run }: { run: RunData }) {
  const story = useMemo(() => diagnose(run), [run]);
  if (!story.length) return null;
  const told = new Set<string>();
  return (
    <section className={SECTION} data-testid="why">
      <Heading>{t('為什麼會這樣')}</Heading>
      <ol className="mt-1 space-y-1.5">
        {story.map((s, i) => {
          const why = s.why && !told.has(s.why) ? s.why : undefined;
          if (why) told.add(why);
          return (
            <li key={i} className="flex gap-2 text-[14px] leading-snug">
              <span className="num faint w-[60px] shrink-0">{sec(s.t)}</span>
              <span>
                <span style={s.kind === 'stuck' ? { color: 'var(--bad-ink)' } : s.kind === 'recover' ? { color: 'var(--ok-ink)' } : undefined}>{s.text}</span>
                {why && <span className="muted mt-0.5 block">{why}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ChallengeCard({ c, run, scenarioOk, done }: { c: Challenge; run: RunData | null; scenarioOk: boolean; done: boolean }) {
  const example = useApp((s) => s.example);
  const v = useMemo(() => (run && scenarioOk && example ? judge(c, run, EXAMPLES[example]) : null), [c, run, scenarioOk, example]);
  return (
    <div className="card mt-2 p-2 text-[14px] leading-snug" data-testid={`challenge-${c.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t(c.title)}</span>
        {done && (
          <span className="flex items-center gap-1 text-[13px]" style={{ color: 'var(--ok-ink)' }}>
            <Trophy size={12} />
            {t('已過關')}
          </span>
        )}
      </div>
      <div className="muted mt-0.5">{t(c.text)}</div>
      {v && (
        <ul className="mt-1.5 space-y-0.5">
          {v.goals.map((g, i) => (
            <li key={i} className="flex gap-1.5">
              {g.ok ? <CircleCheck size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> : <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />}
              <span>
                {g.text}
                <span className="num faint">{t('（這次：{v}）', { v: g.value })}</span>
              </span>
            </li>
          ))}
          {v.broken.map((b, i) => (
            <li key={`r${i}`} className="flex gap-1.5">
              <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} />
              <span>{t('不符合規則：{why}', { why: b })}</span>
            </li>
          ))}
        </ul>
      )}
      {v?.passed && (
        <div className="mt-1.5 font-medium" style={{ color: 'var(--ok-ink)' }} data-testid="passed">
          {t('過關！')}
        </div>
      )}
      {c.rules.map((r, i) => (
        <div key={i} className="faint mt-1 text-[13px]" title={t(r.text)}>
          {t('規則：{r}', { r: t(r.short) })}
        </div>
      ))}
      <details className="mt-1">
        <summary className="muted flex cursor-pointer items-center gap-1 text-[13px]">
          <Lightbulb size={12} />
          {t('提示')}
        </summary>
        <div className="muted mt-0.5 text-[13px]">{t(c.hint)}</div>
      </details>
    </div>
  );
}

function Challenges({ lesson, run }: { lesson: Lesson; run: RunData | null }) {
  const passed = useApp((s) => s.passed);
  const want = SCENARIOS[lesson.scenario];
  const scenarioOk = !run || lessonScenario(lesson, run);
  return (
    <section className={SECTION} data-testid="challenges">
      <Heading>{t('挑戰')}</Heading>
      <div className="faint mt-0.5 text-[13px]">{t('改設計、按「執行」，每次跑完都會自動判定。')}</div>
      {[...new Map(lesson.challenges.flatMap((c) => c.rules).map((r) => [r.short, r])).values()].map((r) => (
        <div key={r.short} className="muted mt-1 text-[13px] leading-snug">
          <span className="font-medium">{t(r.short)}</span>
          {t('：{text}', { text: t(r.text) })}
        </div>
      ))}
      {!scenarioOk && want && <div className="mt-1 text-[14px]" style={{ color: 'var(--warn-ink)' }}>{t('情境改過了：換回「{name}」才算數。', { name: t(want.name ?? lesson.scenario) })}</div>}
      {lesson.challenges.map((c) => (
        <ChallengeCard key={c.id} c={c} run={run} scenarioOk={scenarioOk} done={passed.includes(c.id)} />
      ))}
    </section>
  );
}

const lessonScenario = (lesson: Lesson, run: RunData) => {
  const want = SCENARIOS[lesson.scenario];
  return want !== undefined && sameScenario(run.scenario, want);
};

/**
 * Judges the challenges of every finished lesson run and saves the passed ones. Always mounted,
 * so a run counts while the Learn tab is closed.
 */
export function LessonJudge(): null {
  const example = useApp((s) => s.example);
  const markPassed = useApp((s) => s.markPassed);
  const run = useRun();
  useEffect(() => {
    const lesson = example ? LESSONS[example] : undefined;
    if (!lesson || !run || !example || !lessonScenario(lesson, run)) return;
    markPassed(lesson.challenges.filter((c) => judge(c, run, EXAMPLES[example]).passed).map((c) => c.id));
  }, [example, run, markPassed]);
  return null;
}

/** Questions before the run (a lesson's example), the story after it (any design), then challenges. */
export function Learn() {
  const example = useApp((s) => s.example);
  const lesson = example ? LESSONS[example] : undefined;
  const run = useRun();
  const hidden = useCauseHidden();
  if (!lesson && !run)
    return (
      <div>
        <div className="muted text-[14px] leading-relaxed">{t('按「執行」。跑完後，這裡會顯示 SLA、成本，並照時間說明發生了什麼。範例的題目和挑戰目前只有「重試風暴」有；限制條件題目、值班練習和先猜紀錄在上方的「練習」。')}</div>
      </div>
    );
  return (
    <div>
      {lesson && <Questions lesson={lesson} run={run} />}
      {run && <SlaSection run={run} />}
      {run && <CostSection run={run} />}
      {run && !hidden && <Why run={run} />}
      {run && hidden && <div className="faint mt-4 text-[13px]" data-testid="why-hidden">{t('值班練習中：發生了什麼，送出答案後才看得到。')}</div>}
      {lesson && <Challenges lesson={lesson} run={run} />}
    </div>
  );
}
