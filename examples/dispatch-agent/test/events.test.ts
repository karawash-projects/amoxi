import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ScriptedChatModel } from 'amoxi/ai';
import { OPS_OWNER } from '../src/agents/identity';
import type { RunCard } from '../src/runs/run-board';
import { eventsOf, SECRET, settled, start, waitFor } from './helpers';

const EVENT = {
  vehicleId: 'TRK-214',
  type: 'breakdown',
  location: 'Hwy 401 EB near Port Hope (km 464)',
  note: 'Coolant leak, tow requested',
  occurredAt: '2026-10-18T14:05:00Z',
};

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/telematics/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('event-driven exception handling', () => {
  test('a telematics event starts an exception-handler run that assesses the incident with nobody typing', async () => {
    const t = await start();
    try {
      const res = await post(t.base, EVENT, { 'x-telematics-secret': SECRET });
      assert.equal(res.status, 202);
      const body = (await res.json()) as { runId: string; eventId: string };
      assert.equal(res.headers.get('location'), `/runs/${body.runId}`);
      const run = await t.platform.getRun(body.runId);
      assert.equal(run?.agent, 'exception-handler');
      assert.equal(run?.owner, OPS_OWNER, 'owned by the ops team, so dispatchers can open it');
      assert.deepEqual(run?.principal, { source: 'telematics', name: 'Telematics TRK-214', vehicleId: 'TRK-214', eventId: body.eventId, incidentType: 'breakdown' });
      assert.equal(t.db.vehicle('TRK-214')?.status, 'breakdown', 'the system of record is updated at once');

      const events = await eventsOf(t.platform, body.runId);
      const call = events.find((e) => e.type === 'tool.started');
      assert.equal(call?.data.tool, 'assess_vehicle_incident');
      assert.deepEqual(call?.data.input, { vehicleId: 'TRK-214', type: 'breakdown' });
      const ui = events.find((e) => e.type === 'ui');
      assert.equal(ui?.data.component, 'IncidentBrief');
      const props = ui?.data.props as { affected: unknown[]; recommendation: { vehicleId: string } | null };
      assert.equal(props.affected.length, 5);
      assert.ok(props.recommendation, 'a recovery truck is recommended');
      const done = await settled(t.platform, body.runId);
      assert.equal(done.status, 'completed', 'read-only analysis needs no approval');
      // onRunFinished posts the ops alert for the run.
      const alert = t.db.alerts.find((a) => a.runId === body.runId);
      assert.equal(alert?.severity, 'critical');
      assert.equal(alert?.vehicleId, 'TRK-214');

      // The dispatcher sees it in the console and can open it; strangers can't.
      await t.signIn();
      const board = (await (await t.request('/api/runs')).json()) as { runs: RunCard[] };
      const card = board.runs.find((r) => r.id === body.runId);
      assert.equal(card?.startedBy, 'telematics');
      assert.equal(card?.title, `TRK-214 breakdown reported by telematics (${body.eventId})`);
      assert.equal((await t.request(`/agents/exception-handler/runs/${body.runId}`)).status, 200);
      assert.equal((await t.request(`/runs/${body.runId}`, { headers: { accept: 'text/html' } })).status, 200);
      assert.equal((await fetch(`${t.base}/agents/exception-handler/runs/${body.runId}`)).status, 404);
      assert.equal((await fetch(`${t.base}/api/runs`)).status, 401);
    } finally {
      await t.app.close();
    }
  });

  test('the webhook rejects a missing or wrong secret (401) and invalid payloads (400)', async () => {
    const t = await start();
    try {
      assert.equal((await post(t.base, EVENT)).status, 401);
      assert.equal((await post(t.base, EVENT, { 'x-telematics-secret': 'guess' })).status, 401);
      const bad = await post(t.base, { vehicleId: 'truck 9', type: 'flat_tyre', location: '', occurredAt: 'yesterday', isAdmin: true }, { 'x-telematics-secret': SECRET });
      assert.equal(bad.status, 400);
      const details = ((await bad.json()) as { details: Array<{ path: string }> }).details.map((d) => d.path).sort();
      assert.deepEqual(details, ['location', 'occurredAt', 'type', 'vehicleId']);
      const unknown = await post(t.base, { ...EVENT, vehicleId: 'TRK-999' }, { 'x-telematics-secret': SECRET });
      assert.equal(unknown.status, 404);
      assert.equal(t.db.incidents.length, 0, 'nothing was recorded');
    } finally {
      await t.app.close();
    }
  });

  test('moving freight to a recovery truck waits for the dispatcher, then applies once', async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: 'assess_vehicle_incident', input: { vehicleId: 'TRK-214', type: 'breakdown' } }] },
      { toolCalls: [{ name: 'post_ops_alert', input: { severity: 'critical', vehicleId: 'TRK-214', title: 'TRK-214 down near Port Hope', body: '5 shipments at risk; TRK-305 proposed.' } }] },
      { toolCalls: [{ name: 'reassign_shipments', input: { fromVehicleId: 'TRK-214', toVehicleId: 'TRK-305' } }] },
      { text: 'TRK-305 is collecting the freight from TRK-214.' },
    ]);
    const t = await start({ model });
    try {
      const res = await post(t.base, EVENT, { 'x-telematics-secret': SECRET });
      const { runId } = (await res.json()) as { runId: string };
      const paused = await settled(t.platform, runId);
      assert.equal(paused.status, 'awaiting_approval');
      assert.equal(paused.pending?.[0].tool, 'reassign_shipments');
      assert.equal(t.db.loadOf('TRK-214').length, 5, 'nothing moved yet');
      assert.equal(t.db.alerts.filter((a) => a.runId === runId).length, 1, 'the alert went up straight away');
      assert.match(model.requests[0].system ?? '', /started by telematics event EV-\d+ for TRK-214/);

      // The dispatcher approves from the console's run page.
      await t.signIn();
      const ok = await t.request(`/api/runs/${runId}/approvals/${paused.pending![0].callId}`, { method: 'POST', body: JSON.stringify({ approved: true }) });
      assert.equal(ok.status, 200);
      const done = await settled(t.platform, runId);
      assert.equal(done.status, 'completed');
      assert.equal(t.db.loadOf('TRK-214').length, 0);
      assert.equal(t.db.loadOf('TRK-305').length, 5);
      assert.equal(t.db.vehicle('TRK-305')?.status, 'on_route');
      assert.equal(t.db.messages.filter((m) => m.vehicleId === 'TRK-305').length, 1, 'the recovery driver is texted');
      assert.equal(t.db.alerts.filter((a) => a.runId === runId).length, 1, 'one alert per run');
      assert.equal((await t.request(`/api/runs/${runId}/approvals/${paused.pending![0].callId}`, { method: 'POST', body: JSON.stringify({ approved: true }) })).status, 409);
    } finally {
      await t.app.close();
    }
  });

  test('the morning planning schedule is off by default and starts one planning run per depot when on', async () => {
    const off = await start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(await off.platform.threads(OPS_OWNER), []);
      // "Run now" from the console starts the same runs on demand.
      await off.signIn();
      const now = await off.request('/api/schedule/morning-planning', { method: 'POST' });
      assert.equal(((await now.json()) as { started: unknown[] }).started.length, 3);
    } finally {
      await off.app.close();
    }
    const on = await start({ config: { dispatch: { schedule: { enabled: true, 'interval-ms': 1000, depots: 'Toronto,Ottawa' } } } });
    try {
      const threads = await waitFor(async () => {
        const list = await on.platform.threads(OPS_OWNER, 'dispatch-planner');
        return list.length >= 2 ? list : undefined;
      }, 5000);
      const { messages } = (await on.platform.thread(threads[0].id))!;
      assert.match(JSON.stringify(messages[0].content), /Plan routes for (Toronto|Ottawa) depot tomorrow/);
      const runs = await on.app.context.getBean<{ runsOfThread(id: string): Promise<Array<{ principal?: unknown }>> }>('RunBoard').runsOfThread(threads[0].id);
      assert.deepEqual(runs[0].principal, { source: 'schedule', name: 'Morning planning' });
    } finally {
      await on.app.close();
    }
  });
});
