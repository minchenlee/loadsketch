// The guess log in the Learn tab (M5, Q14=A): the patterns the learner often gets wrong, counts by
// topic, every guess with what the run measured, and export / import as JSON (Q13=A).
import { useMemo, useRef, useState } from 'react';
import { Download, Upload, Trash2 } from 'lucide-react';
import { useApp } from '../store.ts';
import { LESSONS } from '../../learn/lessons.ts';
import { TOPICS, gap, logFile, measuredText, parseLog, patterns, topicStats, type GuessEntry } from '../../learn/guessLog.ts';
import { t } from '../../i18n/index.ts';

/** The question and option texts of an entry (ids when the lesson no longer has them). */
function texts(e: GuessEntry): { q: string; guess: string; answer: string } {
  const q = LESSONS[e.example]?.questions.find((x) => x.id === e.question);
  const opt = (id: string) => {
    const o = q?.options.find((x) => x.id === id);
    return o ? t(o.text) : id;
  };
  return { q: q ? t(q.text) : `${e.example} / ${e.question}`, guess: opt(e.guess), answer: opt(e.answer) };
}

function gapText(e: GuessEntry): string {
  const g = gap(e);
  if (g === 0) return t('猜對');
  return g > 0 ? t('高估 {n} 格', { n: g }) : t('低估 {n} 格', { n: -g });
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
    const r = parseLog(await f.text(), LESSONS);
    if (!r.ok) setMsg({ ok: false, text: r.error });
    else {
      // new ids that the log kept (a full log drops its oldest entries, so lengths do not tell)
      const before = new Set(log.map((e) => e.id));
      importLog(r.entries);
      const after = new Set(useApp.getState().guessLog.map((e) => e.id));
      const added = new Set(r.entries.filter((e) => !before.has(e.id) && after.has(e.id)).map((e) => e.id)).size;
      setMsg({ ok: true, text: t('匯入 {n} 筆，新增 {k} 筆。', { n: r.entries.length, k: added }) });
    }
    if (file.current) file.current.value = '';
  };

  return (
    <section className={className} data-testid="guess-log">
      <div className="text-[15px] font-semibold">{t('先猜紀錄')}</div>
      {log.length === 0 ? (
        <div className="faint mt-0.5 text-[13px]">{t('還沒有紀錄。在有題目的範例先猜、再執行，每次猜測和實際結果都會記在這台電腦的瀏覽器裡。')}</div>
      ) : (
        <>
          <div className="mt-0.5 text-[14px]" data-testid="guess-summary">
            {t('猜了 {n} 次，猜對 {k} 次。', { n: log.length, k: right })}
          </div>
          {pats.length > 0 && (
            <ul className="mt-1.5 space-y-1" data-testid="guess-patterns" aria-label={t('常猜錯的模式')}>
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
                <th className="font-medium">{t('主題')}</th>
                <th className="num text-right font-medium">{t('次數')}</th>
                <th className="num text-right font-medium">{t('猜對')}</th>
                <th className="num text-right font-medium">{t('高估')}</th>
                <th className="num text-right font-medium">{t('低估')}</th>
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
            {open ? t('收起每次的紀錄') : t('看每次的紀錄')}
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
                      {t('你猜：{g}；實際：{a}（{m}）', { g: x.guess, a: x.answer, m: measuredText(e) })}
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
          <Download size={13} /> {t('匯出 JSON')}
        </button>
        <button type="button" className="btn text-[13px]" onClick={() => file.current?.click()} data-testid="guess-import">
          <Upload size={13} /> {t('匯入 JSON')}
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
              <Trash2 size={13} /> {t('確定清除全部紀錄')}
            </button>
          ) : (
            <button type="button" className="btn text-[13px]" onClick={() => setConfirm(true)} data-testid="guess-clear">
              <Trash2 size={13} /> {t('清除')}
            </button>
          ))}
        <input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label={t('選先猜紀錄檔')} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="guess-file" />
      </div>
      {msg && (
        <div className="mt-1 text-[13px]" style={{ color: msg.ok ? 'var(--ok-ink)' : 'var(--bad-ink)' }} role="status">
          {msg.text}
        </div>
      )}
    </section>
  );
}
