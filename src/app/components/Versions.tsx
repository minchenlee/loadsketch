// The version list (roadmap-next M1): every finished run, newest first. Rename, pin, delete, put
// back on the canvas, export to a file and import from one.
import { useRef } from 'react';
import { Download, FileInput, Pin, PinOff, Trash2, Upload } from 'lucide-react';
import { useApp } from '../store.ts';
import { MAX_VERSIONS, parseVersionFile, versionFile, type Version } from '../versions.ts';
import { fmtMs, pct } from '../ui.ts';
import { fmtUsd } from '../../learn/cost.ts';
import { getLang, t } from '../../i18n/index.ts';

/** The time of a version: the clock today, the date and clock before. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const locale = getLang() === 'en' ? 'en-US' : 'zh-TW';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** The scenario of a version, as one short line: its name, and the seed when it is not the default. */
export function scenarioLine(v: Version): string {
  const name = v.scenario.name ? t(v.scenario.name) : t('自訂');
  return v.scenario.seed !== undefined && v.scenario.seed !== 1 ? t('{name}，種子 {seed}', { name, seed: v.scenario.seed }) : name;
}

export function Versions() {
  const versions = useApp((s) => s.versions);
  const file = useRef<HTMLInputElement>(null);

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
      useApp.setState({ error: t('打不開 {file}：這不是 loadsketch 匯出的版本檔。', { file: f.name }) });
      return;
    }
    useApp.getState().importVersions(r.versions);
    if (r.skipped) useApp.setState({ error: t('{file} 裡有 {n} 個版本格式不對，沒有匯入。', { file: f.name, n: r.skipped }) });
  };

  return (
    <div data-testid="versions">
      <div className="flex items-start gap-2">
        <p className="muted flex-1 text-[13px] leading-snug">{t('每次執行完會自動留一個版本，最多 {n} 個；釘選的不會被擠掉。版本存在這個瀏覽器裡。', { n: MAX_VERSIONS })}</p>
        <button className="btn shrink-0 px-2" onClick={exportAll} disabled={!versions.length} title={t('把所有版本存成一個檔案')} aria-label={t('匯出版本')} data-testid="versions-export">
          <Download size={14} />
        </button>
        <button className="btn shrink-0 px-2" onClick={() => file.current?.click()} title={t('從檔案加入版本')} aria-label={t('匯入版本')} data-testid="versions-import">
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
      {!versions.length && <div className="faint mt-6 text-center text-[14px]" data-testid="versions-empty">{t('還沒有版本。按「執行」，跑完就會出現在這裡。')}</div>}
      <ul className="mt-2 space-y-2">
        {versions.map((v) => (
          <VersionRow key={v.id} v={v} />
        ))}
      </ul>
    </div>
  );
}

function VersionRow({ v }: { v: Version }) {
  const s = v.summary;
  const st = useApp.getState;
  return (
    <li className="card px-2.5 py-2" data-testid="version" data-version={v.id} data-pinned={v.pinned || undefined}>
      <div className="flex items-center gap-1.5">
        <input className="field min-w-0 flex-1 py-0.5 font-medium" value={v.name} aria-label={t('版本名稱')} onChange={(e) => st().renameVersion(v.id, e.target.value)} data-testid="version-name" />
        <button className={`btn px-1.5 ${v.pinned ? 'btn-on' : ''}`} onClick={() => st().pinVersion(v.id, !v.pinned)} aria-pressed={v.pinned} aria-label={v.pinned ? t('取消釘選') : t('釘選')} title={v.pinned ? t('取消釘選') : t('釘選：不會被新的版本擠掉')} data-testid="version-pin">
          {v.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="btn px-1.5" onClick={() => st().loadVersion(v.id)} aria-label={t('載回畫布')} title={t('把這個版本的設計和情境放回畫布')} data-testid="version-load">
          <Upload size={14} />
        </button>
        <button className="btn px-1.5" onClick={() => st().removeVersion(v.id)} aria-label={t('刪除版本')} title={t('刪除版本')} data-testid="version-delete">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="faint mt-1 text-[12px]">
        <span className="num">{fmtWhen(v.at)}</span> · {scenarioLine(v)}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px]" data-testid="version-numbers">
        <span>
          {t('錯誤率')} <span className="num font-medium" style={{ color: s.errorRate > 0 ? 'var(--bad-ink)' : undefined }}>{pct(s.errorRate)}</span>
        </span>
        <span>
          p99 <span className="num font-medium">{fmtMs(s.p99)}</span>
        </span>
        <span>
          {t('每月')} <span className="num font-medium">{fmtUsd(s.costPerMonth)}</span>
        </span>
      </div>
    </li>
  );
}
