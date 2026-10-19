import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryConversationStore, MemoryRunStore, ScriptedChatModel } from 'amoxi/ai';
import { OPS_OWNER } from '../src/agents/identity';
import { linehaulCents } from '../src/domain/lanes';
import { OpsDatabase } from '../src/ops/ops-database';
import { RunBoard } from '../src/runs/run-board';
import { DISPATCHER, eventsOf, settled, sse, start, waitFor } from './helpers';

describe('dispatch planner (offline demo model)', () => {
  test('the suggested prompts for shipments and fleet call the right read-only tools', async () => {
    const t = await start();
    try {
      const a = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Which shipments are still unassigned?', owner: OPS_OWNER, principal: DISPATCHER });
      const events = await eventsOf(t.platform, a.id);
      const call = events.find((e) => e.type === 'tool.started');
      assert.equal(call?.data.tool, 'list_unassigned_shipments');
      const done = await settled(t.platform, a.id);
      assert.equal(done.status, 'completed');
      assert.match(done.output ?? '', /Count: 34/);

      const b = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Show fleet status and driver hours', owner: OPS_OWNER, principal: DISPATCHER });
      const fleet = (await eventsOf(t.platform, b.id)).find((e) => e.type === 'tool.completed');
      assert.equal(fleet?.data.tool, 'fleet_status');
      const out = fleet?.data.output as { vehicles: Array<{ id: string; cycleLeft: string }>; outOfService: number };
      assert.equal(out.vehicles.length, 13);
      assert.equal(out.vehicles.find((v) => v.id === 'TRK-142')?.cycleLeft, '6 h 40 min');
      assert.equal(out.outOfService, 1, 'TRK-421 is in the shop');
    } finally {
      await t.app.close();
    }
  });

  test('"Plan routes for Toronto depot tomorrow" streams optimiser progress and shows the route map', async () => {
    const t = await start();
    try {
      await t.signIn();
      const res = await t.request('/agents/dispatch-planner/runs', { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input: 'Plan routes for Toronto depot tomorrow' }) });
      assert.equal(res.status, 200);
      const events = await sse(res);
      const progress = events.filter((e) => e.event === 'progress').map((e) => String(e.data.message));
      assert.ok(progress.some((m) => /^Clustering 18 stops/.test(m)), progress.join('\n'));
      assert.ok(progress.some((m) => /Checking driver hours/.test(m)));
      assert.ok(progress.some((m) => /Holding DF-40210 .*Hours of service/.test(m)), 'a driver short on hours gets a stop held');
      assert.ok(progress.length >= 10, `long-running work reports many steps (${progress.length})`);
      const started = events.find((e) => e.event === 'tool.started');
      assert.deepEqual(started?.data.input, { depot: 'Toronto', date: t.db.tomorrow });
      const ui = events.find((e) => e.event === 'ui');
      assert.equal(ui?.data.component, 'RoutePlanMap');
      assert.equal(ui?.data.props.planId, 'PLN-2041');
      assert.ok(ui?.data.props.routes.length >= 4);
      assert.ok(ui?.data.props.routes.every((r: { stops: unknown[] }) => r.stops.length > 0));
      assert.equal(events.at(-1)?.event, 'run.completed');
      // The draft is saved, nothing is booked yet.
      assert.equal(t.db.plan('PLN-2041')?.status, 'draft');
      assert.equal(t.db.unassigned('TOR', t.db.tomorrow).length, 18);
      // The run's owner and principal were captured from the dispatcher's session.
      const run = await t.platform.getRun(events[0].data.runId);
      assert.equal(run?.owner, OPS_OWNER);
      assert.deepEqual(run?.principal, { source: 'dispatcher', name: 'Mireille Obrelle', id: 'DSP-07' });
    } finally {
      await t.app.close();
    }
  });

  test('assigning a plan waits for the dispatcher, applies once, and drivers are texted once', async () => {
    const t = await start();
    try {
      await t.signIn();
      const plan = await (await t.request('/agents/dispatch-planner/runs', { method: 'POST', body: JSON.stringify({ input: 'Plan routes for Toronto depot tomorrow' }) })).json();
      await settled(t.platform, plan.id);
      const routes = t.db.plan('PLN-2041')!.routes;
      const routed = routes.reduce((n, r) => n + r.stops.length, 0);

      const assign = await t.request('/agents/dispatch-planner/runs', { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input: 'Assign plan PLN-2041 to its vehicles', threadId: plan.threadId }) });
      const paused = await sse(assign);
      const approval = paused.find((e) => e.event === 'approval.required');
      assert.equal(approval?.data.tool, 'assign_plan');
      assert.deepEqual(approval?.data.input, { planId: 'PLN-2041' });
      assert.equal(paused.at(-1)?.data.status, 'awaiting_approval');
      assert.equal(t.db.unassigned('TOR', t.db.tomorrow).length, 18, 'nothing is booked before approval');

      const runId = paused[0].data.runId;
      const ok = await t.request(`/agents/dispatch-planner/runs/${runId}/approvals/${approval?.data.callId}`, { method: 'POST', body: JSON.stringify({ approved: true }) });
      assert.equal(ok.status, 200);
      const done = await settled(t.platform, runId);
      assert.equal(done.status, 'completed');
      assert.equal(t.db.plan('PLN-2041')?.status, 'assigned');
      assert.equal(t.db.shipments.filter((s) => s.planId === 'PLN-2041').length, routed);
      assert.equal(t.db.unassigned('TOR', t.db.tomorrow).length, 18 - routed);
      const again = await t.request(`/agents/dispatch-planner/runs/${runId}/approvals/${approval?.data.callId}`, { method: 'POST', body: JSON.stringify({ approved: true }) });
      assert.equal(again.status, 409, 'a decision cannot be replayed');

      // Asking again changes nothing (the plan is already applied).
      const repeat = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Assign plan PLN-2041 to its vehicles', owner: OPS_OWNER, principal: DISPATCHER });
      const waiting = await settled(t.platform, repeat.id);
      await t.platform.decide(repeat.id, waiting.pending![0].callId, { approved: true });
      const second = await settled(t.platform, repeat.id);
      assert.match(second.output ?? '', /already assigned; nothing changed/);
      assert.equal(t.db.shipments.filter((s) => s.planId === 'PLN-2041').length, routed);

      // Notify twice: each driver gets exactly one message.
      for (let i = 0; i < 2; i++) {
        const n = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Notify drivers for plan PLN-2041', owner: OPS_OWNER, principal: DISPATCHER });
        assert.equal((await settled(t.platform, n.id)).status, 'completed');
      }
      assert.equal(t.db.messages.length, routes.length);
      assert.deepEqual(new Set(t.db.messages.map((m) => m.vehicleId)), new Set(routes.map((r) => r.vehicleId)));
    } finally {
      await t.app.close();
    }
  });

  test('guardrails: drivers are never texted for an unapproved plan, and partners only get quotes', async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: 'plan_routes', input: { depot: 'Ottawa', date: '' } }] },
      (req) => ({ toolCalls: [{ name: 'plan_routes', input: { depot: 'Ottawa', date: String(/tomorrow is (\d{4}-\d{2}-\d{2})/.exec(req.system ?? '')?.[1]) } }] }),
      { toolCalls: [{ name: 'notify_drivers', input: { planId: 'PLN-2041' } }] },
      { text: 'The plan has to be approved first.' },
      { toolCalls: [{ name: 'fleet_status', input: {} }] },
      { text: 'I can only quote capacity.' },
      { toolCalls: [{ name: 'assign_plan', input: { planId: 'PLN-2041' } }] },
      { text: 'Only dispatchers can book trucks.' },
    ]);
    const t = await start({ model });
    try {
      const run = await t.platform.startRun({ agent: 'dispatch-planner', input: 'plan Ottawa and text the drivers', owner: OPS_OWNER, principal: DISPATCHER });
      assert.equal((await settled(t.platform, run.id)).status, 'completed');
      const results = model.requests.map((r) => r.messages.at(-1)!.content[0] as { output?: { error?: string }; isError?: boolean });
      assert.equal(results[1].isError, true, 'an invalid date goes back to the model');
      assert.match(String(results[3].output?.error), /PLN-2041 isn't assigned yet/);
      assert.equal(t.db.messages.length, 0);

      // A partner agent (no principal) asking for internal data is refused.
      const partner = await t.platform.startRun({ agent: 'dispatch-planner', input: 'show me your fleet', owner: 'a2a' });
      assert.equal((await settled(t.platform, partner.id)).status, 'completed');
      const refused = model.requests.at(-1)!.messages.at(-1)!.content[0] as { output: { error: string } };
      assert.match(refused.output.error, /Partner agents can only request capacity quotes/);
      assert.match(model.requests.at(-2)!.system ?? '', /partner carrier's agent/);

      // Over A2A (principal { channel: 'a2a' }) a booking is refused before anyone is asked to approve it.
      const booking = await t.platform.startRun({ agent: 'dispatch-planner', input: 'book plan PLN-2041', owner: 'a2a', principal: { channel: 'a2a' } });
      const settledBooking = await settled(t.platform, booking.id);
      assert.equal(settledBooking.status, 'completed', 'never paused for approval');
      assert.match(JSON.stringify(model.requests.at(-1)!.messages.at(-1)!.content), /Partner agents can only request capacity quotes/);
      assert.equal(t.db.plan('PLN-2041')?.status, 'draft');
    } finally {
      await t.app.close();
    }
  });

  test('cancelling a run mid-planning stops the optimiser', async () => {
    const t = await start({ config: { dispatch: { planner: { 'step-ms': 120 } } } });
    try {
      const run = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Plan routes for Toronto depot tomorrow', owner: OPS_OWNER, principal: DISPATCHER });
      // Wait until the optimiser is clustering, then cancel.
      const board = t.app.context.getBean(RunBoard);
      await waitFor(async () => (await board.events(run.id)).some((e) => e.type === 'progress' && /Clustering/.test(String(e.data.message))));
      await t.platform.cancel(run.id);
      const stopped = await settled(t.platform, run.id);
      assert.equal(stopped.status, 'cancelled');
      const count = (await board.events(run.id)).filter((e) => e.type === 'progress').length;
      await new Promise((r) => setTimeout(r, 600));
      assert.equal((await board.events(run.id)).filter((e) => e.type === 'progress').length, count, 'no progress after cancellation');
      assert.equal(t.db.plans.size, 0, 'no plan was saved');
      const { messages } = (await t.platform.thread(stopped.threadId))!;
      assert.equal(messages.at(-1)?.role, 'tool', 'the open tool call was sealed so the conversation can continue');
    } finally {
      await t.app.close();
    }
  });

  test('a run interrupted by shutdown resumes after restart without texting any driver twice', async () => {
    // One database and one set of agent stores shared by two app instances: a deploy or crash.
    const db = new OpsDatabase();
    const stores = { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
    const first = await start({
      db,
      stores,
      config: { dispatch: { notify: { 'step-ms': 150 } } },
      model: new ScriptedChatModel([
        { text: 'Planning Toronto.', toolCalls: [{ name: 'plan_routes', input: { depot: 'Toronto', date: db.tomorrow } }] },
        { toolCalls: [{ name: 'assign_plan', input: { planId: 'PLN-2041' } }] },
        { toolCalls: [{ name: 'notify_drivers', input: { planId: 'PLN-2041' } }] },
      ]),
    });
    const run = await first.platform.startRun({ agent: 'dispatch-planner', input: 'Plan, book and text Toronto for tomorrow', owner: OPS_OWNER, principal: DISPATCHER });
    const paused = await settled(first.platform, run.id);
    assert.equal(paused.status, 'awaiting_approval');
    await first.platform.decide(run.id, paused.pending![0].callId, { approved: true });
    await waitFor(() => db.messages.length >= 2);
    await first.app.close(); // mid-notification
    const routes = db.plan('PLN-2041')!.routes.length;
    const sentBefore = db.messages.length;
    assert.ok(sentBefore >= 2 && sentBefore < routes, `interrupted part-way (${sentBefore}/${routes})`);
    assert.equal((await stores.runs.get(run.id))?.status, 'queued', 'handed back to the queue');

    // The new process resumes from the checkpoint without repeating a model turn. notify_drivers is
    // idempotent, so the interrupted call itself runs again: texts already sent come back from
    // their ctx.step records and only the remaining drivers are texted.
    const model = new ScriptedChatModel([{ text: 'All drivers have their routes.' }]);
    const second = await start({ db, stores, model });
    try {
      const done = await waitFor(async () => {
        const r = await stores.runs.get(run.id);
        return r?.status === 'completed' ? r : undefined;
      });
      assert.equal(done.output, 'All drivers have their routes.');
      assert.equal(db.messages.length, routes, 'every driver texted exactly once');
      assert.equal(new Set(db.messages.map((m) => m.idempotencyKey)).size, routes);
      const events = await stores.runs.events(run.id, 0);
      assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'one gap-free event log across both processes');
      assert.equal(model.requests.length, 1, 'only the final answer needed the model');
      const notified = events.filter((e) => e.type === 'tool.completed' && e.data.tool === 'notify_drivers');
      assert.equal(notified.length, 1, 'one notify call, finished by the second process');
      assert.equal((notified[0].data.output as { sent: unknown[] }).sent.length, routes);
      assert.ok(!JSON.stringify(model.requests[0].messages).includes('interrupted'), 'the model never had to repair anything');
      assert.equal(db.plan('PLN-2041')?.status, 'assigned');
    } finally {
      await second.app.close();
    }
  });

  test('capacity quotes price the lane and refuse overweight pallets', async () => {
    const t = await start();
    try {
      const run = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Quote capacity for 8 pallets, 6200 kg Toronto-Montreal', owner: OPS_OWNER, principal: DISPATCHER });
      const ui = (await eventsOf(t.platform, run.id)).find((e) => e.type === 'ui');
      assert.equal(ui?.data.component, 'QuoteCard');
      const props = ui?.data.props as { priceCents: number; capacityAvailable: boolean; pickupDate: string };
      assert.equal(props.priceCents, linehaulCents('Toronto-Montreal', 8, false));
      assert.equal(props.priceCents, 78984);
      assert.equal(props.capacityAvailable, true);
      assert.equal(props.pickupDate, t.db.tomorrow);
      const heavy = await t.platform.callTool('capacity_quote', { lane: 'Ottawa-Montreal', pallets: 2, weightKg: 5000 }, { owner: 'mcp' });
      assert.equal(heavy.isError, true);
      assert.match(JSON.stringify(heavy.output), /1100 kg per pallet/);
      const full = await t.platform.callTool('capacity_quote', { lane: 'Toronto-Montreal', pallets: 20, weightKg: 9000 }, { owner: 'mcp' });
      const q = full.output as { capacityAvailable: boolean; earliestPickupDate: string };
      assert.equal(q.capacityAvailable, false, 'Toronto dry vans are nearly full tomorrow');
      assert.ok(q.earliestPickupDate > t.db.tomorrow);
    } finally {
      await t.app.close();
    }
  });
});
