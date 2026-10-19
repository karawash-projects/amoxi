import { Controller, ErrorPage, Island, Page, PathParam, QueryParam, Value, withData, withStatus, type RequestContext } from 'amoxi';
import type { AgentPlatform, ChatItem } from 'amoxi/ai';
import { originOf, signInDemoDispatcher } from '../agents/identity';
import OpsBoard from '../islands/OpsBoard';
import PlannerChat from '../islands/PlannerChat';
import RunViewer from '../islands/RunViewer';
import RunsPanel from '../islands/RunsPanel';
import TriggerButton from '../islands/TriggerButton';
import { OpsDatabase } from '../ops/ops-database';
import { OpsViews } from '../ops/ops-views';
import { AGENT_LABELS, RunBoard, runTitle } from '../runs/run-board';
import { MorningPlanning } from '../schedule/morning-planning';
import { TELEMATICS_PATH } from '../telematics/telematics-controller';
import { clock, dayLabel, SOURCE_LABELS } from '../ui/labels';
import { Layout } from '../ui/layout';

const EXAMPLES = ['Which shipments are still unassigned?', 'Show fleet status and driver hours', 'Plan routes for Toronto depot tomorrow', 'Quote capacity for 8 pallets, 6200 kg Toronto-Montreal'];

/** Server-rendered pages. The console is one screen: live data around the planner conversation. */
@Controller()
export class Pages {
  constructor(
    private readonly views: OpsViews,
    private readonly board: RunBoard,
    private readonly platform: AgentPlatform,
    private readonly db: OpsDatabase,
    private readonly schedule: MorningPlanning,
    @Value('${ai.a2a.enabled:false}') private readonly a2a: boolean,
    @Value('${ai.mcp.enabled:false}') private readonly mcp: boolean,
  ) {}

  @Page('/')
  async console(@QueryParam('new') fresh: string | undefined, ctx: RequestContext) {
    const dispatcher = signInDemoDispatcher(ctx);
    const snapshot = this.views.snapshot();
    const runs = await this.board.list();
    const conversation = fresh ? undefined : await this.board.latestPlannerConversation();
    const page = (
      <Layout title="Operations console" active="console" dispatcher={dispatcher} today={dayLabel(this.db.today)} wide>
        <h1 class="visually-hidden">Operations console</h1>
        <Island of={OpsBoard} part="kpis" snapshot={snapshot} />
        <div class="console">
          <div class="col-work">
            <Island of={OpsBoard} part="work" snapshot={snapshot} />
          </div>
          <div class="col-chat">
            <Island of={PlannerChat} initial={(conversation?.items ?? []) as ChatItem[]} threadId={conversation?.threadId} activeRun={conversation?.activeRun} examples={EXAMPLES} />
          </div>
          <div class="col-runs">
            <Island of={RunsPanel} runs={runs} now={Date.now()} triggers={true} />
            <Island of={OpsBoard} part="alerts" snapshot={snapshot} />
          </div>
        </div>
      </Layout>
    );
    return withData(page, { kpis: snapshot.kpis, unassigned: snapshot.unassigned, runs: runs.map((r) => ({ id: r.id, agent: r.agent, status: r.status, startedBy: r.startedBy, step: r.currentStep })) });
  }

  @Page('/runs/:id')
  async run(@PathParam() id: string, ctx: RequestContext) {
    const dispatcher = signInDemoDispatcher(ctx);
    const run = await this.platform.getRun(id);
    if (!this.board.visible(run)) return withStatus(404, this.notFoundPage(ctx));
    const [events, prior, card] = await Promise.all([this.board.events(run.id), this.board.priorItems(run), this.board.card(run)]);
    const origin = originOf(run.principal, run.owner);
    const incident = this.db.incidents.find((i) => i.runId === run.id || (origin.eventId !== undefined && i.id === origin.eventId));
    const page = (
      <Layout title={`${AGENT_LABELS[run.agent] ?? run.agent} run`} active="runs" dispatcher={dispatcher} today={dayLabel(this.db.today)} wide>
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="/">Console</a> <span aria-hidden="true">/</span> <span>{AGENT_LABELS[run.agent] ?? run.agent} run</span>
        </nav>
        <header class="run-header">
          <p class={`origin origin-${origin.source}`}>
            {SOURCE_LABELS[origin.source]}: {origin.name}
          </p>
          <h1>{runTitle(run.input, origin)}</h1>
        </header>
        <div class="run-page">
          <div class="run-main">
            <Island
              of={RunViewer}
              runId={run.id}
              status={run.status}
              events={events.map((e) => ({ seq: e.seq, type: e.type, data: e.data }))}
              prior={prior as ChatItem[]}
              followUpHint={run.agent === 'exception-handler' ? 'Ask the exception desk, e.g. to move the freight' : 'Ask the planner, e.g. to plan another depot'}
            />
          </div>
          <aside class="run-aside">
            <section class="panel facts" aria-labelledby="facts-title">
              <h2 id="facts-title">About this run</h2>
              <dl>
                <div>
                  <dt>Agent</dt>
                  <dd>{run.agent}</dd>
                </div>
                <div>
                  <dt>Started by</dt>
                  <dd>{origin.name}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time datetime={run.createdAt}>{clock(run.createdAt)}</time>
                  </dd>
                </div>
                {run.finishedAt ? (
                  <div>
                    <dt>Finished</dt>
                    <dd>
                      <time datetime={run.finishedAt}>{clock(run.finishedAt)}</time>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Run id</dt>
                  <dd class="break">{run.id}</dd>
                </div>
              </dl>
            </section>
            {incident ? (
              <section class="panel facts" aria-labelledby="event-title">
                <h2 id="event-title">Telematics event {incident.id}</h2>
                <dl>
                  <div>
                    <dt>Truck</dt>
                    <dd>{incident.vehicleId}</dd>
                  </div>
                  <div>
                    <dt>Type</dt>
                    <dd>{incident.type.replace('_', ' ')}</dd>
                  </div>
                  <div>
                    <dt>Where</dt>
                    <dd>{incident.location}</dd>
                  </div>
                  {incident.note ? (
                    <div>
                      <dt>Unit note</dt>
                      <dd>{incident.note}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Occurred</dt>
                    <dd>
                      <time datetime={incident.occurredAt}>{clock(incident.occurredAt)}</time>
                    </dd>
                  </div>
                </dl>
                <p class="aside-note">Nobody typed this request: the webhook started the run, read-only analysis ran at once, and anything that moves freight waits for a dispatcher.</p>
              </section>
            ) : null}
            <section class="panel facts" aria-labelledby="durable-title">
              <h2 id="durable-title">Built to keep going</h2>
              <p class="aside-note">
                Every model turn, tool result and optimiser phase is checkpointed. If the server restarts mid-run, the run resumes from its last step on the next start, and drivers are never texted twice.
              </p>
            </section>
          </aside>
        </div>
      </Layout>
    );
    return withData(page, { run: card, incident: incident ?? null });
  }

  @Page('/integrations')
  integrations(ctx: RequestContext) {
    const dispatcher = signInDemoDispatcher(ctx);
    const agents = this.platform.agents();
    const exposed = this.platform.tools().filter((t) => t.expose && !t.approval);
    return (
      <Layout title="Partners and events" active="integrations" dispatcher={dispatcher} today={dayLabel(this.db.today)}>
        <header class="page-head">
          <h1>Partners and events</h1>
          <p class="lede">The agents don't only answer dispatchers. Truck telematics, a morning schedule and partner carriers' own agents start work too, and all of it shows up in the console's background runs.</p>
        </header>

        <section class="doc-section" aria-labelledby="webhook-title">
          <h2 id="webhook-title">Telematics webhook</h2>
          <p>
            Tracking units post breakdowns, delays and reefer temperature alarms to <code>POST {TELEMATICS_PATH}</code> with the shared secret in <code>x-telematics-secret</code>. The body is validated from its TypeScript type (bad payloads get a 400 listing every problem), and each
            event starts an <code>exception-handler</code> run owned by the ops team, then answers 202 straight away.
          </p>
          <pre class="code" tabindex="0">
            <code>{`curl -X POST http://localhost:8084${TELEMATICS_PATH} \\
  -H "content-type: application/json" \\
  -H "x-telematics-secret: demo-telematics-secret-not-for-production" \\
  -d '{"vehicleId":"TRK-214","type":"breakdown","location":"Hwy 401 EB near Port Hope","note":"Coolant leak","occurredAt":"2026-10-18T14:05:00Z"}'`}</code>
          </pre>
          <p class="actions">
            <Island of={TriggerButton} label="Send a test breakdown for TRK-214" endpoint="/api/demo/telematics" body={{ vehicleId: 'TRK-214', type: 'breakdown' }} variant="alarm" />
            <Island of={TriggerButton} label="Send a reefer alarm for TRK-124" endpoint="/api/demo/telematics" body={{ vehicleId: 'TRK-124', type: 'temperature_alarm' }} />
          </p>
        </section>

        <section class="doc-section" aria-labelledby="schedule-title">
          <h2 id="schedule-title">Morning planning schedule</h2>
          <p>
            A scheduled job asks the planner to plan tomorrow for every depot, with nobody at a keyboard. It is{' '}
            <strong>{this.schedule.enabled ? `on, every ${Math.round(this.schedule.intervalMs / 60000)} minutes` : 'off'}</strong> here; turn it on with <code>--dispatch.schedule.enabled=true</code> and set the interval with <code>dispatch.schedule.interval-ms</code>.
          </p>
          <p class="actions">
            <Island of={TriggerButton} label="Run morning planning now" endpoint="/api/schedule/morning-planning" />
          </p>
        </section>

        <section class="doc-section" aria-labelledby="a2a-title">
          <h2 id="a2a-title">Partner agents (A2A)</h2>
          <p>
            {this.a2a ? 'Enabled.' : 'Disabled in this configuration.'} Partner carriers' and brokers' agents read the agent card at <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a> and send tasks to <code>POST /a2a</code> with{' '}
            <code>Authorization: Bearer demo-a2a-token-not-a-secret</code> (a demo token; production uses a real secret per partner). Partner runs can only quote capacity and track shipments: a guardrail refuses every other tool.
          </p>
          <ul class="skill-list">
            {agents.map((a) => (
              <li>
                <strong>{a.name}</strong>
                <span>{a.description}</span>
              </li>
            ))}
          </ul>
          <pre class="code" tabindex="0">
            <code>{`curl -X POST http://localhost:8084/a2a \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer demo-a2a-token-not-a-secret" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"Quote capacity for 8 pallets, 6200 kg Toronto-Montreal"}],"metadata":{"skill":"dispatch-planner"}}}}'`}</code>
          </pre>
        </section>

        <section class="doc-section" aria-labelledby="mcp-title">
          <h2 id="mcp-title">MCP tools</h2>
          <p>
            {this.mcp ? 'Enabled' : 'Disabled'} at <code>POST /mcp</code> with <code>Authorization: Bearer demo-mcp-token-not-a-secret</code>. Only read-only tools without approval are offered, plus one <code>ask_</code> tool per agent:
          </p>
          <ul class="skill-list">
            {exposed.map((t) => (
              <li>
                <strong>{t.name}</strong>
                <span>{t.description}</span>
              </li>
            ))}
          </ul>
        </section>
      </Layout>
    );
  }

  private notFoundPage(ctx: RequestContext) {
    return (
      <Layout title="Not found" dispatcher={signInDemoDispatcher(ctx)}>
        <header class="page-head">
          <h1>That page isn't here</h1>
          <p class="lede">
            The run may belong to another team, or the link is mistyped. <a href="/">Back to the console</a>.
          </p>
        </header>
      </Layout>
    );
  }

  @ErrorPage(404)
  notFound(ctx: RequestContext) {
    return this.notFoundPage(ctx);
  }
}
