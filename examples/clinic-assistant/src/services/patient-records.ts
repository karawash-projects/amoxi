import { Intercept, PostConstruct, Singleton } from 'amoxi';
import { PATIENTS } from '../domain/clinic-data';
import { addDays } from '../domain/time';
import type { Appointment, Patient, Referral, Slot, Specialty } from '../domain/types';
import { AccessAuditInterceptor } from './access-audit-interceptor';
import type { Access } from './access-log';
import { ClinicDirectory } from './clinic-directory';
import type { Clock } from './clock';
import { ToolError } from 'amoxi/ai';

/** Refusals the assistant explains to the patient (sent to the model as the tool error). */
export class ClinicRuleError extends ToolError {
  override name = 'ClinicRuleError';
}

export const LATE_CANCEL_FEE_CENTS = 4000;
const DAY_MS = 24 * 3600_000;

/**
 * Appointments and referrals: the patient data. Every method that reads or changes a patient's
 * data takes an Access first and is audited by AccessAuditInterceptor (pseudonymous log).
 */
@Singleton()
export class PatientRecords {
  private readonly appointments: Appointment[] = [];
  private readonly referrals: Referral[] = [];
  /** Idempotency keys (run + slot) of bookings already made. */
  private readonly bookingKeys = new Map<string, string>();
  private nextAppointment = 5001;
  private nextReferral = 8001;

  constructor(
    private readonly directory: ClinicDirectory,
    private readonly clock: Clock,
  ) {}

  /** Seeds a few upcoming appointments for the demo patients, relative to today. */
  @PostConstruct()
  seed(): void {
    const now = this.clock.now().getTime();
    const first = (clinicianId: string, from: number, until = from + 21 * DAY_MS): Slot | undefined => {
      const c = this.directory.clinician(clinicianId)!;
      for (let d = 0; d < 28; d++) {
        const date = addDays(this.directory.today(), d);
        const s = this.directory.grid(c, date).find((x) => Date.parse(x.startsAt) >= from && Date.parse(x.startsAt) <= until && !this.directory.heldByOthers(x.id) && !this.isTaken(x.id));
        if (s) return s;
      }
      return undefined;
    };
    const seed = (patientId: string, slot: Slot | undefined, reason: string): void => {
      if (!slot) return;
      this.appointments.push({
        id: `AP-${this.nextAppointment++}`,
        patientId,
        clinicianId: slot.clinicianId,
        slotId: slot.id,
        startsAt: slot.startsAt,
        date: slot.date,
        time: slot.time,
        minutes: slot.minutes,
        reason,
        status: 'booked',
        bookedAt: new Date(now - 6 * DAY_MS).toISOString(),
        bookedBy: 'front-desk',
      });
    };
    seed('P-1001', first('DR-101', now + 3 * DAY_MS), 'Annual physical');
    // Within 24 hours when possible, so the late-cancellation policy can be seen in the demo.
    seed('P-1001', first('RN-107', now + 3 * 3600_000, now + 23 * 3600_000) ?? first('RN-107', now + 3 * 3600_000), 'Blood test (fasting)');
    seed('P-1002', first('NP-105', now + 5 * DAY_MS), 'Cervical screening');
  }

  patient(id: string): Patient | undefined {
    return PATIENTS.find((p) => p.id === id.trim().toUpperCase());
  }

  /** Taken by a Demo Clinic patient (booked and not cancelled). Not patient data: just a time. */
  isTaken(slotId: string): boolean {
    return this.appointments.some((a) => a.slotId === slotId && a.status === 'booked');
  }

  /** Bookable slots of a clinician on a date. */
  openSlots(clinicianId: string, date: string): Slot[] {
    const c = this.directory.clinician(clinicianId);
    if (!c) return [];
    return this.directory.grid(c, date).filter((s) => this.directory.bookable(s) && !this.directory.heldByOthers(s.id) && !this.isTaken(s.id));
  }

  /** First date (from `from`, within two weeks) with open slots for the clinician. */
  nextOpenDate(clinicianId: string, from: string): string | undefined {
    for (let d = 0; d < 14; d++) {
      const date = addDays(from, d);
      if (this.openSlots(clinicianId, date).length > 0) return date;
    }
    return undefined;
  }

  @Intercept(AccessAuditInterceptor)
  appointmentsOf(_access: Access, patientId: string): Appointment[] {
    const now = this.clock.now().getTime();
    return this.appointments
      .filter((a) => a.patientId === patientId && a.status === 'booked' && Date.parse(a.startsAt) + a.minutes * 60_000 > now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((a) => ({ ...a }));
  }

  /** One of the patient's own appointments; another patient's id behaves exactly like a missing one. */
  @Intercept(AccessAuditInterceptor)
  appointmentOf(_access: Access, patientId: string, appointmentId: string): Appointment | undefined {
    const a = this.appointments.find((x) => x.id === appointmentId.trim().toUpperCase() && x.patientId === patientId);
    return a ? { ...a } : undefined;
  }

  /**
   * Books a slot. Idempotent per `key` (one tool call), so a retried or resumed booking returns the
   * same appointment instead of creating a second one. Double booking is refused. A booking that was
   * cancelled since is never handed back as booked: the slot is booked again.
   */
  @Intercept(AccessAuditInterceptor)
  book(_access: Access, patientId: string, input: { slotId: string; reason: string; key: string }): Appointment {
    const previous = this.bookingKeys.get(input.key);
    const earlier = previous ? this.appointments.find((x) => x.id === previous) : undefined;
    if (earlier && earlier.status === 'booked') return { ...earlier };
    if (!this.patient(patientId)) throw new ClinicRuleError('There is no patient file for this session.');
    const slot = this.directory.slot(input.slotId);
    if (!slot) throw new ClinicRuleError(`"${input.slotId}" is not an appointment time on the schedule. Ask for open times first.`);
    // Asking twice for the same time returns the patient's existing booking (a cancelled one doesn't count).
    const mine = this.appointments.find((a) => a.patientId === patientId && a.slotId === slot.id && a.status === 'booked');
    if (mine) return { ...mine };
    const clinician = this.directory.clinician(slot.clinicianId)!;
    if (!this.directory.bookable(slot)) throw new ClinicRuleError('That time has passed or starts in less than 30 minutes. Please choose a later time.');
    if (this.isTaken(slot.id) || this.directory.heldByOthers(slot.id)) {
      throw new ClinicRuleError('That time is already booked (double booking is not allowed). Please choose another open time.');
    }
    if (!clinician.accepting && !this.appointments.some((a) => a.patientId === patientId && a.clinicianId === clinician.id)) {
      throw new ClinicRuleError(`${clinician.name} is not accepting new patients. Your family physician can refer you, or I can show other clinicians.`);
    }
    const start = Date.parse(slot.startsAt);
    const clash = this.appointments.find((a) => a.patientId === patientId && a.status === 'booked' && Math.abs(Date.parse(a.startsAt) - start) < 60 * 60_000);
    if (clash) throw new ClinicRuleError(`You already have appointment ${clash.id} within an hour of that time. Cancel it first or pick another time.`);
    const appointment: Appointment = {
      id: `AP-${this.nextAppointment++}`,
      patientId,
      clinicianId: clinician.id,
      slotId: slot.id,
      startsAt: slot.startsAt,
      date: slot.date,
      time: slot.time,
      minutes: slot.minutes,
      reason: input.reason.trim().slice(0, 120) || 'Appointment',
      status: 'booked',
      bookedAt: this.clock.now().toISOString(),
      bookedBy: 'assistant',
    };
    this.appointments.push(appointment);
    this.bookingKeys.set(input.key, appointment.id);
    return { ...appointment };
  }

  /** Cancels one of the patient's appointments. Less than 24 hours' notice is allowed but flagged (policy). */
  @Intercept(AccessAuditInterceptor)
  cancel(_access: Access, patientId: string, appointmentId: string): { appointment: Appointment; lateCancellation: boolean; hoursNotice: number } {
    const a = this.appointments.find((x) => x.id === appointmentId.trim().toUpperCase() && x.patientId === patientId);
    if (!a) throw new ClinicRuleError(`There is no appointment ${appointmentId} on your file.`);
    if (a.status === 'cancelled') throw new ClinicRuleError(`Appointment ${a.id} is already cancelled.`);
    const now = this.clock.now();
    const hoursNotice = (Date.parse(a.startsAt) - now.getTime()) / 3600_000;
    if (hoursNotice <= 0) throw new ClinicRuleError(`Appointment ${a.id} has already started. Please call the front desk.`);
    a.status = 'cancelled';
    a.cancelledAt = now.toISOString();
    a.lateCancellation = hoursNotice < 24;
    return { appointment: { ...a }, lateCancellation: a.lateCancellation, hoursNotice: Math.floor(hoursNotice) };
  }

  /** A partner organisation's referral. Stored for staff review; nothing about the patient is returned. */
  @Intercept(AccessAuditInterceptor)
  receiveReferral(_access: Access, patientId: string, input: { specialty: Specialty; reason: string; from: string }): Referral {
    const referral: Referral = {
      id: `RF-${this.nextReferral++}`,
      patientId: patientId.trim().toUpperCase(),
      specialty: input.specialty,
      reason: input.reason.trim().slice(0, 300),
      from: input.from,
      receivedAt: this.clock.now().toISOString(),
      status: 'received',
    };
    this.referrals.push(referral);
    return { ...referral };
  }

  @Intercept(AccessAuditInterceptor)
  referralsOf(_access: Access, patientId: string): Referral[] {
    return this.referrals.filter((r) => r.patientId === patientId).map((r) => ({ ...r }));
  }
}
