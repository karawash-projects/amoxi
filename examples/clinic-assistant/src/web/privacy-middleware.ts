import { HttpResponse, Middleware, type HttpMiddleware, type RequestContext } from 'amoxi';
import { PATIENT_SESSION_KEY } from './patient-session';
import { ActiveSessions } from './active-sessions';

/** Pages and endpoints that carry personal health information. */
const PRIVATE = [/^\/assistant(\.md)?$/, /^\/my-data(\.md)?$/, /^\/agents(\/|$)/, /^\/api\/me(\/|$)/];

export function isPrivatePath(path: string): boolean {
  return PRIVATE.some((re) => re.test(path));
}

/**
 * Health data must never sit in a shared cache or leak through the Referer header:
 * private routes get `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 * Starting an assistant run also requires a signed-in patient.
 */
@Middleware(0)
export class PrivacyMiddleware implements HttpMiddleware {
  constructor(private readonly active: ActiveSessions) {}

  async handle(ctx: RequestContext, next: () => Promise<unknown>): Promise<unknown> {
    // A signed-out session is ignored even if a copy of its cookie is replayed.
    if (ctx.session.get(PATIENT_SESSION_KEY) !== undefined && !this.active.has(ctx.session.id)) ctx.session.destroy();
    const sensitive = isPrivatePath(ctx.path);
    if (sensitive) {
      ctx.res.setHeader('cache-control', 'no-store');
      ctx.res.setHeader('referrer-policy', 'no-referrer');
    }
    if (ctx.method === 'POST' && /^\/agents\/[^/]+\/runs$/.test(ctx.path) && typeof ctx.session.get(PATIENT_SESSION_KEY) !== 'string') {
      return new HttpResponse(401, { error: 'Choose a demo patient first (in production: sign in to the patient portal).' });
    }
    const result = await next();
    if (sensitive && !ctx.res.headersSent) {
      ctx.res.setHeader('cache-control', 'no-store');
      ctx.res.setHeader('referrer-policy', 'no-referrer');
    }
    return result;
  }
}
