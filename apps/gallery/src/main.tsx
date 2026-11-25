import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { reportErrors, signalReady } from '@droid-kit/platform';

type Facts = Record<string, string>;

// What the platform gives the page: insets, viewport, media queries, user agent.
function readFacts(): Facts {
  const probe = document.getElementById('inset-probe')!;
  const cs = getComputedStyle(probe);
  const vv = window.visualViewport;
  return {
    'safe-area top/right/bottom/left': [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
    'inner size': `${innerWidth}×${innerHeight}`,
    'visual viewport': vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}` : 'none',
    'screen': `${screen.width}×${screen.height} dpr ${devicePixelRatio}`,
    'prefers-color-scheme': matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    'pointer': matchMedia('(pointer: coarse)').matches ? 'coarse' : matchMedia('(pointer: fine)').matches ? 'fine' : 'none',
    'any-pointer coarse': String(matchMedia('(any-pointer: coarse)').matches),
    'hover': String(matchMedia('(hover: hover)').matches),
    'user agent': navigator.userAgent,
  };
}

function Diagnostics() {
  const [facts, setFacts] = useState<Facts>({});
  const [backPresses, setBackPresses] = useState<string[]>([]);

  useEffect(signalReady, []);

  useEffect(() => {
    const update = () => setFacts(readFacts());
    update();
    addEventListener('resize', update);
    visualViewport?.addEventListener('resize', update);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
    return () => {
      removeEventListener('resize', update);
      visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    let listener: { unregister: () => Promise<void> } | undefined;
    onBackButtonPress(p => setBackPresses(b => [...b, `canGoBack=${p.canGoBack}`]))
      .then(l => { listener = l; })
      .catch(e => setBackPresses(b => [...b, `register failed: ${e}`]));
    return () => { void listener?.unregister(); };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, fontSize: 14 }}>
      <div id="inset-probe" style={{ position: 'fixed', visibility: 'hidden', padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }} />
      <h1>droid-kit gallery</h1>
      <h2>Platform facts</h2>
      <dl id="facts">
        {Object.entries(facts).map(([k, v]) => (
          <div key={k} style={{ marginBottom: 6 }}>
            <dt style={{ fontWeight: 600 }}>{k}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }} data-fact={k}>{v}</dd>
          </div>
        ))}
        <div>
          <dt style={{ fontWeight: 600 }}>back button presses</dt>
          <dd style={{ margin: 0 }} id="back-presses">{backPresses.join(', ') || 'none'}</dd>
        </div>
      </dl>
      <input id="kbd-probe" placeholder="Tap to open the keyboard" style={{ fontSize: 16, padding: 8, width: '100%' }} />
    </main>
  );
}

reportErrors();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Diagnostics />
  </StrictMode>,
);
