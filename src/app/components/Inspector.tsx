import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, Check, Plus, Trash2, TriangleAlert, CircleX, X } from 'lucide-react';
import { KINDS, type ParamSpec } from '../../schema/kinds.ts';
import { EDGE, isPercent, layout, specsOf, toggleOn, unitLabel } from '../paramLayout.ts';
import { apiTraffic, edgeLatencyMs, ID_RE, regionsOf, STORE_KINDS, type DesignApi, type DesignEdge, type ParamSource, type ParamValue } from '../../schema/design.ts';
import type { NodeResult } from '../../engine/index.ts';
import { FAIL_LABEL, FAIL_REASONS } from '../../engine/index.ts';
import { useApp } from '../store.ts';
import { Select } from './Select.tsx';
import { Help, NumberInput, Switch } from './fields.tsx';
import { Learn } from './Learn.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { DescriptionText, NoteText } from './Prose.tsx';
import { LESSONS } from '../../learn/lessons.ts';
import { CATEGORY_COLOR, fmtMs, fmtN, iconOf, pct } from '../ui.ts';
import { t, tx } from '../../i18n/index.ts';
import { EVIDENCE_LABEL, isGuess } from '../sources.ts';
import { ImportChecks } from './ImportChecks.tsx';
import { Versions } from './Versions.tsx';
import { MAX_PRESET_NAME, usePresets } from '../presets.ts';

const CV_PRESETS = [
  { value: 0, label: tx('固定（cv 0）') },
  { value: 0.5, label: tx('小幅變動（cv 0.5）') },
  { value: 1, label: tx('指數分布（cv 1）') },
  { value: 2, label: tx('長尾（cv 2）') },
];


function ParamField({ kind, name, spec, value, onChange, placeholder, origin }: { kind: string; name: string; spec: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue | undefined) => void; placeholder?: string; origin?: ParamSource }) {
  const isSet = value !== undefined;
  const id = `p-${name}`;
  const on = toggleOn(kind, name);
  const percent = isPercent(name, spec);
  // a "0 means off" field: a switch; the number shows only while it is on
  const current = (value as number | undefined) ?? (spec.type === 'dist' || spec.type === 'enum' ? 0 : spec.default);
  const off = on !== undefined && current === 0;
  let input: React.ReactNode = null;
  if (!off) {
    switch (spec.type) {
      case 'int':
      case 'number':
        input = (
          <NumberInput
            value={(value as number | undefined) ?? (placeholder !== undefined ? Number(placeholder) : spec.default)}
            min={on !== undefined ? Math.max(spec.min, spec.type === 'int' ? 1 : 0.001) : spec.min}
            max={spec.max}
            scale={percent ? 100 : 1}
            unit={percent ? '%' : t(unitLabel(spec.unit))}
            labelledBy={id}
            integer={spec.type === 'int' && !percent}
            onChange={onChange}
          />
        );
        break;
      case 'ratio': {
        const v = (value as number | undefined) ?? spec.default;
        input = (
          <div className="grid grid-cols-[1fr_5.5rem] items-start gap-2">
            <input type="range" min={0} max={1} step={0.01} value={v} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5" aria-labelledby={id} />
            <NumberInput value={v} min={on !== undefined ? 0.001 : 0} max={1} scale={100} unit="%" label={t('{label}（百分比）', { label: t(spec.label) })} onChange={onChange} />
          </div>
        );
        break;
      }
      case 'dist': {
        const d = typeof value === 'number' ? { mean: value, cv: spec.default.cv } : ((value as { mean: number; cv?: number } | undefined) ?? spec.default);
        const cv = d.cv ?? spec.default.cv;
        input = (
          <div className="grid grid-cols-[1fr_1.3fr] items-start gap-1.5">
            <NumberInput value={d.mean} min={0} max={spec.max} unit="ms" labelledBy={id} onChange={(v) => onChange({ mean: v, cv })} />
            <Select
              className="w-full"
              aria-label={t('{label}的變動', { label: t(spec.label) })}
              value={cv}
              menuWidth={190}
              options={[...CV_PRESETS.map((p) => ({ value: p.value, label: t(p.label) })), ...(CV_PRESETS.some((p) => p.value === cv) ? [] : [{ value: cv, label: `cv ${cv}` }])]}
              onChange={(v) => onChange({ mean: d.mean, cv: v })}
            />
          </div>
        );
        break;
      }
      case 'enum':
        input = <Select className="w-full" aria-label={t(spec.label)} value={(value as string | undefined) ?? spec.default} options={spec.options.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(v) => onChange(v)} />;
        break;
    }
  }
  return (
    <div className="py-1.5" data-testid={`param-${name}`}>
      <div className="mb-1 flex items-center gap-2">
        <label id={id} className="font-medium">
          {t(spec.label)}
        </label>
        {origin && (
          <span
            className="sd-pill text-[12px]"
            style={{ '--pill': isGuess(origin) ? 'var(--warn)' : origin.evidence === 'answer' ? 'var(--accent)' : 'var(--line-strong)', borderStyle: isGuess(origin) ? 'dashed' : undefined } as React.CSSProperties}
            title={[origin.from, origin.ref].filter(Boolean).join(' · ') || undefined}
            data-testid={`origin-${name}`}
            data-evidence={origin.evidence}
          >
            {t(EVIDENCE_LABEL[origin.evidence])}
          </span>
        )}
        {isSet && (
          <button className="faint ml-auto text-[13px] hover:underline" onClick={() => onChange(undefined)} title={t('改回預設值')}>
            {t('用預設')}
          </button>
        )}
        {on !== undefined && (
          <span className={`flex items-center gap-1.5 ${isSet ? '' : 'ml-auto'}`}>
            <span className="faint text-[13px]">{off ? t('關') : t('開')}</span>
            <Switch on={!off} label={t(spec.label)} onChange={(v) => onChange(v ? (spec.default === on ? undefined : on) : spec.default === 0 ? undefined : 0)} />
          </span>
        )}
      </div>
      {input}
      <Help text={t(spec.help)} />
    </div>
  );
}

/**
 * A kind's parameters in groups. A foldable group (retries, protection, autoscaling…) starts
 * folded while everything in it keeps its default, and its header then says "off".
 */
function ParamGroups({ kind, values, onChange, placeholder, hide, sources }: { kind: string; values: Record<string, ParamValue | undefined>; onChange: (name: string, v: ParamValue | undefined) => void; placeholder?: (name: string) => string | undefined; hide?: string[]; sources?: Record<string, ParamSource> }) {
  const specs = specsOf(kind);
  const groups = layout(kind, values)
    .map((g) => ({ ...g, params: g.params.filter((p) => !hide?.includes(p)) }))
    .filter((g) => g.params.length);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div>
      {groups.map((g) => {
        const isOpen = open[g.key] ?? !g.folded;
        const summary = g.changed.length ? g.changed.map((l) => t(l)).join(t('、')) : g.folded ? t('關') : '';
        return (
          <section key={g.key} className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }} data-testid={`group-${g.key}`}>
            <button type="button" className="flex w-full items-baseline gap-2 text-left" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [g.key]: !isOpen })}>
              <span className="font-semibold">{t(g.label)}</span>
              {!isOpen && summary && <span className="faint min-w-0 flex-1 truncate text-[13px]">{summary}</span>}
              <span className="faint ml-auto text-[13px]" aria-hidden>
                {isOpen ? '▾' : '▸'}
              </span>
            </button>
            {isOpen &&
              g.params.map((k) => <ParamField key={k} kind={kind} name={k} spec={specs[k]} value={values[k]} placeholder={placeholder?.(k)} origin={sources?.[k]} onChange={(v) => onChange(k, v)} />)}
          </section>
        );
      })}
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5" title={hint}>
      <span className="muted">{k}</span>
      <span className="num font-medium">{v}</span>
    </div>
  );
}

function NodeStats({ r }: { r: NodeResult }) {
  const th = r.theory;
  return (
    <div className="card mt-3 p-2.5">
      <div className="mb-1 font-semibold">{t('上次執行的結果')}</div>
      <Stat k={t('每秒請求')} v={fmtN(r.rps)} />
      {r.kind === 'client' && r.arrivals > 0 && (
        <Stat k={t('這個使用者的失敗')} v={t('{n}／{total}（{pct}）', { n: fmtN(r.fail), total: fmtN(r.arrivals), pct: pct(r.fail / r.arrivals) })} hint={t('它送出的請求裡，最後失敗的數量（任何原因）')} />
      )}
      {r.utilization !== undefined && <Stat k={t('平均忙碌')} v={pct(r.utilization)} />}
      {r.peakUtilization !== undefined && <Stat k={t('最忙的一秒')} v={t('{pct}（第 {s} 秒）', { pct: pct(r.peakUtilization), s: Math.round(r.peakAtS ?? 0) })} />}
      {r.waitMs !== undefined && <Stat k={t('平均排隊時間')} v={fmtMs(r.waitMs)} />}
      {r.holdMs !== undefined && <Stat k={t('每個請求佔用時間')} v={fmtMs(r.holdMs)} hint={t('包括等下游回應的時間')} />}
      {r.hitRatio !== undefined && <Stat k={t('命中率')} v={pct(r.hitRatio)} />}
      {r.coalesced !== undefined && <Stat k={t('合併的查詢')} v={fmtN(r.coalesced)} hint={t('沒命中、但等別人查 DB 的結果，自己沒有去查')} />}
      {r.leaseWaits !== undefined && <Stat k={t('Lease 等待次數')} v={fmtN(r.leaseWaits)} hint={t('沒拿到 lease、稍後再問一次快取的次數')} />}
      {r.hcRemoved !== undefined && <Stat k={t('Health check 移出')} v={fmtN(r.hcRemoved)} hint={t('health check 把實例移出輪替的次數')} />}
      {r.blindChecks !== undefined && <Stat k={t('看不到監控')} v={t('{n} 次', { n: r.blindChecks })} hint={t('控制面呼叫失敗，自動擴充、failover 或 DNS 檢查這次沒有動作')} />}
      {r.ejections !== undefined && <Stat k={t('自動剔除')} v={fmtN(r.ejections)} hint={t('連續失敗、被暫時剔除的次數')} />}
      {r.queueDepthEnd !== undefined && <Stat k={t('結束時佇列長度')} v={fmtN(r.queueDepthEnd)} />}
      {r.circuitOpens !== undefined && <Stat k={t('保險絲跳開次數')} v={r.circuitOpens} />}
      {r.autoscale && (
        <>
          <Stat k={t('自動擴充台數')} v={t('最多 {peak} 台，結束時 {end} 台', { peak: r.autoscale.peakActive, end: r.autoscale.endActive })} hint={t('可用範圍 {min}–{max} 台', { min: r.autoscale.min, max: r.autoscale.max })} />
          <Stat k={t('加機器／減機器')} v={t('{up} 台／{down} 台', { up: r.autoscale.launches, down: r.autoscale.retires })} />
          {r.autoscale.bootFails !== undefined && <Stat k={t('開機失敗')} v={t('{n} 次', { n: r.autoscale.bootFails })} hint={t('開機時要呼叫的元件失敗，新機器重開')} />}
        </>
      )}
      {r.asyncOk !== undefined && <Stat k={t('訊息處理完成／失敗')} v={`${fmtN(r.asyncOk)}／${fmtN(r.asyncFail ?? 0)}`} />}
      {r.holBlocked !== undefined && <Stat k={t('排在同組後面等')} v={fmtN(r.holBlocked)} hint={t('FIFO：同一組前一則還沒做完，這則只能等（head-of-line blocking）')} />}
      {r.dualWriteGaps !== undefined && <Stat k={t('資料和訊息不一致')} v={fmtN(r.dualWriteGaps)} hint={t('寫 DB 和送 queue 一個成功一個失敗的寫入（dual write）；outbox 打開就不會有')} />}
      {r.outboxRetries !== undefined && <Stat k={t('outbox 重送')} v={fmtN(r.outboxRetries)} hint={t('relay 送訊息到 queue 失敗、之後再送的次數')} />}
      {r.redelivered !== undefined && (
        <>
          <Stat k={t('重送')} v={fmtN(r.redelivered)} hint={t('沒有在 visibility timeout 內做完（失敗、故障或太慢），訊息重新出現')} />
          <Stat k={t('重複處理')} v={fmtN(r.duplicates ?? 0)} hint={t('同一則訊息被做了兩次：worker 要冪等')} />
          <Stat k={t('移到 DLQ')} v={fmtN(r.dlq ?? 0)} hint={t('收了「最多接收次數」還失敗，不再重試')} />
        </>
      )}
      {r.replicaReads !== undefined && (
        <>
          <Stat
            k={t('讀到舊資料')}
            v={r.replicaReads ? t('{n}／{total}（{pct}）', { n: fmtN(r.staleReads ?? 0), total: fmtN(r.replicaReads), pct: pct((r.staleReads ?? 0) / r.replicaReads) }) : `${fmtN(r.staleReads ?? 0)}／${fmtN(r.replicaReads)}`}
            hint={t('讀副本時，這個 key 有主庫已寫入、副本還沒套用的資料')}
          />
          <Stat k={t('最大複製延遲')} v={fmtMs(r.maxReplLagMs ?? 0)} hint={t('每秒結束時，最落後的副本落後多久')} />
        </>
      )}
      {r.rywMisses !== undefined && (
        <Stat k={t('看不到自己的寫入')} v={<span style={{ color: r.rywMisses ? 'var(--bad-ink)' : undefined }}>{fmtN(r.rywMisses)}</span>} hint={t('使用者寫入後馬上讀，讀到的副本還沒套用那筆寫入（read-your-writes 失敗）')} />
      )}
      {r.lockWaits !== undefined && <Stat k={t('等鎖的寫入')} v={fmtN(r.lockWaits)} hint={t('寫入時這個 key 的列鎖被別的寫入拿著，排隊等它')} />}
      {r.failovers !== undefined && (
        <>
          <Stat k={t('failover 次數')} v={fmtN(r.failovers)} hint={t('副本升為主庫的次數')} />
          <Stat k={t('遺失的寫入')} v={<span style={{ color: r.lostWrites ? 'var(--bad-ink)' : undefined }}>{fmtN(r.lostWrites ?? 0)}</span>} hint={t('主庫已回覆成功、但新主庫沒收到的寫入（非同步複製）')} />
          {r.divergentWrites !== undefined && (
            <Stat k={t('分歧寫入')} v={<span style={{ color: 'var(--bad-ink)' }}>{fmtN(r.divergentWrites)}</span>} hint={t('網路分區時，舊主庫在新主庫升起後收的寫入（split brain）：新主庫沒有這些資料')} />
          )}
        </>
      )}
      {r.expired !== undefined &&
        (r.queueDepthEnd !== undefined ? (
          <Stat k={t('訊息過期')} v={fmtN(r.expired)} hint={t('放超過保留時間還沒做完，被丟掉')} />
        ) : (
          <Stat k={t('過期丟掉')} v={fmtN(r.expired)} hint={t('排到時 deadline 已經過了，直接丟掉，沒有白做')} />
        ))}
      {FAIL_REASONS.filter((k) => r.origin[k]).map((k) => (
        <Stat key={k} k={t(FAIL_LABEL[k])} v={<span style={{ color: 'var(--bad)' }}>{fmtN(r.origin[k])}</span>} />
      ))}
      {th && (
        <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
          <div className="mb-1 font-medium">
            {t('和排隊理論對照（{model}，c = {c}）', { model: th.model, c: th.servers })}
          </div>
          <Stat k={t('使用率 ρ')} v={th.rho.toFixed(2)} />
          <Stat k={t('要排隊的機率')} v={t('模擬 {sim}　理論 {theory}', { sim: pct(th.simPWait), theory: pct(th.pWait) })} />
          <Stat k={t('平均排隊時間')} v={t('模擬 {sim}　理論 {theory}', { sim: fmtMs(th.simWaitMs), theory: th.waitMs === null ? t('無上限') : fmtMs(th.waitMs) })} />
          {th.waitMs === null && <div className="faint text-[13px]">{t('ρ ≥ 1：進來的比處理得快，排隊會一直變長。')}</div>}
          {th.note && <div className="faint mt-1 text-[13px]">{th.note}</div>}
        </div>
      )}
    </div>
  );
}

/** Letters, digits, _ and - (the id rule), at most 48, starting with a letter or digit. */
const cleanRegion = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 48);

function RegionField({ id, region, field = 'region' }: { id: string; region: string | undefined; field?: 'region' | 'replicaRegion' }) {
  const updateNode = useApp((s) => s.updateNode);
  const nodes = useApp((s) => s.nodes);
  const regions = useMemo(() => regionsOf({ nodes: nodes.map((n) => n.data.node) }), [nodes]);
  return (
    <div className="py-1.5">
      <label className="mb-1 block font-medium" htmlFor={`node-${field}`}>
        {field === 'region' ? t('區域') : t('副本所在區域')}
      </label>
      <input
        id={`node-${field}`}
        className="field w-full"
        list={`region-list-${field}`}
        value={region ?? ''}
        placeholder={field === 'region' ? t('不分區域') : t('和主庫同一區')}
        onChange={(e) => updateNode(id, { [field]: cleanRegion(e.target.value) })}
        data-testid={field === 'region' ? 'region' : 'replica-region'}
      />
      <datalist id={`region-list-${field}`}>
        {regions.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="faint mt-1 text-[13px] leading-snug">
        {field === 'region'
          ? t('元件在哪個區域（資料中心），例如 us-east。不同區域之間的呼叫要多花跨區延遲；「整區故障」事件會讓同一區的元件一起故障。')
          : t('讀副本放在另一個區域時填這裡。複製到那裡要多一段跨區延遲；主庫的區域整區故障時，副本還活著，可以 failover 過去。')}
      </div>
    </div>
  );
}

function NodeInspector({ id }: { id: string }) {
  const node = useApp((s) => s.nodes.find((n) => n.id === id)?.data.node);
  const result = useApp((s) => s.result?.nodes[id]);
  const updateNode = useApp((s) => s.updateNode);
  const remove = useApp((s) => s.remove);
  const savePreset = usePresets((s) => s.save);
  // the name being typed for a new preset (null: closed), and the last one saved here
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    setSaving(null);
    setSaved(null);
    setRefused(false);
  }, [id]);
  useEffect(() => setRefused(false), [saving === null]);
  if (!node) return null;
  const spec = KINDS[node.kind];
  const Icon = iconOf(node as { kind: string; params?: Record<string, unknown> });
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <div className="sd-icon flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: CATEGORY_COLOR[spec.category] }}>
          {Icon && <Icon size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t(spec.label)}</div>
          <div className="faint text-[13px]">
            {spec.labelEn} · id <code>{node.id}</code>
          </div>
        </div>
        <button className="btn" onClick={() => setSaving(saving === null ? (node.label?.trim() || t(spec.label)).slice(0, MAX_PRESET_NAME) : null)} title={t('存成樣板：之後可以從左邊「我的樣板」拖出一樣的元件')} aria-label={t('存成樣板')} aria-expanded={saving !== null} data-testid="preset-save">
          <BookmarkPlus size={14} />
        </button>
        <button className="btn" onClick={() => remove({ type: 'node', id })} title={t('刪除元件')}>
          <Trash2 size={14} />
        </button>
      </div>
      {saving !== null && (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving.trim()) return;
            // refused (too many changes wait for storage): the form stays open and says why
            if (!savePreset(node, saving)) return setRefused(true);
            setSaving(null);
            setSaved(saving.trim());
          }}
        >
          <input className="field min-w-0 flex-1" value={saving} maxLength={MAX_PRESET_NAME} autoFocus aria-label={t('樣板名稱')} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSaving(null)} data-testid="preset-name" />
          <button className="btn btn-primary" type="submit" disabled={!saving.trim()} title={t('存成樣板')} aria-label={t('存成樣板')} data-testid="preset-save-confirm">
            <Check size={14} />
          </button>
          <button className="btn" type="button" onClick={() => setSaving(null)} title={t('取消')} aria-label={t('取消')}>
            <X size={14} />
          </button>
        </form>
      )}
      {refused && saving !== null && (
        <p className="mt-2 text-[13px]" style={{ color: 'var(--bad-ink)' }} role="status" data-testid="preset-refused">
          {t('瀏覽器存不了樣板，還沒存的改動太多：這次的改動沒有做。先匯出樣板。')}
        </p>
      )}
      {saved !== null && saving === null && (
        <p className="muted mt-2 text-[13px]" role="status" data-testid="preset-saved">
          {t('存成樣板「{name}」了：在左邊「我的樣板」。', { name: saved })}
        </p>
      )}
      <p className="muted mt-2 text-[14px] leading-relaxed">{t(spec.summary)}</p>
      <div className="py-1.5">
        <label className="mb-1 block font-medium">{t('名稱')}</label>
        <input className="field w-full" value={node.label ?? ''} placeholder={t(spec.label)} onChange={(e) => updateNode(id, { label: e.target.value })} />
      </div>
      {node.kind !== 'client' && <RegionField id={id} region={node.region} />}
      {(node.kind === 'database' || node.kind === 'sharded_db') && <RegionField id={id} region={node.replicaRegion} field="replicaRegion" />}
      {/* localReplicas only means something with a replica region */}
      <ParamGroups
        kind={node.kind}
        values={node.params ?? {}}
        hide={node.replicaRegion ? undefined : ['localReplicas']}
        sources={node.source?.params}
        onChange={(k, v) => updateNode(id, { params: { [k]: v } })}
      />
      {result && <NodeStats r={result} />}
    </div>
  );
}

function EdgeInspector({ id }: { id: string }) {
  const edge = useApp((s) => s.edges.find((e) => e.id === id)?.data?.edge);
  const from = useApp((s) => s.nodes.find((n) => n.id === edge?.from)?.data.node);
  const to = useApp((s) => s.nodes.find((n) => n.id === edge?.to)?.data.node);
  const interRegionMs = useApp((s) => s.doc.interRegionMs);
  const apis = useApp((s) => s.doc.apis);
  const result = useApp((s) => s.result?.edges[id]);
  const updateEdge = useApp((s) => s.updateEdge);
  const remove = useApp((s) => s.remove);
  if (!edge) return null;
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t('呼叫')}</div>
          <div className="faint text-[13px]">
            <code>{edge.from}</code> → <code>{edge.to}</code>
          </div>
        </div>
        <button className="btn" onClick={() => remove({ type: 'edge', id })} title={t('刪除這條呼叫')}>
          <Trash2 size={14} />
        </button>
      </div>
      {from?.kind === 'cache' && to && STORE_KINDS.has(to.kind) && (
        <p className="muted mt-2 text-[13px] leading-snug" data-testid="edge-through-note">
          {t('快取直接接資料庫：這條線是 read-through／write-through。讀取沒命中時，由快取自己去資料庫讀，再填進快取；寫入時，快取先寫進資料庫，再更新自己。呼叫快取的那一方不用另外連資料庫。')}
        </p>
      )}
      <ParamGroups
        kind={EDGE}
        values={edge as unknown as Record<string, ParamValue | undefined>}
        sources={edge.source?.params}
        placeholder={(k) => (k === 'latencyMs' ? String(edgeLatencyMs({}, from ?? { kind: '' }, to, interRegionMs)) : undefined)}
        onChange={(k, v) => updateEdge(id, { [k]: v } as Partial<DesignEdge>)}
      />
      {apis?.length ? <EdgeApis apis={apis} value={edge.apis} onChange={(v) => updateEdge(id, { apis: v })} /> : null}
      {result && (
        <div className="card mt-3 p-2.5">
          <div className="mb-1 font-semibold">{t('上次執行的結果')}</div>
          <Stat k={t('每秒呼叫')} v={fmtN(result.rps)} />
          <Stat k={t('失敗')} v={fmtN(result.fail)} />
          <Stat k={t('重試')} v={fmtN(result.retries)} />
          <Stat k={t('放棄後才回來')} v={fmtN(result.late)} hint={t('呼叫方已經逾時放棄，下游之後才做完：白做的工')} />
          {result.denied !== undefined && <Stat k={t('重試預算擋下')} v={fmtN(result.denied)} hint={t('想重試，但最近 10 秒的重試已經用完預算')} />}
          {result.throttled !== undefined && <Stat k={t('自我限流擋下')} v={fmtN(result.throttled)} hint={t('呼叫端看到下游最近很少成功，自己在本地擋掉、沒有送出的呼叫')} />}
          {result.bulkhead !== undefined && <Stat k={t('隔艙擋下')} v={fmtN(result.bulkhead)} hint={t('呼叫端同時呼叫的名額滿了，直接失敗的呼叫')} />}
          {result.fallbacks !== undefined && <Stat k={t('改用備用回應')} v={fmtN(result.fallbacks)} hint={t('呼叫失敗後，呼叫端改用備用回應（降級），請求照樣成功')} />}
          {result.hedges !== undefined && <Stat k={t('對沖多送')} v={fmtN(result.hedges)} hint={t('等太久沒回應，多送給另一台的第二份（算在每秒呼叫裡）')} />}
          {result.hedges !== undefined && <Stat k={t('對沖先成功')} v={fmtN(result.hedgeWins ?? 0)} hint={t('第二份比原本的那份先成功回來的次數')} />}
          {result.connects !== undefined && <Stat k={t('新開連線')} v={fmtN(result.connects)} hint={t('要先做 TCP＋TLS 握手的呼叫數；其他呼叫重用留著的連線')} />}
          {result.copies !== undefined && <Stat k={t('扇出送出的份數')} v={fmtN(result.copies)} hint={t('每個呼叫同時送給幾個分片或實例，全部加起來的份數；終點的負載是呼叫數的這麼多倍')} />}
        </div>
      )}
    </div>
  );
}

/** Which APIs an edge carries: a chip per API of the design; none chosen means every API. */
function EdgeApis({ apis, value, onChange }: { apis: DesignApi[]; value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  const on = new Set(value ?? []);
  return (
    <div className="py-1.5" data-testid="edge-apis">
      <div className="mb-1 font-medium" id="p-apis">
        {t('走哪些 API')}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="p-apis">
        {apis.map((a) => (
          <button
            key={a.name}
            className={`btn ${on.has(a.name) ? 'btn-on' : ''}`}
            aria-pressed={on.has(a.name)}
            onClick={() => {
              const next = apis.map((x) => x.name).filter((n) => (n === a.name ? !on.has(n) : on.has(n)));
              onChange(next.length ? next : undefined);
            }}
          >
            {a.name}
          </button>
        ))}
      </div>
      <div className="faint mt-1 text-[13px] leading-snug">{value?.length ? t('只有呼叫這些 API 的請求走這條線。') : t('沒有選：每個 API 的請求都走這條線。選幾個，這條線就只給它們走（依 API 路徑路由）。')}</div>
    </div>
  );
}

/**
 * The APIs users call and their share of the traffic. With APIs, each request calls one of them;
 * the API, not the scenario's read share, says whether it reads or writes.
 */
function ApiEditor() {
  const apis = useApp((s) => s.doc.apis) ?? [];
  const setApis = useApp((s) => s.setApis);
  const design = useApp((s) => s.design);
  // recomputed on every render: cheap, and edges or client weights may have changed
  const traffic = apis.length ? apiTraffic(design()) : {};
  const patch = (i: number, p: Partial<DesignApi>) => setApis(apis.map((a, k) => (k === i ? { ...a, ...p } : a)));
  const add = () => {
    const taken = new Set(apis.map((a) => a.name));
    let k = apis.length + 1;
    while (taken.has(`api${k}`)) k++;
    setApis([...apis, { name: `api${k}`, op: 'read', share: 1 }]);
  };
  return (
    <div className="mt-4" data-testid="api-editor">
      <div className="flex items-center gap-2">
        <div className="font-semibold">API</div>
        <button className="btn ml-auto" onClick={add} title={t('加一個 API')} aria-label={t('加一個 API')}>
          <Plus size={14} />
        </button>
      </div>
      {apis.length === 0 ? (
        <div className="faint mt-1 text-[13px] leading-snug">{t('沒有分 API：每個請求依情境的讀取比例，決定是讀還是寫。加上 API 後，可以讓一條線只走某些 API。')}</div>
      ) : (
        <>
        <div className="faint mt-1 text-[13px] leading-snug">{t('名稱、讀或寫、比例。每個使用者只呼叫它連出去的線能走的 API，依比例抽；所以實際佔比也看使用者的權重。')}</div>
        <ul className="mt-1 space-y-1.5">
          {apis.map((a, i) => (
            <li key={i} className="grid grid-cols-[1fr_5.5rem_3.5rem_auto] items-center gap-1.5">
              <ApiName value={a.name} taken={apis.filter((_, k) => k !== i).map((x) => x.name)} onCommit={(name) => setApis(apis.map((x, k) => (k === i ? { ...x, name } : x)), { [a.name]: name })} />
              <Select className="w-full" aria-label={t('「{api}」讀或寫', { api: a.name })} value={a.op} options={[{ value: 'read', label: t('讀取') }, { value: 'write', label: t('寫入') }]} onChange={(v) => patch(i, { op: v as DesignApi['op'] })} />
              <NumberInput value={a.share ?? 1} min={0} max={1000} onChange={(v) => patch(i, { share: v })} />
              <button className="btn" onClick={() => setApis(apis.filter((_, k) => k !== i))} title={t('刪除這個 API')} aria-label={t('刪除 API「{api}」', { api: a.name })}>
                <X size={14} />
              </button>
              <div className="faint col-span-4 -mt-1 text-[12px]">{t('佔全部流量 {p}', { p: pct(traffic[a.name] ?? 0) })}</div>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}

/** An API name: committed on blur or Enter, when it is a valid, unused id. */
function ApiName({ value, taken, onCommit }: { value: string; taken: string[]; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const ok = ID_RE.test(text) && !taken.includes(text);
  const commit = () => (ok && text !== value ? onCommit(text) : setText(value));
  return <input className="field w-full" value={text} aria-label={t('API 名稱')} aria-invalid={!ok} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function DesignInfo() {
  const doc = useApp((s) => s.doc);
  const issues = useApp((s) => s.issues);
  const result = useApp((s) => s.result);
  const example = useApp((s) => s.example);
  const lesson = example ? LESSONS[example] : undefined;
  // before the first run, a lesson hides the description: it gives the answer away
  const about = lesson && !result ? t(lesson.intro) : doc.description;
  return (
    <div>
      <div className="font-semibold">{doc.name}</div>
      {about && (
        <div className="muted mt-1 text-[14px] leading-relaxed" data-testid="design-about">
          <DescriptionText text={about} />
        </div>
      )}
      {/* notes of the design: what to try, what is simplified */}
      {doc.notes?.map((n) => (
        <div key={n.id} className="card mt-3 px-3 py-2.5 text-[14px] leading-relaxed" data-testid="design-note">
          <NoteText text={n.text} />
        </div>
      ))}
      {result && (
        <>
          <div className="mt-4 font-semibold">{t('上次執行')}</div>
          <div className="mt-1">
            <Stat k={t('送出')} v={fmtN(result.summary.offered)} />
            <Stat k={t('成功')} v={fmtN(result.summary.ok)} />
            <Stat k={t('錯誤率')} v={pct(result.summary.errorRate)} />
            <Stat k="p50 / p99" v={`${fmtMs(result.summary.latencyMs.p50)} / ${fmtMs(result.summary.latencyMs.p99)}`} />
          </div>
          {result.apis && (
            <table className="mt-2 w-full text-[13px]" data-testid="api-results">
              <thead className="faint text-left">
                <tr>
                  <th className="font-normal">API</th>
                  <th className="text-right font-normal">{t('送出')}</th>
                  <th className="text-right font-normal">{t('錯誤率')}</th>
                  <th className="text-right font-normal">p99</th>
                </tr>
              </thead>
              <tbody className="num">
                {Object.entries(result.apis).map(([name, a]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="text-right">{fmtN(a.offered)}</td>
                    <td className="text-right" style={a.errorRate > 0.01 ? { color: 'var(--bad)' } : undefined}>
                      {pct(a.errorRate)}
                    </td>
                    <td className="text-right">{fmtMs(a.latencyMs.p99)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <ApiEditor />
      <div className="mt-4 font-semibold">{t('設計檢查')}</div>
      {issues.length === 0 ? (
        <div className="faint mt-1">{t('沒有問題。')}</div>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {issues.map((i, k) => (
            <li key={k} className="flex gap-1.5 text-[14px] leading-snug">
              {i.level === 'error' ? <CircleX size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--bad)' }} /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />}
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="faint mt-4 text-[13px] leading-relaxed">{t('點一個元件或一條呼叫，可以改它的設定。執行後再點元件，可以看它的結果和排隊理論的對照。')}</div>
    </div>
  );
}

type Tab = 'design' | 'scenario' | 'learn' | 'versions' | 'checks';

/**
 * Four tabs: the settings of the design or the selected part, the scenario (traffic and events), the results (lesson questions, SLA, cost, the story
 * of the run, challenges) and the versions (one per finished run). A lesson example opens on the lesson; selecting a part shows its settings.
 */
const WIDTH_KEY = 'loadsketch-right-width';
const DEFAULT_W = 340;
const MIN_W = 280;
/** At most 60% of the window (and 900 px): the canvas keeps some room. */
const maxW = () => Math.max(MIN_W, Math.min(900, Math.round(window.innerWidth * 0.6)));
const clampW = (w: number) => Math.round(Math.min(maxW(), Math.max(MIN_W, w)));

/** The panel's width, dragged on its left edge (or arrow keys there); kept in localStorage. */
function usePanelWidth() {
  // pref: the width asked for; w: that width inside this window's limits (the window can shrink and grow back)
  const [pref, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v > 0 ? v : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  const [, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // the width shown during a drag, apart from the stored preference (a drag in a narrow window must not overwrite it)
  const [dragW, setDragW] = useState<number | null>(null);
  const w = clampW(dragW ?? pref);
  // the preference is kept as asked (within 280–900 px), not as this window clamps it: a wider window shows it again
  // A resize starts from the width shown. One that ends at this window's limit keeps a wider stored
  // width (a wider window shows it again); a narrower one is the new choice.
  const save = (v: number, exact = false) => {
    const c = Math.round(Math.min(900, Math.max(MIN_W, !exact && v >= maxW() ? Math.max(v, pref) : v)));
    setW(c);
    try {
      localStorage.setItem(WIDTH_KEY, String(c));
    } catch {
      // private mode: the width just is not kept
    }
  };
  const drag = useRef<{ x: number; w: number } | null>(null);
  const handle = (
    <div
      className="sd-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('調整設定面板寬度')}
      aria-valuenow={w}
      aria-valuemin={MIN_W}
      aria-valuemax={maxW()}
      tabIndex={0}
      title={t('拖曳調整寬度，連按兩下恢復預設')}
      data-testid="right-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = '';
        drag.current = { x: e.clientX, w };
      }}
      onPointerMove={(e) => {
        // the panel is on the right: dragging its left edge to the left makes it wider
        if (drag.current) setDragW(clampW(drag.current.w + drag.current.x - e.clientX));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        delete e.currentTarget.dataset.dragging;
        save(drag.current.w + drag.current.x - e.clientX);
        setDragW(null);
        drag.current = null;
      }}
      onDoubleClick={() => save(DEFAULT_W, true)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') save(w + 16);
        else if (e.key === 'ArrowRight') save(w - 16);
        else return;
        e.preventDefault();
      }}
    />
  );
  return { w, handle };
}

export function Inspector() {
  const { w: width, handle } = usePanelWidth();
  const selected = useApp((s) => s.selected);
  const example = useApp((s) => s.example);
  const status = useApp((s) => s.status);
  // the checks tab: only while the imported design is the one loaded
  const hasChecks = useApp((s) => !!s.imported && s.imported.loads === s.loads);
  const hasLesson = example ? LESSONS[example] !== undefined : false;
  // opened with a part already selected (the phone drawer after a tap): its settings, not the lesson
  const [tab, setTab] = useState<Tab>(hasLesson && !selected ? 'learn' : 'design');
  const [seen, setSeen] = useState(true);
  const imports = useApp((s) => s.imported?.loads);
  const asked = useApp((s) => s.settingsAsked);
  const [last, setLast] = useState({ selected, example, status, imports, asked });
  if (last.selected !== selected || last.example !== example || last.status !== status || last.imports !== imports || last.asked !== asked) {
    setLast({ selected, example, status, imports, asked });
    if (imports !== undefined && imports !== last.imports) setTab('checks');
    else if (asked !== last.asked || (selected && selected !== last.selected)) setTab('design');
    else if (example !== last.example) setTab(hasLesson ? 'learn' : 'design');
    // a finished run has a new story: mark the tab when it is not open
    if (status === 'done' && last.status !== 'done') setSeen(tab === 'learn');
  }
  // the checks tab went away (another design loaded) while it was open: back to settings
  if (tab === 'checks' && !hasChecks) setTab('design');
  const open = (x: Tab) => {
    setTab(x);
    if (x === 'learn') setSeen(true);
  };
  const tabBtn = (x: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === x}
      className={`relative flex-1 border-b-2 px-2 py-2 text-[14px] font-medium ${tab === x ? 'border-[var(--accent)]' : 'muted border-transparent'}`}
      onClick={() => open(x)}
      data-testid={`tab-${x}`}
    >
      {label}
      {x === 'learn' && !seen && tab !== 'learn' && <span className="absolute top-2 ml-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-label={t('有新的說明')} />}
    </button>
  );
  return (
    <aside className="panel relative flex shrink-0 flex-col border-l" style={{ width }} aria-label={t('設定')} data-testid="right-panel">
      {handle}
      <div role="tablist" className="flex shrink-0 border-b border-[var(--line)] px-3">
        {tabBtn('design', t('設定'))}
        {tabBtn('scenario', t('情境'))}
        {tabBtn('learn', t('結果'))}
        {tabBtn('versions', t('版本'))}
        {hasChecks && tabBtn('checks', t('檢查'))}
      </div>
      <div className="flex-1 overflow-y-auto p-3" role="tabpanel">
        {tab === 'checks' && hasChecks ? (
          <ImportChecks onRun={() => open('learn')} />
        ) : tab === 'learn' ? (
          <Learn />
        ) : tab === 'versions' ? (
          <Versions />
        ) : tab === 'scenario' ? (
          <ScenarioEditor />
        ) : selected?.type === 'node' ? (
          <NodeInspector key={selected.id} id={selected.id} />
        ) : selected?.type === 'edge' ? (
          <EdgeInspector key={selected.id} id={selected.id} />
        ) : (
          <DesignInfo />
        )}
      </div>
    </aside>
  );
}
