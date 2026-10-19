import { Singleton, type Invocation, type MethodInterceptor } from 'amoxi';
import { AccessLog, type Access } from './access-log';

/** What each audited method means, in words a patient understands. */
const ACTIONS: Record<string, string> = {
  appointmentsOf: 'Viewed your upcoming appointments',
  appointmentOf: 'Viewed one of your appointments',
  book: 'Booked an appointment',
  cancel: 'Cancelled an appointment',
  receiveReferral: 'Sent a referral request',
  referralsOf: 'Viewed referral requests',
};

/**
 * AOP: every PatientRecords method marked @Intercept(AccessAuditInterceptor) is logged with the
 * actor, purpose and outcome, keyed by a pseudonym. The service code stays free of logging calls,
 * and a new method can't forget to audit itself.
 */
@Singleton()
export class AccessAuditInterceptor implements MethodInterceptor {
  constructor(private readonly log: AccessLog) {}

  intercept(invocation: Invocation): unknown {
    const access = invocation.args[0] as Access | undefined;
    const patientId = invocation.args[1];
    if (!access || typeof patientId !== 'string') return invocation.proceed();
    const action = ACTIONS[invocation.method] ?? invocation.method;
    let result: unknown;
    try {
      result = invocation.proceed();
    } catch (err) {
      this.log.record(patientId, access, action, 'refused');
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          this.log.record(patientId, access, action, 'ok');
          return v;
        },
        (err) => {
          this.log.record(patientId, access, action, 'refused');
          throw err;
        },
      );
    }
    this.log.record(patientId, access, action, 'ok');
    return result;
  }
}
