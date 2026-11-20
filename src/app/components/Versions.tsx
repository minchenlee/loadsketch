// The version list (roadmap-next M1): every finished run, newest first. Rename, pin, delete, put
// back on the canvas, export to a file and import from one.
import { useRef, useState } from 'react';
import { Download, FileInput, GitCompareArrows, Pin, PinOff, Trash2, Upload } from 'lucide-react';
import { useApp } from '../store.ts';
import { MAX_VERSIONS, parseVersionFile, versionFile, type Version } from '../versions.ts';
import { MAX_COMPARE, type CompareItem } from '../compare.ts';
import { fmtMs, pct } from '../ui.ts';
import { fmtUsd } from '../../learn/cost.ts';
import { getLocaleInfo, t } from '../../i18n/index.ts';

/** The time of a version: the clock today, the date and clock before. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const locale = getLocaleInfo().intlLocale;
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** The scenario of a version, as one short line: its name, and the seed when it is not the default. */
export function scenarioLine(v: Version): string {
  const name = v.scenario.name ? t(v.scenario.name) : t('Custom');
  return v.scenario.seed !== undefined && v.scenario.seed !== 1 ? t('{name}, seed {seed}', { name, seed: v.scenario.seed }) : name;
}

export function Versions() {
  const versions = useApp((s) => s.versions);
  const memoryOnly = useApp((s) => s.versionsMemoryOnly);
  const file = useRef<HTMLInputElement>(null);
  // the versions ticked for comparing (ids that are gone are dropped)
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = picked.filter((id) => versions.some((v) => v.id === id));
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const compare = () => {
    // oldest first: the first one is the baseline
    const items: CompareItem[] = versions
      .filter((v) => chosen.includes(v.id))
      .sort((a, b) => a.at - b.at)
      .map((v) => ({ key: v.id, name: v.name, at: v.at, design: v.design, scenario: v.scenario, summary: v.summary }));
    useApp.getState().openCompare(items);
  };

  const exportAll = () => {
    const blob = new Blob([versionFile(versions)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'loadsketch-versions.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = async (f: File) => {
    const r = parseVersionFile(await f.text());
    if (!r.ok) {
      useApp.setState({ error: t('Cannot open {file}: it is not a version file exported by loadsketch.', { file: f.name }) });
      return;
    }
    useApp.getState().importVersions(r.versions);
    if (r.skipped) useApp.setState({ error: t('{n} versions in {file} have a wrong format and were not imported.', { file: f.name, n: r.skipped }) });
  };

  return (
    <div data-testid="versions">
      <div className="flex items-start gap-2">
        <p className="muted flex-1 text-[13px] leading-snug">{t('Every finished run keeps a version, up to {n}. Pinned versions are never pushed out. Versions are kept in this browser.', { n: MAX_VERSIONS })}</p>
        <button className="btn shrink-0 px-2" onClick={exportAll} disabled={!versions.length} title={t('Save all versions to one file')} aria-label={t('Export versions')} data-testid="versions-export">
          <Download size={14} />
        </button>
        <button className="btn shrink-0 px-2" onClick={() => file.current?.click()} title={t('Add versions from a file')} aria-label={t('Import versions')} data-testid="versions-import">
          <FileInput size={14} />
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="versions-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
      {memoryOnly && (
        <div className="card mt-2 px-2.5 py-1.5 text-[13px] leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--warn) 55%, var(--line))' }} data-testid="versions-memory-only">
          {t('This browser does not let the page store data: versions last only until the tab closes. To keep versions, export them to a file first.')}
        </div>
      )}
      {versions.length > 1 && (
        <div className="mt-2 flex items-center gap-2">
          <button className="btn btn-primary" onClick={compare} disabled={chosen.length < 2} data-testid="versions-compare">
            <GitCompareArrows size={14} /> {t('Compare ({n})', { n: chosen.length })}
          </button>
          <span className="faint text-[13px]">{chosen.length < 2 ? t('Tick 2 to {max} versions to compare them.', { max: MAX_COMPARE }) : t('The oldest is the baseline.')}</span>
        </div>
      )}
      {!versions.length && <div className="faint mt-6 text-center text-[14px]" data-testid="versions-empty">{t('No versions yet. Press "Run": when the run ends, it shows up here.')}</div>}
      <ul className="mt-2 space-y-2">
        {versions.map((v) => (
          <VersionRow key={v.id} v={v} picked={chosen.includes(v.id)} canPick={chosen.includes(v.id) || chosen.length < MAX_COMPARE} onPick={() => toggle(v.id)} />
        ))}
      </ul>
    </div>
  );
}

function VersionRow({ v, picked, canPick, onPick }: { v: Version; picked: boolean; canPick: boolean; onPick: () => void }) {
  const s = v.summary;
  const st = useApp.getState;
  return (
    <li className="card px-2.5 py-2" data-testid="version" data-version={v.id} data-pinned={v.pinned || undefined}>
      <div className="flex items-center gap-1.5">
        <input type="checkbox" className="shrink-0" checked={picked} disabled={!canPick} onChange={onPick} aria-label={t('Pick to compare')} title={canPick ? t('Pick to compare') : t('Compare at most {n}', { n: MAX_COMPARE })} data-testid="version-pick" />
        <input className="field min-w-0 flex-1 py-0.5 font-medium" value={v.name} aria-label={t('Version name')} onChange={(e) => st().renameVersion(v.id, e.target.value)} data-testid="version-name" />
        <button className={`btn px-1.5 ${v.pinned ? 'btn-on' : ''}`} onClick={() => st().pinVersion(v.id, !v.pinned)} aria-pressed={v.pinned} aria-label={v.pinned ? t('Unpin') : t('Pin')} title={v.pinned ? t('Unpin') : t('Pin: new versions will not push it out')} data-testid="version-pin">
          {v.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="btn px-1.5" onClick={() => st().loadVersion(v.id)} aria-label={t('Load onto canvas')} title={t('Put this version\'s design and scenario back on the canvas')} data-testid="version-load">
          <Upload size={14} />
        </button>
        <button className="btn px-1.5" onClick={() => st().removeVersion(v.id)} aria-label={t('Delete version')} title={t('Delete version')} data-testid="version-delete">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="faint mt-1 text-[12px]">
        <span className="num">{fmtWhen(v.at)}</span> · {scenarioLine(v)}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px]" data-testid="version-numbers">
        <span>
          {t('Error rate')} <span className="num font-medium" style={{ color: s.errorRate > 0 ? 'var(--bad-ink)' : undefined }}>{pct(s.errorRate)}</span>
        </span>
        <span>
          p99 <span className="num font-medium">{fmtMs(s.p99)}</span>
        </span>
        <span>
          {t('Per month')} <span className="num font-medium">{fmtUsd(s.costPerMonth)}</span>
        </span>
      </div>
    </li>
  );
}
