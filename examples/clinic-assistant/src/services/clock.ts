import { Singleton } from 'amoxi';

/** The current time. Replaced in tests (overrides: [['Clock', fixedClock]]) so schedules are deterministic. */
export interface Clock {
  now(): Date;
}

@Singleton()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
