import { useId, useMemo } from 'react';
import { Trash2, TriangleAlert, CircleX } from 'lucide-react';
import { checkScenario, regionsOf, type Scenario, type ScenarioEvent } from '../../schema/design.ts';
import { useApp } from '../store.ts';
import { useCauseHidden } from './OnCall.tsx';
import { EVENT_SPEC, eventEdges, eventNodes, instanceCount, newEvent, retype, usableTypes, type EventNumField, type EventType } from '../scenarioEdit.ts';
import { Select } from './Select.tsx';
import { Help, NumberInput, Switch } from './fields.tsx';
import { t, tx } from '../../i18n/index.ts';

const CUSTOM = tx('自訂');

/** A labelled field: the label on top, the input under it, help under that. */
function Field({ label, help, children }: { label: string; help?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="mb-2.5">
      <div id={id} className="muted mb-1 text-[13px] font-medium">
        {label}
      </div>
      {children(id)}
      {help && <Help text={help} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4" aria-label={title}>
      <h3 className="mb-2 text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The scenario tab: traffic, how long users wait, key heat, the run length, and the events as
 * a list of forms. Every change makes the scenario a custom one.
 */
export function ScenarioEditor() {
  const scenario = useApp((s) => s.scenario);
  const setScenario = useApp((s) => s.setScenario);
  const hidden = useCauseHidden();
  const nodes = useApp((s) => s.nodes);
  const edges = useApp((s) => s.edges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const design = useMemo(() => useApp.getState().design(), [nodes, edges]);
  const issues = useMemo(() => checkScenario(scenario, design), [scenario, design]);
  const set = (s: Partial<Scenario>) => setScenario({ ...scenario, ...s, name: CUSTOM });
  const traffic = (p: Partial<Scenario['traffic']>) => set({ traffic: { ...scenario.traffic, ...p } });
  const durationS = scenario.durationS ?? 60;
  const events = scenario.events ?? [];
  const setEvents = (evs: ScenarioEvent[]) => set({ events: evs });
  const hasApis = !!design.apis?.length;

  return (
    <div data-testid="scenario-editor">
      <Section title={t('流量')}>
        <Field label={t('每秒請求數')} help={t('所有使用者合計每秒送出幾個請求。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.traffic.rps} min={0} max={1000000} unit="req/s" onChange={(v) => traffic({ rps: v })} />}
        </Field>
        {!hasApis && (
          <Field label={t('讀取比例')} help={t('讀取請求占多少；其餘是寫入。')}>
            {(id) => <NumberInput labelledBy={id} value={scenario.traffic.readRatio ?? 0.9} min={0} max={1} scale={100} unit="%" onChange={(v) => traffic({ readRatio: v })} />}
          </Field>
        )}
        <Field label={t('寫後讀')} help={t('寫入成功後，有這個比例的使用者馬上讀同一筆資料（例如發文後看自己的頁面）。讀副本時可能看不到自己剛寫的（read-your-writes）。0 表示不送。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.traffic.followReads ?? 0} min={0} max={1} scale={100} unit="%" onChange={(v) => traffic({ followReads: v || undefined })} />}
        </Field>
        {(scenario.traffic.followReads ?? 0) > 0 && (
          <Field label={t('寫完多久後讀')}>
            {(id) => <NumberInput labelledBy={id} value={scenario.traffic.followAfterMs ?? 100} min={0} max={600000} unit="ms" onChange={(v) => traffic({ followAfterMs: v })} />}
          </Field>
        )}
        <Field label={t('使用者放棄時間')} help={t('一個請求等這麼久還沒回應，使用者就放棄（算逾時）。下游還在做的工作不會停。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.traffic.clientTimeoutMs ?? 3000} min={1} max={600000} unit="ms" onChange={(v) => traffic({ clientTimeoutMs: v })} />}
        </Field>
        <Field label={t('請求怎麼到')}>
          {() => (
            <Select
              aria-label={t('請求怎麼到')}
              data-testid="sc-arrivals"
              value={scenario.traffic.arrivals ?? 'poisson'}
              options={[
                { value: 'poisson' as const, label: t('隨機（Poisson，像真的使用者）') },
                { value: 'constant' as const, label: t('平均間隔（每個請求間隔一樣）') },
              ]}
              onChange={(v) => traffic({ arrivals: v })}
            />
          )}
        </Field>
      </Section>

      <Section title={t('熱度')}>
        <Field label={t('不同 key 的數量')} help={t('請求會讀寫多少種不同的資料（例如不同的使用者或貼文）。key 越多，快取越難全部放下。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.keys?.count ?? 100000} min={1} max={1000000} integer onChange={(v) => set({ keys: { ...scenario.keys, count: v } })} />}
        </Field>
        <Field label={t('熱門程度（Zipf）')} help={t('0 表示每個 key 一樣常被讀；1 左右表示少數 key 非常熱門（熱點）。值越大，快取命中率越高，但熱門 key 所在的分片越忙。')}>
          {(id) => (
            <NumberInput labelledBy={id} value={scenario.keys?.zipf ?? 0.8} min={0} max={3} onChange={(v) => set({ keys: { count: scenario.keys?.count ?? 100000, zipf: v } })} />
          )}
        </Field>
      </Section>

      <Section title={t('時間')}>
        <Field label={t('總時長')}>
          {(id) => <NumberInput labelledBy={id} value={durationS} min={1} max={3600} unit="s" onChange={(v) => set({ durationS: v })} />}
        </Field>
        <Field label={t('暖機時間')} help={t('一開始這段時間不算進統計（快取還是空的、機器剛開始忙）。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.warmupS ?? 5} min={0} max={3600} unit="s" onChange={(v) => set({ warmupS: v })} />}
        </Field>
        <Field label={t('隨機種子')} help={t('同樣的設計、同樣的種子，結果一模一樣。換一個種子看看結果差多少。')}>
          {(id) => <NumberInput labelledBy={id} value={scenario.seed ?? 1} min={0} max={2 ** 31} integer onChange={(v) => set({ seed: v })} />}
        </Field>
        <Field label={t('縮小模擬')} help={t('請求很多時，自動只模擬 1/k 的流量和容量，再把數字乘回來，幾秒內算完。每台同時處理數最少留 32，台數最少留 10。')}>
          {() => (
            <Select
              aria-label={t('縮小模擬')}
              data-testid="sc-scale"
              value={scenario.scale === 1 ? 'off' : 'auto'}
              options={[
                { value: 'auto' as const, label: t('自動') },
                { value: 'off' as const, label: t('不縮小（原尺寸）') },
              ]}
              onChange={(v) => set({ scale: v === 'off' ? 1 : undefined })}
            />
          )}
        </Field>
      </Section>

      <Section title={t('事件')}>
        {hidden ? (
          <div className="faint text-[13px]" data-testid="events-hidden">{t('值班練習中：故障藏在這裡，送出答案後才看得到。')}</div>
        ) : (
        <>
        {events.length === 0 && <div className="faint mb-2 text-[13px]">{t('沒有事件：流量固定，元件都正常。')}</div>}
        <ol className="space-y-2" aria-label={t('事件清單')}>
          {events.map((ev, i) => (
            <EventRow
              key={i}
              index={i}
              ev={ev}
              durationS={durationS}
              onChange={(e) => setEvents(events.map((x, j) => (j === i ? e : x)))}
              onDelete={() => setEvents(events.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
        <div className="mt-2">
          <Select<EventType>
            aria-label={t('新增事件')}
            data-testid="add-event"
            value={undefined}
            placeholder={t('＋ 新增事件')}
            options={usableTypes(design).map((s) => ({ value: s.type, label: t(s.label), hint: t(s.help) }))}
            menuWidth={300}
            onChange={(type) => setEvents([...events, newEvent(type, design, durationS)])}
          />
        </div>
        </>
        )}
      </Section>

      {issues.length > 0 && (
        <ul className="space-y-1" data-testid="scenario-issues">
          {issues.map((x, i) => (
            <li key={i} className="flex gap-1.5 text-[13px]" style={{ color: x.level === 'error' ? 'var(--bad-ink)' : 'var(--warn-ink, var(--ink-2))' }}>
              {x.level === 'error' ? <CircleX size={14} className="mt-0.5 shrink-0" /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" />}
              {x.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ ev, index, durationS, onChange, onDelete }: { ev: ScenarioEvent; index: number; durationS: number; onChange: (e: ScenarioEvent) => void; onDelete: () => void }) {
  const nodes = useApp((s) => s.nodes);
  const edges = useApp((s) => s.edges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const design = useMemo(() => useApp.getState().design(), [nodes, edges]);
  const spec = EVENT_SPEC[ev.type];
  const rec = ev as Record<string, unknown>;
  const put = (k: string, v: unknown) => {
    const next = { ...rec };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next as ScenarioEvent);
  };
  const node = typeof rec.node === 'string' ? rec.node : undefined;
  const insts = node ? instanceCount(design, node) : 0;
  return (
    <li className="card p-2.5" data-testid="event-row" aria-label={t('事件 {n}：{type}', { n: index + 1, type: t(spec.label) })}>
      <div className="mb-2 flex items-center gap-2">
        <Select<EventType>
          className="min-w-0 flex-1"
          aria-label={t('事件種類')}
          data-testid="event-type"
          value={ev.type}
          options={[...new Set([spec, ...usableTypes(design)])].map((s) => ({ value: s.type, label: t(s.label), hint: t(s.help) }))}
          menuWidth={300}
          onChange={(type) => type !== ev.type && onChange(retype(ev, type, design, durationS))}
        />
        <button type="button" className="btn shrink-0 px-2" onClick={onDelete} aria-label={t('刪除事件 {n}', { n: index + 1 })} title={t('刪除')} data-testid="event-delete">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        <Field label={t('開始')}>
          {(id) => <NumberInput labelledBy={id} value={ev.atS} min={0} max={86400} unit="s" onChange={(v) => put('atS', v)} />}
        </Field>
        {!spec.noFor && <Field label={spec.forLabel ? t(spec.forLabel) : t('持續')}>
          {(id) =>
            spec.needsFor || typeof rec.forS === 'number' ? (
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <NumberInput labelledBy={id} value={typeof rec.forS === 'number' ? rec.forS : 10} min={0} max={86400} unit="s" onChange={(v) => put('forS', v)} />
                </div>
                {!spec.needsFor && <Switch on label={spec.forLabel ? t(spec.forLabel) : t('有結束時間')} onChange={() => put('forS', undefined)} />}
              </div>
            ) : (
              <div className="flex h-[30px] items-center gap-1.5 text-[13px]">
                <Switch on={false} label={spec.forLabel ? t(spec.forLabel) : t('有結束時間')} onChange={() => put('forS', Math.max(1, Math.round(durationS / 4)))} />
                <span className="faint">{spec.forOff ? t(spec.forOff) : t('直到結束')}</span>
              </div>
            )
          }
        </Field>}
      </div>
      {spec.target === 'node' && (
        <Field label={t('對象')}>
          {() => (
            <Select
              aria-label={t('對象')}
              data-testid="event-node"
              value={node ?? (spec.anyNode ? '' : undefined)}
              placeholder={t('選一個元件')}
              options={[...(spec.anyNode ? [{ value: '', label: t(spec.anyNode) }] : []), ...eventNodes(design, ev.type).map((n) => ({ value: n.id, label: n.label }))]}
              onChange={(v) => {
                const next: Record<string, unknown> = { ...rec, node: v };
                if (v === '') delete next.node;
                delete next.instance;
                onChange(next as ScenarioEvent);
              }}
            />
          )}
        </Field>
      )}
      {spec.instance && insts > 1 && (
        <Field label={t('哪一台')}>
          {() => (
            <Select
              aria-label={t('哪一台')}
              data-testid="event-instance"
              value={typeof rec.instance === 'number' ? rec.instance : -1}
              options={[
                { value: -1, label: t('全部') },
                ...Array.from({ length: insts }, (_, i) => ({ value: i, label: t('第 {n} 台', { n: i + 1 }) })),
              ]}
              onChange={(v) => put('instance', v < 0 ? undefined : v)}
            />
          )}
        </Field>
      )}
      {spec.target === 'edge' && (
        <Field label={t('連線')}>
          {() => (
            <Select
              aria-label={t('連線')}
              data-testid="event-edge"
              value={typeof rec.from === 'string' && typeof rec.to === 'string' ? `${rec.from}->${rec.to}` : undefined}
              placeholder={t('選一條連線')}
              options={eventEdges(design).map((e) => ({ value: `${e.from}->${e.to}`, label: e.label }))}
              onChange={(v) => {
                const [from, to] = v.split('->');
                onChange({ ...rec, from, to } as ScenarioEvent);
              }}
            />
          )}
        </Field>
      )}
      {spec.target === 'region' && (
        <Field label={t('區域')}>
          {() => (
            <Select
              aria-label={t('區域')}
              data-testid="event-region"
              value={typeof rec.region === 'string' ? rec.region : undefined}
              placeholder={t('選一個區域')}
              options={regionsOf(design).map((r) => ({ value: r, label: r }))}
              onChange={(v) => put('region', v)}
            />
          )}
        </Field>
      )}
      {spec.target === 'regions' && (
        <div className="grid grid-cols-2 gap-x-2">
          {[t('區域 A'), t('區域 B')].map((label, k) => (
            <Field key={k} label={label}>
              {() => (
                <Select
                  aria-label={label}
                  data-testid={`event-region-${k}`}
                  value={Array.isArray(rec.regions) ? (rec.regions[k] as string) : undefined}
                  placeholder={t('選一個區域')}
                  options={regionsOf(design).map((r) => ({ value: r, label: r }))}
                  onChange={(v) => {
                    const pair = Array.isArray(rec.regions) ? [...(rec.regions as string[])] : ['', ''];
                    pair[k] = v;
                    put('regions', pair);
                  }}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {spec.fields.length > 0 && (
        <div className="grid grid-cols-2 gap-x-2">
          {spec.fields.map((f) => (
            <EventNumber key={f.key} f={f} value={typeof rec[f.key] === 'number' ? (rec[f.key] as number) : undefined} onChange={(v) => put(f.key, v)} />
          ))}
        </div>
      )}
      {spec.flags?.map((f) => (
        <div key={f.key} className="flex h-[30px] items-center gap-1.5 text-[13px]" data-testid={`event-flag-${f.key}`}>
          <Switch on={rec[f.key] === true} label={t(f.label)} onChange={(on) => put(f.key, on ? true : undefined)} />
          <span>{t(f.label)}</span>
        </div>
      ))}
      <Help text={t(spec.help)} />
    </li>
  );
}

function EventNumber({ f, value, onChange }: { f: EventNumField; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <Field label={t(f.label)}>
      {(id) =>
        f.optional && value === undefined ? (
          <div className="flex h-[30px] items-center gap-1.5 text-[13px]">
            <Switch on={false} label={t(f.label)} onChange={() => onChange(f.min || 1)} />
            <span className="faint">{t('不用')}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <NumberInput labelledBy={id} value={value ?? f.min} min={f.min} max={f.max} scale={f.scale} unit={f.unit} onChange={onChange} />
            </div>
            {f.optional && <Switch on label={t(f.label)} onChange={() => onChange(undefined)} />}
          </div>
        )
      }
    </Field>
  );
}
