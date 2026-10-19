import type { RequestContext } from 'amoxi';
import { Agent, type AgentRunContext, type ToolContext } from 'amoxi/ai';
import { CLINIC } from '../domain/clinic-data';
import { clinicParts, dateLabel, timeLabel } from '../domain/time';
import { AccessLog } from '../services/access-log';
import type { Clock } from '../services/clock';
import { PATIENT_SESSION_KEY } from '../web/patient-session';
import { ClinicTools } from './clinic-tools';
import { identityOf } from './identity';

/** Tools that act on a patient's own record. */
const PATIENT_TOOLS = new Set(['book_appointment', 'cancel_appointment', 'upcoming_appointments']);

/** Health details the assistant must never keep in long-term memory. */
const CLINICAL =
  /(diagnos|symptom|pain|ache|fever|cough|rash|bleed|blood|medic|pill|dose|\bmg\b|prescri|allerg|pregnan|test result|cancer|diabet|asthma|depress|anxi|suicid|mental|condition|disease|infection|surgery|injur|\bhiv\b|\bsti\b|weight|pressure|therapy|lump|mole|period|sexual)/i;
/** What a remembered preference is about. */
const PREFERENCE = /(prefer|language|english|french|spanish|mandarin|cantonese|tamil|hindi|polish|persian|arabic|morning|afternoon|evening|weekend|saturday|clinician|doctor|\bdr\.?\s|nurse|remind|text me|email|call me|phone|pronoun|interpreter|accessib|wheelchair|time)/i;

/**
 * Demo Clinic's patient assistant: answers clinic questions, screens symptoms for urgency
 * (never diagnoses), finds clinicians and open times, and books or cancels appointments with
 * the patient's confirmation. Partner organisations' agents can send referral requests over A2A.
 */
@Agent({
  name: 'clinic-assistant',
  tools: [ClinicTools],
  ui: ['ClinicianCards', 'SlotPicker', 'AppointmentConfirmation', 'UrgentCareNotice'],
  knowledge: ['clinic'],
  memory: { recall: 3, remember: true },
  examples: [
    'Find a clinician who speaks French',
    'Show available slots tomorrow',
    'How do I prepare for a blood test?',
    'Check my symptoms: chest pain spreading to my left arm',
    'Referral for patient P-1002 to dermatology',
  ],
  maxTurns: 8,
})
export class ClinicAssistant {
  constructor(
    private readonly accessLog: AccessLog,
    private readonly clock: Clock,
  ) {}

  instructions(ctx: AgentRunContext): string {
    // The clinic's clock (fixed in tests and demos), the same one schedules and slots use.
    const now = clinicParts(this.clock.now());
    const clock = `It is ${dateLabel(now.date)}, ${timeLabel(now.time)} in Toronto (America/Toronto); all appointment times are Toronto time.`;
    const safety = [
      'Safety rules (never break them):',
      '- Never diagnose, name a likely condition, or interpret test results. Never recommend, prescribe, renew or dose medicines. Say a clinician can assess it and offer to book a visit.',
      '- Whenever someone describes symptoms, call check_symptom_urgency first, before anything else, and follow its urgency level exactly.',
      '- If the urgency is emergency: your first sentence tells them to call 911 now or go to the nearest emergency department (for thoughts of suicide also mention calling or texting 9-8-8). Do not offer to book a clinic appointment instead.',
      '- Keep answers short, warm and plain. Do not ask for more health details than needed to book.',
    ].join('\n');

    if (identityOf(ctx.principal).kind === 'partner') {
      return [
        `You are the referral desk agent of ${CLINIC.name}, a family clinic in Toronto, talking to a partner organisation's agent (pharmacy or hospital) over A2A.`,
        clock,
        'Partners may only send referral requests: use request_referral with the patient id, the specialty and the reason they give.',
        'Never reveal or confirm anything about a patient (whether they are a patient, appointments, history). Acknowledge the referral id and the next step only.',
        safety,
      ].join('\n\n');
    }

    const patientId = typeof ctx.principal === 'string' ? ctx.principal : 'unknown';
    return [
      `You are the patient assistant of ${CLINIC.name}, a multi-clinician family clinic at ${CLINIC.address}. Front desk: ${CLINIC.phone}.`,
      clock,
      `You are helping the signed-in patient (patient id ${patientId}). You may only look at or change this patient's own appointments; never book for anyone else.`,
      'What you can do: answer clinic questions with clinic_policy (cite the source title), find clinicians with find_clinicians, show open times with available_slots, book with book_appointment and cancel with cancel_appointment (the patient confirms both in the app), list upcoming_appointments.',
      'Booking: show open times first; book only a slot id that came from available_slots. When a tool shows a card, add one short sentence instead of repeating it.',
      'Memory and consent: only call remember when the patient asks you to remember something, and only for scheduling preferences (preferred clinician, language, time of day, how to be reminded). Never remember symptoms, conditions, medicines, test results or anything clinical. After saving, tell the patient exactly what you saved.',
      safety,
    ].join('\n\n');
  }

  /** Runs execute in the background: capture the patient id from the session while the request is here. */
  principal(req: RequestContext): string | undefined {
    return req.session.get<string>(PATIENT_SESSION_KEY);
  }

  /** Conversations belong to the patient, not to the browser: another patient gets 404. */
  owner(req: RequestContext): string | undefined {
    return req.session.get<string>(PATIENT_SESSION_KEY);
  }

  /**
   * Guardrails, checked before every tool call (including the built-in remember tool). For tools
   * that need approval they run before the patient is asked, so a refused call never shows a card.
   */
  beforeToolCall(call: { tool: string; input: unknown; ctx: ToolContext }): string | undefined {
    const who = identityOf(call.ctx.principal);
    const input = (call.input ?? {}) as Record<string, unknown>;

    if (PATIENT_TOOLS.has(call.tool) && who.kind !== 'patient') {
      return 'Refused: only the signed-in patient can view, book or cancel their appointments. Partner organisations can send referrals.';
    }
    if (call.tool === 'book_appointment' && who.kind === 'patient' && typeof input.patientId === 'string' && input.patientId.trim() !== '') {
      const target = input.patientId.trim().toUpperCase();
      if (target !== who.patientId) {
        // The other patient sees the refused attempt on their own access page.
        this.accessLog.record(target, { actor: 'assistant', purpose: "Requested from another patient's session" }, 'Tried to book an appointment for you', 'refused');
        return 'Refused: for privacy and safety the assistant only books for the signed-in patient. A family member needs their own login, or can call the front desk at 416-555-0142.';
      }
    }
    if (call.tool === 'request_referral' && who.kind !== 'partner') {
      return 'Refused: referrals come from your clinician or a partner organisation. I can book you a visit with your family physician to discuss one.';
    }
    if (call.tool === 'remember') {
      const fact = String(input.fact ?? '');
      if (who.kind !== 'patient') return 'Refused: memory is only kept for signed-in patients.';
      if (CLINICAL.test(fact)) return 'Refused: I never keep health details in memory. I can remember scheduling preferences such as a preferred clinician, language or time of day.';
      if (!PREFERENCE.test(fact)) return 'Refused: I only remember scheduling preferences (preferred clinician, language, time of day, reminders).';
    }
    return undefined;
  }
}
