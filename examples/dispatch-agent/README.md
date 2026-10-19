# Demo Freight: dispatch agents that keep working

Demo Freight is a fictional regional carrier with depots in Toronto, Montreal and Ottawa. This example is its operations console. The AI work here is not a chat reply that has to fit in one HTTP request. It is **long-running, event-driven agent work** that a serverless route handler can't do:

- **The dispatch planner** builds tomorrow's routes for a depot. It runs for many seconds in the background, through many steps (load, cluster, match trucks, check driver hours, sequence, check delivery windows) and reports each one live. It survives restarts, then asks a dispatcher to approve the plan before any truck is booked.
- **The exception handler** starts when a truck's telematics unit reports a breakdown, delay or reefer temperature alarm. Nobody types anything. It assesses the impact at once, recommends a recovery truck, posts an ops alert, and leaves the freight transfer waiting for a dispatcher to approve.
- **Partner carriers' agents** ask for capacity quotes over A2A, and MCP clients can call the quote and tracking tools.
- **A morning schedule** can plan every depot with nobody at a keyboard.

Everything works offline with no API key: a built-in demo model picks tools by keyword. Demo data is fictional: the company, customers, drivers and trucks are invented.

<!-- screenshots -->
## Screenshots

Taken from this app running with the offline demo model. All data is fictional.

**Operations console**

<img src="../../website/public/shots/logistics-console-desktop.jpg" alt="Operations console, desktop" width="100%">

**Route plan from a long run**

<img src="../../website/public/shots/logistics-plan-desktop.jpg" alt="Route plan from a long run, desktop" width="100%">

**Exception from a vehicle event**

<img src="../../website/public/shots/logistics-exception-desktop.jpg" alt="Exception from a vehicle event, desktop" width="100%">

On a phone:

| Operations console | Route plan from a long run | Exception from a vehicle event |
|---|---|---|
| <img src="../../website/public/shots/logistics-console-mobile.jpg" alt="Operations console, phone" width="240"> | <img src="../../website/public/shots/logistics-plan-mobile.jpg" alt="Route plan from a long run, phone" width="240"> | <img src="../../website/public/shots/logistics-exception-mobile.jpg" alt="Exception from a vehicle event, phone" width="240"> |

## What to try

Open the console at http://localhost:8084 (the demo signs you in as the dispatcher on shift, Mireille Obrelle).

| Do this | What happens |
|---|---|
| "Which shipments are still unassigned?" | Reads tomorrow's unassigned freight (`list_unassigned_shipments`) |
| "Show fleet status and driver hours" | Trucks, loads, and driving hours left today and in the 70 h cycle (`fleet_status`) |
| "Plan routes for Toronto depot tomorrow" | Several seconds of optimiser progress, then the **route map**. One stop is held because a driver is short on hours |
| Click "Assign plan PLN-2041 to its vehicles" | An **approval card** lists every truck. Nothing is booked until you click "Approve and book" |
| Click "Notify drivers for plan PLN-2041" | Texts each driver once. Ask again and nobody is texted twice |
| "Quote capacity for 8 pallets, 6200 kg Toronto-Montreal" | A **quote card** with price in CAD and the room left on the pickup date |
| "Simulate TRK-214 breakdown" (Background runs panel) | A telematics event starts an **exception-handler run** by itself. Open it to see the **incident brief**, then click "Reassign shipments from TRK-214 to TRK-118" and approve |
| "Run morning planning" | The schedule starts one planning run per depot. Watch them in Background runs |
| Partners and events page | The webhook, schedule, A2A and MCP contracts, with test buttons |

Planning keeps running if you close the tab, and reloading the console continues an in-progress run in place (approval cards included, via `agentChat({ resume })`). The Background runs panel lists every run (who or what started it, the step it is on, and whether it needs approval). Each run has a live page at `/runs/<id>`.

**Durability, live:** start a Toronto plan, stop the server (Ctrl+C) while it is sequencing, and start it again. The run resumes from its checkpoint. The run page shows "Resuming after a restart" and skips the phases that already finished. Conversations and runs are kept in `data/ai/`. The demo's operations data is in memory and reseeds on restart, like a fresh database.

## Amoxi feature: why it matters in logistics

| Amoxi feature | Why it matters in logistics and operations |
|---|---|
| **Durable background runs** (checkpointed after every model turn and tool result) | Route optimisation takes minutes, not milliseconds. It must outlive the HTTP request, the browser tab and a deploy |
| **`ctx.step()` + `@Tool({ idempotent: true })`** | After a restart an interrupted tool runs again: optimiser phases are replayed instead of recomputed, and texts already sent to drivers come back from their records instead of going out twice |
| **`ctx.progress()` + SSE streaming** | Dispatchers see "Checking driver hours…", not a spinner. The runs panel shows the current step of every run |
| **`ctx.signal` cancellation** | "Stop" halts the optimiser mid-phase. No half-written plan is saved |
| **`approval: true` tools** | Booking trucks and moving freight between trucks always wait for a dispatcher, even when an event started the run |
| **`beforeToolCall` guardrails** (run before approval is requested) | Drivers are never texted for an unapproved plan. Partner agents can only quote and track, and can't even request a booking |
| **Programmatic runs** (`AgentPlatform.startRun`) | Telematics webhooks and schedules start agents with no human typing. The run's `principal` records what started it |
| **`owner()` / `principal()` hooks** | Runs belong to the ops team (`user:ops`), so any dispatcher on shift can open and approve a run that telematics started at 3 a.m. |
| **Generative UI** (`@generative` islands shown with `ctx.ui()`) | Route maps, incident briefs and quotes come from tool data, never from figures the model made up. Partner agents get the quote as data, not a card |
| **A2A server** (agent card, tasks, `input-required`) | Partner carriers' and brokers' agents ask for capacity on a lane machine-to-machine |
| **MCP server** (read-only tools only) | Customers' assistants can track shipments; approval tools are never exposed |
| **Body validation from TypeScript types** | The telematics webhook rejects malformed events with a 400 listing every problem, before any agent runs |
| **Middleware** | A shared-secret check on the webhook, before validation |
| **`@Eager` beans + `@Value` config** | The morning schedule is plain DI configuration, off by default and in tests |
| **Pages for agents** (`.md`, JSON with `withData`, `/llms.txt`) | Other systems can read the console's KPIs and runs without scraping HTML |
| **Islands and signals** | A live console (KPIs, fleet, runs, chat) in about 22 kB of JavaScript |

## How to run

From this folder:

`npm start` runs in production, which refuses the demo secrets (they are in `application-development.json`, used by `npm run dev` only). Before the first start, create a file named `.env.production.local` in this folder (git ignores it) with your own values, each at least 16 characters:

```
AI_MCP_CALLERS_PARTNER=replace-with-a-long-random-value
AI_A2A_CALLERS_PARTNER=replace-with-a-long-random-value
DISPATCH_TELEMATICS_SECRET=replace-with-a-long-random-value
```

```bash
npm run build
npm start
```

`npm start` runs one worker because this demo keeps its data in memory, which each worker process would hold separately. A production version with a database (and `ai.store.type` set to `postgres`) can run one worker per CPU core with `amoxi start dist/src/main.js --workers auto`.

or, for development with reloads:

```bash
npm run dev
```

Run the tests (14 tests, about 5 seconds):

```bash
npm test
```

### Use a real model

Create `.env` in this folder with one of:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

and restart. The same agents then use the real model: the planner chains plan → assign (approval) → notify on its own, and the exception handler assesses, posts an alert and proposes the transfer in one run. Without a key, the offline model calls one tool per message, so the console offers the next step as a suggestion.

### Configuration

| Key | Default | |
|---|---|---|
| `dispatch.planner.step-ms` | 650 | Pace of the simulated optimiser. Tests use 2 |
| `dispatch.notify.step-ms` | 450 | Pause per driver text |
| `dispatch.telematics.secret` | `demo-telematics-secret-not-for-production` in development | Shared secret for `x-telematics-secret`; required in production (`DISPATCH_TELEMATICS_SECRET`) |
| `dispatch.schedule.enabled` | `false` | Morning planning schedule (`--dispatch.schedule.enabled=true`) |
| `dispatch.schedule.interval-ms` | 86400000 | How often it runs |
| `dispatch.schedule.depots` | `Toronto,Montreal,Ottawa` | Depots it plans |
| `ai.mcp.callers.partner` / `ai.a2a.callers.partner` | `demo-mcp-token-not-a-secret` / `demo-a2a-token-not-a-secret` in development | The partner's own tokens, so its runs are owned by `mcp:partner` / `a2a:partner` and appear in the console. **Demo tokens, not secrets:** production refuses them (`AI_MCP_CALLERS_PARTNER`, `AI_A2A_CALLERS_PARTNER`) |

### Webhook and partner calls

```bash
curl -X POST http://localhost:8084/api/telematics/events -H "content-type: application/json" -H "x-telematics-secret: demo-telematics-secret-not-for-production" -d "{\"vehicleId\":\"TRK-214\",\"type\":\"breakdown\",\"location\":\"Hwy 401 EB near Port Hope\",\"occurredAt\":\"2026-10-18T14:05:00Z\"}"
```

Answers `202` with the run id and starts the exception handler. A missing or wrong secret gets 401, and an invalid body gets 400.

- A2A agent card: `GET /.well-known/agent-card.json` (skills `dispatch-planner` and `exception-handler`). Tasks: `POST /a2a` with `Authorization: Bearer demo-a2a-token-not-a-secret`.
- MCP: `POST /mcp` with `Authorization: Bearer demo-mcp-token-not-a-secret`. Offers `capacity_quote`, `track_shipment` and `ask_*`.

## How the durability test works

`test/planner.test.ts` ("a run interrupted by shutdown resumes…") starts two application instances, one after the other. They share a `MemoryRunStore`, a `MemoryConversationStore` and one `OpsDatabase` (the stand-in for the carrier's database and SMS gateway), passed as `overrides`.

1. The first instance plans Toronto, gets the assignment approved, and starts texting drivers. It is shut down after two texts.
2. The run goes back to the queue with its checkpoint.
3. The second instance claims it without repeating any model turn. `notify_drivers` is marked `idempotent: true`, so the interrupted call itself runs again. Each text already sent returns its recorded `ctx.step` result, and only the remaining drivers are texted. The model is only asked for the final answer.
4. The test checks that every driver is texted exactly once and that the event log has no gaps across both processes.

Tools that aren't marked idempotent are never re-run blindly: the model is told the action was interrupted. The SMS gateway also drops repeats by an idempotency key (`plan:vehicle`). That is defence in depth, for example if someone asks to notify the same plan twice.

## File map

```
src/
  agents/        dispatch-planner.ts, exception-handler.ts (agents and hooks)
                 dispatch-tools.ts (plan, assign, notify), exception-tools.ts (assess, reassign, alert)
                 partner-tools.ts (capacity quote, tracking: MCP/A2A), identity.ts (owners, run origins)
  domain/        geography.ts (depots, lakes, highways), lanes.ts (pricing), model.ts, seed.ts (demo data)
  ops/           ops-database.ts (in-memory TMS), route-optimizer.ts (sweep, 2-opt, HOS, windows), ops-views.ts
  telematics/    incident-service.ts (event -> run), telematics-controller.ts (webhook + secret middleware)
  schedule/      morning-planning.ts (@Eager interval schedule)
  runs/          run-board.ts (background runs for the console)
  api/           ops-api.ts (console JSON/SSE: snapshot, runs, approvals, follow-ups, demo triggers)
  pages/         pages.tsx (console, run page, partners and events)
  islands/       PlannerChat, RunsPanel, OpsBoard, RunViewer, TriggerButton
                 RoutePlanMap, IncidentBrief, QuoteCard (@generative)
  ui/            layout, chat renderers, run event reducer, live snapshot, labels
test/            planner, events (webhook, exceptions, schedule), protocols (MCP, A2A, pages)
```

## What production adds

- A real identity provider (dispatcher roles and per-depot permissions) instead of the demo sign-in, and per-partner A2A/MCP credentials.
- PostgreSQL for runs and conversations (`ai.store.type=postgres`), so any number of workers share the run queue. Use the carrier's TMS database instead of the in-memory `OpsDatabase`.
- A real optimiser (OR-Tools, a commercial VRP API) behind the same checkpointed phases, plus live traffic and electronic logging device (ELD) hours.
- The telematics provider's HMAC signatures or mTLS instead of a shared secret, and event de-duplication.
- An SMS or driver-app gateway with idempotency keys (the demo gateway keeps them in memory).
- A real scheduler (cron, or the platform's), with one leader across instances.
