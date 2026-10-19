import { Island, asset } from 'amoxi';
import SignOut from '../islands/SignOut';

export type Section = 'assistant' | 'accounts' | 'rates' | 'audit';

export interface LayoutProps {
  title: string;
  description?: string;
  active?: Section;
  customer?: { id: string; name: string };
  /** Full-height workspace (the assistant) instead of a scrolling page. */
  workspace?: boolean;
  children?: unknown;
}

const NAV: Array<[Section, string, string]> = [
  ['assistant', '/assistant', 'Assistant'],
  ['accounts', '/accounts', 'Accounts'],
  ['rates', '/rates', 'Rates and fees'],
  ['audit', '/audit', 'Audit trail'],
];

/** Demo Bank's logo mark. */
export function Mark() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path class="mark-stone" d="M6.5 10.5C8.6 5.6 14 3.8 19.6 4.6c5.6.8 8.6 4.9 8 10.6-.6 6.2-5.2 11.6-11.8 12.2C9.4 28 4.2 23.6 4.4 17.6c.1-2.6.9-4.9 2.1-7.1Z" />
      <path class="mark-nib" d="M21.5 8.5 12 21l-1.6 4.1 3.7-2.4 9.5-12.6c.8-1 .5-2.2-.4-2.8-.6-.4-1.3-.2-1.7.2Z" />
      <path class="mark-slit" d="m12.9 22.6 4.6-6.1" />
    </svg>
  );
}

export function Layout(props: LayoutProps) {
  const signedIn = Boolean(props.customer);
  return (
    <html lang="en-CA">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light" />
        <meta name="theme-color" content="#FFFFFF" />
        {props.description && <meta name="description" content={props.description} />}
        <title>{props.title} | Demo Bank</title>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={asset('app.css')} />
      </head>
      <body class={props.workspace ? 'is-workspace' : undefined}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="topbar">
          <a class="brand" href={signedIn ? '/assistant' : '/signin'} aria-label="Demo Bank home">
            <Mark />
            <span class="brand-name">Demo Bank</span>
          </a>
          <nav class="topnav" aria-label="Main">
            <ul>
              {NAV.filter(([key]) => signedIn || key === 'rates').map(([key, href, label]) => (
                <li>
                  <a href={href} aria-current={props.active === key ? 'page' : undefined}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div class="who">
            {props.customer ? (
              <>
                <span class="who-name">
                  {props.customer.name}
                  <span class="ledger-sub">{props.customer.id}</span>
                </span>
                <Island of={SignOut} load="idle" />
              </>
            ) : (
              <a class="btn btn-small" href="/signin">
                Sign in
              </a>
            )}
          </div>
        </header>
        <main id="main" class={props.workspace ? 'workspace' : 'page'} tabindex="-1">
          {props.children}
        </main>
        {!props.workspace && (
          <footer class="footer">
            <p>
              <strong>Demo: fictional data.</strong> Demo Bank, its customers, rates and policies are invented for this Amoxi example. Nothing here is financial advice.
            </p>
          </footer>
        )}
        {props.workspace && (
          <p class="workspace-foot">
            <strong>Demo: fictional data.</strong> Demo Bank is not a real bank.
          </p>
        )}
      </body>
    </html>
  );
}
