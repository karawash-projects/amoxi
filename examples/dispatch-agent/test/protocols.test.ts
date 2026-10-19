import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OPS_OWNER } from '../src/agents/identity';
import { A2A_TOKEN, DISPATCHER, MCP_TOKEN, settled, start } from './helpers';

const rpc = (base: string, path: string, token: string | undefined, method: string, params: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('partner agents and pages', () => {
  test('MCP offers the capacity quote and shipment tracking, never the tools that need approval', async () => {
    const t = await start();
    try {
      const v = { 'mcp-protocol-version': '2025-11-25' };
      assert.equal((await rpc(t.base, '/mcp', undefined, 'tools/list', {}, v)).status, 401);
      const list = (await (await rpc(t.base, '/mcp', MCP_TOKEN, 'tools/list', {}, v)).json()) as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
      const names = list.result.tools.map((x) => x.name);
      assert.ok(names.includes('capacity_quote') && names.includes('track_shipment'));
      for (const hidden of ['assign_plan', 'reassign_shipments', 'plan_routes', 'notify_drivers', 'fleet_status']) assert.ok(!names.includes(hidden), hidden);
      assert.ok(names.includes('ask_dispatch_planner') && names.includes('ask_exception_handler'));
      assert.equal(list.result.tools.find((x) => x.name === 'capacity_quote')?.annotations?.readOnlyHint, true);

      const call = await rpc(t.base, '/mcp', MCP_TOKEN, 'tools/call', { name: 'capacity_quote', arguments: { lane: 'Ottawa-Montreal', pallets: 4, weightKg: 2400 } }, v);
      const body = (await call.json()) as { result: { isError?: boolean; structuredContent: { priceCents: number; lane: string; currency: string } } };
      assert.ok(!body.result.isError);
      assert.equal(body.result.structuredContent.lane, 'Ottawa-Montreal');
      assert.equal(body.result.structuredContent.currency, 'CAD');
      assert.ok(body.result.structuredContent.priceCents > 0);
      const track = await rpc(t.base, '/mcp', MCP_TOKEN, 'tools/call', { name: 'track_shipment', arguments: { shipmentId: 'DF-40102' } }, v);
      const tracked = ((await track.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      assert.equal(tracked.vehicleId, 'TRK-214');
      assert.ok(!JSON.stringify(tracked).includes('Aisha'), 'no driver names for partners');
    } finally {
      await t.app.close();
    }
  });

  test('the A2A agent card lists both agents as skills and partners get quotes over A2A', async () => {
    const t = await start();
    try {
      const card = (await (await fetch(`${t.base}/.well-known/agent-card.json`)).json()) as { skills: Array<{ id: string; examples: string[] }>; securitySchemes?: unknown };
      assert.deepEqual(card.skills.map((s) => s.id).sort(), ['dispatch-planner', 'exception-handler']);
      assert.ok(card.skills.find((s) => s.id === 'dispatch-planner')?.examples.includes('Plan routes for Toronto depot tomorrow'));
      assert.ok(card.securitySchemes, 'the card advertises bearer auth');
      const params = {
        message: { role: 'user', messageId: 'm-1', kind: 'message', parts: [{ kind: 'text', text: 'Quote capacity for 6 pallets, 3000 kg Toronto-Ottawa' }], metadata: { skill: 'dispatch-planner' } },
        configuration: { blocking: true },
      };
      assert.equal((await rpc(t.base, '/a2a', undefined, 'message/send', params)).status, 401);
      const res = await rpc(t.base, '/a2a', A2A_TOKEN, 'message/send', params);
      assert.equal(res.status, 200);
      const task = (await res.json()) as { result: { id: string; status: { state: string } } };
      assert.equal(task.result.status.state, 'completed');
      const run = await settled(t.platform, task.result.id);
      assert.equal(run.owner, 'a2a:partner');
      assert.match(run.output ?? '', /Price: \$/);
      // The console lists partner runs too.
      await t.signIn();
      const board = (await (await t.request('/api/runs')).json()) as { runs: Array<{ id: string; startedBy: string }> };
      assert.equal(board.runs.find((r) => r.id === run.id)?.startedBy, 'partner');
    } finally {
      await t.app.close();
    }
  });

  test('pages render for people and for AI agents', async () => {
    const t = await start();
    try {
      await t.signIn();
      const run = await t.platform.startRun({ agent: 'dispatch-planner', input: 'Show fleet status and driver hours', owner: OPS_OWNER, principal: DISPATCHER });
      await settled(t.platform, run.id);
      const home = await t.request('/', { headers: { accept: 'text/html' } });
      assert.equal(home.status, 200);
      const html = await home.text();
      for (const island of ['PlannerChat', 'RunsPanel', 'OpsBoard']) assert.match(html, new RegExp(`data-c="${island}"`));
      assert.match(html, /Demo: fictional data/);
      assert.match(html, /DF-40201/);
      const runPage = await t.request(`/runs/${run.id}`, { headers: { accept: 'text/html' } });
      assert.equal(runPage.status, 200);
      assert.match(await runPage.text(), /data-c="RunViewer"/);
      assert.equal((await t.request('/runs/not-a-run', { headers: { accept: 'text/html' } })).status, 404);
      const md = await t.request('/integrations.md');
      assert.equal(md.status, 200);
      assert.match(await md.text(), /Telematics webhook/);
      const json = (await (await t.request('/', { headers: { accept: 'application/json' } })).json()) as { data: { kpis: { tomorrowUnassigned: number }; runs: unknown[] } };
      assert.equal(json.data.kpis.tomorrowUnassigned, 34);
      assert.equal(json.data.runs.length, 1);
      const llms = await (await fetch(`${t.base}/llms.txt`)).text();
      assert.match(llms, /dispatch-planner/);
      assert.match(llms, /exception-handler/);
    } finally {
      await t.app.close();
    }
  });
});
