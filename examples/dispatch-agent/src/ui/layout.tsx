import { asset } from 'amoxi';
import type { Dispatcher } from '../agents/identity';

export type Section = 'console' | 'integrations' | 'runs';

export interface LayoutProps {
  title: string;
  active?: Section;
  dispatcher?: Dispatcher;
  /** Shown in the top bar, e.g. "Sun 18 Oct". */
  today?: string;
  wide?: boolean;
  children?: unknown;
}

export function BrandMark() {
  return (
    <svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="9" class="mark-tile" />
      <path class="mark-wave" d="M6 24c4.5-5 9-5 13.5 0s9 5 14.5 0" />
      <path class="mark-road" d="M6 15h28" />
      <path class="mark-dash" d="M9 15h4M18 15h4M27 15h4" />
    </svg>
  );
}

/** The HTML document shared by every page. */
export function Layout(props: LayoutProps) {
  const link = (href: string, key: Section, label: string) => (
    <a href={href} aria-current={props.active === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <html lang="en-CA">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="theme-color" content="#0B1C2B" />
        <title>{props.title} | Demo Freight dispatch</title>
        <meta name="description" content="Demo Freight's operations console: AI agents that plan routes in the background, handle telematics exceptions and quote capacity to partner carriers." />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={asset('app.css')} />
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="topbar">
          <a class="brand" href="/" aria-label="Demo Freight operations console">
            <BrandMark />
            <span class="brand-name">
              Demo Freight <span class="brand-sub">Dispatch</span>
            </span>
          </a>
          <nav class="topnav" aria-label="Main">
            {link('/', 'console', 'Console')}
            {link('/integrations', 'integrations', 'Partners and events')}
          </nav>
          <div class="shift">
            {props.today ? <span class="shift-day">{props.today}, day shift</span> : null}
            {props.dispatcher ? (
              <span class="shift-who">
                <span class="avatar" aria-hidden="true">
                  {props.dispatcher.name
                    .split(' ')
                    .map((p) => p[0])
                    .join('')}
                </span>
                {props.dispatcher.name}
              </span>
            ) : null}
          </div>
        </header>
        <main id="main" tabindex="-1" class={props.wide ? 'main wide' : 'main'}>
          {props.children}
        </main>
        <footer class="footer">
          <p>
            <strong>Demo: fictional data.</strong> Demo Freight, its customers, drivers and trucks are invented. Built with Amoxi; runs offline without an AI key.
          </p>
          <p>
            <a href="/llms.txt">llms.txt</a> <a href="/integrations">Webhooks, MCP and A2A</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
