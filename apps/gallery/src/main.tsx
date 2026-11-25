import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@droid-kit/platform/platform.css';
import {
  dk,
  installBackHandler,
  onThemeChange,
  reportErrors,
  setThemePreference,
  signalReady,
  syncSystemBars,
  type ThemePreference,
} from '@droid-kit/platform';

declare global {
  interface Window {
    __DK_AT_HEAD__?: string;
  }
}

type Facts = Record<string, string>;

// What the platform gives the page, next to what the boot script decided.
function readFacts(): Facts {
  const probe = document.getElementById('inset-probe')!;
  const cs = getComputedStyle(probe);
  const vv = window.visualViewport;
  const d = dk();
  return {
    'platform': d.platform,
    'engine': `${d.engine.name} ${d.engine.version ?? '(unknown version)'}`,
    'form factor': d.formFactor,
    'theme (preference)': `${d.theme} (${d.themePreference})`,
    'html attributes': ['data-platform', 'data-form-factor', 'data-theme'].map(a => document.documentElement.getAttribute(a)).join(' · '),
    '__DK__ as seen in <head>': window.__DK_AT_HEAD__ ?? 'missing',
    'safe-area top/right/bottom/left': [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
    '--dk-keyboard': getComputedStyle(document.documentElement).getPropertyValue('--dk-keyboard') || 'unset',
    'inner size': `${innerWidth}×${innerHeight}`,
    'visual viewport': vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}` : 'none',
    'screen': `${screen.width}×${screen.height} dpr ${devicePixelRatio}`,
    'pointer': matchMedia('(pointer: coarse)').matches ? 'coarse' : matchMedia('(pointer: fine)').matches ? 'fine' : 'none',
    'user agent': navigator.userAgent,
  };
}

const button: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '0 14px', fontSize: 15, marginRight: 8, marginBottom: 8 };

function Diagnostics() {
  const [facts, setFacts] = useState<Facts>({});
  const [depth, setDepth] = useState(0);

  useEffect(signalReady, []);

  useEffect(() => {
    const update = () => setFacts(readFacts());
    update();
    addEventListener('resize', update);
    visualViewport?.addEventListener('resize', update);
    const offTheme = onThemeChange(update);
    const onPop = () => setDepth(history.state?.depth ?? 0);
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('resize', update);
      visualViewport?.removeEventListener('resize', update);
      removeEventListener('popstate', onPop);
      offTheme();
    };
  }, []);

  const theme = (p: ThemePreference) => () => setThemePreference(p);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, paddingBottom: 'calc(96px + var(--dk-inset-bottom))', fontSize: 14 }}>
      <div id="inset-probe" style={{ position: 'fixed', visibility: 'hidden', padding: 'var(--dk-inset-top) var(--dk-inset-right) var(--dk-inset-bottom) var(--dk-inset-left)' }} />
      <h1>droid-kit gallery</h1>
      <h2>Theme</h2>
      <div>
        <button style={button} onClick={theme('system')}>System</button>
        <button style={button} onClick={theme('light')}>Light</button>
        <button style={button} onClick={theme('dark')}>Dark</button>
      </div>
      <h2>History</h2>
      <p id="history-depth">depth {depth}</p>
      <button
        style={button}
        onClick={() => {
          const next = depth + 1;
          history.pushState({ depth: next }, '');
          setDepth(next);
        }}
      >
        Push an entry
      </button>
      {dk().debug && (
        <>
          <h2>Debug</h2>
          <button
            style={button}
            onClick={() => {
              localStorage.setItem('dk.debug.engineVersion', '103');
              location.reload();
            }}
          >
            Pretend the engine is version 103
          </button>
        </>
      )}
      <h2>Platform facts</h2>
      <dl id="facts">
        {Object.entries(facts).map(([k, v]) => (
          <div key={k} style={{ marginBottom: 6 }}>
            <dt style={{ fontWeight: 600 }}>{k}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }} data-fact={k}>{v}</dd>
          </div>
        ))}
      </dl>
      <input id="kbd-probe" placeholder="Tap to open the keyboard" style={{ fontSize: 16, padding: 8, width: '100%', boxSizing: 'border-box' }} />
      <InsetBar />
    </main>
  );
}

// A bar fixed to the bottom edge: its background reaches the edge, its buttons
// stay above the navigation bar or gesture area.
function InsetBar() {
  return (
    <nav
      id="inset-bar"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 'var(--dk-keyboard)', display: 'flex', justifyContent: 'space-around',
        background: '#155dfc', paddingBottom: 'var(--dk-inset-bottom)', paddingLeft: 'var(--dk-inset-left)', paddingRight: 'var(--dk-inset-right)',
      }}
    >
      {['One', 'Two', 'Three'].map(l => (
        <button key={l} style={{ ...button, margin: 0, background: '#dbeafe', border: '2px solid #09090b', flex: 1, maxWidth: 120 }}>{l}</button>
      ))}
    </nav>
  );
}

reportErrors();
syncSystemBars();
void installBackHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Diagnostics />
  </StrictMode>,
);
