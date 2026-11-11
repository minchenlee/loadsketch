import { useReactFlow } from '@xyflow/react';
import { CATEGORY_LABEL, KINDS, KIND_NAMES } from '../../schema/kinds.ts';
import { useApp } from '../store.ts';
import { CATEGORY_COLOR, CATEGORY_ORDER, ICONS } from '../ui.ts';
import { DRAG_MIME } from './Canvas.tsx';
import { NODE_W } from './ComponentNode.tsx';
import { t } from '../../i18n/index.ts';

export function Palette() {
  const addNode = useApp((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  return (
    <aside className="panel flex w-[232px] shrink-0 flex-col overflow-y-auto border-r" aria-label={t('元件')}>
      <div className="px-3 pt-3 pb-1">
        <div className="text-[15px] font-semibold">{t('元件')}</div>
        <div className="faint text-[13px]">{t('拖到畫布上，或點一下加到中間。')}</div>
      </div>
      {CATEGORY_ORDER.map((cat) => {
        const kinds = KIND_NAMES.filter((k) => KINDS[k].category === cat);
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
                  onClick={() => {
                    const el = document.querySelector('.react-flow')?.getBoundingClientRect();
                    const p = el ? screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 };
                    addNode(k, p.x - NODE_W / 2 + (Math.random() - 0.5) * 60, p.y - 24 + (Math.random() - 0.5) * 60);
                  }}
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
      <div className="faint mt-auto px-3 py-3 text-[13px] leading-relaxed">
        {t('從節點右邊的點拖到另一個節點左邊的點，就是一條呼叫。選取後按 Delete 刪除。')}
      </div>
    </aside>
  );
}
