import { useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, Download, Ellipsis, Dumbbell, FileInput, Link2, Redo2, Undo2, FilePlus2, FolderOpen, Languages, Moon, PanelBottom, PanelLeft, PanelRight, Sun } from 'lucide-react';
import logoBlack from '../assets/logo-black.svg';
import logoWhite from '../assets/logo-white.svg';
import { DESIGN_SCHEMA, parseDesign } from '../../schema/design.ts';
import { useApp, type Panels } from '../store.ts';
import { ExampleBrowser } from './ExampleBrowser.tsx';
import { EXAMPLE_PLANS, ImportTerraform } from './ImportTerraform.tsx';
import { PracticeDialog } from './Practice.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { encodeShare, SHARE_WARN_CHARS } from '../share.ts';
import { IS_MAC, SHORTCUT } from '../ui.ts';
import { t, tx } from '../../i18n/index.ts';
import { usePhone } from '../phone.ts';
import { importMessage } from '../../i18n/importMessages.ts';
import { importTerraform, PlanError, runChecks } from '../../import/terraform/index.ts';

const PANEL_BUTTONS: { key: keyof Panels; label: string; Icon: typeof PanelLeft }[] = [
  { key: 'left', label: tx('元件面板'), Icon: PanelLeft },
  { key: 'bottom', label: tx('指標面板'), Icon: PanelBottom },
  { key: 'right', label: tx('設定面板'), Icon: PanelRight },
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

  // the link holds the design and the scenario; it goes to the clipboard, or to the address bar when
  // the clipboard is not allowed
  const share = async () => {
    const st = useApp.getState();
    const hash = await encodeShare({ design: st.design(), scenario: st.scenario });
    const url = `${location.origin}${location.pathname}#${hash}`;
    if (url.length > SHARE_WARN_CHARS) useApp.setState({ error: t('分享連結很長（{n} 個字元），有些聊天軟體會截斷。大的設計建議用「存成 JSON」分享。', { n: url.length }) });
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      history.replaceState(null, '', url);
      useApp.setState({ error: t('不能寫入剪貼簿：連結已放在網址列，從那裡複製。') });
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
        useApp.setState({ error: t('打不開 {file}：{why}', { file: f.name, why: r.issues[0]?.message ?? t('格式不對') }) });
        return;
      }
      load(r.value);
    } catch (e) {
      useApp.setState({ error: t('打不開 {file}：{why}', { file: f.name, why: (e as Error).message }) });
    }
  };

  // Terraform import (M29, Q21): the same flow as "open", with the plan JSON (`terraform show -json`)
  const importPlan = async (f: File) => {
    // a .tf file is the source, not the plan: say how to make the plan
    if (/\.tf$/i.test(f.name)) {
      useApp.setState({ error: t('不能匯入 {file}：這是 Terraform 原始檔（.tf）。先執行 terraform plan -out plan.out，再執行 terraform show -json plan.out > plan.json，然後匯入 plan.json。', { file: f.name }) });
      return;
    }
    let plan: unknown;
    try {
      plan = JSON.parse(await f.text());
    } catch {
      useApp.setState({ error: t('不能匯入 {file}：這不是 JSON。要匯入的是 terraform show -json 輸出的 plan JSON。', { file: f.name }) });
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
        useApp.setState({ error: t('不能匯入 {file}：{why}', { file: fileName, why: v.issues[0]?.message ?? t('格式不對') }) });
        return;
      }
      useApp.getState().loadImport(fileName, r.design, runChecks(r));
    } catch (e) {
      const why = e instanceof PlanError ? importMessage(e.id, e.args) : (e as Error).message;
      useApp.setState({ error: t('不能匯入 {file}：{why}', { file: fileName, why }) });
    }
  };
  const importExample = async (id: string) => {
    const p = EXAMPLE_PLANS.find((x) => x.id === id);
    if (!p) return;
    setImporting(false);
    importPlanJson(`${id}.plan.json`, await p.load());
  };

  const fileItems: MenuItem[] = [
    { label: t('新設計'), icon: <FilePlus2 size={14} />, onSelect: () => load({ schema: DESIGN_SCHEMA, name: t('未命名設計'), nodes: [], edges: [] }), 'data-testid': 'new-design' },
    { label: t('開啟'), icon: <FolderOpen size={14} />, onSelect: () => file.current?.click() },
    { label: t('匯入 Terraform'), icon: <FileInput size={14} />, onSelect: () => setImporting(true), title: t('把 Terraform plan（terraform show -json 的輸出）轉成設計'), 'data-testid': 'import-terraform' },
    { label: t('存成 JSON'), icon: <Download size={14} />, onSelect: save, sep: true, 'data-testid': 'save-json' },
  ];
  const phone = usePhone();
  // a phone has no room for these in the bar: they are in the menu
  const phoneItems: MenuItem[] = [
    { label: t('分享'), icon: <Link2 size={14} />, onSelect: () => void share(), 'data-testid': 'phone-share' },
    { label: t('復原'), icon: <Undo2 size={14} />, onSelect: undo },
    { label: t('重做'), icon: <Redo2 size={14} />, onSelect: redo },
  ];
  const moreItems: MenuItem[] = [
    ...(phone ? phoneItems : []),
    { label: lang === 'en' ? '切換成中文' : 'Switch to English', sep: phone, icon: <Languages size={14} />, onSelect: () => setLang(lang === 'en' ? 'zh-TW' : 'en'), 'data-testid': 'lang' },
    { label: t('切換深淺色'), icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'), 'data-testid': 'theme' },
  ];

  return (
    <header className="panel flex h-12 shrink-0 items-center gap-2 border-b px-3">
      {/* the logo: a black tile on the light theme, a white tile on the dark theme */}
      <img src={logoBlack} alt="" width={28} height={28} className="shrink-0 dark:hidden" />
      <img src={logoWhite} alt="" width={28} height={28} className="hidden shrink-0 dark:block" />
      <span className="sd-desk shrink-0 whitespace-nowrap font-semibold tracking-tight">loadsketch</span>
      {/* the subtitle goes first when the bar is short of room, then the name field narrows */}
      <span className="faint hidden shrink-0 whitespace-nowrap xl:inline">{t('系統設計模擬器')}</span>
      <div className="sd-desk mx-2 h-5 w-px shrink-0" style={{ background: 'var(--line)' }} />
      {/* the design: its name, and next to it what you do with the file */}
      <input
        className="field sd-name w-[340px] shrink font-medium"
        style={{ minWidth: 140 }}
        value={doc.name}
        aria-label={t('設計名稱')}
        onChange={(e) => useApp.getState().rename(e.target.value)}
      />
      <Menu items={fileItems} className="btn shrink-0 px-1.5" aria-label={t('檔案')} title={t('檔案')} data-testid="file-menu">
        <ChevronDown size={15} />
      </Menu>
      {dirty && <span className="sd-pill sd-desk shrink-0 whitespace-nowrap" style={{ '--pill': 'var(--warn)' } as React.CSSProperties}>{t('未儲存')}</span>}
      <div className="seg sd-desk ml-1 shrink-0" role="group" aria-label={t('編輯紀錄')}>
        <button className="btn px-2" onClick={undo} disabled={!canUndo} aria-label={t('復原')} title={t('復原（{key}）', { key: IS_MAC ? '⌘Z' : 'Ctrl+Z' })} data-testid="undo">
          <Undo2 size={15} />
        </button>
        <button className="btn px-2" onClick={redo} disabled={!canRedo} aria-label={t('重做')} title={t('重做（{key}）', { key: IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z' })} data-testid="redo">
          <Redo2 size={15} />
        </button>
      </div>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
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
        <button className="btn" onClick={() => setBrowse(true)} aria-label={t('範例')} data-testid="open-examples">
          <BookOpen size={14} /> <span className="sd-desk">{t('範例')}</span>
        </button>
        {browse && <ExampleBrowser onClose={() => setBrowse(false)} />}
        <button className="btn" onClick={() => setPractice(true)} title={t('限制條件題目、值班練習和先猜紀錄')} aria-label={t('練習')} data-testid="open-practice">
          <Dumbbell size={14} /> <span className="sd-desk">{t('練習')}</span>
        </button>
        {practice && <PracticeDialog onClose={() => setPractice(false)} />}
        <div className="sd-desk mx-1 h-5 w-px" style={{ background: 'var(--line)' }} />
        <button className="btn sd-desk" onClick={() => void share()} title={t('把設計和情境放進一個網址，貼給別人就能打開')} data-testid="share">
          {shared ? <Check size={14} /> : <Link2 size={14} />} {shared ? t('已複製連結') : t('分享')}
        </button>
        <div className="seg sd-desk" role="group" aria-label={t('面板')}>
          {PANEL_BUTTONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`btn px-2 ${panels[key] ? 'btn-on' : ''}`}
              onClick={() => togglePanel(key)}
              aria-pressed={panels[key]}
              aria-label={panels[key] ? t('隱藏{panel}', { panel: t(label) }) : t('顯示{panel}', { panel: t(label) })}
              title={panels[key] ? t('隱藏{panel}（{key}）', { panel: t(label), key: SHORTCUT[key] }) : t('顯示{panel}（{key}）', { panel: t(label), key: SHORTCUT[key] })}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
        <Menu items={moreItems} className="btn px-2" align="end" aria-label={t('更多')} title={t('更多')} data-testid="more-menu">
          <Ellipsis size={15} />
        </Menu>
      </div>
    </header>
  );
}
