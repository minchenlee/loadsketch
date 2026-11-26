// The intro site (the page at /). The simulator is at /app/; the live panels on this page are that
// same simulator in an iframe with ?embed=1 (src/app/App.tsx), not pictures of it. The feature
// carousel shows screenshots of it (src/site/media/, made by scripts/site-shots.ts).
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useModal } from '../app/modal.ts';
import { ArrowLeft, ArrowRight, Code, Languages, Maximize2, Moon, Sun, Wrench, X, Zap, GraduationCap } from 'lucide-react';
import '../app/index.css';
import './site.css';
import logoBlack from '../app/assets/logo-black.svg';
import logoWhite from '../app/assets/logo-white.svg';
import { getAllLocales, getLocaleInfo, pickLang, setLang, t, tx, type Lang } from '../i18n/index.ts';
import { REPO } from '../repo.ts';

const APP = './app/';
const LEARN = './learn/';

type Theme = 'light' | 'dark';

/** The same order as the simulator: ?lang=, then the saved choice, then the browser language. */
function initialLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q) return pickLang(q);
  try {
    const saved = localStorage.getItem('loadsketch-lang');
    if (saved) return pickLang(saved);
  } catch {
    /* private mode */
  }
  return pickLang(navigator.language);
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A phone shows the canvas only: the run bar and the charts do not fit in a frame this narrow. */
const PHONE = matchMedia('(max-width: 720px)').matches;
const phoneQuery = (q: string) => `${q.replace('&panels=bottom', '')}&bar=0&controls=0`;
/** A screen the simulator's phone layout fits (480 px, plus the page's side margins): the frame shows that layout. */
const PHONE_APP_QUERY = '(max-width: 512px)';
/** A media query, followed as the window changes (a phone turned on its side). */
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
  );
}
const phoneAppQuery = (q: string, drawer?: string) => `${q.replace('&panels=bottom', '').replace('&bar=0', '')}&phone=1&focus=api${drawer ? `&drawer=${drawer}` : ''}`;
/** On a phone the frame is as flat as the design in it, so the canvas has no empty space. */
const PHONE_HEIGHT = 240;

/** Comes into view once: the element rises into place the first time it is on screen. */
function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el.current || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '0px 0px -8% 0px' });
    io.observe(el.current);
    return () => io.disconnect();
  }, [seen]);
  return (
    <div ref={el} className={`site-reveal ${className}`} data-seen={seen || undefined} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function WindowBar({ url, live }: { url?: string; live?: boolean }) {
  return (
    <div className="site-bar">
      <i />
      <i />
      <i />
      <span className="site-bar-url">{url}</span>
      {live && <span className="site-bar-live">LIVE</span>}
    </div>
  );
}

/** A live simulator in a window frame. It loads when it comes near the window, so the page opens fast. */
function Live({ query, height, lang, theme, title, open, drawer }: { query: string; height: number; lang: Lang; theme: Theme; title: string; open: string; drawer?: string }) {
  const box = useRef<HTMLDivElement>(null);
  // followed live: the frame's height and the layout inside it change together
  const phoneApp = useMedia(PHONE_APP_QUERY);
  const phone = useMedia('(max-width: 720px)');
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return (
    <div className="site-window site-live">
      <WindowBar url={`loadsketch.mclee.dev/app/?example=${open}`} live />
      <div ref={box} className={phoneApp ? 'site-live-phone' : undefined} style={phoneApp ? undefined : { height: phone ? PHONE_HEIGHT : height }}>
        {near && <iframe src={`${APP}?embed=1&${phoneApp ? phoneAppQuery(query, drawer) : phone ? phoneQuery(query) : query}&lang=${lang}&theme=${theme}`} title={title} />}
      </div>
    </div>
  );
}

/**
 * One screenshot over the whole window. A modal dialog: it is outside #root, the page behind it is
 * inert, Escape closes it and Tab stays in it (useModal). Focus goes back to where it was.
 */
function Zoom({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, []);
  return createPortal(
    <div ref={box} className="site-zoom" role="dialog" aria-modal aria-label={title} onClick={onClose} data-testid="site-zoom">
      <img src={src} alt={title} />
      <button className="btn site-round site-zoom-close" aria-label={t('Close')} autoFocus>
        <X size={16} />
      </button>
    </div>,
    document.body,
  );
}

/** The hero simulator leans back, and stands up as the page scrolls to it. */
function Stage({ children }: { children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || still() || PHONE) return;
    let raf = 0;
    const place = () => {
      raf = 0;
      const p = Math.min(1, scrollY / 380);
      node.style.transform = `perspective(1800px) rotateX(${(12 * (1 - p)).toFixed(2)}deg) scale(${(0.94 + 0.06 * p).toFixed(4)})`;
    };
    const onScroll = () => (raf ||= requestAnimationFrame(place));
    place();
    addEventListener('scroll', onScroll, { passive: true });
    return () => {
      removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div className="site-stage">
      <div ref={el} className="site-stage-tilt">
        {children}
      </div>
    </div>
  );
}

function Feature({ title, children, open, flip, live }: { title: string; children: React.ReactNode; open?: string; flip?: boolean; live: React.ReactNode }) {
  return (
    <section className="site-wrap site-wrap-wide site-feature mt-20 sm:mt-32" data-flip={flip || undefined}>
      <Reveal className="site-feature-text">
        <h2 className="site-h2">{title}</h2>
        <p className="site-lead mt-4">{children}</p>
        {open && (
          <a className="site-link mt-5" href={`${APP}?example=${open}`}>
            {t('Open this example')}
            <ArrowRight size={16} />
          </a>
        )}
      </Reveal>
      <Reveal delay={90}>{live}</Reveal>
    </section>
  );
}

// ---- the feature carousel: one screenshot of the simulator for each feature

const MEDIA = import.meta.glob<string>('./media/*.webp', { eager: true, query: '?url', import: 'default' });
const shot = (id: string, lang: Lang, theme: Theme) => {
  const tag = lang === 'zh-TW' ? 'zh' : lang;
  return MEDIA[`./media/${id}-${tag}-${theme}.webp`] ?? MEDIA[`./media/${id}-${lang}-${theme}.webp`] ?? MEDIA[`./media/${id}-en-${theme}.webp`];
};

const SLIDES = [
  { id: 'oncall', title: tx('On-call practice'), text: tx('Something is broken. You see only the error rate and the latency. Find it. Fix it.') },
  { id: 'brief', title: tx('Design from requirements'), text: tx('Only the requirements and an almost empty canvas. Build it, run it, and see if it holds.') },
  { id: 'why', title: tx('Why it happened'), text: tx('After every run, it tells you what happened. Step by step, in time order.') },
  { id: 'constraints', title: tx('Design on a budget'), text: tx('Hit the error-rate and latency targets. Stay in budget. Spend less, score more.') },
  { id: 'terraform', title: tx('Import Terraform'), text: tx('Turn plan JSON into a design. Run any capacity finding in one click.') },
  { id: 'examples', title: tx('48 examples'), text: tx('Cache stampede. Split brain. A bad config push. Run them. Change them.') },
];

function Carousel({ lang, theme }: { lang: Lang; theme: Theme }) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  // the slide nearest the middle of the track is the current one
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      [...el.children].forEach((c, i) => {
        const s = c as HTMLElement;
        if (Math.abs(s.offsetLeft + s.offsetWidth / 2 - mid) < Math.abs((el.children[best] as HTMLElement).offsetLeft + (el.children[best] as HTMLElement).offsetWidth / 2 - mid)) best = i;
      });
      setAt(best);
    };
    const onScroll = () => (raf ||= requestAnimationFrame(read));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  const go = (i: number) => {
    const el = track.current;
    const s = el?.children[Math.max(0, Math.min(SLIDES.length - 1, i))] as HTMLElement | undefined;
    if (el && s) el.scrollTo({ left: s.offsetLeft + s.offsetWidth / 2 - el.clientWidth / 2, behavior: still() ? 'auto' : 'smooth' });
  };
  const s = SLIDES[at];
  // the current screenshot, large: a phone shows it at full height and pans sideways
  const [big, setBig] = useState(false);
  return (
    <section className="mt-20 sm:mt-32" data-testid="site-carousel">
      {big && <Zoom src={shot(s.id, lang, theme)} title={t(s.title)} onClose={() => setBig(false)} />}
      <div
        ref={track}
        className="site-slides"
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={t('Features')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(at + 1);
          if (e.key === 'ArrowLeft') go(at - 1);
        }}
      >
        {SLIDES.map((sl, i) => (
          <div key={sl.id} className="site-slide site-window" data-on={i === at || undefined} onClick={() => (i === at ? setBig(true) : go(i))}>
            <div className="site-bar">
              <i />
              <i />
              <i />
              <span className="flex-1" />
              {i === at && (
                <button className="site-bar-zoom" aria-label={t('Enlarge')} title={t('Enlarge')}>
                  <Maximize2 size={14} />
                </button>
              )}
            </div>
            <img src={shot(sl.id, lang, theme)} alt={t(sl.title)} width={2160} height={1350} loading="lazy" draggable={false} />
          </div>
        ))}
      </div>
      <div className="site-wrap text-center">
        <div className="faint num text-[14px]">
          {at + 1} / {SLIDES.length}
        </div>
        {/* made again for each slide, so the words come in with it */}
        <div key={s.id} className="site-caption" aria-live="polite">
          <h2 className="site-h3 mt-1">{t(s.title)}</h2>
          <p className="site-lead mx-auto mt-2 max-w-[680px]">{t(s.text)}</p>
        </div>
        <div className="mt-5 flex items-center justify-center gap-3">
          <button className="btn site-round" onClick={() => go(at - 1)} disabled={at === 0} aria-label={t('Previous')}>
            <ArrowLeft size={16} />
          </button>
          <div className="flex gap-2.5">
            {SLIDES.map((sl, i) => (
              <button key={sl.id} className="site-dot" data-on={i === at || undefined} onClick={() => go(i)} aria-label={t(sl.title)} aria-current={i === at || undefined} />
            ))}
          </div>
          <button className="btn site-round" onClick={() => go(at + 1)} disabled={at === SLIDES.length - 1} aria-label={t('Next')}>
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

const EXAMPLES = [
  ['retry-storm', 'cache-stampede', 'split-brain', 'gray-failure', 'bad-config-push', 'fifo-poison', 'region-cutover', 'hot-shard', 'flash-sale', 'slow-dependency', 'blind-autoscaler', 'order-outbox'],
  ['hedged-reads', 'scatter-gather', 'quorum', 'lifo-codel', 'bulkhead-fallback', 'replica-lag', 'timeline-fanout', 'cdn-offload', 'tenant-limits', 'priority-shedding', 'autoscale', 'url-shortener'],
];

/** Two rows of example names that drift past; each opens that example. */
function Marquee() {
  return (
    <div className="site-marquee mt-12 sm:mt-14" aria-label={t('Examples')}>
      {EXAMPLES.map((row, i) => (
        <div key={i} className="site-marquee-row" data-back={i === 1 || undefined}>
          {/* the row twice, so the loop has no seam; the copy is hidden from screen readers */}
          {[0, 1].map((copy) => (
            <div key={copy} className="site-marquee-set" aria-hidden={copy === 1 || undefined}>
              {row.map((id) => (
                <a key={id} className="site-chip" href={`${APP}?example=${id}`} tabIndex={copy === 1 ? -1 : undefined}>
                  {id}
                </a>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The ways the footer can break, in turn. Each has a name and the story of what happened (as the simulator tells a run). */
const FAULTS = [
  { id: 'drop', name: tx('Links dropped'), story: [tx('The rule gave way at one end'), tx('Three links fell, one after another')] },
  { id: 'storm', name: tx('Retry storm'), story: [tx('The links got no answer and tried again'), tx('Every retry added more load. It kept growing')] },
  { id: 'partition', name: tx('Network partition'), story: [tx('The left side and the right side lost each other'), tx('Each side thinks it is the right one')] },
] as const;
/** When each line of the story shows, in seconds after the break. */
const STORY_AT = [0.4, 1.2];
const UNFIXED_AT = 2.5;
const SAMPLE_MS = 250;
const SAMPLES = 64;

/**
 * The footer takes the page's last line ("go break something") at its word. It has a status line,
 * an availability number with its chart, and a button that breaks it: a different fault each time.
 * An incident log tells what happened, and the same button fixes it. The links work in every state.
 */
function Footer() {
  // the number of breaks so far; the fault of break n is FAULTS[(n - 1) % 3]
  const [count, setCount] = useState(0);
  const [broken, setBroken] = useState(false);
  // time up and time down, for the availability number. The time before the first break counts as up.
  const born = useRef(performance.now());
  const [ms, setMs] = useState({ up: 0, down: 0 });
  // the last samples of up (1) and down (0), for the chart
  const [hist, setHist] = useState<number[]>([]);
  // this incident: seconds down so far, and its length once fixed
  const [downS, setDownS] = useState(0);
  const [fixedS, setFixedS] = useState<number | null>(null);
  const toggle = () => {
    if (!broken) {
      if (count === 0) {
        setMs({ up: performance.now() - born.current, down: 0 });
        setHist(Array<number>(SAMPLES / 2).fill(1));
      }
      setCount(count + 1);
      setDownS(0);
      setFixedS(null);
    } else setFixedS(downS);
    setBroken(!broken);
  };
  useEffect(() => {
    if (!count) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const d = now - last;
      last = now;
      setMs((m) => (broken ? { ...m, down: m.down + d } : { ...m, up: m.up + d }));
      setHist((h) => [...h, broken ? 0 : 1].slice(-SAMPLES));
      if (broken) setDownS((x) => x + d / 1000);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [broken, count]);
  const total = ms.up + ms.down;
  const availability = total ? (ms.up / total) * 100 : 100;
  const fault = count ? FAULTS[(count - 1) % FAULTS.length] : null;
  // each part's place when broken: the fall (degrees, pixels) and the side it is on in a partition
  const part = (r: number, y: number, side: -1 | 1) => ({ style: { '--r': `${r}deg`, '--y': `${y}px`, '--side': side } as React.CSSProperties });
  const link = (label: string, href: string, r: number, y: number) => (
    <a {...part(r, y, 1)} className="site-foot-part muted hover:underline" href={href} data-text={label}>
      {label}
    </a>
  );
  // the chart: a step line, high while up
  const W = 96, H = 18;
  const line = hist.map((v, i) => `${i ? 'L' : 'M'}${((i / (SAMPLES - 1)) * W).toFixed(1)} ${v ? 3 : H - 3}`).join(' ');
  const log: [number, string][] = fault
    ? [[0, t('Someone pressed “Break it”')], ...fault.story.map((x, i): [number, string] => [STORY_AT[i], t(x)]), [UNFIXED_AT, t('Nobody has come to fix it yet')]]
    : [];
  const seen = fixedS ?? downS;
  return (
    <footer className="site-wrap site-foot mt-20 sm:mt-32" data-broken={broken || undefined} data-fault={broken ? fault?.id : undefined} data-testid="site-footer">
      <div className="site-foot-status" role="status">
        <span className="site-foot-dot" aria-hidden />
        <span className="font-medium">{broken && fault ? t('The footer is down: {fault}', { fault: t(fault.name) }) : t('The footer is up')}</span>
        <span className="faint num" data-testid="site-footer-availability">
          {t('Availability {p}%', { p: availability.toFixed(2) })}
        </span>
        {count > 0 && (
          <svg className="site-foot-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            <path d={line} />
          </svg>
        )}
        <span className="flex-1" />
        <button className="btn" onClick={toggle} data-testid="site-footer-break">
          {broken ? <Wrench size={14} /> : <Zap size={14} />}
          {broken ? t('Fix it') : count ? t('Break it again') : t('Break it')}
        </button>
      </div>
      <div className="site-foot-row">
        <span {...part(-2, 10, -1)} className="site-foot-part faint">
          {t('MIT license. The examples are simplified models, not any company\'s real architecture.')}
        </span>
        <span className="flex-1" />
        {link('GitHub', REPO, 7, 18)}
        {link(t('How the model works'), `${REPO}/blob/main/docs/model.md`, -11, 34)}
        {link(t('Contribute'), `${REPO}/blob/main/CONTRIBUTING.md`, 16, 24)}
      </div>
      {fault && (
        <div className="site-foot-log" data-testid="site-footer-log">
          <div className="faint">{t('Incident #{n}: {fault}', { n: count, fault: t(fault.name) })}</div>
          {log
            .filter(([at]) => at <= seen)
            .map(([at, text]) => (
              <div key={at} className="site-foot-line">
                <span className="faint num">{at.toFixed(1)}s</span>
                {text}
              </div>
            ))}
          {fixedS !== null && (
            <div className="site-foot-line" data-ok>
              <span className="faint num">{fixedS.toFixed(1)}s</span>
              {t('Fixed. Down for {s} s.', { s: fixedS.toFixed(1) })}
            </div>
          )}
        </div>
      )}
    </footer>
  );
}

// The output of this command, as the CLI prints it.
const CLI_CMD = 'node cli/loadsketch.ts run examples/designs/three-tier.json \\\n    --scenario examples/scenarios/spike.json';
const CLI_OUT = `Requests: 51,317 offered, 46,116 ok, 5,201 failed (error rate 10.13%)
  Failure reasons: Rejected because the queue is full 5,201
Latency of successful requests (ms): mean 515, p50 83.2, p95 1209, p99 1233

Bottleneck: API server (3 instances all busy) is saturated around
second 22 (busy 100% at that second, 1,497 queued).`;

function Site() {
  const [lang, setL] = useState<Lang>(initialLang);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  setLang(lang);
  useEffect(() => {
    document.documentElement.lang = getLocaleInfo(lang).htmlLang;
  }, [lang]);
  const allLocales = getAllLocales();
  const langIdx = allLocales.findIndex((x) => x.code === lang);
  const nextLocale = allLocales[(langIdx + 1) % allLocales.length] ?? allLocales[0];
  const nextLangLabel = allLocales.length <= 2 ? (lang === 'en' ? '中文' : 'English') : nextLocale.label;
  const flipLang = () => {
    save('loadsketch-lang', nextLocale.code);
    setL(nextLocale.code);
  };
  const flipTheme = () => {
    const th: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', th === 'dark');
    save('loadsketch-theme', th);
    setTheme(th);
  };
  const live = { lang, theme };

  return (
    <div className="overflow-x-clip pb-14">
      <div className="site-wrap pt-3" style={{ position: 'sticky', top: 0, zIndex: 20 }}>
        <nav className="site-nav flex items-center gap-2 px-3 py-2">
          <img src={logoBlack} alt="" width={26} height={26} className="shrink-0 dark:hidden" />
          <img src={logoWhite} alt="" width={26} height={26} className="hidden shrink-0 dark:block" />
          <span className="text-[16px] font-semibold">loadsketch</span>
          <span className="flex-1" />
          <button className="btn" onClick={flipLang} aria-label={t('Language')} title={t('Language')} data-testid="site-lang">
            <Languages size={16} />
            <span className="hidden sm:inline">{nextLangLabel}</span>
          </button>
          <button className="btn" onClick={flipTheme} aria-label={t('Dark / light')} title={t('Dark / light')} data-testid="site-theme">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <a className="btn" href={LEARN} aria-label={t('Course')} data-testid="site-course">
            <GraduationCap size={16} />
            <span className="hidden sm:inline">{t('Course')}</span>
          </a>
          <a className="btn site-wide" href={REPO}>
            <Code size={16} />
            GitHub
          </a>
          <a className="btn btn-primary" href={APP} data-testid="site-open">
            {t('Open the simulator')}
          </a>
        </nav>
      </div>

      <header className="site-wrap mt-12 text-center sm:mt-24">
        {/* one line per sentence; each line comes in after the one before */}
        <h1 className="site-h1" key={lang}>
          <span className="site-line">{t('Sketch a system.')}</span>{' '}
          <span className="site-line">{t('Send traffic.')}</span>{' '}
          <span className="site-line">
            {t('See what ')}
            <em>{t('breaks first.')}</em>
          </span>
        </h1>
        <p className="site-lead site-rise mx-auto mt-7 max-w-[560px]">{t('A system design simulator. Every request runs for real.')}</p>
        <div className="site-rise mt-8 flex flex-wrap justify-center gap-2.5" style={{ animationDelay: '520ms' }}>
          <a className="btn btn-primary site-cta" href={APP}>
            {t('Open the simulator')}
            <ArrowRight size={18} />
          </a>
          <a className="btn site-cta" href={LEARN} data-testid="site-course-cta">
            <GraduationCap size={18} />
            {t('Start the course')}
          </a>
          <a className="btn site-cta" href={REPO}>
            <Code size={18} />
            {t('View the source')}
          </a>
        </div>
      </header>

      <div className="site-wrap site-wrap-wide site-rise mt-10 sm:mt-14" style={{ animationDelay: '640ms' }}>
        <Stage>
          <Live {...live} height={640} open="three-tier" query="example=three-tier&autorun=1&loop=1&panels=bottom" title={t('A three-tier design in a traffic spike')} />
        </Stage>
      </div>

      <Feature
        title={t('See every request.')}
        open="async-queue"
        live={<Live {...live} height={420} open="async-queue" query="example=async-queue&speed=0.1&autorun=1&loop=1&bar=0" title={t('Slow motion: single requests go along the whole path')} />}
      >
        {t('Slow to 0.1× speed. Blue reads. Orange writes. Red fails.')}
      </Feature>

      <Feature
        flip
        title={t('Spike ends. Outage stays.')}
        open="retry-storm"
        live={<Live {...live} height={620} open="retry-storm" drawer="metrics" query="example=retry-storm&speed=3&autorun=1&loop=1&panels=bottom" title={t('Retry storm')} />}
      >
        {t('Every layer retries and multiplies the load. Add a retry budget. It recovers in seconds.')}
      </Feature>

      <Carousel {...live} />

      <Marquee />
      <p className="site-wrap muted mt-8 text-center text-[16px]">{t('48 examples. 16 kinds of component. Every parameter is yours to change.')}</p>

      <Feature
        title={t('The CLI. The same engine.')}
        live={
          <div className="site-window site-term">
            <WindowBar />
            <pre>
              <span className="site-term-cmd">$ {CLI_CMD}</span>
              {'\n\n'}
              {CLI_OUT}
            </pre>
          </div>
        }
      >
        {t('A design is one JSON file. People can read it. AI agents can write it.')}
      </Feature>

      <section className="site-wrap mt-24 text-center sm:mt-36">
        <Reveal>
          <h2 className="site-h1 site-h1-end">{t('Go break something.')}</h2>
          <div className="mt-9 flex justify-center">
            <a className="btn btn-primary site-cta" href={APP}>
              {t('Open the simulator')}
              <ArrowRight size={18} />
            </a>
          </div>
        </Reveal>
      </section>

      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
