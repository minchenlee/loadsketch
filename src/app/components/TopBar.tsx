import { useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, ClipboardPaste, Download, Ellipsis, Dumbbell, FileInput, GraduationCap, Link2, Redo2, Undo2, FilePlus2, FolderOpen, Languages, Moon, PanelBottom, PanelLeft, PanelRight, Sun } from 'lucide-react';
import logoBlack from '../assets/logo-black.svg';
import logoWhite from '../assets/logo-white.svg';
import { DESIGN_SCHEMA, parseDesign } from '../../schema/design.ts';
import { EMBEDDED, useApp, type Panels } from '../store.ts';
import { REPO } from '../../repo.ts';
import { ExampleBrowser } from './ExampleBrowser.tsx';
import { EXAMPLE_PLANS, ImportTerraform } from './ImportTerraform.tsx';
import { PracticeDialog } from './Practice.tsx';
import { PasteDesign } from './PasteDesign.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { encodeShare, SHARE_WARN_CHARS } from '../share.ts';
import { IS_MAC, SHORTCUT } from '../ui.ts';
import { t, tx } from '../../i18n/index.ts';
import { usePhone } from '../phone.ts';
import { importMessage } from '../../i18n/importMessages.ts';
import { importTerraform, PlanError, runChecks } from '../../import/terraform/index.ts';

/** The course page (/learn/), next to the simulator's own /app/. */
const COURSE_URL = '../learn/';

const PANEL_BUTTONS: { key: keyof Panels; label: string; Icon: typeof PanelLeft }[] = [
  { key: 'left', label: tx('Component panel'), Icon: PanelLeft },
  { key: 'bottom', label: tx('Metrics panel'), Icon: PanelBottom },
  { key: 'right', label: tx('Settings panel'), Icon: PanelRight },
];

export function TopBar() {
  const doc = useApp((s) => s.doc);
  const dirty = useApp((s) => s.dirty);
  const theme = useApp((s) => s.theme);
  const load = useApp((s) => s.load);
  const [browse, setBrowse] = useState(false);
  const [practice, setPractice] = useState(false);
  const exportText = useApp((s) => s.exportText);
  const setTheme = useApp((s) => s.setTheme);
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const panels = useApp((s) => s.panels);
  const togglePanel = useApp((s) => s.togglePanel);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const file = useRef<HTMLInputElement>(null);
  const planFile = useRef<HTMLInputElement>(null);
  const [shared, setShared] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pasting, setPasting] = useState(false);

  // the link holds the design and the scenario; it goes to the clipboard, or to the address bar when
  // the clipboard is not allowed
  const share = async () => {
    const st = useApp.getState();
    const hash = await encodeShare({ design: st.design(), scenario: st.scenario });
    const url = `${location.origin}${location.pathname}#${hash}`;
    if (url.length > SHARE_WARN_CHARS) useApp.setState({ error: t('The share link is long ({n} characters); some chat apps cut it. For a big design, share the file from "Save as JSON".', { n: url.length }) });
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      history.replaceState(null, '', url);
      useApp.setState({ error: t('Cannot write to the clipboard: the link is in the address bar, copy it from there.') });
    }
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  };

  const save = () => {
    const blob = new Blob([exportText()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.replace(/[\\/:*?"<>|]+/g, '-') || 'design'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    useApp.getState().markSaved();
  };

  const open = async (f: File) => {
    try {
      const r = parseDesign(JSON.parse(await f.text()));
      if (!r.ok) {
        useApp.setState({ error: t('Cannot open {file}: {why}', { file: f.name, why: r.issues[0]?.message ?? t('Bad format') }) });
        return;
      }
      load(r.value);
    } catch (e) {
      useApp.setState({ error: t('Cannot open {file}: {why}', { file: f.name, why: (e as Error).message }) });
    }
  };

  // Terraform import (M29, Q21): the same flow as "open", with the plan JSON (`terraform show -json`)
  const importPlan = async (f: File) => {
    // a .tf file is the source, not the plan: say how to make the plan
    if (/\.tf$/i.test(f.name)) {
      useApp.setState({ error: t('Cannot import {file}: this is a Terraform source file (.tf). Run terraform plan -out plan.out, then terraform show -json plan.out > plan.json, and import plan.json.', { file: f.name }) });
      return;
    }
    let plan: unknown;
    try {
      plan = JSON.parse(await f.text());
    } catch {
      useApp.setState({ error: t('Cannot import {file}: this is not JSON. Import the plan JSON that terraform show -json writes.', { file: f.name }) });
      return;
    }
    importPlanJson(f.name, plan);
  };
  const importPlanJson = (fileName: string, plan: unknown) => {
    try {
      const r = importTerraform(plan, { name: fileName.replace(/\.(plan\.)?json$/i, '').slice(0, 120) });
      // the same validation as "open": a design the schema rejects is not loaded
      const v = parseDesign(r.design);
      if (!v.ok) {
        useApp.setState({ error: t('Cannot import {file}: {why}', { file: fileName, why: v.issues[0]?.message ?? t('Bad format') }) });
        return;
      }
      useApp.getState().loadImport(fileName, r.design, runChecks(r));
    } catch (e) {
      const why = e instanceof PlanError ? importMessage(e.id, e.args) : (e as Error).message;
      useApp.setState({ error: t('Cannot import {file}: {why}', { file: fileName, why }) });
    }
  };
  const importExample = async (id: string) => {
    const p = EXAMPLE_PLANS.find((x) => x.id === id);
    if (!p) return;
    setImporting(false);
    importPlanJson(`${id}.plan.json`, await p.load());
  };

  const fileItems: MenuItem[] = [
    { label: t('New design'), icon: <FilePlus2 size={14} />, onSelect: () => load({ schema: DESIGN_SCHEMA, name: t('Untitled design'), nodes: [], edges: [] }), 'data-testid': 'new-design' },
    { label: t('Open'), icon: <FolderOpen size={14} />, onSelect: () => file.current?.click() },
    { label: t('Paste design JSON'), icon: <ClipboardPaste size={14} />, onSelect: () => setPasting(true), title: t('Change the design with an AI: copy a prompt for it, then paste its answer back; or paste a design JSON someone gave you'), 'data-testid': 'paste-design-open' },
    { label: t('Import Terraform'), icon: <FileInput size={14} />, onSelect: () => setImporting(true), title: t('Turn a Terraform plan (the output of terraform show -json) into a design'), 'data-testid': 'import-terraform' },
    { label: t('Save as JSON'), icon: <Download size={14} />, onSelect: save, sep: true, 'data-testid': 'save-json' },
  ];
  const phone = usePhone();
  // a phone has no room for these in the bar: they are in the menu
  const phoneItems: MenuItem[] = [
    { label: t('Share'), icon: <Link2 size={14} />, onSelect: () => void share(), 'data-testid': 'phone-share' },
    { label: t('Undo'), icon: <Undo2 size={14} />, onSelect: undo },
    { label: t('Redo'), icon: <Redo2 size={14} />, onSelect: redo },
  ];
  const moreItems: MenuItem[] = [
    ...(phone ? phoneItems : []),
    // the course link is in the bar on a wide window; the course's own frame does not link to it
    ...(phone && !EMBEDDED ? [{ label: t('Course'), icon: <GraduationCap size={14} />, onSelect: () => void location.assign(COURSE_URL), 'data-testid': 'course-item' }] : []),
    // a phone has no room for the GitHub button either (M16); the embedded app links nowhere
    ...(phone && !EMBEDDED ? [{ label: 'GitHub', icon: <GithubMark />, onSelect: () => void window.open(REPO, '_blank', 'noopener,noreferrer'), title: t('View the source on GitHub'), 'data-testid': 'github-item' }] : []),
    { label: lang === 'en' ? '切換成中文' : 'Switch to English', sep: phone, icon: <Languages size={14} />, onSelect: () => setLang(lang === 'en' ? 'zh-TW' : 'en'), 'data-testid': 'lang' },
    { label: t('Toggle light/dark'), icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'), 'data-testid': 'theme' },
  ];

  return (
    <header className="panel flex h-12 shrink-0 items-center gap-2 border-b px-3">
      {/* the logo: a black tile on the light theme, a white tile on the dark theme */}
      <img src={logoBlack} alt="" width={28} height={28} className="shrink-0 dark:hidden" />
      <img src={logoWhite} alt="" width={28} height={28} className="hidden shrink-0 dark:block" />
      <span className="sd-desk shrink-0 whitespace-nowrap font-semibold tracking-tight">loadsketch</span>
      {/* the subtitle goes first when the bar is short of room, then the name field narrows */}
      <span className="faint hidden shrink-0 whitespace-nowrap xl:inline">{t('System design simulator')}</span>
      <div className="sd-desk mx-2 h-5 w-px shrink-0" style={{ background: 'var(--line)' }} />
      {/* the design: its name, and next to it what you do with the file */}
      <input
        className="field sd-name w-[340px] shrink font-medium"
        style={{ minWidth: 140 }}
        value={doc.name}
        aria-label={t('Design name')}
        onChange={(e) => useApp.getState().rename(e.target.value)}
      />
      <Menu items={fileItems} className="btn shrink-0 px-1.5" aria-label={t('File')} title={t('File')} data-testid="file-menu">
        <ChevronDown size={15} />
      </Menu>
      {dirty && <span className="sd-pill sd-desk shrink-0 whitespace-nowrap" style={{ '--pill': 'var(--warn)' } as React.CSSProperties}>{t('Not saved')}</span>}
      <div className="seg sd-desk ml-1 shrink-0" role="group" aria-label={t('Edit history')}>
        <button className="btn px-2" onClick={undo} disabled={!canUndo} aria-label={t('Undo')} title={t('Undo ({key})', { key: IS_MAC ? '⌘Z' : 'Ctrl+Z' })} data-testid="undo">
          <Undo2 size={15} />
        </button>
        <button className="btn px-2" onClick={redo} disabled={!canRedo} aria-label={t('Redo')} title={t('Redo ({key})', { key: IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z' })} data-testid="redo">
          <Redo2 size={15} />
        </button>
      </div>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
      {pasting && <PasteDesign onClose={() => setPasting(false)} />}
      {importing && (
        <ImportTerraform
          onClose={() => setImporting(false)}
          onPick={() => {
            setImporting(false);
            planFile.current?.click();
          }}
          onExample={(id) => void importExample(id)}
        />
      )}
      <input
        ref={planFile}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="import-terraform-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importPlan(f);
        }}
      />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button className="btn" onClick={() => setBrowse(true)} aria-label={t('Examples')} data-testid="open-examples">
          <BookOpen size={14} /> <span className="sd-desk">{t('Examples')}</span>
        </button>
        {browse && <ExampleBrowser onClose={() => setBrowse(false)} />}
        <button className="btn" onClick={() => setPractice(true)} title={t('Design briefs, constraint problems, on-call practice and your guess record')} aria-label={t('Practice')} data-testid="open-practice">
          <Dumbbell size={14} /> <span className="sd-desk">{t('Practice')}</span>
        </button>
        {practice && <PracticeDialog onClose={() => setPractice(false)} />}
        {!EMBEDDED && (
          <a className="btn sd-desk" href={COURSE_URL} aria-label={t('Course')} title={t('Lessons: guess, run, read why, change the design')} data-testid="open-course">
            {/* the label only where the bar has room for a fourth one (docs/design-system.md section 6) */}
            <GraduationCap size={14} /> <span className="hidden lg:inline">{t('Course')}</span>
          </a>
        )}
        <div className="sd-desk mx-1 h-5 w-px" style={{ background: 'var(--line)' }} />
        <button className="btn sd-desk" onClick={() => void share()} title={t('Put the design and the scenario into one URL: anyone who opens it gets both')} data-testid="share">
          {shared ? <Check size={14} /> : <Link2 size={14} />} {shared ? t('Link copied') : t('Share')}
        </button>
        <div className="seg sd-desk" role="group" aria-label={t('Panel')}>
          {PANEL_BUTTONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`btn px-2 ${panels[key] ? 'btn-on' : ''}`}
              onClick={() => togglePanel(key)}
              aria-pressed={panels[key]}
              aria-label={panels[key] ? t('Hide {panel}', { panel: t(label) }) : t('Show {panel}', { panel: t(label) })}
              title={panels[key] ? t('Hide {panel} ({key})', { panel: t(label), key: SHORTCUT[key] }) : t('Show {panel} ({key})', { panel: t(label), key: SHORTCUT[key] })}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
        {!EMBEDDED && (
          <a className="btn sd-desk px-2" href={REPO} target="_blank" rel="noopener noreferrer" aria-label="GitHub" title={t('View the source on GitHub')} data-testid="github-link">
            <GithubMark />
          </a>
        )}
        <Menu items={moreItems} className="btn px-2" align="end" aria-label={t('More')} title={t('More')} data-testid="more-menu">
          <Ellipsis size={15} />
        </Menu>
      </div>
    </header>
  );
}

/** The GitHub mark (Octicons mark-github, MIT): lucide has no brand icons. */
function GithubMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}
