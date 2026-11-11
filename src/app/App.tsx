import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas.tsx';
import { LessonJudge } from './components/Learn.tsx';
import { OnCallJudge } from './components/OnCall.tsx';
import { ConstraintJudge } from './components/Constraints.tsx';
import { Inspector } from './components/Inspector.tsx';
import { Metrics } from './components/Metrics.tsx';
import { Palette } from './components/Palette.tsx';
import { RunBar } from './components/RunBar.tsx';
import { Slide } from './components/Slide.tsx';
import { TopBar } from './components/TopBar.tsx';
import { SCENARIOS, SPEEDS, useApp } from './store.ts';
import { IS_MAC } from './ui.ts';
import { decodeShare, isShareHash } from './share.ts';
import { t } from '../i18n/index.ts';
import { PracticeOverlay } from './components/Practice.tsx';
import { PhoneDrawer, PhoneTabs } from './components/Phone.tsx';
import { isPhone, usePhone } from './phone.ts';

/** Open the design and scenario of a share link (#s=…). False when the hash holds none. */
async function openShared(): Promise<boolean> {
  if (!isShareHash(location.hash)) return false;
  const r = await decodeShare(location.hash);
  const st = useApp.getState();
  if (!r.ok) {
    useApp.setState({ error: t('打不開分享連結：{why}', { why: r.why }) });
    return false;
  }
  st.load(r.value.design);
  st.setScenario(r.value.scenario);
  return true;
}

// URL options, for sharing a state and for headless screenshots:
//   ?example=three-tier&scenario=spike&speed=0.1&autorun=1&theme=dark&select=api
// A share link (#s=…) holds a whole design and scenario: it wins over ?example and ?scenario.
function useUrlOptions() {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const st = useApp.getState();
    st.loadExample(q.get('example') ?? 'three-tier');
    const sc = q.get('scenario');
    if (sc && SCENARIOS[sc]) st.setScenario(structuredClone(SCENARIOS[sc]));
    // a link pasted into this tab changes only the hash: no reload
    const onHash = () => void openShared();
    window.addEventListener('hashchange', onHash);
    void openShared().then((shared) => {
      if (shared && q.get('autorun')) setTimeout(() => useApp.getState().run(), 300);
    });
    const sp = Number(q.get('speed'));
    if (SPEEDS.includes(sp)) st.setSpeed(sp);
    const sel = q.get('select');
    if (sel) {
      useApp.setState({ selected: { type: 'node', id: sel }, nodes: useApp.getState().nodes.map((n) => ({ ...n, selected: n.id === sel })) });
    }
    if (q.get('autorun') && !isShareHash(location.hash)) setTimeout(() => useApp.getState().run(), 300);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}

/**
 * ?embed=1: the simulator inside another page (the intro site shows it in an iframe). The top bar
 * and the component list are left out. &panels=right,bottom picks the panels (the saved choice is
 * not read or changed); &bar=0 leaves the run bar out; &loop=1 runs again a moment after a run ends.
 * &phone=1: in a frame as narrow as a phone, the whole phone layout is shown; &drawer=metrics (or
 * palette, inspector) opens that drawer at the start.
 */
const EMBED = (() => {
  const q = new URLSearchParams(location.search);
  if (!q.get('embed')) return null;
  const panels = (q.get('panels') ?? '').split(',');
  return { right: panels.includes('right'), bottom: panels.includes('bottom'), bar: q.get('bar') !== '0', loop: !!q.get('loop'), phone: q.get('phone') === '1', drawer: q.get('drawer') };
})();
if (EMBED?.phone && (EMBED.drawer === 'palette' || EMBED.drawer === 'inspector' || EMBED.drawer === 'metrics')) useApp.setState({ drawer: EMBED.drawer });
const LOOP_PAUSE_MS = 2500;

function useLoop() {
  const status = useApp((s) => s.status);
  useEffect(() => {
    if (!EMBED?.loop || status !== 'done') return;
    const id = setTimeout(() => useApp.getState().status === 'done' && useApp.getState().run(), LOOP_PAUSE_MS);
    return () => clearTimeout(id);
  }, [status]);
}

/**
 * Panel shortcuts (Ctrl instead of ⌘ outside macOS):
 *   ⌘B left panel (components), ⌥⌘B right panel (inspector), ⌘J bottom panel (metrics).
 * e.code is used because ⌥ changes e.key on macOS (⌥B types ∫).
 */
/** A modal dialog is open: the app behind it is inert and takes no shortcuts either. */
const modalOpen = () => !!document.getElementById('root')?.inert;

function usePanelKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.shiftKey) return;
      const p = e.code === 'KeyJ' && !e.altKey ? 'bottom' : e.code === 'KeyB' ? (e.altKey ? 'right' : 'left') : null;
      if (!p || EMBED) return;
      // also with a dialog open: the browser must not take the key (Ctrl+J opens Downloads on Windows/Linux)
      e.preventDefault();
      if (modalOpen()) return;
      const s = useApp.getState();
      // a phone-sized window has drawers in place of the panels
      if (isPhone()) {
        const d = p === 'left' ? 'palette' : p === 'right' ? 'inspector' : 'metrics';
        s.setDrawer(s.drawer === d ? null : d);
      } else s.togglePanel(p);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/**
 * Undo and redo of design edits: ⌘Z, ⇧⌘Z (also ⌘Y; Ctrl outside macOS). In a text field the
 * browser's own undo of the typed text applies instead.
 */
function useUndoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      if (!(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const redo = (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && !e.shiftKey);
      if (!redo && !(e.code === 'KeyZ' && !e.shiftKey)) return;
      e.preventDefault();
      if (redo) useApp.getState().redo();
      else useApp.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// Test hook: headless tests read the store through window.__loadsketch.
(window as unknown as { __loadsketch: typeof useApp }).__loadsketch = useApp;

export function App() {
  useUrlOptions();
  usePanelKeys();
  useUndoKeys();
  useLoop();
  // Remounted when the language changes, so every text is made again; the hooks above stay.
  const lang = useApp((s) => s.lang);
  return <Shell key={lang} />;
}

function Shell() {
  const saved = useApp((s) => s.panels);
  const panels = EMBED ? { left: false, right: EMBED.right, bottom: EMBED.bottom } : saved;
  const phone = usePhone() && (!EMBED || EMBED.phone);
  const drawer = useApp((s) => s.drawer);
  // a phone: the canvas alone, with the panels in drawers that come up from the bottom
  if (phone)
    return (
      <ReactFlowProvider>
        <div className="sd-phone flex h-full flex-col">
          <TopBar />
          <main className="relative min-h-0 min-w-0 flex-1">
            <Canvas />
            <PracticeOverlay />
            {/* the run controls float over the canvas, and move up to stay above an open drawer */}
            <div className="sd-runcard" data-up={drawer ? '' : undefined}>
              <RunBar />
            </div>
            <PhoneDrawer />
          </main>
          <LessonJudge />
          <OnCallJudge />
          <ConstraintJudge />
          <PhoneTabs />
        </div>
      </ReactFlowProvider>
    );
  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        {!EMBED && <TopBar />}
        <div className="flex min-h-0 flex-1">
          <Slide open={panels.left} axis="x" anchor="end">
            <Palette />
          </Slide>
          <main className="relative min-w-0 flex-1">
            <Canvas />
            <PracticeOverlay />
          </main>
          {/* judges lesson runs with the right panel hidden too */}
          <LessonJudge />
          <OnCallJudge />
          <ConstraintJudge />
          <Slide open={panels.right} axis="x">
            <Inspector />
          </Slide>
        </div>
        {(!EMBED || EMBED.bar) && <RunBar />}
        <Slide open={panels.bottom} axis="y">
          <Metrics />
        </Slide>
      </div>
    </ReactFlowProvider>
  );
}
