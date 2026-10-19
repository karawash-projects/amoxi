import { Island, asset } from 'amoxi';
import { CLINIC } from '../domain/clinic-data';
import type { Patient } from '../domain/types';
import SignOut from '../islands/SignOut';

export type Section = 'home' | 'clinicians' | 'policies' | 'assistant' | 'partners' | 'my-data';

export interface LayoutProps {
  readonly title: string;
  readonly description?: string;
  readonly active?: Section;
  readonly patient?: Patient;
  /** Full-width app layout (assistant) instead of the page layout. */
  readonly app?: boolean;
  readonly children?: unknown;
}

const LINKS: Array<[Section, string, string]> = [
  ['home', '/', 'Clinic'],
  ['clinicians', '/clinicians', 'Clinicians'],
  ['policies', '/policies', 'Policies'],
  ['assistant', '/assistant', 'Assistant'],
  ['partners', '/partners', 'For partners'],
];

export function BrandMark() {
  return (
    <svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="11" class="mark-bg" />
      <path class="mark-sprig" d="M20 33V9M20 14l-6-4M20 14l6-4M20 20l-8-5M20 20l8-5M20 26l-9-5M20 26l9-5" />
    </svg>
  );
}

export function Layout(props: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#FFFFFF" />
        {props.description && <meta name="description" content={props.description} />}
        <title>{`${props.title} | ${CLINIC.name}`}</title>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={asset('app.css')} />
      </head>
      <body class={props.app ? 'is-app' : undefined}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="topbar">
          <a class="brand" href="/">
            <BrandMark />
            <span class="brand-name">
              Demo Clinic
            </span>
          </a>
          <nav class="mainnav" aria-label="Main">
            <ul>
              {LINKS.map(([key, href, label]) => (
                <li>
                  <a href={href} aria-current={props.active === key ? 'page' : undefined}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div class="whoami">
            {props.patient ? (
              <>
                <a class="patient-chip" href="/my-data" aria-current={props.active === 'my-data' ? 'page' : undefined}>
                  <span class="avatar avatar-patient avatar-xs" aria-hidden="true">
                    {props.patient.name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')}
                  </span>
                  <span class="patient-chip-text">
                    {props.patient.name.split(' ')[0]} <span class="demo-tag">demo</span>
                  </span>
                </a>
                <Island of={SignOut} label="Sign out" load="idle" />
              </>
            ) : (
              <a class="btn btn-small btn-outline" href="/assistant">
                Patient sign-in
              </a>
            )}
          </div>
        </header>
        <main id="main" tabindex="-1" class={props.app ? 'main main-app' : 'main'}>
          {props.children}
        </main>
        {!props.app && (
          <footer class="footer">
            <div class="footer-grid">
              <div>
                <p class="footer-brand">
                  <BrandMark /> {CLINIC.name}
                </p>
                <p>{CLINIC.address}</p>
                <p>
                  Front desk <a href={`tel:${CLINIC.phone}`}>{CLINIC.phone}</a>
                </p>
              </div>
              <div>
                <p class="footer-head">Emergencies</p>
                <p>
                  Call <a href="tel:911">911</a> or go to the nearest emergency department. Crisis line: call or text <a href="tel:988">9-8-8</a>.
                </p>
              </div>
              <div>
                <p class="footer-head">Your data</p>
                <p>
                  <a href="/my-data">Who accessed my data</a>
                </p>
                <p>
                  <a href="/policies#privacy">Privacy policy</a>
                </p>
              </div>
            </div>
            <p class="demo-note">Demo: fictional clinic, clinicians, patients and coverage plan. Not medical advice.</p>
          </footer>
        )}
      </body>
    </html>
  );
}
