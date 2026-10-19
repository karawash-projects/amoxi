import { Singleton } from 'amoxi';
import { KnowledgeBases, Tool, type JsonValue, type ToolContext } from 'amoxi/ai';
import { CLINIC, clinicianById, CLINICIANS } from '../domain/clinic-data';
import { addDays, clinicParts, dateLabel, shortDateLabel, timeLabel } from '../domain/time';
import { LANGUAGE_LABELS, SPECIALTY_LABELS, type Appointment, type Clinician, type Language, type Specialty } from '../domain/types';
import type { Access } from '../services/access-log';
import { ClinicDirectory } from '../services/clinic-directory';
import type { Clock } from '../services/clock';
import { CLINIC_KB } from '../services/knowledge-loader';
import { ClinicRuleError, LATE_CANCEL_FEE_CENTS, PatientRecords } from '../services/patient-records';
import type { ClinicianCard } from '../ui/cards';
import { identityOf } from './identity';
import { screenSymptoms } from './triage';

const AS_ASSISTANT: Access = { actor: 'assistant', purpose: 'Requested by you in the Demo Clinic assistant' };

function when(a: { date: string; time: string }): string {
  return `${dateLabel(a.date)} at ${timeLabel(a.time)}`;
}

function preparationFor(clinician: Clinician, reason: string): string[] {
  const out = ['Bring your health card and a list of the medicines you take.', 'Arrive 10 minutes early to check in.'];
  if (clinician.specialty === 'nursing' && /blood|lab|fasting/i.test(reason)) {
    out.unshift('If your requisition says fasting: no food for 8 to 12 hours before. Water is fine.');
  }
  if (clinician.specialty === 'pediatrics') out.push("Bring your child's vaccination record.");
  return out;
}

/**
 * The assistant's tools. Each one acts for the identity captured when the run started (a
 * patient's session, or a partner agent over A2A) and reads or writes patient data only through
 * PatientRecords, whose methods are audited.
 */
@Singleton()
export class ClinicTools {
  constructor(
    private readonly directory: ClinicDirectory,
    private readonly records: PatientRecords,
    private readonly knowledge: KnowledgeBases,
    private readonly clock: Clock,
  ) {}

  private patientOf(ctx: ToolContext): string {
    const who = identityOf(ctx.principal);
    if (who.kind !== 'patient') throw new ClinicRuleError('This needs a signed-in patient. Partner organisations can only send referrals.');
    return who.patientId;
  }

  private card(c: Clinician): ClinicianCard {
    const next = c.accepting ? this.records.nextOpenDate(c.id, this.directory.today()) : undefined;
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      specialty: SPECIALTY_LABELS[c.specialty],
      languages: c.languages.map((l) => LANGUAGE_LABELS[l]),
      accepting: c.accepting,
      focus: [...c.focus],
      ...(next ? { nextOpenDate: next, nextOpenLabel: shortDateLabel(next) } : {}),
    };
  }

  /** Find Demo Clinic clinicians by specialty or by a language they speak, and show them as cards with their next open day. */
  @Tool({ readOnly: true })
  findClinicians(
    input: {
      /** Area of care: family (family physicians), pediatrics, dermatology, womens-health, mental-health or nursing (blood tests, vaccines). */
      specialty?: Specialty;
      /** A language the patient wants the clinician to speak, lower-case, e.g. french. */
      language?: Language;
    },
    ctx: ToolContext,
  ) {
    const found = this.directory.clinicians(input);
    const cards = found.map((c) => this.card(c));
    const parts = [input.specialty ? SPECIALTY_LABELS[input.specialty] : '', input.language ? `speaks ${LANGUAGE_LABELS[input.language]}` : ''].filter(Boolean);
    if (cards.length > 0) ctx.ui('ClinicianCards', { title: parts.length ? `Clinicians: ${parts.join(', ')}` : 'Demo Clinic clinicians', clinicians: cards });
    return {
      count: cards.length,
      clinicians: cards.map((c) => ({ id: c.id, name: c.name, role: c.role, nextOpen: c.accepting ? (c.nextOpenLabel ?? 'no openings in two weeks') : 'not accepting new patients', languages: c.languages.join(', ') })),
      ...(cards.length === 0 ? { note: 'No clinician matches. Interpretation can be arranged for any visit.' } : {}),
    };
  }

  /** List open appointment times (available slots) for one clinician on a date and show a time picker. Without a clinician it uses the first family physician with openings. */
  @Tool({ readOnly: true })
  availableSlots(
    input: {
      /** Clinician id such as DR-101, or the clinician's name. */
      clinicianId?: string;
      /**
       * Day to look at (yyyy-mm-dd). Defaults to the next day with openings.
       * @format date
       */
      date?: string;
    },
    ctx: ToolContext,
  ) {
    const today = this.directory.today();
    let clinician: Clinician | undefined;
    if (input.clinicianId) {
      const key = input.clinicianId.trim().toLowerCase();
      clinician = clinicianById(input.clinicianId) ?? CLINICIANS.find((c) => c.name.toLowerCase().includes(key.replace(/^dr\.?\s*/, '')));
      if (!clinician) throw new ClinicRuleError(`I couldn't find a clinician "${input.clinicianId}". Ask me to find clinicians first.`);
    }
    const wanted = input.date && input.date >= today ? input.date : today;
    if (!clinician) {
      clinician = CLINICIANS.filter((c) => c.specialty === 'family' && c.accepting).sort((a, b) => (this.records.nextOpenDate(a.id, wanted) ?? '9').localeCompare(this.records.nextOpenDate(b.id, wanted) ?? '9'))[0];
    }
    if (!clinician.accepting) throw new ClinicRuleError(`${clinician.name} is not accepting new patients. I can show other clinicians, or your family physician can refer you.`);
    let date = wanted;
    let note: string | undefined;
    if (this.records.openSlots(clinician.id, wanted).length === 0) {
      const next = this.records.nextOpenDate(clinician.id, wanted);
      if (!next) throw new ClinicRuleError(`${clinician.name} has no open times in the next two weeks. I can show other clinicians.`);
      note = `No open times on ${dateLabel(wanted)}${input.date ? '' : ' (today)'}. Showing the next day with openings.`;
      date = next;
    }
    const slots = this.records.openSlots(clinician.id, date);
    const otherDays: Array<{ date: string; label: string }> = [];
    for (let d = 1; d < 14 && otherDays.length < 4; d++) {
      const day = addDays(date, d);
      if (this.records.openSlots(clinician.id, day).length > 0) otherDays.push({ date: day, label: shortDateLabel(day) });
    }
    ctx.ui('SlotPicker', {
      clinicianId: clinician.id,
      clinicianName: clinician.name,
      role: clinician.role,
      date,
      dateLabel: dateLabel(date),
      ...(note ? { note } : {}),
      slots: slots.map((s) => ({ id: s.id, time: s.time, label: timeLabel(s.time) })),
      otherDays,
    });
    return {
      clinician: `${clinician.name} (${clinician.id})`,
      date: dateLabel(date),
      openTimes: slots.slice(0, 8).map((s) => timeLabel(s.time)).join(', ') + (slots.length > 8 ? ` and ${slots.length - 8} more` : ''),
      ...(note ? { note } : {}),
      howToBook: 'Pick a time in the picker, or ask to book a slot by its id.',
    };
  }

  /** Book an appointment slot for the signed-in patient. The patient confirms before anything is booked. */
  // idempotent: safe to re-run after a crash: ctx.step() replays a finished booking, and the
  // records' per-call key returns the same appointment if the crash came between the two.
  @Tool({ approval: true, idempotent: true })
  async bookAppointment(
    input: {
      /** Slot id from the open times, e.g. S-101-20261020-0930. */
      slotId: string;
      /** Only the signed-in patient can be booked; leave empty. */
      patientId?: string;
      /** What the visit is for, in a few words (optional; no clinical detail needed). */
      reason?: string;
    },
    ctx: ToolContext,
  ) {
    const patientId = this.patientOf(ctx);
    // Durable step: if the run is resumed after a crash, the booking is not repeated.
    const appointment = (await ctx.step('book', () => this.records.book(AS_ASSISTANT, patientId, { slotId: input.slotId, reason: input.reason ?? 'Appointment', key: `${ctx.runId}:${ctx.callId}` }) as unknown as JsonValue)) as unknown as Appointment;
    const clinician = clinicianById(appointment.clinicianId)!;
    const cutoff = clinicParts(new Date(Date.parse(appointment.startsAt) - 24 * 3600_000));
    ctx.ui('AppointmentConfirmation', {
      appointmentId: appointment.id,
      clinicianName: clinician.name,
      role: clinician.role,
      dateLabel: dateLabel(appointment.date),
      timeLabel: timeLabel(appointment.time),
      minutes: appointment.minutes,
      location: `${CLINIC.address}, ${clinician.room}`,
      reason: appointment.reason,
      preparation: preparationFor(clinician, appointment.reason),
      cancelBy: `Cancel before ${dateLabel(cutoff.date)} at ${timeLabel(cutoff.time)} to avoid the late-cancellation fee.`,
    });
    return { booked: true, appointmentId: appointment.id, clinician: clinician.name, when: when(appointment), location: clinician.room };
  }

  /** Cancel one of the signed-in patient's appointments. The 24-hour notice policy applies; the patient confirms first. */
  @Tool({ approval: true })
  async cancelAppointment(
    input: {
      /** Appointment id, e.g. AP-5001. */
      appointmentId: string;
    },
    ctx: ToolContext,
  ) {
    const patientId = this.patientOf(ctx);
    const result = (await ctx.step('cancel', () => this.records.cancel(AS_ASSISTANT, patientId, input.appointmentId) as unknown as JsonValue)) as unknown as { appointment: Appointment; lateCancellation: boolean; hoursNotice: number };
    const a = result.appointment;
    return {
      cancelled: true,
      appointmentId: a.id,
      when: when(a),
      notice: result.lateCancellation ? `Less than 24 hours (${result.hoursNotice} h)` : 'More than 24 hours',
      policy: result.lateCancellation
        ? 'Late cancellation: a fee may apply for uninsured services. It is waived once a year and always waived if you are unwell.'
        : 'Cancelled with enough notice: no fee.',
      ...(result.lateCancellation ? { possibleFeeCents: LATE_CANCEL_FEE_CENTS } : {}),
    };
  }

  /** Show the signed-in patient's upcoming appointments with date, time, clinician and reason. */
  @Tool({ readOnly: true })
  async upcomingAppointments(_input: {}, ctx: ToolContext) {
    const patientId = this.patientOf(ctx);
    const list = this.records.appointmentsOf(AS_ASSISTANT, patientId);
    const now = this.clock.now().getTime();
    return {
      count: list.length,
      appointments: list.map((a) => ({ id: a.id, when: when(a), clinician: clinicianById(a.clinicianId)?.name ?? a.clinicianId, reason: a.reason, hoursAway: Math.max(0, Math.round((Date.parse(a.startsAt) - now) / 3600_000)) })),
    };
  }

  /**
   * Safety screen of symptoms the person describes (chest pain, trouble breathing, bleeding, stroke signs, face or arm numb,
   * fever, rash, cough, headache, vomiting, sore throat, suicidal thoughts) to decide how urgently to get care. Never a diagnosis.
   */
  @Tool({ readOnly: true })
  checkSymptomUrgency(
    input: {
      /**
       * The person's own description of their symptoms.
       * @minLength 3
       * @maxLength 2000
       */
      text: string;
    },
    ctx: ToolContext,
  ) {
    const result = screenSymptoms(input.text);
    if (result.urgency === 'emergency' || result.urgency === 'urgent') {
      ctx.ui('UrgentCareNotice', {
        level: result.urgency,
        headline: result.headline,
        actions: [...result.guidance],
        redFlags: [...result.redFlags],
        ...(result.callNumber ? { callNumber: result.callNumber } : {}),
        disclaimer: result.disclaimer,
      });
    }
    return {
      whatToDo: result.guidance[0],
      urgency: result.urgency,
      ...(result.guidance[1] ? { also: result.guidance[1] } : {}),
      redFlags: result.redFlags.join(', ') || 'none',
      ...(result.callNumber ? { callNow: result.callNumber } : {}),
      note: result.disclaimer,
    };
  }

  /**
   * Answer questions about clinic policies from the clinic handbook: cancellation policy, how to prepare for a blood test,
   * fasting, vaccinations and flu shots, prescription renewal, privacy, insurance coverage and fees, what to bring.
   */
  @Tool({ readOnly: true })
  async clinicPolicy(
    input: {
      /**
       * The question, in the person's words.
       * @minLength 2
       * @maxLength 500
       */
      question: string;
    },
    ctx: ToolContext,
  ) {
    const hits = await this.knowledge.get(CLINIC_KB).search(input.question, { limit: 3, signal: ctx.signal });
    if (hits.length === 0) return { answer: 'The handbook has nothing on that. The front desk can help: 416-555-0142.' };
    const [top, ...rest] = hits;
    return {
      answer: top.text,
      source: top.title ?? 'Clinic handbook',
      link: top.url ?? '/policies',
      ...(rest[0] && rest[0].documentId.split('-')[0] === top.documentId.split('-')[0] ? { more: rest[0].text } : {}),
    };
  }

  /** Partner organisations (pharmacies, hospitals) request a specialist referral for a Demo Clinic patient. Only for partner agents. */
  @Tool()
  async requestReferral(
    input: {
      /** Demo Clinic patient id, e.g. P-1002. */
      patientId: string;
      /** Specialty the patient is referred to. */
      specialty: Specialty;
      /**
       * Reason for referral as written by the referring professional.
       * @maxLength 300
       */
      reason?: string;
    },
    ctx: ToolContext,
  ) {
    const who = identityOf(ctx.principal);
    const from = who.kind === 'partner' ? who.partner : 'Unknown sender';
    const referral = await ctx.step('referral', () => this.records.receiveReferral({ actor: 'partner-agent', purpose: `Referral to ${SPECIALTY_LABELS[input.specialty]}` }, input.patientId.trim().toUpperCase(), { specialty: input.specialty, reason: input.reason ?? 'Not given', from }) as unknown as JsonValue);
    const r = referral as unknown as { id: string; receivedAt: string };
    return {
      referralId: r.id,
      status: 'received',
      specialty: SPECIALTY_LABELS[input.specialty],
      nextStep: 'The Demo Clinic referral desk reviews requests within 2 business days and contacts the patient directly. No patient details are shared over this channel.',
    };
  }
}
