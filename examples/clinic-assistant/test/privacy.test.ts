import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessLog } from '../src/services/access-log';
import { A2A_TOKEN, AGENT, Client, MONDAY_9AM, start } from './helpers';

test('ownership: conversations and appointments belong to one patient; others get 404, anonymous callers 401', async () => {
  const t = await start({ now: MONDAY_9AM });
  try {
    const jordan = new Client(t.base);
    const samira = new Client(t.base);
    await jordan.signIn('P-1001');
    await samira.signIn('P-1002');

    const events = await jordan.ask('Show my upcoming appointments');
    const { runId, threadId } = events[0].data;
    assert.equal((await jordan.request(`/agents/${AGENT}/threads/${threadId}`)).status, 200);
    assert.equal((await samira.request(`/agents/${AGENT}/threads/${threadId}`)).status, 404);
    assert.equal((await samira.request(`/agents/${AGENT}/runs/${runId}`)).status, 404);
    assert.equal((await samira.request(`/agents/${AGENT}/runs`, { method: 'POST', body: JSON.stringify({ input: 'continue', threadId }) })).status, 404);
    assert.deepEqual(((await (await samira.request(`/agents/${AGENT}/threads`)).json()) as { threads: unknown[] }).threads, []);

    // The same for appointments: Samira's AP-5003 is "not found" for Jordan, not "forbidden".
    assert.equal((await samira.request('/api/me/appointments/AP-5003')).status, 200);
    assert.equal((await jordan.request('/api/me/appointments/AP-5003')).status, 404);
    const mine = (await (await jordan.request('/api/me/appointments')).json()) as { appointments: Array<{ id: string }> };
    assert.deepEqual(
      mine.appointments.map((a) => a.id),
      ['AP-5002', 'AP-5001'],
    );

    // No patient, no assistant.
    const anonymous = new Client(t.base);
    assert.equal((await anonymous.request(`/agents/${AGENT}/runs`, { method: 'POST', body: JSON.stringify({ input: 'Show my upcoming appointments' }) })).status, 401);
    assert.equal((await anonymous.request('/api/me/appointments')).status, 401);
    assert.equal((await anonymous.request('/session/demo-patient', { method: 'POST', body: JSON.stringify({ patientId: 'P-9999' }) })).status, 400);
  } finally {
    await t.close();
  }
});

test('sign-out is final: a copy of the cookie taken before sign-out no longer works', async () => {
  const t = await start({ now: MONDAY_9AM });
  try {
    const patient = new Client(t.base);
    await patient.signIn('P-1001');
    assert.equal((await patient.request('/api/me/appointments')).status, 200);
    const stolen = patient.cookie;
    assert.equal((await patient.request('/session/sign-out', { method: 'POST' })).status, 200);
    const thief = new Client(t.base);
    thief.cookie = stolen;
    assert.equal((await thief.request('/api/me/appointments')).status, 401, 'replayed cookie after sign-out');
  } finally {
    await t.close();
  }
});

test('access log: every touch of patient data is logged pseudonymously, and patients see only their own entries', async () => {
  const t = await start({ now: MONDAY_9AM });
  try {
    const jordan = new Client(t.base);
    await jordan.signIn('P-1001');
    await jordan.ask('Show my upcoming appointments');
    await jordan.request('/assistant', { headers: { accept: 'text/html' } });

    const log = t.get<AccessLog>('AccessLog');
    const entries = log.all();
    assert.ok(entries.some((e) => e.actor === 'assistant' && e.action === 'Viewed your upcoming appointments'));
    assert.ok(entries.some((e) => e.actor === 'patient-portal'));
    const raw = JSON.stringify(entries);
    for (const secret of ['Jordan', 'Averlin', 'Samira', 'Elbarenne', '1988-04-12', 'P-1001', 'P-1002']) assert.ok(!raw.includes(secret), `access log contains ${secret}`);
    assert.match(entries[0].subject, /^pt-[0-9a-f]{10}$/);

    const page = await (await jordan.request('/my-data', { headers: { accept: 'text/html' } })).text();
    assert.match(page, /Who accessed my data/);
    assert.match(page, /Demo Clinic assistant \(AI\), for you/);
    assert.ok(page.includes(log.pseudonym('P-1001')));
    const samira = new Client(t.base);
    await samira.signIn('P-1002');
    const other = await (await samira.request('/my-data', { headers: { accept: 'text/html' } })).text();
    assert.doesNotMatch(other, /Viewed your upcoming appointments/, "Samira doesn't see Jordan's entries");
  } finally {
    await t.close();
  }
});

test('privacy headers: assistant pages and agent routes are no-store and no-referrer; public pages are not', async () => {
  const t = await start();
  try {
    const me = new Client(t.base);
    await me.signIn('P-1001');
    for (const path of ['/assistant', '/my-data', `/agents/${AGENT}/threads`, '/api/me/appointments', '/assistant.md']) {
      const res = await me.request(path, { headers: { accept: path.startsWith('/a') && !path.startsWith('/assistant') ? 'application/json' : 'text/html' } });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    }
    const events = await me.request(`/agents/${AGENT}/runs`, { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input: 'hello' }) });
    assert.equal(events.headers.get('referrer-policy'), 'no-referrer');
    await events.text();
    const home = await fetch(`${t.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  } finally {
    await t.close();
  }
});

test('A2A: the agent card lists the skill; a partner referral creates a task, logged on the patient\'s access page', async () => {
  const t = await start();
  try {
    const card = (await (await fetch(`${t.base}/.well-known/agent-card.json`)).json()) as { skills: Array<{ id: string; examples: string[] }>; securitySchemes?: unknown };
    const skill = card.skills.find((s) => s.id === AGENT);
    assert.ok(skill, 'skill listed');
    assert.ok(skill.examples.includes('Referral for patient P-1002 to dermatology'));
    assert.ok(card.securitySchemes, 'bearer token advertised');

    const send = (text: string, token?: string) =>
      fetch(`${t.base}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', messageId: `m-${text.length}`, parts: [{ kind: 'text', text }] }, metadata: { skill: AGENT }, configuration: { blocking: true } },
        }),
      });
    assert.equal((await send('Referral for patient P-1002 to dermatology')).status, 401);

    const res = await send('Referral for patient P-1002 to dermatology', A2A_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { id: string; kind?: string; status: { state: string } } };
    assert.equal(body.result.status.state, 'completed');
    const run = await t.platform.getRun(body.result.id);
    assert.deepEqual(run?.principal, { channel: 'a2a' }, 'A2A runs carry the partner channel as their principal');
    assert.match(String(run?.output), /RF-8001/);
    assert.doesNotMatch(String(run?.output), /Samira|Elbarenne/, 'no patient details go back to the partner');

    const log = t.get<AccessLog>('AccessLog').forPatient('P-1002');
    assert.ok(log.some((e) => e.actor === 'partner-agent' && e.action === 'Sent a referral request' && /Dermatology/.test(e.purpose)));

    // A partner can't use patient tools.
    const probe = await send('Show my upcoming appointments', A2A_TOKEN);
    const probed = (await probe.json()) as { result: { id: string } };
    const probeRun = await t.platform.getRun(probed.result.id);
    assert.match(String(probeRun?.output), /Refused/);
  } finally {
    await t.close();
  }
});

test('pages: public pages render with real content, have markdown and JSON versions, and llms.txt lists the agent', async () => {
  const t = await start();
  try {
    const html = async (path: string) => {
      const res = await fetch(t.base + path, { headers: { accept: 'text/html' } });
      return { status: res.status, text: await res.text() };
    };
    const home = await html('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /never does/);
    assert.match(home.text, /Demo: fictional/);
    assert.match((await html('/clinicians?language=french')).text, /Dr\. Amara Obrelle/);
    assert.match((await html('/clinicians/DR-103')).text, /Dr\. Mei-Lin Tsaoray/);
    assert.equal((await html('/clinicians/DR-999')).status, 404);
    assert.match((await html('/policies')).text, /Cancellation and missed appointments/);
    assert.match((await html('/partners')).text, /message\/send/);
    assert.match((await html('/assistant')).text, /Continue as a demo patient/, 'the assistant asks who you are first');

    const md = await (await fetch(`${t.base}/policies.md`)).text();
    assert.match(md, /# Clinic policies/);
    assert.match(md, /fasting/i);
    const json = (await (await fetch(`${t.base}/clinicians`, { headers: { accept: 'application/json' } })).json()) as { data?: { clinicians: unknown[] } };
    assert.equal(json.data?.clinicians.length, 7);
    const llms = await (await fetch(`${t.base}/llms.txt`)).text();
    assert.match(llms, /Demo Clinic/);
    assert.match(llms, /clinic-assistant/);
  } finally {
    await t.close();
  }
});
