import { Eager, Logger, PostConstruct, PreDestroy, Singleton, Value } from 'amoxi';
import { TERMINAL_STATUSES, type AgentPlatform, type RunRecord } from 'amoxi/ai';
import { OPS_OWNER, toPrincipal } from '../agents/identity';

/**
 * The morning planning schedule: every `dispatch.schedule.interval-ms` it asks the planner to
 * plan tomorrow for each depot, with no one at a keyboard. Off by default (and in tests); turn
 * it on with `--dispatch.schedule.enabled=true` or DISPATCH_SCHEDULE_ENABLED=true. A production
 * deployment would use a cron expression or the platform's scheduler instead of an interval.
 */
@Eager()
@Singleton()
export class MorningPlanning {
  private timer?: ReturnType<typeof setInterval>;
  private readonly last = new Map<string, string>();
  private readonly depots: string[];

  constructor(
    private readonly platform: AgentPlatform,
    @Value('${dispatch.schedule.enabled:false}') readonly enabled: boolean,
    @Value('${dispatch.schedule.interval-ms:86400000}') readonly intervalMs: number,
    @Value('${dispatch.schedule.depots:Toronto,Montreal,Ottawa}') depots: string,
  ) {
    this.depots = depots.split(',').map((d) => d.trim()).filter(Boolean);
  }

  @PostConstruct()
  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      this.runNow().catch((err) => new Logger('info', false).error('Morning planning failed', { err }));
    }, Math.max(1000, this.intervalMs));
    this.timer.unref?.();
  }

  @PreDestroy()
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Starts one planning run per depot, skipping a depot whose previous run is still going. */
  async runNow(): Promise<RunRecord[]> {
    const started: RunRecord[] = [];
    for (const depot of this.depots) {
      const previous = this.last.get(depot);
      if (previous) {
        const run = await this.platform.getRun(previous);
        if (run && !TERMINAL_STATUSES.has(run.status)) continue;
      }
      const run = await this.platform.startRun({
        agent: 'dispatch-planner',
        input: `Plan routes for ${depot} depot tomorrow`,
        owner: OPS_OWNER,
        principal: toPrincipal({ source: 'schedule', name: 'Morning planning' }),
      });
      this.last.set(depot, run.id);
      started.push(run);
    }
    return started;
  }
}
