// Paste a design as JSON (roadmap-next M4, Q12, Q15): the text an AI or a person gives back. What is
// wrong is said in plain words; a design that reads shows what it changes against the canvas, and
// replaces the canvas only on a click. The prompt for an AI (M5: the format guide, the current design
// and room for the request) and the design alone can be copied from here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleX, ClipboardPaste, Copy, Download, FileText, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { useExit, useModal } from '../modal.ts';
import { keepSources, readPasted } from '../pasteDesign.ts';
import { describeChange, diffDesigns } from '../designDiff.ts';
import { aiPrompt } from '../../schema/aiGuide.ts';
import { t } from '../../i18n/index.ts';

/** The full guide is at the site's root (public/llms-full.txt; /llms.txt is its index); the app is at /app/. */
export const guideUrl = () => new URL('../llms-full.txt', location.href).href;
/** The Agent Skill (M12; M15: SKILL.md and reference.md in a loadsketch folder): public/skills/loadsketch.zip. */
export const skillUrl = () => new URL('../skills/loadsketch.zip', location.href).href;

/** Reading waits this long after the last key, so a long paste is not read at every key. */
const READ_MS = 200;

export function PasteDesign({ onClose }: { onClose: () => void }) {
  const [closing, close] = useExit(onClose);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, close);
  const dirty = useApp((s) => s.dirty);
  const [text, setText] = useState('');
  const [read, setRead] = useState('');
  const [copied, setCopied] = useState<'prompt' | 'design' | 'no' | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setRead(text), READ_MS);
    return () => clearTimeout(h);
  }, [text]);
  const result = useMemo(() => (read.trim() ? readPasted(read) : null), [read]);
  const { changes, kept } = useMemo(() => {
    if (!result?.ok) return { changes: [], kept: null };
    const canvas = useApp.getState().design();
    const changes = diffDesigns(canvas, result.design);
    return { changes, kept: keepSources(canvas, result.design, changes) };
  }, [result]);
  const ready = result?.ok && read === text;

  const apply = () => {
    if (!kept) return;
    useApp.getState().load(kept.design);
    close();
  };
  const copy = async (what: 'prompt' | 'design') => {
    const st = useApp.getState();
    try {
      await navigator.clipboard.writeText(what === 'prompt' ? aiPrompt(st.design(), guideUrl()) : st.exportText());
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      setCopied('no');
    }
  };

  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('Paste design JSON')} className="panel sd-dialog flex max-h-[92vh] w-[min(720px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="paste-design">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <ClipboardPaste size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('Paste design JSON')}</div>
          <button className="btn ml-auto" onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[14px] leading-relaxed">
          <div className="space-y-2" data-testid="paste-design-step1">
            <p>{t('1. Copy the prompt for an AI and paste it into the AI you use (ChatGPT, Claude…); at the end, write what to change. The prompt holds the format guide and the current design.')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={() => void copy('prompt')} data-testid="paste-design-prompt">
                {copied === 'prompt' ? <Check size={14} /> : <Sparkles size={14} />} {copied === 'prompt' ? t('Copied') : t('Copy a prompt for an AI')}
              </button>
              <button className="btn" onClick={() => void copy('design')} title={t('Copy the design on the canvas as JSON, to give to an AI to change')} data-testid="paste-design-copy">
                {copied === 'design' ? <Check size={14} /> : <Copy size={14} />} {copied === 'design' ? t('Copied') : t('Copy only the design JSON')}
              </button>
              <a className="btn" href={guideUrl()} target="_blank" rel="noreferrer" title={t('The format guide for AI models. You can give this address to an AI as it is.')} data-testid="paste-design-guide">
                <FileText size={14} /> {t('Format guide')}
              </a>
              <a className="btn" href={skillUrl()} download="loadsketch.zip" title={t('A skill for AI agents such as Claude Code: SKILL.md (the steps and the format) and reference.md (the parameters of each component), in a loadsketch folder')} data-testid="paste-design-skill">
                <Download size={14} /> {t('Download the skill (zip)')}
              </a>
            </div>
            <p className="faint text-[13px]" data-testid="paste-design-skill-hint">
              {t('With an AI agent such as Claude Code: unpack the zip into ~/.claude/skills/ (it adds a loadsketch folder), then ask it to change the design JSON.')}
            </p>
            {copied === 'no' && (
              <p className="text-[13px]" style={{ color: 'var(--bad-ink)' }} data-testid="paste-design-copy-failed">
                {t('Cannot write to the clipboard. Use "Save as JSON" in the file menu instead.')}
              </p>
            )}
          </div>
          <p className="border-t border-[var(--line)] pt-3">{t('2. Paste the AI\'s answer (or a design JSON someone gave you) below. See how it differs from the canvas first; the canvas changes only when you click "Replace the canvas".')}</p>
          <textarea
            className="field block w-full resize-y font-mono text-[12.5px] leading-snug"
            // .field is a one-line control: this one is a box
            style={{ height: 200, minHeight: 96, padding: '6px 8px' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{ "schema": "loadsketch/design@1", "name": "…", "nodes": [ … ], "edges": [ … ] }'}
            spellCheck={false}
            autoFocus
            aria-label={t('Design JSON')}
            data-testid="paste-design-text"
          />
          <div aria-live="polite" data-testid="paste-design-result">
            {result && !result.ok && (
              <div data-testid="paste-design-problems">
                <div className="mb-1 font-medium">{t('Not usable yet. Fix these first:')}</div>
                <ul className="space-y-1">
                  {result.problems.map((p, i) => (
                    <li key={i} className="flex gap-1.5">
                      <CircleX size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--bad)' }} />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result?.ok && (
              <div className="space-y-2">
                <div data-testid="paste-design-diff">
                  <div className="mb-1 font-medium">
                    {changes.length ? t('"{name}" differs from the canvas in {n} places:', { name: result.design.name, n: changes.length }) : t('"{name}" is the same as the design on the canvas (positions and names do not count).', { name: result.design.name })}
                  </div>
                  {!!changes.length && (
                    <ul className="max-h-[220px] list-disc space-y-0.5 overflow-y-auto pl-5">
                      {changes.map((c, i) => (
                        <li key={i}>{describeChange(c)}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {!!kept && (kept.restored > 0 || kept.edited > 0 || kept.dropped > 0 || kept.rewired > 0) && (
                  <div className="space-y-1" data-testid="paste-design-sources">
                    {kept.restored > 0 && (
                      <p className="flex gap-1.5">
                        <Check size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--ok)' }} />
                        <span>{t('The pasted JSON left out the import source (source) of {n} components or lines: put back from the canvas.', { n: kept.restored })}</span>
                      </p>
                    )}
                    {kept.edited > 0 && (
                      <p className="flex gap-1.5">
                        <Check size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--ok)' }} />
                        <span>{t('{n} imported values were changed: their source now says "set by the user", as when you change a value in the settings panel.', { n: kept.edited })}</span>
                      </p>
                    )}
                    {kept.rewired > 0 && (
                      <p className="flex gap-1.5">
                        <TriangleAlert size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--warn)' }} />
                        <span>{t('{n} lines now join other components: the Terraform evidence was about the old lines, so these are now marked as drawn by the user.', { n: kept.rewired })}</span>
                      </p>
                    )}
                    {kept.dropped > 0 && (
                      <p className="flex gap-1.5">
                        <TriangleAlert size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--warn)' }} />
                        <span>{t('{n} components became another kind, so their import source no longer fits: after the replace, they no longer show where their values came from.', { n: kept.dropped })}</span>
                      </p>
                    )}
                  </div>
                )}
                {!!result.warnings.length && (
                  <div data-testid="paste-design-warnings">
                    <div className="muted mb-1">{t('Design check (you can replace, but note):')}</div>
                    <ul className="space-y-1">
                      {result.warnings.map((w, i) => (
                        <li key={i} className="flex gap-1.5">
                          <TriangleAlert size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--warn)' }} />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
          {dirty && result?.ok && <span className="faint mr-auto text-[13px]" data-testid="paste-design-unsaved">{t('The changes on the canvas are not saved: after replacing, they are gone.')}</span>}
          <button className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button className="btn btn-primary" onClick={apply} disabled={!ready} data-testid="paste-design-apply">
            {t('Replace the canvas')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
