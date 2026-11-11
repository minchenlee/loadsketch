// The "import Terraform" dialog: what file to pick (plan JSON, not .tf), how to make it, and three
// example plans to try. The file input stays in TopBar (the e2e tests set files on it directly).
import { useEffect } from 'react';
import { FileInput, X } from 'lucide-react';
import { useExit } from '../modal.ts';
import { t, tx } from '../../i18n/index.ts';

/** The example plans (tests/import/fixtures, made by scripts/gen-fixtures.sh), loaded only when picked. */
export const EXAMPLE_PLANS: { id: string; label: string; load: () => Promise<unknown> }[] = [
  { id: 'ecs-rds', label: tx('ECS → RDS'), load: () => import('../../../tests/import/fixtures/ecs-rds.plan.json').then((m) => m.default) },
  { id: 'lambda-sqs-rds', label: tx('Lambda＋SQS＋RDS'), load: () => import('../../../tests/import/fixtures/lambda-sqs-rds.plan.json').then((m) => m.default) },
  { id: 'aurora-cache-multiaz', label: tx('Aurora＋快取（多 AZ）'), load: () => import('../../../tests/import/fixtures/aurora-cache-multiaz.plan.json').then((m) => m.default) },
];

export function ImportTerraform({ onClose, onPick, onExample }: { onClose: () => void; onPick: () => void; onExample: (id: string) => void }) {
  const [closing, close] = useExit(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="sd-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label={t('匯入 Terraform')} className="panel sd-dialog w-[min(560px,100%)] rounded-xl border shadow-2xl" data-testid="import-terraform-dialog">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <FileInput size={18} className="muted" />
          <div className="text-[16px] font-semibold">{t('匯入 Terraform')}</div>
          <button className="btn ml-auto" onClick={close} aria-label={t('關閉')}>
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4 text-[14px] leading-relaxed">
          <p>{t('要選的是 Terraform plan 的 JSON，不是 .tf 原始檔。在你的 Terraform 資料夾執行：')}</p>
          <pre className="overflow-x-auto rounded-md bg-[var(--panel-2)] px-3 py-2 text-[13px]">
            <code>{'terraform plan -out plan.out\nterraform show -json plan.out > plan.json'}</code>
          </pre>
          <p className="muted">{t('然後選 plan.json。檔案只在瀏覽器裡讀，不會上傳。匯入後，「檢查」分頁列出發現；猜的值用虛線框標出來。')}</p>
          <button className="btn btn-primary" onClick={onPick} data-testid="import-terraform-pick">
            <FileInput size={14} /> {t('選擇 plan.json')}
          </button>
          <div className="border-t border-[var(--line)] pt-3">
            <div className="muted mb-2">{t('手邊沒有 plan？用範例試試：')}</div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_PLANS.map((p) => (
                <button key={p.id} className="btn" onClick={() => onExample(p.id)} data-testid={`import-example-${p.id}`}>
                  {t(p.label)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
