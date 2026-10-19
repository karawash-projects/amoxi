import { createHmac } from 'node:crypto';
import { Singleton, Value } from 'amoxi';
import type { AccessEntry } from '../domain/types';
import type { Clock } from './clock';

/** Who touched a patient's data and why. Passed as the first argument of every audited PatientRecords method. */
export interface Access {
  readonly actor: AccessEntry['actor'];
  readonly purpose: string;
}

/**
 * Append-only privacy log. Patients are identified by a keyed hash of their id (a pseudonym),
 * so the log can be shipped to analytics or a SIEM without names, dates of birth or chart numbers.
 */
@Singleton()
export class AccessLog {
  private readonly entries: AccessEntry[] = [];
  private seq = 0;

  constructor(
    private readonly clock: Clock,
    @Value('${clinic.pseudonym-key}') private readonly key: string,
  ) {}

  /** Stable pseudonym of a patient id, e.g. "pt-3f9a0c41d2". */
  pseudonym(patientId: string): string {
    return `pt-${createHmac('sha256', this.key).update(patientId.trim().toUpperCase()).digest('hex').slice(0, 10)}`;
  }

  record(patientId: string, access: Access, action: string, outcome: AccessEntry['outcome']): AccessEntry {
    const entry: AccessEntry = { seq: ++this.seq, at: this.clock.now().toISOString(), subject: this.pseudonym(patientId), actor: access.actor, action, purpose: access.purpose, outcome };
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.shift();
    return entry;
  }

  /** A patient's own entries, newest first. */
  forPatient(patientId: string): AccessEntry[] {
    const subject = this.pseudonym(patientId);
    return this.entries.filter((e) => e.subject === subject).reverse();
  }

  all(): readonly AccessEntry[] {
    return this.entries;
  }
}
