import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';

/**
 * Plain design text (a description or a note) laid out for reading in the narrow side panel:
 * a "label:" prefix becomes a heading, "1) … 2) …" becomes a numbered list, URLs become short
 * links, and the sources of a description go in a list below it. The text itself is not changed.
 */

const URL_RE = /https?:\/\/[^\s，、。）)]+/g;
const LABEL_RE = /^(試試看|簡化|Try it|Try this|Simplified)[:：]\s*/;
const SOURCES_RE = /(?:^|[\s。.])(?:來源|Sources?)[:：]\s*/;

/** The host of a URL without "www.", as the text of its link. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Text with each URL as a short link. */
export function Linked({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,]+$/, '');
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(
      <a key={m.index} href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2" title={url}>
        {host(url)}
      </a>,
    );
    at = m.index + url.length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** "1) a 2) b 3) c" → ['a', 'b', 'c'] when every number marker runs 1, 2, 3… in order; otherwise null. */
export function splitSteps(text: string): { lead: string; steps: string[] } | null {
  const run = [...text.matchAll(/(^|[\s。.:：])(\d{1,2})\)\s+/g)];
  if (run.length < 2 || run.some((m, i) => Number(m[2]) !== i + 1)) return null;
  const start = (m: RegExpMatchArray) => m.index! + m[1].length;
  const steps = run.map((m, i) => text.slice(m.index! + m[0].length, i + 1 < run.length ? start(run[i + 1]) : undefined).trim());
  return { lead: text.slice(0, start(run[0])).trim(), steps };
}

/**
 * The action of a step ("what to change") and what happens: up to the first colon, else the first
 * sentence; a short step without either is all action.
 */
export function splitAction(text: string): { action: string; rest: string } {
  // the first colon that is not inside a URL (https://host:8080/a:b)
  // a URL does not end in punctuation: "see https://x.io/a: it…" ends the action after /a
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].replace(/[:：.,;!?]+$/, '').length]);
  for (const m of text.matchAll(/[：:]/g)) {
    const at = m.index!;
    if (at > 200) break;
    if (at < 1 || urls.some(([a, b]) => at >= a && at < b)) continue;
    const end = at + 1;
    return { action: text.slice(0, end), rest: text.slice(end).trimStart() };
  }
  const sentence = /^(.{2,140}?(?:[。！？]|[.!?](?=\s)))\s*/.exec(text);
  if (sentence) return { action: sentence[1], rest: text.slice(sentence[0].length) };
  return text.length <= 140 ? { action: text, rest: '' } : { action: '', rest: text };
}

/** The space between the action and the rest: one after ASCII punctuation, none after CJK punctuation. */
export function stepGap(action: string, rest: string): string {
  return action && rest && /[:.!?]$/.test(action) ? ' ' : '';
}

function Step({ text }: { text: string }) {
  const { action, rest } = splitAction(text);
  const gap = stepGap(action, rest);
  return (
    <>
      {action && <span className="font-semibold" style={{ color: 'var(--ink)' }}><Linked text={action} /></span>}
      {gap}
      {rest && <Linked text={rest} />}
    </>
  );
}

/** A design note: an optional heading, then a paragraph or numbered steps. */
export function NoteText({ text }: { text: string }) {
  const label = LABEL_RE.exec(text);
  const body = label ? text.slice(label[0].length) : text;
  const steps = splitSteps(body);
  return (
    <>
      {label && <div className="mb-1 text-[13px] font-semibold tracking-wide">{label[1]}</div>}
      {steps ? (
        <>
          {steps.lead && <p className="mb-1.5"><Linked text={steps.lead} /></p>}
          <ol className="space-y-2">
            {steps.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="num mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  {i + 1}
                </span>
                <span className="min-w-0"><Step text={s} /></span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="whitespace-pre-line"><Linked text={body} /></p>
      )}
    </>
  );
}

/**
 * The sources part of a description: each URL with the words that name it ("（talk at QCon）" after
 * it, or "the lease paper:" before it), and the sentence after the last URL as a closing line.
 */
export function splitSources(text: string): { body: string; sources: { url: string; note: string }[]; tail: string } {
  const m = SOURCES_RE.exec(text);
  if (!m) return { body: text, sources: [], tail: '' };
  const body = text.slice(0, m.index + (/[。.]/.test(m[0][0]) ? 1 : 0)).trim();
  const rest = text.slice(m.index + m[0].length);
  const urls = [...rest.matchAll(URL_RE)];
  if (urls.length === 0) return { body: text, sources: [], tail: '' };
  const clean = (s: string) => s.replace(/^[\s、,，。.:：]+|[\s、,，:：]+$/g, '').trim();
  const sources: { url: string; note: string }[] = [];
  let before = clean(rest.slice(0, urls[0].index));
  urls.forEach((u, i) => {
    const url = u[0].replace(/[.,]+$/, '');
    const end = u.index! + url.length;
    const next = i + 1 < urls.length ? urls[i + 1].index! : rest.length;
    let between = rest.slice(end, next);
    // "（…）" right after a URL describes it; other words name the next URL
    const paren = /^\s*([（(][^）)]*[）)])/.exec(between);
    const note = [before, paren ? paren[1] : ''].filter(Boolean).join(' ');
    if (paren) between = between.slice(paren[0].length);
    sources.push({ url, note });
    before = i + 1 < urls.length ? clean(between) : '';
    if (i + 1 === urls.length) before = between;
  });
  return { body, sources, tail: clean(before) };
}

/** A design description: the text, then its sources as a list of short links. */
export function DescriptionText({ text }: { text: string }) {
  const { body, sources, tail } = splitSources(text);
  return (
    <>
      <p className="whitespace-pre-line"><Linked text={body} /></p>
      {sources.length > 0 && (
        <div className="mt-2">
          <div className="text-[12px] font-semibold tracking-wide">{t('來源')}</div>
          <ul className="mt-0.5 space-y-0.5">
            {sources.map((s) => (
              <li key={s.url} className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span className="min-w-0">
                  <Linked text={s.url} />
                  {s.note && <span className="faint"> {s.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tail && <p className="faint mt-2 text-[13px]">{tail}</p>}
    </>
  );
}
