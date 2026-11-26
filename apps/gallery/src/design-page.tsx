// Design page: every undecided token value as rendered options, in light and
// dark side by side. Tapping an option selects it; Save writes the selection
// to the app's data directory, where `dk tokens apply` picks it up.
import { useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { tokens } from '@droid-kit/tokens';
import optionsFile from '@droid-kit/tokens/options.json';

type Value = { value: number; unit: string } | string;
interface Option { id: string; label: string; tokens: Record<string, Value> }
interface Decision { id: string; title: string; question: string; darkOnly?: boolean; options: Option[] }

const decisions = (optionsFile as { decisions: Decision[] }).decisions;
const STORAGE_KEY = 'dk.tokenChoices';

const css = (v: Value) => (typeof v === 'string' ? v : `${v.value}${v.unit}`);

/** The CSS variables an option sets, for previewing it inside a subtree. */
function previewStyle(option: Option, mode: 'light' | 'dark'): CSSProperties {
  const style: Record<string, string> = {};
  for (const [path, value] of Object.entries(option.tokens)) {
    const dark = path.endsWith('@dark');
    if (dark && mode !== 'dark') continue;
    const p = path.replace(/@dark$/, '');
    if (p.startsWith('radius.')) style[`--radius-${p.slice(7)}`] = css(value);
    else if (p === 'space.unit') style['--spacing'] = css(value);
    else if (p.startsWith('font.size.')) style[`--text-${p.slice(10)}`] = css(value);
    else if (p.startsWith('motion.duration.')) style[`--dk-duration-${p.slice(16)}`] = css(value);
    else if (p === 'color.accent') style['--color-primary'] = css(value);
    else if (p === 'color.on-accent') style['--color-primary-content'] = css(value);
  }
  return style as CSSProperties;
}

/** Which option matches the token source as it is now. */
function currentOption(d: Decision): string | undefined {
  const t = tokens as unknown as {
    radius: Record<string, string>; spacingUnit: string; fontSize: Record<string, string>;
    duration: Record<string, number>; colors: { dark: Record<string, string> };
  };
  const matches = (o: Option) =>
    Object.entries(o.tokens).every(([path, value]) => {
      const p = path.replace(/@dark$/, '');
      if (p.startsWith('radius.')) return t.radius[p.slice(7)] === css(value);
      if (p === 'space.unit') return t.spacingUnit === css(value);
      if (p.startsWith('font.size.')) return t.fontSize[p.slice(10)] === css(value);
      if (p.startsWith('motion.duration.')) return `${t.duration[p.slice(16)]}ms` === css(value);
      if (p.startsWith('color.')) return t.colors.dark[p.slice(6)] === value;
      return false;
    });
  return d.options.find(matches)?.id;
}

function loadChoices(): Record<string, string> {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  })();
  return Object.fromEntries(decisions.map(d => [d.id, saved[d.id] ?? currentOption(d) ?? d.options[0].id]));
}

function Sample({ motionKey }: { motionKey: number }) {
  return (
    <div className="card bg-base-100 border-divider border">
      <div className="card-body gap-3 p-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="checkbox checkbox-primary" defaultChecked />
          <span className="min-w-0 flex-1">
            <span className="text-body block font-medium">Morning run</span>
            <span className="text-caption text-muted block">After coffee · 6:30</span>
          </span>
          <span className="badge badge-secondary">12</span>
        </label>
        <input className="input border-control bg-base-200 text-body w-full" placeholder="Habit name" />
        <div className="tabs tabs-box">
          <button className="tab tab-active flex-1">Day</button>
          <button className="tab flex-1">Week</button>
          <button className="tab flex-1">Month</button>
        </div>
        <div className="bg-base-200 rounded-field h-3 overflow-hidden">
          <div
            key={motionKey}
            className="bg-primary h-full"
            style={{ width: motionKey ? '100%' : '30%', transition: `width var(--dk-duration-slow) var(--ease-standard)` }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost">Cancel</button>
          <button className="btn btn-primary">Save habit</button>
        </div>
      </div>
    </div>
  );
}

function OptionCard({ decision, option, selected, onSelect }: { decision: Decision; option: Option; selected: boolean; onSelect: () => void }) {
  const [play, setPlay] = useState(0);
  const modes = decision.darkOnly ? (['dark'] as const) : (['light', 'dark'] as const);
  return (
    <section
      data-option={`${decision.id}/${option.id}`}
      className={`rounded-box border-2 p-2 ${selected ? 'border-primary' : 'border-transparent'}`}
    >
      <button className="btn btn-block min-h-touch justify-between" onClick={onSelect} aria-pressed={selected}>
        <span>{option.label}</span>
        <span className={selected ? 'badge badge-primary' : 'badge badge-ghost'}>{selected ? 'Chosen' : 'Choose'}</span>
      </button>
      <div className={`mt-2 grid gap-2 ${modes.length === 2 ? 'grid-cols-2' : ''}`}>
        {modes.map(mode => (
          <div key={mode} data-theme={mode} inert className="bg-background text-base-content rounded-box p-2" style={previewStyle(option, mode)}>
            <div className="text-caption text-muted mb-1">{mode === 'light' ? 'Light' : 'Dark'}</div>
            <div style={{ zoom: modes.length === 2 ? 0.62 : 1 }}>
              <Sample motionKey={play} />
            </div>
          </div>
        ))}
      </div>
      {decision.id === 'motion' && (
        <button className="btn btn-sm mt-2 min-h-touch" onClick={() => setPlay(p => (p ? 0 : 1))}>
          Play
        </button>
      )}
    </section>
  );
}

export function DesignPage() {
  const [choices, setChoices] = useState(loadChoices);
  const [saved, setSaved] = useState<string | null>(null);

  const choose = (decision: string, option: string) => {
    const next = { ...choices, [decision]: option };
    setChoices(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(null);
  };

  const save = async () => {
    const file = { chosenAt: new Date().toISOString(), choices };
    try {
      const path = await invoke<string>('save_token_choices', { json: JSON.stringify(file, null, 2) });
      setSaved(`Saved to ${path}. Run dk tokens apply.`);
    } catch (e) {
      setSaved(`Could not save: ${String(e)}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <p className="text-muted">
        Each choice shows the same sample in light and dark. Tap an option to choose it, then Save at the bottom.
      </p>
      {decisions.map(d => (
        <section key={d.id} id={`decision-${d.id}`} className="flex flex-col gap-2">
          <h2 className="text-title font-bold">{d.title}</h2>
          <p className="text-muted">{d.question}</p>
          {d.options.map(o => (
            <OptionCard key={o.id} decision={d} option={o} selected={choices[d.id] === o.id} onSelect={() => choose(d.id, o.id)} />
          ))}
        </section>
      ))}
      <button id="save-choices" className="btn btn-primary btn-lg min-h-touch" onClick={save}>
        Save my choices
      </button>
      {saved && <p id="saved-message" className="text-small">{saved}</p>}
    </div>
  );
}
