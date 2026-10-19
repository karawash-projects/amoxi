import { Controller, ErrorPage, Island, Page, type RequestContext } from 'amoxi';
import AddNote from '../islands/AddNote';
import Counter from '../islands/Counter';
import { NoteService } from '../notes/note-service';
import { Layout } from '../ui/layout';

const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Pages are rendered on the server. Only the islands (Counter, AddNote) send JavaScript
 * to the browser. Services arrive through constructor injection.
 */
@Controller()
export class HomePage {
  constructor(private readonly notes: NoteService) {}

  @Page('/')
  home() {
    const notes = this.notes.list();
    return (
      <Layout title="Home" active="home">
        <div class="split">
          <section class="intro">
            <h1>{{APP_TITLE}}</h1>
            <p>
              This page was rendered on the server. Edit <code>src/pages/home-page.tsx</code> while <code>npm run dev</code> is
              running and it updates in place.
            </p>
            <Island of={Counter} start={0} />
          </section>

          <section class="panel" aria-labelledby="notes-title">
            <div class="panel-head">
              <h2 id="notes-title">Notes</h2>
              <span class="count">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
            </div>
            <Island of={AddNote} />
            <ul class="notes">
              {notes.map((n) => (
                <li>
                  <p>{n.text}</p>
                  <time datetime={n.createdAt}>{dateTime.format(new Date(n.createdAt))}</time>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Layout>
    );
  }

  @Page('/about')
  about() {
    return (
      <Layout title="About" active="about">
        <div class="split">
          <section class="intro">
            <h1>About</h1>
            <p>
              Amoxi resolves this app's dependencies at build time, renders pages on the server, and only sends JavaScript
              for interactive islands. Switching between Home and About doesn't reload the page.
            </p>
          </section>

          <section class="panel" aria-labelledby="files-title">
            <h2 id="files-title">Where things live</h2>
            <ul class="files">
              <li><code>src/pages/</code><span>Pages (@Page) and error pages</span></li>
              <li><code>src/islands/</code><span>Interactive components bundled for the browser</span></li>
              <li><code>src/notes/</code><span>A service and a JSON API with validated input</span></li>
              <li><code>src/styles/</code><span>Stylesheets, bundled with hashed names</span></li>
              <li><code>application.json</code><span>Configuration, with per-profile overrides</span></li>
              <li><code>test/</code><span>Tests, run with npm test</span></li>
            </ul>
          </section>
        </div>
      </Layout>
    );
  }

  @ErrorPage(404)
  notFound() {
    return (
      <Layout title="Page not found">
        <div class="message">
          <h1>Page not found</h1>
          <p>The address may be mistyped, or the page may have moved.</p>
          <p><a href="/">Go home</a></p>
        </div>
      </Layout>
    );
  }

  @ErrorPage(500)
  serverError(ctx: RequestContext) {
    return (
      <Layout title="Something went wrong">
        <div class="message">
          <h1>Something went wrong</h1>
          <p>Try again in a moment. If it keeps happening, report reference {ctx.id}.</p>
        </div>
      </Layout>
    );
  }
}
