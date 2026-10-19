import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryService, ScriptedChatModel } from 'amoxi/ai';
import { SAFETY_REPLACEMENT, SafeguardedChatModel, safeguard } from '../src/ai/clinical-safety';
import { screenSymptoms } from '../src/ai/triage';
import { AccessLog } from '../src/services/access-log';
import { PatientRecords } from '../src/services/patient-records';
import { AGENT, Client, MONDAY_9AM, approveAll, parseSse, runAs, settle, start, toolResults } from './helpers';

test('offline model: each suggested prompt calls the intended tool and shows its component', async () => {
  const t = await start();
  try {
    const me = new Client(t.base);
    await me.signIn('P-1001');
    const cases: Array<[string, string, string | undefined]> = [
      ['Find a clinician who speaks French', 'find_clinicians', 'ClinicianCards'],
      ['Show available slots tomorrow', 'available_slots', 'SlotPicker'],
      ['How do I prepare for a blood test?', 'clinic_policy', undefined],
      ['What is the cancellation policy?', 'clinic_policy', undefined],
      ['Show my upcoming appointments', 'upcoming_appointments', undefined],
      ['Show available slots for DR-103 on 2026-10-21', 'available_slots', 'SlotPicker'],
      ['Remember my preference: "I prefer Dr. Obrelle, in French"', 'remember', undefined],
    ];
    for (const [prompt, tool, component] of cases) {
      const events = await me.ask(prompt);
      const started = events.find((e) => e.event === 'tool.started');
      assert.equal(started?.data.tool, tool, prompt);
      assert.equal(events.at(-1)?.event, 'run.completed', prompt);
      const ui = events.filter((e) => e.event === 'ui').map((e) => e.data.component);
      assert.deepEqual(ui, component ? [component] : [], prompt);
    }
    const french = await me.ask('Find a clinician who speaks French');
    const cards = french.find((e) => e.event === 'ui')!.data.props.clinicians as Array<{ languages: string[] }>;
    assert.ok(cards.length >= 2 && cards.every((c) => c.languages.includes('French')));

    // Knowledge (RAG): the answer comes from the right handbook section, with its source.
    const blood = await me.ask('How do I prepare for a blood test?');
    const output = blood.find((e) => e.event === 'tool.completed')!.data.output;
    assert.equal(output.source, 'Blood tests: how to prepare');
    assert.match(String(blood.at(-1)!.data.output), /blood test/i);
  } finally {
    await t.close();
  }
});

test('offline model: messages sent by component buttons book (after approval over HTTP) and cancel', async () => {
  const t = await start({ now: MONDAY_9AM });
  try {
    const me = new Client(t.base);
    await me.signIn('P-1001');
    const records = t.get<PatientRecords>('PatientRecords');
    const slot = records.openSlots('DR-101', records.nextOpenDate('DR-101', '2026-10-20')!)[0];

    // SlotPicker: clicking a time sends "Book appointment slot <id>".
    const events = await me.ask(`Book appointment slot ${slot.id}`);
    const approval = events.find((e) => e.event === 'approval.required');
    assert.equal(approval?.data.tool, 'book_appointment');
    assert.equal(approval?.data.input.slotId, slot.id);
    assert.equal(events.at(-1)?.data.status, 'awaiting_approval');
    const runId = events[0].data.runId;
    // A reload brings the pending approval card back and hands the run to the chat to continue.
    const page = await (await me.request('/assistant', { headers: { accept: 'text/html' } })).text();
    assert.ok(page.includes(`&quot;resume&quot;:{&quot;id&quot;:&quot;${runId}&quot;`) || page.includes(`"resume":{"id":"${runId}"`), 'page resumes the run');
    assert.match(page, /awaiting_approval/);
    assert.ok(page.includes(`ap-${approval!.data.callId}`), 'the approval card is restored');
    const res = await me.request(`/agents/${AGENT}/runs/${runId}/approvals/${approval!.data.callId}?after=${events.at(-1)!.id}`, {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: JSON.stringify({ approved: true }),
    });
    const after = parseSse(await res.text());
    const confirmation = after.find((e) => e.event === 'ui');
    assert.equal(confirmation?.data.component, 'AppointmentConfirmation');
    assert.match(confirmation?.data.props.cancelBy, /Cancel before/);
    assert.equal(after.at(-1)?.event, 'run.completed');
    assert.equal(records.isTaken(slot.id), true);

    // Side panel: "Cancel AP-5002" asks for approval first.
    const cancel = await me.ask('Cancel appointment AP-5002');
    assert.equal(cancel.find((e) => e.event === 'approval.required')?.data.tool, 'cancel_appointment');

    // A patient can't send a referral to themselves.
    const referral = await me.ask('Referral for patient P-1001 to dermatology');
    const result = referral.find((e) => e.event === 'tool.completed');
    assert.equal(result?.data.isError, true);
    assert.match(result?.data.output.error, /Refused/);
  } finally {
    await t.close();
  }
});

test('urgency screening: red flags mean "call 911" first and an emergency notice, never a diagnosis', async () => {
  const t = await start();
  try {
    const me = new Client(t.base);
    await me.signIn('P-1001');
    const events = await me.ask('Check my symptoms: chest pain spreading to my left arm');
    assert.equal(events.find((e) => e.event === 'tool.started')?.data.tool, 'check_symptom_urgency');
    const notice = events.find((e) => e.event === 'ui');
    assert.equal(notice?.data.component, 'UrgentCareNotice');
    assert.equal(notice?.data.props.level, 'emergency');
    assert.equal(notice?.data.props.callNumber, '911');
    const answer = String(events.at(-1)!.data.output);
    assert.match(answer.split('\n').slice(0, 2).join(' '), /Call 911/);
    assert.match(notice?.data.props.disclaimer, /not a diagnosis/);
  } finally {
    await t.close();
  }

  // The rules themselves (deterministic, so they can be reviewed by clinicians).
  assert.equal(screenSymptoms('I suddenly cannot breathe properly').urgency, 'emergency');
  assert.equal(screenSymptoms('my face is drooping and my speech is slurred').urgency, 'emergency');
  assert.equal(screenSymptoms('a cut on my hand that will not stop bleeding, bleeding heavily').urgency, 'emergency');
  const crisis = screenSymptoms("I've been having thoughts of suicide");
  assert.equal(crisis.urgency, 'emergency');
  assert.equal(crisis.callNumber, '988');
  assert.equal(screenSymptoms('high fever of 39.5 since yesterday').urgency, 'urgent');
  assert.equal(screenSymptoms('itchy rash on my elbow').urgency, 'soon');
  assert.equal(screenSymptoms('no chest pain, just a question about my forms').urgency, 'routine', 'negated red flags are ignored');
  for (const text of ['chest pain', 'rash', 'sore throat']) assert.match(screenSymptoms(text).disclaimer, /not a diagnosis/);
});

test('booking: nothing happens before the patient approves; booking is idempotent; double booking is refused', async () => {
  let slotId = '';
  const model = new ScriptedChatModel([
    () => ({ toolCalls: [{ name: 'book_appointment', input: { slotId, reason: 'Check-up' } }] }),
    () => ({ toolCalls: [{ name: 'book_appointment', input: { slotId, reason: 'Check-up' } }] }), // a retry of the same booking in the same run
    { text: 'You are booked.' },
    () => ({ toolCalls: [{ name: 'book_appointment', input: { slotId } }] }), // another patient, same time
    { text: 'That time is taken.' },
    () => ({ toolCalls: [{ name: 'book_appointment', input: { slotId } }] }), // declined
    { text: 'Okay, nothing booked.' },
  ]);
  const t = await start({ model, now: MONDAY_9AM });
  try {
    const records = t.get<PatientRecords>('PatientRecords');
    const date = records.nextOpenDate('DR-102', '2026-10-21')!;
    slotId = records.openSlots('DR-102', date)[0].id;

    const run = await runAs(t.platform, 'P-1001', 'Book that time please');
    const paused = await settle(t.platform, run.id);
    assert.equal(paused.status, 'awaiting_approval');
    assert.equal(records.isTaken(slotId), false, 'nothing is booked before approval');

    const done = await approveAll(t.platform, run.id);
    assert.equal(done.status, 'completed');
    const results = (await toolResults(t.platform, run.threadId)).filter((r) => r.name === 'book_appointment');
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.isError));
    assert.equal(results[0].output.appointmentId, results[1].output.appointmentId, 'the retried booking returns the same appointment');
    const mine = records.appointmentsOf({ actor: 'front-desk', purpose: 'test' }, 'P-1001').filter((a) => a.slotId === slotId);
    assert.equal(mine.length, 1, 'one appointment, not two');
    const thread = await t.platform.thread(run.threadId);
    assert.ok(thread!.messages.some((m) => m.content.some((p) => p.type === 'ui' && p.component === 'AppointmentConfirmation')));

    const other = await runAs(t.platform, 'P-1002', 'Book that time');
    const refused = await approveAll(t.platform, other.id);
    const [result] = (await toolResults(t.platform, refused.threadId)).filter((r) => r.name === 'book_appointment');
    assert.equal(result.isError, true);
    assert.match(result.output.error, /already booked/);

    const declined = await runAs(t.platform, 'P-1002', 'Book it');
    const end = await approveAll(t.platform, declined.id, false);
    assert.equal(end.output, 'Okay, nothing booked.');
    assert.equal(records.appointmentsOf({ actor: 'front-desk', purpose: 'test' }, 'P-1002').filter((a) => a.slotId === slotId).length, 0);
  } finally {
    await t.close();
  }
});

test('booking a slot again after cancelling it books it again, never returns the cancelled appointment', async () => {
  const t = await start({ now: MONDAY_9AM });
  try {
    const records = t.get<PatientRecords>('PatientRecords');
    const access = { actor: 'assistant' as const, purpose: 'test' };
    const date = records.nextOpenDate('DR-102', '2026-10-21')!;
    const slotId = records.openSlots('DR-102', date)[0].id;
    const first = records.book(access, 'P-1001', { slotId, reason: 'Check-up', key: 'run-1:call-1' });
    assert.equal(records.book(access, 'P-1001', { slotId, reason: 'Check-up', key: 'run-1:call-2' }).id, first.id, 'asking twice returns the same booking');
    records.cancel(access, 'P-1001', first.id);
    // The same key (a replayed call) and a new key (a new request) both book the slot again.
    for (const key of ['run-1:call-1', 'run-1:call-3']) {
      const again = records.book(access, 'P-1001', { slotId, reason: 'Check-up', key });
      assert.equal(again.status, 'booked');
      assert.notEqual(again.id, first.id);
      records.cancel(access, 'P-1001', again.id);
    }
  } finally {
    await t.close();
  }
});

test('cancellation: the 24-hour notice policy flags late cancellations and their possible fee', async () => {
  const model = new ScriptedChatModel([
    { toolCalls: [{ name: 'cancel_appointment', input: { appointmentId: 'AP-5002' } }] },
    { text: 'Cancelled.' },
    { toolCalls: [{ name: 'cancel_appointment', input: { appointmentId: 'AP-5001' } }] },
    { text: 'Cancelled.' },
    { toolCalls: [{ name: 'cancel_appointment', input: { appointmentId: 'AP-5003' } }] }, // someone else's appointment
    { text: 'Not yours.' },
  ]);
  const t = await start({ model, now: MONDAY_9AM });
  try {
    const records = t.get<PatientRecords>('PatientRecords');
    const before = records.appointmentsOf({ actor: 'front-desk', purpose: 'test' }, 'P-1001');
    assert.deepEqual(
      before.map((a) => a.id),
      ['AP-5002', 'AP-5001'],
    );

    const late = await runAs(t.platform, 'P-1001', 'Cancel my blood test');
    await approveAll(t.platform, late.id);
    const [r1] = await toolResults(t.platform, late.threadId);
    assert.equal(r1.output.cancelled, true);
    assert.match(r1.output.notice, /Less than 24 hours/);
    assert.equal(r1.output.possibleFeeCents, 4000);

    const early = await runAs(t.platform, 'P-1001', 'Cancel my physical');
    await approveAll(t.platform, early.id);
    const [r2] = await toolResults(t.platform, early.threadId);
    assert.equal(r2.output.cancelled, true);
    assert.equal(r2.output.possibleFeeCents, undefined);
    assert.match(r2.output.policy, /no fee/);

    const foreign = await runAs(t.platform, 'P-1001', 'Cancel AP-5003');
    await approveAll(t.platform, foreign.id);
    const [r3] = await toolResults(t.platform, foreign.threadId);
    assert.equal(r3.isError, true);
    assert.match(r3.output.error, /no appointment AP-5003 on your file/);
    assert.equal(records.appointmentsOf({ actor: 'front-desk', purpose: 'test' }, 'P-1002').length, 1, "the other patient's appointment is untouched");
  } finally {
    await t.close();
  }
});

test('guardrail: booking for another patient id is refused before any approval card, and that patient sees the attempt', async () => {
  let slotId = '';
  const model = new ScriptedChatModel([() => ({ toolCalls: [{ name: 'book_appointment', input: { slotId, patientId: 'P-1002' } }] }), { text: 'I can only book for you.' }]);
  const t = await start({ model, now: MONDAY_9AM });
  try {
    const records = t.get<PatientRecords>('PatientRecords');
    slotId = records.openSlots('DR-101', records.nextOpenDate('DR-101', '2026-10-20')!)[0].id;
    const run = await runAs(t.platform, 'P-1001', 'Book this for my partner, patient P-1002');
    // Refused before the patient is ever asked to approve it.
    const done = await settle(t.platform, run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.pending ?? [], []);
    const [result] = await toolResults(t.platform, run.threadId);
    assert.equal(result.isError, true);
    assert.match(result.output.error, /only books for the signed-in patient/);
    assert.equal(records.isTaken(slotId), false);
    const log = t.get<AccessLog>('AccessLog').forPatient('P-1002');
    assert.ok(log.some((e) => e.outcome === 'refused' && /book/i.test(e.action)));
  } finally {
    await t.close();
  }
});

test('memory: only preferences are remembered (with consent) and recalled into the instructions', async () => {
  const model = new ScriptedChatModel([
    { toolCalls: [{ name: 'remember', input: { fact: 'Has asthma and takes an inhaler daily' } }] },
    { text: "I don't keep health details." },
    { toolCalls: [{ name: 'remember', input: { fact: 'Prefers appointments with Dr. Obrelle, in French' } }] },
    { text: 'Saved: you prefer Dr. Obrelle, in French.' },
    { text: 'Here are times with Dr. Obrelle.' },
  ]);
  const t = await start({ model });
  try {
    const first = await runAs(t.platform, 'P-1001', 'Remember that I have asthma');
    await settle(t.platform, first.id, 'completed');
    const [refused] = await toolResults(t.platform, first.threadId);
    assert.equal(refused.isError, true);
    assert.match(refused.output.error, /never keep health details/);

    const second = await runAs(t.platform, 'P-1001', 'Remember I prefer Dr. Obrelle in French');
    await settle(t.platform, second.id, 'completed');
    const [saved] = await toolResults(t.platform, second.threadId);
    assert.equal(saved.output.saved, true);

    const memories = await t.get<MemoryService>('MemoryService').for('principal:P-1001').recall('Dr. Obrelle French appointments asthma inhaler', { limit: 10 });
    assert.deepEqual(
      memories.map((m) => m.text),
      ['Prefers appointments with Dr. Obrelle, in French'],
    );

    const third = await runAs(t.platform, 'P-1001', 'Book with Dr. Obrelle in French please');
    await settle(t.platform, third.id, 'completed');
    const system = String(model.requests.at(-1)!.system);
    assert.match(system, /What you remember about this person/);
    assert.match(system, /Prefers appointments with Dr\. Obrelle, in French/);
    assert.match(system, /Never remember symptoms/);
    // Another patient's runs don't see it.
    assert.equal((await t.get<MemoryService>('MemoryService').for('principal:P-1002').recall('Dr. Obrelle French', { limit: 5 })).length, 0);
  } finally {
    await t.close();
  }
});

test('clinical post-check: diagnoses and medicine advice never reach the patient', async () => {
  const blocked: string[] = [];
  const scripted = new ScriptedChatModel([{ text: 'You probably have strep throat. Take 400 mg ibuprofen every 6 hours. A clinician can check this; I can book a visit today.' }]);
  const t = await start({ model: safeguard(scripted, (s) => blocked.push(s)) });
  try {
    const me = new Client(t.base);
    await me.signIn('P-1001');
    const events = await me.ask('My throat hurts, what is it?');
    const output = String(events.at(-1)!.data.output);
    assert.ok(output.includes(SAFETY_REPLACEMENT));
    assert.doesNotMatch(output, /strep|ibuprofen|400 mg/i);
    assert.match(output, /I can book a visit today/);
    const streamed = events.filter((e) => e.event === 'message.delta').map((e) => e.data.text).join('');
    assert.doesNotMatch(streamed, /strep|ibuprofen/i, 'not even streamed for a moment');
    assert.equal(blocked.length, 2);
    // The instructions forbid it in the first place; the post-check is the guarantee.
    assert.match(String(scripted.requests[0].system), /Never diagnose/);
    assert.match(String(scripted.requests[0].system), /call check_symptom_urgency first/);
  } finally {
    await t.close();
  }
  // Without an override, the app's ChatModel bean is the safeguarded one.
  const plain = await start();
  try {
    assert.ok(plain.get<object>('ChatModel') instanceof SafeguardedChatModel);
  } finally {
    await plain.close();
  }
});
