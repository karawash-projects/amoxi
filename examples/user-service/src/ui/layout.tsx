import { Island, asset, raw } from 'amoxi';
import ThemeToggle from '../islands/ThemeToggle';

export type Section = 'people' | 'wiring' | 'status';

export interface LayoutProps {
  title: string;
  active?: Section;
  /** Translator and locale of the current request (ctx.t / ctx.locale). */
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  /** Current path, for the language links. */
  path: string;
  /** Framework startup time and OS, shown in the sidebar. */
  startupMs: number;
  platform: string;
  flash?: string;
  children?: unknown;
}

// Runs before first paint so a saved theme never flashes.
const THEME_BOOT = `try{var t=localStorage.getItem('amoxi-theme');if(t)document.documentElement.dataset.theme=t;var a=localStorage.getItem('amoxi-accent');if(a)document.documentElement.style.setProperty('--storm',a)}catch(e){}`;

const ICONS: Record<Section, unknown> = {
  people: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6" />
    </svg>
  ),
  wiring: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="18" cy="5" r="2" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M16 19a7 7 0 0 1 0-14M16 12a3.5 3.5 0 0 1 0-7" />
    </svg>
  ),
  status: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </svg>
  ),
};

const LINKS: Section[] = ['people', 'wiring', 'status'];
const LANGUAGES: Array<[string, string]> = [
  ['en', 'English'],
  ['fr', 'Français'],
];

export function Layout(props: LayoutProps) {
  return (
    <html lang={props.locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#EEF1F5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#121722" media="(prefers-color-scheme: dark)" />
        <title>{props.title} | User service</title>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="stylesheet" href={asset('app.css')} />
        <script>{raw(THEME_BOOT)}</script>
      </head>
      <body>
        <a class="skip-link" href="#view">{props.t('layout.skip')}</a>
        <div class="shell">
          <nav class="nav" aria-label="Main">
            <a class="brand" href="/people" aria-label="User service home">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path class="brand-cloud" d="M9 24h14.5a5.5 5.5 0 0 0 .6-10.97A8 8 0 0 0 8.5 14.6 4.75 4.75 0 0 0 9 24Z" />
                <path class="brand-bolt" d="M17.5 15 13 21h4l-1.5 5 5-7h-4l1-4Z" />
              </svg>
              <span>User service</span>
            </a>
            <ul class="nav-links">
              {LINKS.map((key) => (
                <li>
                  <a href={`/${key}`} aria-current={props.active === key ? 'page' : undefined}>
                    {ICONS[key]}
                    <span>{props.t(`nav.${key}`)}</span>
                  </a>
                </li>
              ))}
            </ul>
            <div class="nav-foot">
              <p class="ready">{props.t('layout.started', { ms: props.startupMs, platform: props.platform })}</p>
              <nav class="languages" aria-label={props.t('nav.language')}>
                {LANGUAGES.map(([code, name]) => (
                  <a href={`${props.path}?lang=${code}`} hreflang={code} lang={code} aria-current={props.locale === code ? 'true' : undefined}>
                    {name}
                  </a>
                ))}
              </nav>
              <Island of={ThemeToggle} variant="link" load="idle" />
            </div>
          </nav>
          <main id="view" class="view" tabindex="-1">
            {props.children}
          </main>
        </div>
        {props.flash && (
          <div class="toast show flash" role="status">
            {props.flash}
          </div>
        )}
      </body>
    </html>
  );
}
