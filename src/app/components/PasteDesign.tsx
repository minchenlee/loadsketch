// Paste a design as JSON (roadmap-next M4, Q12, Q15): the text an AI or a person gives back. What is
// wrong is said in plain words; a design that reads shows what it changes against the canvas, and
// replaces the canvas only on a click. The current design can be copied from here, to give to an AI.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleX, ClipboardPaste, Copy, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { useExit, useModal } from '../modal.ts';
import { readPasted } from '../pasteDesign.ts';
import { describeChange, diffDesigns } from '../designDiff.ts';
import { t } from '../../i18n/index.ts';

/** Reading waits this long after the last key, so a long paste is not read at every key. */
const READ_MS = 200;

export function PasteDesign({ onClose }: { onClose: () => void }) {
  const [closing, close] = useExit(onClose);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, close);
  const dirty = useApp((s) => s.dirty);
  const [text, setText] = useState('');
  const [read, setRead] = useState('');
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setRead(text), READ_MS);
    return () => clearTimeout(h);
  }, [text]);
  const result = useMemo(() => (read.trim() ? readPasted(read) : null), [read]);
  const changes = useMemo(() => (result?.ok ? diffDesigns(useApp.getState().design(), result.design) : []), [result]);
  const ready = result?.ok && read === text;

  const apply = () => {
    if (!result?.ok) return;
    useApp.getState().load(result.design);
    close();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(useApp.getState().exportText());
      setCopied('yes');
      setTimeout(() => setCopied((c) => (c === 'yes' ? null : c)), 2000);
    } catch {
      setCopied('no');
    }
  };

  return createPortal(
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('貼上設計 JSON')} className="panel sd-dialog flex max-h-[92vh] w-[min(720px,100%)] flex-col overflow-hidden rounded-xl border shadow-2xl" data-testid="paste-design">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <ClipboardPaste size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('貼上設計 JSON')}</div>
          <button className="btn ml-auto" onClick={close} aria-label={t('關閉')}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[14px] leading-relaxed">
          <div className="flex flex-wrap items-center gap-2">
            <p className="muted min-w-0 flex-1">{t('貼上 AI 或別人給你的設計 JSON。先看它和畫布差在哪裡，按「換掉畫布」才會換。')}</p>
            <button className="btn shrink-0" onClick={() => void copy()} title={t('把畫布上的設計複製成 JSON，貼給 AI 修改')} data-testid="paste-design-copy">
              {copied === 'yes' ? <Check size={14} /> : <Copy size={14} />} {copied === 'yes' ? t('已複製') : t('複製目前的設計')}
            </button>
          </div>
          {copied === 'no' && (
            <p className="text-[13px]" style={{ color: 'var(--bad-ink)' }} data-testid="paste-design-copy-failed">
              {t('不能寫入剪貼簿。改用檔案選單的「存成 JSON」。')}
            </p>
          )}
          <textarea
            className="field block w-full resize-y font-mono text-[12.5px] leading-snug"
            // .field is a one-line control: this one is a box
            style={{ height: 200, minHeight: 96, padding: '6px 8px' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{ "schema": "loadsketch/design@1", "name": "…", "nodes": [ … ], "edges": [ … ] }'}
            spellCheck={false}
            autoFocus
            aria-label={t('設計 JSON')}
            data-testid="paste-design-text"
          />
          <div aria-live="polite" data-testid="paste-design-result">
            {result && !result.ok && (
              <div data-testid="paste-design-problems">
                <div className="mb-1 font-medium">{t('還不能用，要先改：')}</div>
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
                    {changes.length ? t('「{name}」和畫布有 {n} 處不同：', { name: result.design.name, n: changes.length }) : t('「{name}」和畫布上的設計一樣（位置和名稱不算）。', { name: result.design.name })}
                  </div>
                  {!!changes.length && (
                    <ul className="max-h-[220px] list-disc space-y-0.5 overflow-y-auto pl-5">
                      {changes.map((c, i) => (
                        <li key={i}>{describeChange(c)}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {!!result.warnings.length && (
                  <div data-testid="paste-design-warnings">
                    <div className="muted mb-1">{t('設計檢查（可以換，但要注意）：')}</div>
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
          {dirty && result?.ok && <span className="faint mr-auto text-[13px]" data-testid="paste-design-unsaved">{t('畫布上的修改還沒存：換掉後拿不回來。')}</span>}
          <button className="btn" onClick={close}>
            {t('取消')}
          </button>
          <button className="btn btn-primary" onClick={apply} disabled={!ready} data-testid="paste-design-apply">
            {t('換掉畫布')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
