import { onMount, signal } from 'amoxi';

type Theme = 'system' | 'light' | 'dark';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const EVENT = 'amoxi-theme';

// Components also run on the server, so guard browser globals.
function current(): Theme {
  return typeof document === 'undefined' ? 'system' : ((document.documentElement.dataset.theme as Theme) ?? 'system');
}

function apply(theme: Theme): void {
  try {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('amoxi-theme');
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('amoxi-theme', theme);
    }
  } catch {
    /* storage unavailable: the theme still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const label = (t: Theme): string => t[0].toUpperCase() + t.slice(1);

/** Theme switcher. Several instances on one page stay in sync through a window event. */
export default function ThemeToggle(props: { variant: 'link' | 'buttons' }) {
  const [theme, setTheme] = signal<Theme>(current());
  onMount(() => {
    const sync = (): void => setTheme(current());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync); // cleaned up on client-side navigation
  });

  if (props.variant === 'link') {
    return (
      <button class="theme-toggle" type="button" onClick={() => apply(THEMES[(THEMES.indexOf(theme()) + 1) % 3])}>
        {() => `Theme: ${theme()}`}
      </button>
    );
  }
  return (
    <div role="radiogroup" aria-label="Theme" class="theme-choice">
      {THEMES.map((t) => (
        <button
          type="button"
          role="radio"
          class={() => (theme() === t ? 'btn primary' : 'btn')}
          aria-checked={() => String(theme() === t)}
          onClick={() => apply(t)}
        >
          {label(t)}
        </button>
      ))}
    </div>
  );
}
