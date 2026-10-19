import { HttpError, HttpResponse, Middleware, type HttpMiddleware, type RequestContext } from 'amoxi';
import { CustomerDirectory } from '../bank/customers';
import { ActiveSessions } from './active-sessions';

/** Paths anyone may open (their markdown views too: ctx.path is the page path). /mcp has its own bearer token. */
const PUBLIC = new Set(['/signin', '/rates', '/api/session', '/mcp']);

/**
 * Online banking requires a signed-in customer. Pages redirect to the sign-in page; APIs and the
 * agent endpoints (/agents/...) answer 401. Runs before every route, including the ones the AI
 * module adds, so the assistant is protected by the same rule as the rest of the app.
 */
@Middleware(10)
export class AuthMiddleware implements HttpMiddleware {
  constructor(
    private readonly customers: CustomerDirectory,
    private readonly active: ActiveSessions,
  ) {}

  async handle(ctx: RequestContext, next: () => Promise<unknown>): Promise<unknown> {
    // A session that was signed out (or never signed in here) is ignored, even if its cookie is replayed.
    if (ctx.session.get('customerId') !== undefined && !this.active.has(ctx.session.id)) ctx.session.destroy();
    const path = ctx.path;
    if (PUBLIC.has(path)) return next();
    const customer = this.customers.find(ctx.session.get('customerId'));
    if (customer) {
      ctx.state.customer = customer;
      return next();
    }
    if (path.startsWith('/agents') || path.startsWith('/api/')) {
      throw new HttpError(401, 'Sign in to online banking first');
    }
    const target = ctx.path === '/' ? '' : `?next=${encodeURIComponent(ctx.path + (ctx.search ? `?${ctx.search}` : ''))}`;
    return HttpResponse.redirect(`/signin${target}`, 303);
  }
}
