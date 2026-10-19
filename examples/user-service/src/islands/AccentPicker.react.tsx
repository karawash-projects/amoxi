/** @jsxImportSource react */
import { useEffect, useId, useState } from 'react';
import { HexColorInput, HexColorPicker } from 'react-colorful';

const KEY = 'amoxi-accent';

/**
 * A React island: rendered on the server with react-dom/server, hydrated with React in the
 * browser, using normal hooks and a React component library (react-colorful). Only pages that
 * render a React island download React.
 */
export default function AccentPicker(props: { label: string; resetLabel: string; initial: string }) {
  const [color, setColor] = useState(props.initial);
  const [custom, setCustom] = useState(false);
  const inputId = useId();

  // Read the saved colour after hydration (localStorage doesn't exist on the server).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) {
        setColor(saved);
        setCustom(true);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (!custom) return;
    document.documentElement.style.setProperty('--storm', color);
    try {
      localStorage.setItem(KEY, color);
    } catch {
      /* storage unavailable */
    }
  }, [color, custom]);

  const choose = (next: string): void => {
    setColor(next);
    setCustom(true);
  };

  const reset = (): void => {
    setCustom(false);
    setColor(props.initial);
    document.documentElement.style.removeProperty('--storm');
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <div className="accent-picker">
      <HexColorPicker color={color} onChange={choose} />
      <div className="accent-row">
        <label htmlFor={inputId}>{props.label}</label>
        <HexColorInput id={inputId} color={color} onChange={choose} prefixed />
        <button type="button" className="btn" onClick={reset} disabled={!custom}>
          {props.resetLabel}
        </button>
      </div>
    </div>
  );
}
