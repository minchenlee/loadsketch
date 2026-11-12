import { useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Download, FileInput, X } from 'lucide-react';
import { CATEGORY_LABEL, CUSTOM_KIND, KINDS, KIND_NAMES } from '../../schema/kinds.ts';
import { useConstraints } from './Constraints.tsx';
import { useOnCall } from './OnCall.tsx';
import { useApp } from '../store.ts';
import { CATEGORY_COLOR, CATEGORY_ORDER, ICONS, iconOf } from '../ui.ts';
import { DRAG_MIME, PRESET_MIME } from './Canvas.tsx';
import { MAX_PRESETS, parsePresetFile, presetFile, usePresets, type Preset } from '../presets.ts';
import { NODE_W } from './ComponentNode.tsx';
import { t } from '../../i18n/index.ts';

export function Palette() {
  const addNode = useApp((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  // a practice problem is open: a custom service is not allowed there (Q20), so it is not offered
  const problem = useConstraints((s) => s.id !== null);
  const incident = useOnCall((s) => s.id !== null);
  const practice = problem || incident;
  /** A component in the middle of the canvas, a little off so a few clicks do not stack them. */
  const addAtCenter = (kind: string, init?: { label?: string; params?: Preset['params'] }) => {
    const el = document.querySelector('.react-flow')?.getBoundingClientRect();
    const p = el ? screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 };
    addNode(kind, p.x - NODE_W / 2 + (Math.random() - 0.5) * 60, p.y - 24 + (Math.random() - 0.5) * 60, init);
  };
  return (
    <aside className="panel flex w-[232px] shrink-0 flex-col overflow-y-auto border-r" aria-label={t('元件')}>
      <div className="px-3 pt-3 pb-1">
        <div className="text-[15px] font-semibold">{t('元件')}</div>
        <div className="faint text-[13px]">{t('拖到畫布上，或點一下加到中間。')}</div>
      </div>
      {CATEGORY_ORDER.map((cat) => {
        const kinds = KIND_NAMES.filter((k) => KINDS[k].category === cat && !(practice && k === CUSTOM_KIND));
        if (!kinds.length) return null;
        return (
          <div key={cat} className="px-2 pt-2">
            <div className="faint px-1.5 pb-1 text-[13px] font-medium tracking-wide">{t(CATEGORY_LABEL[cat])}</div>
            {kinds.map((k) => {
              const spec = KINDS[k];
              const Icon = ICONS[spec.icon];
              return (
                <button
                  key={k}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME, k);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => addAtCenter(k)}
                  title={t(spec.summary)}
                  className="sd-pal flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--panel-2)] active:cursor-grabbing"
                  data-kind={k}
                >
                  <span className="sd-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ color: CATEGORY_COLOR[cat] }}>
                    {Icon && <Icon size={14} strokeWidth={2} />}
                  </span>
                  <span className="truncate">{t(spec.label)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <PresetList practice={practice} add={(p) => addAtCenter(p.kind, { label: p.name, params: p.params })} />
      <div className="faint mt-auto px-3 py-3 text-[13px] leading-relaxed">
        {t('從節點右邊的點拖到另一個節點左邊的點，就是一條呼叫。選取後按 Delete 刪除。')}
      </div>
    </aside>
  );
}

/** My presets (M8, Q21): components with their settings, saved from the inspector, kept in this browser. */
function PresetList({ practice, add }: { practice: boolean; add: (p: Preset) => void }) {
  const all = usePresets((s) => s.presets);
  const memoryOnly = usePresets((s) => s.memoryOnly);
  const refused = usePresets((s) => s.refused);
  const remove = usePresets((s) => s.remove);
  const file = useRef<HTMLInputElement>(null);
  // a custom service is not allowed in a practice problem (Q20)
  const presets = practice ? all.filter((p) => p.kind !== CUSTOM_KIND) : all;

  const exportAll = () => {
    const blob = new Blob([presetFile(all)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'loadsketch-presets.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = async (f: File) => {
    const r = parsePresetFile(await f.text());
    if (!r.ok) {
      useApp.setState({ error: t('打不開 {file}：這不是 loadsketch 匯出的樣板檔。', { file: f.name }) });
      return;
    }
    const { full, refused } = usePresets.getState().importPresets(r.presets);
    // refused: the palette says why (presets-refused)
    if (refused) return;
    const why = [
      r.skipped ? t('{n} 個樣板格式不對', { n: r.skipped }) : '',
      full ? t('{n} 個樣板放不下（最多 {max} 個）', { n: full, max: MAX_PRESETS }) : '',
    ].filter(Boolean);
    if (why.length) useApp.setState({ error: t('{file} 有些樣板沒有匯入：{why}。', { file: f.name, why: why.join(t('、')) }) });
  };

  return (
    <div className="px-2 pt-3" data-testid="presets">
      <div className="flex items-center gap-1 px-1.5 pb-1">
        <div className="faint flex-1 text-[13px] font-medium tracking-wide">{t('我的樣板')}</div>
        <button className="btn px-1.5 py-0.5" onClick={exportAll} disabled={!all.length} title={t('把所有樣板存成一個檔案')} aria-label={t('匯出樣板')} data-testid="presets-export">
          <Download size={13} />
        </button>
        <button className="btn px-1.5 py-0.5" onClick={() => file.current?.click()} title={t('從檔案加入樣板')} aria-label={t('匯入樣板')} data-testid="presets-import">
          <FileInput size={13} />
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="presets-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
      {!presets.length && <div className="faint px-1.5 pb-1 text-[13px] leading-snug">{t('選一個元件，在右邊按「存成樣板」：它和它的設定會出現在這裡，可以再拖到畫布上。')}</div>}
      {refused && <div className="px-1.5 pb-1 text-[13px] leading-snug" style={{ color: 'var(--bad-ink)' }} role="status" data-testid="presets-refused">{t('瀏覽器存不了樣板，還沒存的改動太多：這次的改動沒有做。先匯出樣板。')}</div>}
      {memoryOnly && <div className="faint px-1.5 pb-1 text-[13px] leading-snug" data-testid="presets-memory-only">{t('這個瀏覽器不讓網頁存資料：樣板只留到關閉分頁。要留下樣板，先匯出成檔案。')}</div>}
      {presets.map((p) => {
        const spec = KINDS[p.kind];
        const Icon = iconOf(p);
        return (
          <div key={p.id} className="flex items-center rounded-md hover:bg-[var(--panel-2)]" data-preset={p.id}>
            <button
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(PRESET_MIME, p.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => add(p)}
              title={t('{kind}：{name}', { kind: t(spec.label), name: p.name })}
              className="sd-pal flex min-w-0 flex-1 cursor-grab items-center gap-2 px-1.5 py-1 text-left active:cursor-grabbing"
              data-testid="preset-item"
              data-adds
            >
              <span className="sd-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ color: CATEGORY_COLOR[spec.category] }}>
                {Icon && <Icon size={14} strokeWidth={2} />}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
            <button className="faint shrink-0 rounded px-1 py-1 hover:text-[var(--text)]" onClick={() => remove(p.id)} title={t('刪除樣板')} aria-label={t('刪除樣板「{name}」', { name: p.name })} data-testid="preset-remove">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
