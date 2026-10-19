import { Controller, ErrorPage, HttpError, Island, Page, PathParam, raw } from 'amoxi';
import { ADVANTAGES, COMPARISON, FIT, GENERATED_SAMPLE, SOURCE_SAMPLE, BUILD_ERROR_SAMPLE } from '../content/advantages';
import { DOCS, DOCS_INTRO } from '../content/docs.generated';
import { SECTORS, sectorBySlug, type Sector } from '../content/sectors';
import CopyCommand from '../islands/CopyCommand';
import DocsNav from '../islands/DocsNav';
import ScreenshotViewer from '../islands/ScreenshotViewer';
import { Layout, REPO } from '../ui/layout';
import { BENCH, StartupRuler } from '../ui/ruler';

const CREATE = ['npx create-amoxi-app@latest my-app', 'cd my-app', 'npm run dev'];

/** Commands to run one example from a clone, one per line so they work in every shell. */
const runExample = (s: Sector): string[] => [
  `git clone ${REPO}.git`,
  'cd amoxi',
  'npm install',
  'npm run build',
  `npm run dev -w ${s.folder.split('/').pop()}`,
];

function SectorRow(props: { sector: Sector; flip: boolean }) {
  const s = props.sector;
  return (
    <article class={props.flip ? 'sector-row flip' : 'sector-row'} style={`--sector:${s.accent}`} aria-labelledby={`sector-${s.slug}`}>
      <div class="sector-text">
        <p class="sector-name">{s.sector}</p>
        <h3 id={`sector-${s.slug}`}>
          <a href={`/examples/${s.slug}`}>{s.brand}</a>
        </h3>
        <p class="sector-summary">{s.summary}</p>
        <ul class="outcomes">
          {s.outcomes.map((o) => (
            <li>{o}</li>
          ))}
        </ul>
        <p>
          <a class="text-link" href={`/examples/${s.slug}`}>
            See how the {s.brand} example is built
          </a>
        </p>
      </div>
      <a class="sector-shot" href={`/examples/${s.slug}`} tabindex="-1" aria-hidden="true">
        <img src={`/shots/${s.screens[0].file}-desktop.jpg`} alt="" width="1440" height="900" loading="lazy" decoding="async" />
      </a>
    </article>
  );
}

function CodeBlock(props: { file: string; code: string; tone?: 'generated' | 'terminal' }) {
  return (
    <figure class={`code ${props.tone ?? ''}`}>
      <figcaption>{props.file}</figcaption>
      <pre>
        <code>{props.code}</code>
      </pre>
    </figure>
  );
}

/** The showcase site. Every page is static, so `amoxi export --strict` can render it all. */
@Controller()
export class SitePages {
  @Page('/')
  home() {
    return (
      <Layout title="Amoxi" description="An open-source TypeScript framework for web apps and AI agents: compile-time wiring, durable streaming agents with generative UI, MCP and A2A, and servers that start in milliseconds.">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-copy">
            <h1 id="hero-title">Web apps and AI agents, wired before they start.</h1>
            <p class="lede">
              Amoxi builds pages, APIs, dependency injection and AI agents with the TypeScript compiler, the way Micronaut does
              for Java. Agents run as durable background work, stream every token and show your own components. Nothing is
              scanned at start-up, so a server with {BENCH.beans.toLocaleString('en-US')} services is ready in about{' '}
              {Math.round(BENCH.lazyMs)} milliseconds.
            </p>
            <div class="hero-actions">
              <Island of={CopyCommand} lines={CREATE} label="Create an Amoxi app" />
              <p class="hero-links">
                <a class="button" href="#examples">
                  Browse sector examples
                </a>
                <a class="text-link" href={REPO}>
                  View the source on GitHub
                </a>
              </p>
            </div>
          </div>
          <StartupRuler />
        </section>

        <section class="band" id="why" aria-labelledby="why-title">
          <div class="band-head">
            <h2 id="why-title">What your team gets</h2>
            <p>
              Each advantage below is used by at least one of the sector examples, so you can read the code behind it before adopting
              anything.
            </p>
          </div>
          <div class="advantages">
            {ADVANTAGES.map((group) => (
              <section class={group.id === 'agents' ? 'advantage-group wide' : 'advantage-group'} aria-labelledby={`adv-${group.id}`}>
                <h3 id={`adv-${group.id}`}>{group.title}</h3>
                <p class="advantage-intro">{group.intro}</p>
                <dl>
                  {group.items.map((item) => (
                    <div class="advantage">
                      <dt>{item.title}</dt>
                      <dd>
                        {item.text}
                        {item.example ? (
                          <>
                            {' '}
                            <a href={`/examples/${item.example}`}>
                              In the {sectorBySlug(item.example)!.brand} example
                            </a>
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </section>

        <section class="band examples" id="examples" aria-labelledby="examples-title">
          <div class="band-head">
            <h2 id="examples-title">Built for your sector</h2>
            <p>
              Four complete example apps live in the repository, each with tests and a README that maps every framework feature to the
              business need it serves. Company names and data are fictional.
            </p>
          </div>
          {SECTORS.map((s, i) => (
            <SectorRow sector={s} flip={i % 2 === 1} />
          ))}
        </section>

        <section class="band" id="how" aria-labelledby="how-title">
          <div class="band-head">
            <h2 id="how-title">How it works</h2>
            <p>Decorators are markers. The compiler turns them into plain TypeScript that you can read, debug and step through.</p>
          </div>
          <ol class="steps">
            <li>
              <h3>Write services, tools and agents</h3>
              <p>Tools are ordinary methods with typed inputs; agents list the tools, components and knowledge they may use.</p>
              <CodeBlock file="src/agent/banking-tools.ts (shortened)" code={SOURCE_SAMPLE} />
            </li>
            <li>
              <h3>amoxi build resolves everything</h3>
              <p>
                The TypeScript compiler checks the whole graph, from services to agents, and generates the wiring, the tool
                schemas the model sees and the validators its arguments must pass. Mistakes stop the build, not production.
              </p>
              <CodeBlock file="Terminal" code={BUILD_ERROR_SAMPLE} tone="terminal" />
            </li>
            <li>
              <h3>Start in milliseconds</h3>
              <p>
                At start-up there's nothing left to discover: the server listens in milliseconds, and agents run as durable background
                work that streams to the browser.
              </p>
              <CodeBlock file="src/generated/amoxi.generated.ts (excerpt)" code={GENERATED_SAMPLE} tone="generated" />
            </li>
          </ol>
        </section>

        <section class="band" id="compare" aria-labelledby="compare-title">
          <div class="band-head">
            <h2 id="compare-title">Compared with Next.js</h2>
            <p>
              Amoxi follows Next.js conventions where it can, so the commands and project structure feel familiar. These are the
              differences that matter when you choose.
            </p>
          </div>
          <div class="table-scroll" tabindex="0" role="region" aria-labelledby="compare-title">
            <table class="compare">
              <thead>
                <tr>
                  <th scope="col">Need</th>
                  <th scope="col">Next.js</th>
                  <th scope="col">Amoxi</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr>
                    <th scope="row">{row.need}</th>
                    <td>{row.next}</td>
                    <td>{row.amoxi}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="fit">
            <section aria-labelledby="fit-good">
              <h3 id="fit-good">A good fit when</h3>
              <ul>
                {FIT.map((f) => (
                  <li>{f}</li>
                ))}
              </ul>
            </section>
          </div>
        </section>

        <section class="band start" id="start" aria-labelledby="start-title">
          <div class="band-head">
            <h2 id="start-title">Start a project</h2>
            <p>
              You need Node.js 22 or newer. No environment variables or accounts are required: the app runs at http://localhost:8080.
            </p>
          </div>
          <div class="start-grid">
            <Island of={CopyCommand} lines={CREATE} label="Create an Amoxi app" />
            <p>
              Amoxi is free to use in commercial products under the Apache License 2.0, which includes a patent grant. The{' '}
              <a href="/docs">documentation</a> covers every feature, from the first page to deploying in production.
            </p>
          </div>
        </section>
      </Layout>
    );
  }

  @Page('/docs')
  docs() {
    return (
      <Layout title="Documentation" description="The Amoxi documentation: backend, frontend, data and security, AI agents, deployment and configuration." active="docs">
        <div class="docs">
          <nav class="docs-nav" aria-label="Documentation">
            <Island of={DocsNav} sections={DOCS.map((d) => ({ id: d.id, title: d.title, children: [...d.children] }))} />
          </nav>
          <article class="docs-body">
            <header class="docs-head">
              <h1>Documentation</h1>
              <div class="docs-intro">{raw(DOCS_INTRO)}</div>
            </header>
            {DOCS.map((s) => (
              <section aria-labelledby={s.id}>
                <h2 id={s.id}>{raw(s.titleHtml)}</h2>
                {raw(s.html)}
              </section>
            ))}
          </article>
        </div>
      </Layout>
    );
  }

  @Page('/examples/:slug')
  example(@PathParam() slug: string) {
    const s = sectorBySlug(slug);
    if (!s) throw new HttpError(404, 'No such example');
    const i = SECTORS.indexOf(s);
    const next = SECTORS[(i + 1) % SECTORS.length];
    return (
      <Layout title={`${s.sector} example`} description={`${s.brand}: ${s.summary} An Amoxi example app.`} active="examples">
        <article class="example" style={`--sector:${s.accent}`}>
          <header class="example-head">
            <p class="crumbs">
              <a href="/#examples">Sector examples</a>
              <span aria-hidden="true"> / </span>
              {s.sector}
            </p>
            <h1>{s.brand}</h1>
            <p class="lede">{s.summary}</p>
          </header>

          <Island of={ScreenshotViewer} screens={s.screens} brand={s.brand} />

          <div class="example-body">
            <section aria-labelledby="problem">
              <h2 id="problem">The problem it solves</h2>
              <p>{s.problem}</p>
              <ul class="outcomes">
                {s.outcomes.map((o) => (
                  <li>{o}</li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="run">
              <h2 id="run">Run it on your computer</h2>
              <Island of={CopyCommand} lines={runExample(s)} label={`Run the ${s.brand} example`} />
              <p class="muted">
                Then open http://localhost:{s.port}. The tests run with <code>npm test -w {s.folder.split('/').pop()}</code>.
              </p>
              <p>
                <a class="text-link" href={`${REPO}/tree/main/${s.folder}`}>
                  Read the source and README on GitHub
                </a>
              </p>
            </section>
          </div>

          <section class="features" aria-labelledby="features">
            <h2 id="features">Amoxi features in this example</h2>
            <div class="table-scroll" tabindex="0" role="region" aria-labelledby="features">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    <th scope="col">Why it matters here</th>
                  </tr>
                </thead>
                <tbody>
                  {s.features.map((f) => (
                    <tr>
                      <th scope="row">{f.feature}</th>
                      <td>{f.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <nav class="example-next" aria-label="More examples">
            <a href={`/examples/${next.slug}`}>
              <span class="muted">Next example</span>
              <span class="example-next-name">
                {next.brand}, {next.sector.toLowerCase()}
              </span>
            </a>
          </nav>
        </article>
      </Layout>
    );
  }

  @ErrorPage(404)
  notFound() {
    return (
      <Layout title="Page not found" description="This page doesn't exist.">
        <section class="not-found">
          <h1>This page doesn't exist</h1>
          <p class="lede">The address may be mistyped, or the page may have moved.</p>
          <p>
            <a class="button" href="/">
              Go to the home page
            </a>
          </p>
        </section>
      </Layout>
    );
  }
}
