import { Singleton, type Invocation, type MethodInterceptor, type Provider } from 'amoxi';
import { RequestTimings } from './request-timings';

/**
 * AOP: measures every method of beans annotated with @Intercept(TimingInterceptor).
 * The interceptor is a singleton, so it reaches the request-scoped RequestTimings through a
 * Provider; outside a request (startup, tests) getIfAvailable() returns undefined.
 */
@Singleton()
export class TimingInterceptor implements MethodInterceptor {
  constructor(private readonly timings: Provider<RequestTimings>) {}

  intercept(invocation: Invocation): unknown {
    const start = performance.now();
    const done = (): void => this.timings.getIfAvailable()?.record(`${invocation.bean}.${invocation.method}`, performance.now() - start);
    let result: unknown;
    try {
      result = invocation.proceed();
    } catch (err) {
      done();
      throw err;
    }
    if (result instanceof Promise) return result.finally(done);
    done();
    return result;
  }
}
