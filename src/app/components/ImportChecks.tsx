// The checks tab (M29, Q21): the findings of the last Terraform import, as `loadsketch import terraform`
// prints them. They were made at import time: values changed later on the canvas are not checked again.
import { Play } from 'lucide-react';
import type { Scenario } from '../../core/index.ts';
import { useApp } from '../store.ts';
import { importMessage } from '../../i18n/importMessages.ts';
import { CERTAINTY, SEVERITY } from '../../i18n/importReport.ts';
import { t } from '../../i18n/index.ts';
import { scenarioFor } from '../../import/terraform/scenarioFor.ts';

const SEVERITY_COLOR: Record<string, string> = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--line-strong)', info: 'var(--line)' };

/** `onRun`: after a finding's scenario starts (the panel opens the results tab). */
export function ImportChecks({ onRun }: { onRun?: () => void }) {
  const imported = useApp((s) => s.imported);
  const focus = useApp((s) => s.focus);
  // the scenario is made from the design on the canvas now (a node may have been changed or removed)
  useApp((s) => s.nodes);
  useApp((s) => s.edges);
  const design = useApp.getState().design();
  if (!imported) return null;
  const simulate = (sc: Scenario) => {
    const st = useApp.getState();
    st.setScenario(structuredClone(sc));
    st.run();
    onRun?.();
  };
  const { findings, file } = imported;
  return (
    <div data-testid="import-checks">
      <div className="font-semibold">{t('匯入檢查')}</div>
      <p className="faint mt-1 text-[13px] leading-relaxed">
        {t('{file} 匯入時的檢查。之後在畫布上改的值不會重新檢查；要重新檢查，用 CLI 加答案檔再匯入一次。', { file })}
      </p>
      {!findings.length && <p className="muted mt-3 text-[14px]">{t('沒有發現。')}</p>}
      {findings.map((f, i) => (
        <div key={i} className="card mt-3 px-3 py-2.5 text-[14px] leading-relaxed" data-testid="import-finding" data-check={f.check} data-certainty={f.certainty}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="sd-pill" style={{ '--pill': SEVERITY_COLOR[f.severity] } as React.CSSProperties}>{t(SEVERITY[f.severity])}</span>
            <span className="faint text-[13px]">{f.check}</span>
            <span className="faint text-[13px]">· {t(CERTAINTY[f.certainty])}</span>
            <button className="ml-auto text-[13px] hover:underline" onClick={() => focus({ type: 'node', id: f.node })} title={t('在畫布上選取這個元件')}>
              <code>{f.node}</code>
            </button>
          </div>
          <div className="mt-1">{importMessage(f.id, f.args)}</div>
          {(() => {
            const sim = scenarioFor(f, design);
            if ('none' in sim) return <div className="faint mt-2 border-t border-[var(--line)] pt-2 text-[13px]" data-testid="import-finding-nosim">{importMessage(`sim.none.${sim.none}`)}</div>;
            return (
              <div className="mt-2 border-t border-[var(--line)] pt-2">
                <button className="inline-flex items-center gap-1 text-[13px] font-medium hover:underline" style={{ color: 'var(--accent)' }} onClick={() => simulate(sim.scenario)} data-testid="import-finding-simulate">
                  <Play size={12} aria-hidden />
                  {t('模擬這個情況')}
                </button>
                <div className="faint mt-0.5 text-[13px] leading-relaxed">{importMessage(`sim.${sim.note}`, sim.args)}</div>
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}
