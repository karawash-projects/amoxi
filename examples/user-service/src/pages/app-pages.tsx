import {
  ApplicationContext,
  Await,
  Cached,
  Controller,
  ErrorPage,
  HttpResponse,
  Island,
  Page,
  PathParam,
  QueryParam,
  type RequestContext,
  describeApp,
  describeBeans,
  describeRoutes,
  withStatus,
} from 'amoxi';
import { ActivityHub } from '../activity/activity-hub';
import { AvatarStore } from '../avatars/avatar-store';
import AccentPicker from '../islands/AccentPicker.react';
import AddPerson from '../islands/AddPerson';
import AvatarUpload from '../islands/AvatarUpload';
import LiveActivity from '../islands/LiveActivity';
import DeletePerson from '../islands/DeletePerson';
import PeopleList from '../islands/PeopleList';
import ThemeToggle from '../islands/ThemeToggle';
import WiringDiagram from '../islands/WiringDiagram';
import type { Notifier } from '../notification/notifier';
import { UserService } from '../service/user-service';
import { PLATFORMS, dateTime, duration, initials } from '../ui/format';
import { Layout, type LayoutProps, type Section } from '../ui/layout';

// Only known codes become messages, so the query string can never inject text.
const FLASH = new Set(['added', 'deleted']);

/**
 * Server-rendered pages. Each @Page method returns JSX, which Amoxi renders to HTML with
 * no virtual DOM. Services arrive through the same compile-time DI as everything else.
 */
@Controller()
export class AppPages {
  constructor(
    private readonly users: UserService,
    private readonly ctx: ApplicationContext,
    private readonly avatars: AvatarStore,
    private readonly activity: ActivityHub,
  ) {}

  private shell(req: RequestContext, active: Section | undefined, title: string, flash?: string): Omit<LayoutProps, 'children'> {
    return {
      active,
      title,
      t: (key, params) => req.t(key, params),
      locale: req.locale,
      path: req.path,
      flash: flash && FLASH.has(flash) ? req.t(`flash.${flash}`) : undefined,
      startupMs: Math.round(this.ctx.startup.ms * 100) / 100,
      platform: PLATFORMS[process.platform] ?? process.platform,
    };
  }

  @Page('/')
  home() {
    return new HttpResponse(302, undefined, { location: '/people' });
  }

  @Page('/people')
  people(@QueryParam() flash: string | undefined, ctx: RequestContext) {
    return this.peopleView(undefined, flash, ctx);
  }

  @Page('/people/:id')
  person(@PathParam() id: number, @QueryParam() flash: string | undefined, ctx: RequestContext) {
    return this.peopleView(id, flash, ctx);
  }

  private peopleView(id: number | undefined, flash: string | undefined, ctx: RequestContext) {
    const t = ctx.t.bind(ctx);
    const users = this.users.list();
    const user = id === undefined ? undefined : this.users.get(id);

    // "Recently viewed" lives in the encrypted session cookie, so it survives restarts and works across workers.
    let recentIds = (ctx.session.get<number[]>('recent') ?? []).filter((r) => typeof r === 'number');
    if (user) {
      recentIds = [user.id, ...recentIds.filter((r) => r !== user.id)].slice(0, 5);
      ctx.session.set('recent', recentIds);
    }
    const recent = recentIds.map((r) => this.users.get(r)).filter((u) => u !== undefined && u.id !== id);
    const photo = user ? this.avatars.find(user.id) : undefined;
    const page = (
      <Layout {...this.shell(ctx, 'people', user?.name ?? t('people.title'), flash)}>
        <header class="view-head">
          <div>
            <h1>{t('people.title')}</h1>
            <p class="lede">{t('people.count', { count: users.length })}</p>
          </div>
          <Island of={AddPerson} />
        </header>
        {recent.length > 0 && (
          <nav class="recent" aria-label="Recently viewed">
            <span>{t('people.recent')}</span>
            {recent.map((u) => (
              <a href={`/people/${u!.id}`}>{u!.name}</a>
            ))}
          </nav>
        )}
        <div class={id === undefined ? 'people' : 'people has-detail'}>
          <div class="people-side">
            <Island of={PeopleList} users={users} selectedId={id} />
            <Island of={LiveActivity} title={t('activity.title')} events={[...this.activity.recent]} load="idle" />
          </div>
          {id === undefined ? (
            <section class="detail" aria-label="Details">
              <p class="muted">{t('people.select')}</p>
            </section>
          ) : user ? (
            <section class="detail" aria-labelledby="person-name">
              <a class="btn back" href="/people">{t('people.all')}</a>
              {photo ? (
                <img class="photo" src={`/users/${user.id}/avatar?v=${photo.version}`} alt="" width="56" height="56" />
              ) : (
                <div class="initials" aria-hidden="true">{initials(user.name)}</div>
              )}
              <h2 id="person-name">{user.name}</h2>
              <dl class="facts">
                <dt>{t('people.email')}</dt>
                <dd><a href={`mailto:${user.email}`}>{user.email}</a></dd>
                <dt>{t('people.id')}</dt>
                <dd>{user.id}</dd>
                <dt>{t('people.added')}</dt>
                <dd>{new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(user.createdAt))}</dd>
              </dl>
              <div class="detail-actions">
                <Island of={AvatarUpload} id={user.id} hasPhoto={!!photo} />
                <Island of={DeletePerson} id={user.id} />
              </div>
            </section>
          ) : (
            <section class="detail">
              <a class="btn back" href="/people">{t('people.all')}</a>
              <h2>{t('people.notFound')}</h2>
              <p class="muted">{t('people.notFoundText', { id: id! })}</p>
            </section>
          )}
        </div>
      </Layout>
    );
    return id !== undefined && !user ? withStatus(404, page) : page;
  }

  // Re-rendered at most every 5 s, served stale for up to 30 s while refreshing (like Next.js ISR).
  @Page('/wiring')
  @Cached(5, { staleWhileRevalidate: 30 })
  wiring(ctx: RequestContext) {
    const beans = describeBeans(this.ctx);
    const routes = describeRoutes(this.ctx);
    const created = beans.filter((b) => b.created).length;
    return (
      <Layout {...this.shell(ctx, 'wiring', ctx.t('nav.wiring'))}>
        <header class="view-head">
          <div>
            <h1>Wiring</h1>
            <p class="lede">
              {created} of {beans.length} beans created so far. Amoxi worked out this graph at build time; at runtime it
              only follows it.
            </p>
          </div>
        </header>
        <div class="legend">
          <span>Numbers show creation order</span>
          <span><i class="dot on" aria-hidden="true" />Created</span>
          <span><i class="dot" aria-hidden="true" />Created on first use</span>
          <span>Lines connect a bean to what it needs</span>
        </div>
        <Island of={WiringDiagram} beans={beans} load="visible" />
        <h2 class="section-title">Routes</h2>
        <table class="routes">
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Path</th>
              <th scope="col">Handled by</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr>
                <td><span class={`method method-${r.method}`}>{r.method}</span></td>
                <td><code>{r.path}</code></td>
                <td>{r.controller}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Layout>
    );
  }

  @Page('/status')
  status(ctx: RequestContext) {
    const info = describeApp(this.ctx);
    const rt = info.runtime;
    const facts = (pairs: Array<[string, unknown]>) => (
      <dl>
        {pairs.map(([k, v]) => (
          <>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </>
        ))}
      </dl>
    );
    return (
      <Layout {...this.shell(ctx, 'status', ctx.t('nav.status'))}>
        <header class="view-head">
          <div>
            <h1>Status</h1>
            <p class="lede">Rendered on the server at {dateTime.format(new Date())}.</p>
          </div>
          <a class="btn" href="/status">Refresh</a>
        </header>
        <div class="status-grid">
          <section>
            <h2>Application</h2>
            {facts([
              ['Status', <span class="up">Running</span>],
              ['Name', info.name],
              ['Startup time', `${info.startupMs} ms`],
              ['Running for', duration(info.uptimeSeconds)],
              ['Started', dateTime.format(new Date(info.startedAt))],
            ])}
          </section>
          <section>
            <h2>Runtime</h2>
            {facts([
              ['Operating system', `${PLATFORMS[rt.platform] ?? rt.platform} (${rt.arch})`],
              ['Node.js', rt.node],
              ['Memory in use', `${rt.memoryRssMb} MB`],
              ['JavaScript heap', `${rt.heapUsedMb} MB`],
              ['Process id', rt.pid],
            ])}
          </section>
          <section>
            <h2>Dependency injection</h2>
            {facts([
              ['Beans created', `${info.beans.created} of ${info.beans.total}`],
              ['Routes', info.routes],
              ['Graph compiled', dateTime.format(new Date(info.build.generatedAt))],
              ['Compiler', `Amoxi ${info.build.compilerVersion}`],
            ])}
          </section>
          <section>
            <h2>Checks</h2>
            {/* Streamed: the page arrives immediately, this section follows when the checks finish. */}
            <Await promise={this.runChecks()} fallback={<p class="muted" style="margin:.75rem 0 0">Running checks…</p>}>
              {(checks) => facts(checks.map((c) => [c.name, <span class={c.ok ? 'check-ok' : 'check-warn'}>{c.detail}</span>]))}
            </Await>
          </section>
          <section>
            <h2>Appearance</h2>
            <p class="muted" style="margin:.75rem 0 0">System follows your device setting.</p>
            <Island of={ThemeToggle} variant="buttons" />
            <h3 class="subhead">{ctx.t('status.accent')}</h3>
            <Island of={AccentPicker} label={ctx.t('status.accentHex')} resetLabel={ctx.t('status.accentReset')} initial="#2F4A66" load="visible" />
          </section>
        </div>
      </Layout>
    );
  }

  /** Simulates slower checks (e.g. a database ping) to demonstrate streaming. */
  private async runChecks(): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
    const started = performance.now();
    await new Promise((r) => setTimeout(r, 400));
    const lag = performance.now() - started - 400;
    const notifiers = this.ctx.getBeansOfType<Notifier>('Notifier');
    return [
      { name: 'Notification channels', ok: notifiers.length > 0, detail: `${notifiers.length} ready (${notifiers.map((n) => n.channel).join(', ')})` },
      { name: 'People store', ok: true, detail: `${this.users.list().length} records` },
      { name: 'Event loop delay', ok: lag < 50, detail: `${Math.max(0, lag).toFixed(1)} ms` },
    ];
  }

  @ErrorPage(404)
  notFound(ctx: RequestContext) {
    return (
      <Layout {...this.shell(ctx, undefined, ctx.t('errors.notFound'))}>
        <div class="error-view">
          <p class="code">404</p>
          <h1>{ctx.t('errors.notFound')}</h1>
          <p class="lede">{ctx.t('errors.notFoundText')}</p>
          <p><a class="btn primary" href="/people">{ctx.t('errors.home')}</a></p>
        </div>
      </Layout>
    );
  }

  @ErrorPage(500)
  serverError(ctx: RequestContext) {
    return (
      <Layout {...this.shell(ctx, undefined, ctx.t('errors.server'))}>
        <div class="error-view">
          <p class="code">500</p>
          <h1>{ctx.t('errors.server')}</h1>
          <p class="lede">{ctx.t('errors.serverText')}</p>
          <p class="muted">{ctx.t('errors.reference', { id: ctx.id })}</p>
          <p><a class="btn" href="/people">{ctx.t('errors.home')}</a></p>
        </div>
      </Layout>
    );
  }
}
