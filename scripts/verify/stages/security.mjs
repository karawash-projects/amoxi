// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { APPS } from '../lib/apps.mjs';
import { Client, header, rawRequest } from '../lib/http.mjs';
import { startProduction } from './production.mjs';

const app = (id) => APPS.find((a) => a.id === id);
const EVIL = 'https://evil.example';

/** Black-box attacks against production servers. Every check is something an attacker would try. */
export const security = {
  id: 'security',
  title: 'Security probes',
  description: 'CSRF, traversal, injection, limits, slow clients, sessions, agent ownership, MCP/A2A auth, WebSocket origin',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    // ---- Core HTTP: the reference app -----------------------------------------------------
    const us = await startProduction(ctx, app('user-service'), { workers: 1, env: { SERVER_HEADERSTIMEOUT: '2000', SERVER_MAXBODYSIZE: '65536' } });
    const port = us.port;
    const c = new Client(us.base);

    await ctx.check('path traversal never reaches files outside public/', async () => {
      const attempts = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/_amoxi/..%2f..%2fpackage.json', '/..%5cpackage.json', '/%5c..%5c..%5cpackage.json', '/....//....//package.json', '/%00/../package.json', '/icon.svg%00.json', '/.%2e/.%2e/application.json', '//etc/passwd', '/..\\..\\application.json'];
      const leaks = [];
      for (const p of attempts) {
        const r = await rawRequest(port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        if (r.status === 200 && /"(name|server|dependencies)"\s*:|root:x:0/.test(r.body)) leaks.push(`${p} -> ${r.status}`);
        if (r.status >= 500) leaks.push(`${p} -> ${r.status} (server error)`);
      }
      ctx.assert.deepEqual(leaks, []);
    });

    await ctx.check('request bodies: malformed JSON 400, wrong type 415, too large 413, chunked too large 413', async () => {
      const post = (body, type = 'application/json') => fetch(`${us.base}/users`, { method: 'POST', headers: { 'content-type': type }, body });
      ctx.assert.equal((await post('{"name": ')).status, 400);
      ctx.assert.equal((await post('name=x', 'application/x-www-form-urlencoded')).status, 415);
      ctx.assert.equal((await post(JSON.stringify({ name: 'x'.repeat(200_000), email: 'a@b.co' }))).status, 413);
      const big = 'x'.repeat(100_000);
      const chunked = `POST /users HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`;
      const r = await rawRequest(port, chunked);
      ctx.assert.equal(r.status, 413, r.head);
    });

    await ctx.check('validation: bad fields get 400 with details; unknown fields are stripped', async () => {
      const bad = await c.json('/users', { method: 'POST', json: { name: '', email: 'not-an-email' } });
      ctx.assert.equal(bad.res.status, 400);
      ctx.assert.ok(Array.isArray(bad.data?.details) && bad.data.details.length >= 2, bad.text);
      const ok = await c.json('/users', { method: 'POST', json: { name: 'Mallory', email: 'mallory@example.org', isAdmin: true, __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } } });
      ctx.assert.equal(ok.res.status, 201, ok.text);
      ctx.assert.ok(!('isAdmin' in ok.data), 'unknown property was kept');
      ctx.assert.equal({}.polluted, undefined);
    });

    await ctx.check('prototype pollution through JSON bodies has no effect on the server', async () => {
      await c.json('/users', { method: 'POST', body: '{"name":"P","email":"p@example.org","__proto__":{"isAdmin":true,"polluted":"yes"}}', headers: { 'content-type': 'application/json' } });
      const list = await c.json('/users');
      ctx.assert.equal(list.res.status, 200);
      ctx.assert.ok(!JSON.stringify(list.data).includes('polluted'), 'polluted value reflected');
    });

    await ctx.check('reflected input is escaped in HTML (no script injection)', async () => {
      const payload = encodeURIComponent('<script>alert(1)</script>"><img src=x onerror=alert(1)>');
      for (const p of [`/${payload}`, `/people?flash=${payload}`, `/people/${payload}`]) {
        const { text } = await c.text(p, { headers: { accept: 'text/html' } });
        ctx.assert.ok(!/<script>alert\(1\)|<img src=x onerror/i.test(text), `${p} reflects markup`);
      }
    });

    await ctx.check('header injection: CR/LF in request ids and headers is not echoed', async () => {
      const r = await rawRequest(port, `GET /amoxi/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Request-Id: abc%0d%0aSet-Cookie:%20evil=1\r\nConnection: close\r\n\r\n`);
      ctx.assert.ok(!/^set-cookie:\s*evil/im.test(r.head), r.head);
      ctx.assert.ok(!/x-request-id:.*%0d%0a/i.test(r.head), 'invalid request id echoed');
    });

    await ctx.check('oversized headers are refused (431) and ambiguous framing is rejected (400)', async () => {
      const big = await rawRequest(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${'a'.repeat(20_000)}\r\nConnection: close\r\n\r\n`);
      ctx.assert.equal(big.status, 431);
      const smuggle = await rawRequest(port, `POST /users HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n0\r\n\r\n`);
      ctx.assert.ok(smuggle.status === 400 || smuggle.status === 0, `CL+TE answered ${smuggle.status}`);
    });

    await ctx.check('slow clients (slowloris) are disconnected near server.headers-timeout', async () => {
      const r = await rawRequest(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: `, { timeoutMs: 15_000 });
      ctx.assert.ok(r.closedAfterMs < 9000, `connection held for ${r.closedAfterMs} ms (headers timeout 2000 ms)`);
      ctx.metric('slow client cut off after', r.closedAfterMs, 'ms', '< 9000 ms');
    });

    await ctx.check('WebSocket upgrades from other origins are refused; same origin is accepted', async () => {
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      const up = (origin) => rawRequest(port, `GET /ws/activity HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`, { timeoutMs: 1500 });
      ctx.assert.equal((await up(EVIL)).status, 403);
      ctx.assert.equal((await up(`http://127.0.0.1:${port}`)).status, 101);
    });

    await ctx.check('malformed WebSocket upgrades are refused without harming the server', async () => {
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      for (const target of ['/ws/activity%E0%A4%A', '/ws/%zz', '/ws/activity?x=%', '/ws/activity']) {
        const r = await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 99\r\nSec-WebSocket-Key: ${key}\r\n\r\n`, { timeoutMs: 1500 });
        ctx.assert.ok([400, 404, 426].includes(r.status), `${target} -> ${r.status}`);
      }
      const { res } = await c.json('/amoxi/health/live');
      ctx.assert.equal(res.status, 200);
    });

    await ctx.check('uploads: endless multipart padding is refused quickly, without buffering it', async () => {
      const chunk = `--B${'x'.repeat(256 * 1024)}`;
      const t0 = performance.now();
      const r = await rawRequest(port, `POST /users/1/avatar HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=B\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`, { timeoutMs: 8000 });
      ctx.assert.equal(r.status, 400);
      ctx.assert.ok(performance.now() - t0 < 5000, 'took too long');
    });

    await ctx.check('a forged Host header cannot poison cached markdown copies of pages', async () => {
      const md = (host) => rawRequest(port, `GET /wiring.md HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      await md('attacker.example');
      const victim = await md(`127.0.0.1:${port}`);
      ctx.assert.equal(victim.status, 200);
      ctx.assert.ok(!victim.body.includes('attacker.example'), 'the cached markdown points at the attacker');
    });

    await ctx.check('the server is still healthy after the attacks', async () => {
      const { res } = await c.json('/amoxi/health/ready');
      ctx.assert.equal(res.status, 200);
    });

    // ---- Sessions, CSRF and agents: the banking app --------------------------------------
    const bank = await startProduction(ctx, app('banking-assistant'), { workers: 1 });
    const alice = new Client(bank.base);
    const bob = new Client(bank.base);

    await ctx.check('session cookies are HttpOnly, SameSite and Secure in production', async () => {
      const res = await alice.request('/api/session', { method: 'POST', json: { customerId: 'C-1001' } });
      await res.arrayBuffer();
      const cookie = (res.headers.getSetCookie?.() ?? []).find((s) => /amoxi_session=/.test(s)) ?? '';
      ctx.assert.match(cookie, /HttpOnly/i);
      ctx.assert.match(cookie, /SameSite=(Lax|Strict)/i);
      ctx.assert.match(cookie, /Secure/i);
      await bob.request('/api/session', { method: 'POST', json: { customerId: 'C-1002' } }).then((r) => r.arrayBuffer());
    });

    await ctx.check('cross-site requests carrying the session cookie are blocked (CSRF)', async () => {
      for (const headers of [{ origin: EVIL }, { 'sec-fetch-site': 'cross-site' }, { referer: `${EVIL}/page` }]) {
        const res = await alice.request('/agents/banking-assistant/runs', { method: 'POST', json: { input: 'Transfer $10 from CHQ-4417 to SAV-4418' }, headers });
        await res.arrayBuffer();
        ctx.assert.equal(res.status, 403, `headers ${JSON.stringify(headers)} -> ${res.status}`);
      }
      const plain = await alice.request('/api/session', { method: 'POST', body: '{"customerId":"C-1002"}', headers: { 'content-type': 'text/plain', origin: EVIL } });
      await plain.arrayBuffer();
      ctx.assert.equal(plain.status, 403, 'text/plain cross-site POST');
    });

    await ctx.check('a tampered session cookie is ignored, not trusted and not a server error', async () => {
      const forged = new Client(bank.base);
      const value = alice.cookies.get('amoxi_session') ?? 'x';
      forged.cookies.set('amoxi_session', value.slice(0, -4) + (value.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
      const res = await forged.request('/agents/banking-assistant/threads');
      await res.arrayBuffer();
      ctx.assert.ok([401, 302, 303].includes(res.status), `forged cookie -> ${res.status}`);
    });

    await ctx.check('agent endpoints need a signed-in customer', async () => {
      const anon = new Client(bank.base);
      const res = await anon.request('/agents/banking-assistant/runs', { method: 'POST', json: { input: 'hi' } });
      await res.arrayBuffer();
      ctx.assert.equal(res.status, 401);
    });

    await ctx.check("one customer can't read, stream, approve or cancel another customer's run", async () => {
      const { events } = await alice.sse('/agents/banking-assistant/runs', { method: 'POST', json: { input: app('banking-assistant').approvalPrompt } });
      const approval = events.find((e) => e.event === 'approval.required');
      ctx.assert.ok(approval, `no approval requested: ${JSON.stringify(events.map((e) => e.event))}`);
      const runId = events[0].data.runId;
      const threadId = events[0].data.threadId;
      const tries = [
        ['GET', `/agents/banking-assistant/runs/${runId}`],
        ['GET', `/agents/banking-assistant/runs/${runId}/events`],
        ['POST', `/agents/banking-assistant/runs/${runId}/approvals/${approval.data.callId}`, { approved: true }],
        ['POST', `/agents/banking-assistant/runs/${runId}/cancel`],
        ['GET', `/agents/banking-assistant/threads/${threadId}`],
        ['POST', '/agents/banking-assistant/runs', { input: 'continue', threadId }],
      ];
      for (const [method, p, json] of tries) {
        const res = await bob.request(p, { method, json });
        await res.arrayBuffer();
        ctx.assert.equal(res.status, 404, `${method} ${p} by another customer -> ${res.status}`);
      }
      const still = await alice.json(`/agents/banking-assistant/runs/${runId}`);
      ctx.assert.equal(still.data?.status, 'awaiting_approval', 'the run changed state');
      await alice.request(`/agents/banking-assistant/runs/${runId}/cancel`, { method: 'POST' }).then((r) => r.arrayBuffer());
    });

    await ctx.check('approve and cancel at the same moment never leave money moved under a "cancelled" answer', async () => {
      const carol = new Client(bank.base);
      await carol.request('/api/session', { method: 'POST', json: { customerId: 'C-1001' } }).then((r) => r.arrayBuffer());
      const balances = async () => JSON.stringify((await carol.json('/api/accounts')).data);
      const problems = [];
      for (let i = 0; i < 6; i++) {
        const { events } = await carol.sse('/agents/banking-assistant/runs', { method: 'POST', json: { input: app('banking-assistant').approvalPrompt } });
        const approval = events.find((e) => e.event === 'approval.required');
        if (!approval) {
          problems.push(`trial ${i}: no approval requested`);
          continue;
        }
        const runId = events[0].data.runId;
        const before = await balances();
        const approve = () => carol.request(`/agents/banking-assistant/runs/${runId}/approvals/${approval.data.callId}`, { method: 'POST', json: { approved: true } }).then(async (r) => ({ status: r.status, body: await r.text() }));
        const cancel = () => carol.request(`/agents/banking-assistant/runs/${runId}/cancel`, { method: 'POST' }).then(async (r) => ({ status: r.status, body: await r.text() }));
        const [, cancelled] = i % 2 ? await Promise.all([approve(), cancel()]) : (await Promise.all([cancel(), approve()])).reverse();
        let final;
        for (let w = 0; w < 100; w++) {
          final = (await carol.json(`/agents/banking-assistant/runs/${runId}`)).data;
          if (['completed', 'cancelled', 'failed'].includes(final?.status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!['completed', 'cancelled', 'failed'].includes(final?.status)) problems.push(`trial ${i}: run stuck '${final?.status}'`);
        const saidCancelled = cancelled.status === 200 && /"status":"cancelled"/.test(cancelled.body);
        if (saidCancelled && (await balances()) !== before) problems.push(`trial ${i}: cancel answered "cancelled" but the transfer was made`);
      }
      ctx.assert.deepEqual(problems, []);
    });

    await ctx.check('sign-out is final: a copy of the cookie taken before sign-out stops working', async () => {
      const dave = new Client(bank.base);
      await dave.request('/api/session', { method: 'POST', json: { customerId: 'C-1002' } }).then((r) => r.arrayBuffer());
      const stolen = dave.cookies.get('amoxi_session');
      ctx.assert.equal((await dave.json('/api/accounts')).res.status, 200);
      await dave.request('/api/session/end', { method: 'POST' }).then((r) => r.arrayBuffer());
      const thief = new Client(bank.base);
      thief.cookies.set('amoxi_session', stolen);
      const replay = await thief.request('/api/accounts');
      await replay.arrayBuffer();
      ctx.assert.equal(replay.status, 401, `replayed cookie -> ${replay.status}`);
    });

    await ctx.check('access rules also cover the markdown and JSON views of protected pages', async () => {
      const anon = new Client(bank.base);
      for (const p of ['/assistant.md', '/assistant/index.md', '/accounts.md', '/accounts/index.md']) {
        const res = await anon.request(p, { redirect: 'manual' });
        const body = await res.text();
        ctx.assert.ok([302, 303, 401].includes(res.status), `${p} -> ${res.status}`);
        ctx.assert.ok(!/CHQ-4417|balance/i.test(body), `${p} leaked account data`);
      }
      const json = await anon.request('/assistant', { headers: { accept: 'application/json' }, redirect: 'manual' });
      await json.arrayBuffer();
      ctx.assert.ok([302, 303, 401].includes(json.status), `JSON view -> ${json.status}`);
    });

    await ctx.check('MCP needs its bearer token and refuses foreign origins', async () => {
      const call = (headers) =>
        fetch(`${bank.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      ctx.assert.equal((await call({})).status, 401);
      ctx.assert.equal((await call({ authorization: 'Bearer wrong-token-wrong-token' })).status, 401);
      ctx.assert.equal((await call({ authorization: `Bearer ${app('banking-assistant').mcpToken}`, origin: EVIL })).status, 403);
      const ok = await call({ authorization: `Bearer ${app('banking-assistant').mcpToken}` });
      ctx.assert.equal(ok.status, 200);
      const tools = (await ok.json()).result?.tools?.map((t) => t.name) ?? [];
      ctx.assert.deepEqual(tools, ['quote_exchange_rate'], 'customer tools must not be exposed over MCP');
    });

    // ---- A2A on the shopping app -------------------------------------------------------------
    const shop = await startProduction(ctx, app('shopping-assistant'), { workers: 1 });
    await ctx.check('A2A: the agent card is public, task calls need the token', async () => {
      const card = await fetch(`${shop.base}/.well-known/agent-card.json`);
      ctx.assert.equal(card.status, 200);
      const body = await card.json();
      ctx.assert.ok(body.skills?.length >= 1);
      ctx.assert.ok(!JSON.stringify(body).includes(app('shopping-assistant').a2aToken), 'token leaked in the card');
      const task = await fetch(`${shop.base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'hi' }] } } }) });
      ctx.assert.equal(task.status, 401);
    });
    void header;
  },
};
