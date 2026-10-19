import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpError, HttpResponse, Middleware, Post, Value, type HttpMiddleware, type RequestContext } from 'amoxi';
import { IncidentService, type TelematicsEvent } from './incident-service';

export const TELEMATICS_PATH = '/api/telematics/events';

/**
 * Telematics webhook: the fleet's tracking units POST breakdowns, delays and reefer alarms here.
 * Each event starts an exception-handler run in the background and returns 202 at once.
 */
@Controller('/api/telematics')
export class TelematicsController {
  constructor(private readonly incidents: IncidentService) {}

  @Post('/events')
  async receive(@Body() event: TelematicsEvent) {
    const { incident, run } = await this.incidents.report(event);
    return new HttpResponse(
      202,
      { eventId: incident.id, runId: run.id, status: run.status, links: { run: `/runs/${run.id}`, api: `/agents/exception-handler/runs/${run.id}` } },
      { location: `/runs/${run.id}` },
    );
  }
}

/**
 * Shared-secret check for the webhook (header `x-telematics-secret`), before the body is even
 * validated. Production would use the provider's HMAC signature or mTLS; the idea is the same.
 */
@Middleware(10)
export class TelematicsSecretMiddleware implements HttpMiddleware {
  private readonly expected: Buffer;

  constructor(@Value('${dispatch.telematics.secret}') secret: string) {
    this.expected = Buffer.from(secret);
  }

  async handle(ctx: RequestContext, next: () => Promise<unknown>): Promise<unknown> {
    if (ctx.path === TELEMATICS_PATH) {
      const raw = ctx.headers['x-telematics-secret'];
      const given = Buffer.from(typeof raw === 'string' ? raw : '');
      if (given.length !== this.expected.length || !timingSafeEqual(given, this.expected)) {
        throw new HttpError(401, 'Missing or wrong x-telematics-secret header');
      }
    }
    return next();
  }
}
