import { Body, Controller, HttpError, Post, type RequestContext } from 'amoxi';
import { AuditLog } from '../audit/audit-log';
import { CustomerDirectory } from '../bank/customers';
import { ActiveSessions } from './active-sessions';

export interface SignInRequest {
  /**
   * One of the demo customers, e.g. C-1001
   * @pattern ^C-\d{4}$
   */
  readonly customerId: string;
  /**
   * Where to go afterwards (a path on this site)
   * @maxLength 200
   */
  readonly next?: string;
}

/**
 * Demo sign-in: pick a customer, get an encrypted session cookie. In production this controller
 * is replaced by the bank's identity provider (OIDC with step-up MFA); the rest of the app only
 * reads `customerId` from the session and doesn't change.
 */
@Controller('/api/session')
export class SessionController {
  constructor(
    private readonly customers: CustomerDirectory,
    private readonly audit: AuditLog,
    private readonly active: ActiveSessions,
  ) {}

  @Post()
  signIn(@Body() body: SignInRequest, ctx: RequestContext) {
    const customer = this.customers.find(body.customerId);
    if (!customer) throw new HttpError(404, 'Unknown customer');
    ctx.session.regenerate(); // a new session id on every sign-in (no session fixation)
    ctx.session.set('customerId', customer.id);
    this.active.add(ctx.session.id);
    this.audit.append({ actor: customer.id, action: 'session.signin', outcome: 'ok', summary: `${customer.name} signed in (demo sign-in)` });
    const next = body.next && /^\/(?!\/)[\w\-/.?=&%]*$/.test(body.next) ? body.next : '/assistant';
    return { ok: true, customer: { id: customer.id, name: customer.name }, next };
  }

  @Post('/end')
  signOut(ctx: RequestContext) {
    const customer = this.customers.find(ctx.session.get('customerId'));
    if (customer) this.audit.append({ actor: customer.id, action: 'session.signout', outcome: 'ok', summary: `${customer.name} signed out` });
    this.active.remove(ctx.session.id); // the old cookie stops working everywhere, not just in this browser
    ctx.session.destroy();
    return { ok: true, next: '/signin' };
  }
}
