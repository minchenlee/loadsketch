// The guess log in the Learn tab (M5, Q14=A): the patterns the learner often gets wrong, counts by
// topic, every guess with what the run measured, and export / import as JSON (Q13=A).
import { useMemo, useRef, useState } from 'react';
import { Download, Upload, Trash2 } from 'lucide-react';
import { useApp } from '../store.ts';
import { LESSONS } from '../../learn/lessons.ts';
import { COURSE_BY_ID } from '../../learn/course.ts';
import { TOPICS, gap, lessonOfEntry, logFile, measuredText, parseLog, patterns, topicStats, type GuessEntry } from '../../learn/guessLog.ts';
import { t } from '../../i18n/index.ts';

/** The question and option texts of an entry (ids when the lesson no longer has them). */
function texts(e: GuessEntry): { q: string; guess: string; answer: string } {
  const q = lessonOfEntry(e, LESSONS, COURSE_BY_ID)?.questions.find((x) => x.id === e.question);
  const opt = (id: string) => {
    const o = q?.options.find((x) => x.id === id);
    return o ? t(o.text) : id;
  };
  return { q: q ? t(q.text) : `${e.example} / ${e.question}`, guess: opt(e.guess), answer: opt(e.answer) };
}

function gapText(e: GuessEntry): string {
  const g = gap(e);
  if (g === 0) return t('Right');
  return g > 0 ? t('{n} too high', { n: g }) : t('{n} too low', { n: -g });
}

export function GuessLog({ className = '' }: { className?: string }) {
  const log = useApp((s) => s.guessLog);
  const importLog = useApp((s) => s.importGuessLog);
  const clear = useApp((s) => s.clearGuessLog);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const stats = useMemo(() => topicStats(log), [log]);
  const pats = useMemo(() => patterns(log), [log]);
  const right = log.filter((e) => gap(e) === 0).length;

  const exportLog = () => {
    const url = URL.createObjectURL(new Blob([logFile(log)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'loadsketch-guess-log.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const r = parseLog(await f.text(), LESSONS, COURSE_BY_ID);
    if (!r.ok) setMsg({ ok: false, text: r.error });
    else {
      // new ids that the log kept (a full log drops its oldest entries, so lengths do not tell)
      const before = new Set(log.map((e) => e.id));
      importLog(r.entries);
      const after = new Set(useApp.getState().guessLog.map((e) => e.id));
      const added = new Set(r.entries.filter((e) => !before.has(e.id) && after.has(e.id)).map((e) => e.id)).size;
      setMsg({ ok: true, text: t('Imported {n} entries, {k} new.', { n: r.entries.length, k: added }) });
    }
    if (file.current) file.current.value = '';
  };

  return (
    <section className={className} data-testid="guess-log">
      <div className="text-[15px] font-semibold">{t('Guess log')}</div>
      {log.length === 0 ? (
        <div className="faint mt-0.5 text-[13px]">{t('No guesses yet. In an example with questions, guess first, then run. Each guess and the actual result are kept in this browser on this computer.')}</div>
      ) : (
        <>
          <div className="mt-0.5 text-[14px]" data-testid="guess-summary">
            {t('{n} guesses, {k} right.', { n: log.length, k: right })}
          </div>
          {pats.length > 0 && (
            <ul className="mt-1.5 space-y-1" data-testid="guess-patterns" aria-label={t('Patterns you often get wrong')}>
              {pats.map((p) => (
                <li key={p} className="text-[14px] leading-snug" style={{ color: 'var(--warn-ink)' }}>
                  {p}
                </li>
              ))}
            </ul>
          )}
          <table className="mt-2 w-full text-[13px]" data-testid="guess-topics">
            <thead className="faint text-left">
              <tr>
                <th className="font-medium">{t('Topic')}</th>
                <th className="num text-right font-medium">{t('Guesses')}</th>
                <th className="num text-right font-medium">{t('Right')}</th>
                <th className="num text-right font-medium">{t('Too high')}</th>
                <th className="num text-right font-medium">{t('Too low')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.topic}>
                  <td>{t(TOPICS[s.topic] ?? TOPICS.other)}</td>
                  <td className="num text-right">{s.total}</td>
                  <td className="num text-right">{s.right}</td>
                  <td className="num text-right">{s.high}</td>
                  <td className="num text-right">{s.low}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="mt-2 text-[13px] underline decoration-dotted underline-offset-2" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('Hide each guess') : t('Show each guess')}
          </button>
          {open && (
            <ol className="mt-1 space-y-1.5" data-testid="guess-entries">
              {[...log].reverse().map((e) => {
                const x = texts(e);
                return (
                  <li key={e.id} className="text-[13px] leading-snug" data-testid="guess-entry">
                    <div className="faint num">{new Date(e.at).toLocaleString()}</div>
                    <div>{x.q}</div>
                    <div>
                      {t('You guessed: {g}; actual: {a} ({m})', { g: x.guess, a: x.answer, m: measuredText(e) })}
                      <span className="ml-1 font-medium" style={{ color: gap(e) === 0 ? 'var(--ok-ink)' : 'var(--bad-ink)' }}>
                        {gapText(e)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className="btn text-[13px]" onClick={exportLog} disabled={!log.length} data-testid="guess-export">
          <Download size={13} /> {t('Export JSON')}
        </button>
        <button type="button" className="btn text-[13px]" onClick={() => file.current?.click()} data-testid="guess-import">
          <Upload size={13} /> {t('Import JSON')}
        </button>
        {log.length > 0 &&
          (confirm ? (
            <button
              type="button"
              className="btn text-[13px]"
              style={{ color: 'var(--bad-ink)' }}
              onClick={() => {
                clear();
                setConfirm(false);
                setMsg(null);
              }}
              onBlur={() => setConfirm(false)}
              data-testid="guess-clear-confirm"
            >
              <Trash2 size={13} /> {t('Clear the whole log')}
            </button>
          ) : (
            <button type="button" className="btn text-[13px]" onClick={() => setConfirm(true)} data-testid="guess-clear">
              <Trash2 size={13} /> {t('Clear')}
            </button>
          ))}
        <input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label={t('Choose a guess log file')} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="guess-file" />
      </div>
      {msg && (
        <div className="mt-1 text-[13px]" style={{ color: msg.ok ? 'var(--ok-ink)' : 'var(--bad-ink)' }} role="status">
          {msg.text}
        </div>
      )}
    </section>
  );
}
