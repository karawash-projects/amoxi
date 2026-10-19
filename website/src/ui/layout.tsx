import { asset } from 'amoxi';

export const REPO = 'https://github.com/karawash-projects/amoxi';

export interface LayoutProps {
  title: string;
  description: string;
  /** Highlights the matching link in the header. */
  active?: 'home' | 'examples' | 'docs';
  children?: unknown;
}

function Logo() {
  return (
    <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path class="logo-cloud" d="M9 24h14.5a5.5 5.5 0 0 0 .6-10.97A8 8 0 0 0 8.5 14.6 4.75 4.75 0 0 0 9 24Z" />
      <path class="logo-bolt" d="M17.5 15 13 21h4l-1.5 5 5-7h-4l1-4Z" />
    </svg>
  );
}

export function Layout(props: LayoutProps) {
  const title = props.title === 'Amoxi' ? 'Amoxi: compile-time TypeScript framework' : `${props.title} | Amoxi`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="description" content={props.description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={props.description} />
        <title>{title}</title>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="stylesheet" href={asset('site.css')} />
      </head>
      <body>
        <a class="skip-link" href="#main">Skip to content</a>
        <header class="site-header">
          <a class="wordmark" href="/" aria-label="Amoxi home">
            <Logo />
            <span>Amoxi</span>
          </a>
          <nav aria-label="Main">
            <ul>
              <li>
                <a href="/#why">Why Amoxi</a>
              </li>
              <li>
                <a href="/#examples" aria-current={props.active === 'examples' ? 'page' : undefined}>
                  Sector examples
                </a>
              </li>
              <li>
                <a href="/#compare">Compared with Next.js</a>
              </li>
              <li>
                <a href="/docs" aria-current={props.active === 'docs' ? 'page' : undefined}>
                  Documentation
                </a>
              </li>
              <li>
                <a class="nav-github" href={REPO}>
                  GitHub
                </a>
              </li>
            </ul>
          </nav>
        </header>
        <main id="main">{props.children}</main>
        <footer class="site-footer">
          <div class="footer-brand">
            <Logo />
            <p>
              Amoxi is open source under the <a href={`${REPO}/blob/main/LICENSE`}>Apache License 2.0</a>. Copyright 2026 Ahmad Karawash.
            </p>
          </div>
          <ul class="footer-links">
            <li>
              <a href={REPO}>Source code</a>
            </li>
            <li>
              <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>Contributing</a>
            </li>
            <li>
              <a href={`${REPO}/security/policy`}>Security policy</a>
            </li>
            <li>
              <a href={`${REPO}/blob/main/CHANGELOG.md`}>Changelog</a>
            </li>
          </ul>
          <p class="footer-note">
            This site is an Amoxi app exported to static HTML. Company names in the examples are fictional. Next.js is a trademark of
            Vercel, Inc.; Amoxi is not affiliated with Vercel or with the Micronaut Foundation.
          </p>
        </footer>
      </body>
    </html>
  );
}
