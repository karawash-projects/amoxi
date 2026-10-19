import { asset } from 'amoxi';

export interface LayoutProps {
  title: string;
  active?: 'home' | 'about';
  children?: unknown;
}

/** The HTML document shared by every page. Links between pages navigate without full reloads. */
export function Layout(props: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title} | {{APP_TITLE}}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={asset('app.css')} />
      </head>
      <body>
        <header class="site-header">
          <a class="brand" href="/">{{APP_TITLE}}</a>
          <nav aria-label="Main">
            <a href="/" aria-current={props.active === 'home' ? 'page' : undefined}>Home</a>
            <a href="/about" aria-current={props.active === 'about' ? 'page' : undefined}>About</a>
          </nav>
        </header>
        <main id="main" tabindex="-1">{props.children}</main>
        <footer class="site-footer">Built with Amoxi</footer>
      </body>
    </html>
  );
}
