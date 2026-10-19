import { Island, asset } from 'amoxi';
import CartBadge from '../islands/CartBadge';
import { CATEGORIES } from '../catalog/model';

export type Section = 'home' | 'tents' | 'sleeping-bags' | 'jackets' | 'footwear' | 'assistant' | 'guides' | 'agents';

export interface LayoutProps {
  title: string;
  description?: string;
  active?: Section;
  /** Full-bleed app layout (the assistant page). */
  app?: boolean;
  children?: unknown;
}

export function Logo() {
  return (
    <svg class="logo" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 33 15 13l6 10 4-6 11 16Z" fill="#17251F" />
      <path d="M15 13l3.2 5.4-3.2 2.1-3.1-2.2Z" fill="#E5EBE4" />
      <rect x="27" y="4" width="5" height="12" rx="1" fill="#F26B1D" />
    </svg>
  );
}

export function Layout(props: LayoutProps) {
  return (
    <html lang="en-CA">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#EEF1EC" />
        <title>{props.title === 'Demo Outdoor Store' ? props.title : `${props.title} | Demo Outdoor Store`}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={asset('app.css')} />
      </head>
      <body class={props.app ? 'is-app' : undefined}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="site-head">
          <a class="brand" href="/" aria-label="Demo Outdoor Store home">
            <Logo />
            <span class="brand-name">
              Demo Outdoor Store
            </span>
          </a>
          <nav class="site-nav" aria-label="Shop">
            <ul>
              {CATEGORIES.map((c) => (
                <li>
                  <a href={`/shop/${c.id}`} aria-current={props.active === c.id ? 'page' : undefined}>
                    {c.name}
                  </a>
                </li>
              ))}
              <li>
                <a href="/guides" aria-current={props.active === 'guides' ? 'page' : undefined}>
                  Guides
                </a>
              </li>
            </ul>
          </nav>
          <div class="head-actions">
            <a class={props.active === 'assistant' ? 'assist-link current' : 'assist-link'} href="/assistant" aria-current={props.active === 'assistant' ? 'page' : undefined}>
              <span class="blaze" aria-hidden="true" />
              Assistant
            </a>
            <Island of={CartBadge} label="Cart" load="idle" />
          </div>
        </header>
        <main id="main" tabindex="-1" class={props.app ? 'main-app' : 'main'}>
          {props.children}
        </main>
        {props.app ? null : (
          <footer class="site-foot">
            <div class="foot-brand">
              <Logo />
              <p>Demo Outdoor Store. Gear for wet trails, cold lakes and long portages.</p>
            </div>
            <nav aria-label="Store">
              <a href="/guides/returns-policy">Returns</a>
              <a href="/guides/shipping">Shipping</a>
              <a href="/for-agents">For AI agents</a>
              <a href="/llms.txt">llms.txt</a>
            </nav>
            <p class="demo-note">Demo: fictional data. Demo Outdoor Store is not a real store; nothing is charged or shipped.</p>
          </footer>
        )}
      </body>
    </html>
  );
}
