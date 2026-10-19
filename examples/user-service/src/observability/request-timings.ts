import { RequestScope, type RequestContext } from 'amoxi';

/** One instance per HTTP request: collects how long instrumented methods took. */
@RequestScope()
export class RequestTimings {
  private readonly entries: Array<{ name: string; ms: number }> = [];

  constructor(private readonly request: RequestContext) {}

  get requestId(): string {
    return this.request.id;
  }

  record(name: string, ms: number): void {
    this.entries.push({ name, ms });
  }

  /** Server-Timing header entries, visible in the browser's dev tools (Network > Timing). */
  serverTiming(): string[] {
    return this.entries.map((e) => `${e.name};dur=${e.ms.toFixed(2)}`);
  }
}
