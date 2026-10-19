import type { RequestContext } from 'amoxi';
import { PATIENTS } from '../domain/clinic-data';
import type { Patient } from '../domain/types';

/** Session key holding the signed-in (demo) patient id. In production this comes from the patient portal's login. */
export const PATIENT_SESSION_KEY = 'patientId';

export function currentPatient(ctx: RequestContext): Patient | undefined {
  const id = ctx.session.get<string>(PATIENT_SESSION_KEY);
  return typeof id === 'string' ? PATIENTS.find((p) => p.id === id) : undefined;
}
