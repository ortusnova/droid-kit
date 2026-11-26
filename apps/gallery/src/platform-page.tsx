import { useEffect, useState } from 'react';
import { dk, onThemeChange, setThemePreference, type ThemePreference } from '@droid-kit/platform';

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

export const button: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '0 14px', fontSize: 15, marginRight: 8, marginBottom: 8 };

export function PlatformPage() {
  const [facts, setFacts] = useState<Facts>({});

  useEffect(() => {
    const update = () => setFacts(readFacts());
    update();
    addEventListener('resize', update);
    visualViewport?.addEventListener('resize', update);
    const offTheme = onThemeChange(update);
    return () => {
      removeEventListener('resize', update);
      visualViewport?.removeEventListener('resize', update);
      offTheme();
    };
  }, []);

  const theme = (p: ThemePreference) => () => setThemePreference(p);

  return (
    <div style={{ padding: 24 }}>
      <div id="inset-probe" style={{ position: 'fixed', visibility: 'hidden', padding: 'var(--dk-inset-top) var(--dk-inset-right) var(--dk-inset-bottom) var(--dk-inset-left)' }} />
      <h1>droid-kit gallery</h1>
      <h2>Theme</h2>
      <div>
        <button style={button} onClick={theme('system')}>System</button>
        <button style={button} onClick={theme('light')}>Light</button>
        <button style={button} onClick={theme('dark')}>Dark</button>
      </div>
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
      <input id="kbd-probe" placeholder="Tap to open the keyboard" style={{ fontSize: 16, padding: 8, width: '100%', boxSizing: 'border-box', minHeight: 44 }} />
    </div>
  );
}
