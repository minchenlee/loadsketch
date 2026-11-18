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
    <aside className="panel flex w-[232px] shrink-0 flex-col overflow-y-auto border-r" aria-label={t('Component')}>
      <div className="px-3 pt-3 pb-1">
        <div className="text-[15px] font-semibold">{t('Component')}</div>
        <div className="faint text-[13px]">{t('Drag onto the canvas, or click to add it in the middle.')}</div>
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
        {t('Drag from the dot on the right of a node to the dot on the left of another node to make a call. Select it and press Delete to remove it.')}
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
      useApp.setState({ error: t('Cannot open {file}: it is not a preset file exported from loadsketch.', { file: f.name }) });
      return;
    }
    const { full, refused } = usePresets.getState().importPresets(r.presets);
    // refused: the palette says why (presets-refused)
    if (refused) return;
    const why = [
      r.skipped ? t('{n} are not in the right format', { n: r.skipped }) : '',
      full ? t('{n} did not fit (at most {max})', { n: full, max: MAX_PRESETS }) : '',
    ].filter(Boolean);
    if (why.length) useApp.setState({ error: t('Some presets in {file} were not imported: {why}.', { file: f.name, why: why.join(t(', @@list')) }) });
  };

  return (
    <div className="px-2 pt-3" data-testid="presets">
      <div className="flex items-center gap-1 px-1.5 pb-1">
        <div className="faint flex-1 text-[13px] font-medium tracking-wide">{t('My presets')}</div>
        <button className="btn px-1.5 py-0.5" onClick={exportAll} disabled={!all.length} title={t('Save all presets to one file')} aria-label={t('Export presets')} data-testid="presets-export">
          <Download size={13} />
        </button>
        <button className="btn px-1.5 py-0.5" onClick={() => file.current?.click()} title={t('Add presets from a file')} aria-label={t('Import presets')} data-testid="presets-import">
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
      {!presets.length && <div className="faint px-1.5 pb-1 text-[13px] leading-snug">{t('Select a component and press "Save as preset" on the right: it appears here with its settings, ready to drag onto the canvas.')}</div>}
      {refused && <div className="px-1.5 pb-1 text-[13px] leading-snug" style={{ color: 'var(--bad-ink)' }} role="status" data-testid="presets-refused">{t('This browser cannot save presets, and too many changes are waiting: this change was not made. Export your presets first.')}</div>}
      {memoryOnly && <div className="faint px-1.5 pb-1 text-[13px] leading-snug" data-testid="presets-memory-only">{t('This browser does not let pages keep data: presets last until you close the tab. To keep them, export them to a file first.')}</div>}
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
              title={t('{kind}: {name}', { kind: t(spec.label), name: p.name })}
              className="sd-pal flex min-w-0 flex-1 cursor-grab items-center gap-2 px-1.5 py-1 text-left active:cursor-grabbing"
              data-testid="preset-item"
              data-adds
            >
              <span className="sd-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ color: CATEGORY_COLOR[spec.category] }}>
                {Icon && <Icon size={14} strokeWidth={2} />}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
            <button className="faint shrink-0 rounded px-1 py-1 hover:text-[var(--text)]" onClick={() => remove(p.id)} title={t('Delete preset')} aria-label={t('Delete preset "{name}"', { name: p.name })} data-testid="preset-remove">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
