import { Body, Controller, Get, HttpError, HttpResponse, PathParam, Post, type RequestContext } from 'amoxi';
import { clinicianById } from '../domain/clinic-data';
import { dateLabel, timeLabel } from '../domain/time';
import type { Access } from '../services/access-log';
import { PatientRecords } from '../services/patient-records';
import type { Clock } from '../services/clock';
import { ActiveSessions } from './active-sessions';
import { currentPatient, PATIENT_SESSION_KEY } from './patient-session';
import type { AppointmentView } from '../ui/cards';

export type { AppointmentView };

export interface DemoSignIn {
  /**
   * One of the fictional demo patients.
   * @pattern ^P-100[12]$
   * @patternMessage must be a demo patient id (P-1001 or P-1002)
   */
  readonly patientId: string;
}


const AS_PORTAL: Access = { actor: 'patient-portal', purpose: 'You opened your appointments' };

/**
 * Demo sign-in and the patient's own data API. A real deployment replaces the demo sign-in with
 * the clinic's patient portal login (OIDC), and keeps the rest.
 */
@Controller()
export class SessionController {
  constructor(
    private readonly records: PatientRecords,
    private readonly clock: Clock,
    private readonly active: ActiveSessions,
  ) {}

  /** Continue as one of the fictional demo patients. */
  @Post('/session/demo-patient')
  signIn(@Body() body: DemoSignIn, ctx: RequestContext) {
    ctx.session.regenerate(); // a new session id on every sign-in (no session fixation)
    ctx.session.set(PATIENT_SESSION_KEY, body.patientId);
    this.active.add(ctx.session.id);
    return { ok: true, patientId: body.patientId };
  }

  /** Ends the demo session. */
  @Post('/session/sign-out')
  signOut(ctx: RequestContext) {
    this.active.remove(ctx.session.id); // the old cookie stops working everywhere, not just in this browser
    ctx.session.destroy();
    return { ok: true };
  }

  /** The signed-in patient's upcoming appointments. */
  @Get('/api/me/appointments')
  appointments(ctx: RequestContext): { appointments: AppointmentView[] } {
    const patient = currentPatient(ctx);
    if (!patient) throw new HttpError(401, 'Not signed in');
    return { appointments: this.views(patient.id) };
  }

  /** One of the signed-in patient's appointments; another patient's appointment is a 404. */
  @Get('/api/me/appointments/:id')
  appointment(@PathParam() id: string, ctx: RequestContext): AppointmentView | HttpResponse {
    const patient = currentPatient(ctx);
    if (!patient) throw new HttpError(401, 'Not signed in');
    const a = this.records.appointmentOf(AS_PORTAL, patient.id, id);
    if (!a || a.status !== 'booked') return HttpResponse.notFound('Appointment not found');
    return this.view(a);
  }

  views(patientId: string): AppointmentView[] {
    return this.records.appointmentsOf(AS_PORTAL, patientId).map((a) => this.view(a));
  }

  private view(a: { id: string; clinicianId: string; date: string; time: string; startsAt: string; reason: string }): AppointmentView {
    const c = clinicianById(a.clinicianId);
    return {
      id: a.id,
      clinician: c?.name ?? a.clinicianId,
      role: c?.role ?? '',
      dateLabel: dateLabel(a.date),
      timeLabel: timeLabel(a.time),
      startsAt: a.startsAt,
      reason: a.reason,
      within24h: Date.parse(a.startsAt) - this.clock.now().getTime() < 24 * 3600_000,
    };
  }
}
