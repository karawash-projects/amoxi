import { type HttpMiddleware, Middleware, type Provider, type RequestContext } from 'amoxi';
import { RequestTimings } from '../observability/request-timings';

/**
 * Adds a Server-Timing header to every routed response: total time in Amoxi plus each
 * intercepted method (see TimingInterceptor), so it all shows up in the browser's dev tools.
 */
@Middleware(0)
export class ServerTimingMiddleware implements HttpMiddleware {
  constructor(private readonly timings: Provider<RequestTimings>) {}

  async handle(ctx: RequestContext, next: () => Promise<unknown>): Promise<unknown> {
    const start = performance.now();
    const result = await next();
    if (!ctx.res.headersSent) {
      const methods = this.timings.getIfAvailable()?.serverTiming() ?? [];
      ctx.res.setHeader('server-timing', [`app;dur=${(performance.now() - start).toFixed(2)}`, ...methods].join(', '));
    }
    return result;
  }
}
