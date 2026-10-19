import type { JsonValue } from 'amoxi/ai';
import type { Identity } from '../domain/types';

/**
 * Who a run acts for, from the principal captured when it started: a patient's runs carry their
 * id (from the session); runs started by partner agents over A2A carry { channel: 'a2a' } and act
 * as the referral desk's partner, never as a patient.
 */
export function identityOf(principal: JsonValue | undefined): Identity {
  if (typeof principal === 'string' && /^P-\d{4}$/.test(principal)) return { kind: 'patient', patientId: principal };
  if (principal && typeof principal === 'object' && !Array.isArray(principal) && principal.channel === 'a2a') return { kind: 'partner', partner: 'Partner agent (A2A)' };
  return { kind: 'anonymous' };
}
