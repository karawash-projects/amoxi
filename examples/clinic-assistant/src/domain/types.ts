/** Shared domain types. Pure: islands import these too. */

export type Specialty = 'family' | 'pediatrics' | 'dermatology' | 'womens-health' | 'mental-health' | 'nursing';

export type Language = 'english' | 'french' | 'spanish' | 'mandarin' | 'cantonese' | 'tamil' | 'hindi' | 'polish' | 'persian' | 'arabic';

export interface Clinician {
  readonly id: string;
  readonly name: string;
  /** "Family physician", "Nurse practitioner"... */
  readonly role: string;
  readonly specialty: Specialty;
  readonly languages: readonly Language[];
  readonly pronouns: string;
  readonly bio: string;
  readonly focus: readonly string[];
  /** Weekdays worked (1 = Monday ... 6 = Saturday). */
  readonly days: readonly number[];
  readonly accepting: boolean;
  /** Visit length in minutes. */
  readonly visitMinutes: number;
  readonly room: string;
}

export interface Patient {
  readonly id: string;
  readonly name: string;
  /** ISO date of birth (fictional). */
  readonly dob: string;
  readonly preferredLanguage: Language;
}

export interface Slot {
  /** S-<clinician number>-<yyyymmdd>-<hhmm>, e.g. S-101-20261020-0930. */
  readonly id: string;
  readonly clinicianId: string;
  /** Local (Toronto) date, yyyy-mm-dd. */
  readonly date: string;
  /** Local time, HH:MM (24 h). */
  readonly time: string;
  /** UTC instant. */
  readonly startsAt: string;
  readonly minutes: number;
}

export interface Appointment {
  readonly id: string;
  readonly patientId: string;
  readonly clinicianId: string;
  readonly slotId: string;
  readonly startsAt: string;
  readonly date: string;
  readonly time: string;
  readonly minutes: number;
  readonly reason: string;
  status: 'booked' | 'cancelled';
  readonly bookedAt: string;
  readonly bookedBy: 'assistant' | 'front-desk';
  cancelledAt?: string;
  lateCancellation?: boolean;
}

export interface Referral {
  readonly id: string;
  /** As sent by the partner; matched by clinic staff, never echoed back with details. */
  readonly patientId: string;
  readonly specialty: Specialty;
  readonly reason: string;
  readonly from: string;
  readonly receivedAt: string;
  readonly status: 'received';
}

/** One line of the privacy access log. Pseudonymous: no names, no dates of birth, no raw ids. */
export interface AccessEntry {
  readonly seq: number;
  readonly at: string;
  /** Keyed hash of the patient id. */
  readonly subject: string;
  readonly actor: 'assistant' | 'patient-portal' | 'partner-agent' | 'front-desk';
  readonly action: string;
  readonly purpose: string;
  readonly outcome: 'ok' | 'refused';
}

/** Who is asking, captured when a run starts (see ClinicAssistant.principal). */
export type Identity = { readonly kind: 'patient'; readonly patientId: string } | { readonly kind: 'partner'; readonly partner: string } | { readonly kind: 'anonymous' };

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  family: 'Family medicine',
  pediatrics: 'Pediatrics',
  dermatology: 'Dermatology',
  'womens-health': "Women's health",
  'mental-health': 'Mental health',
  nursing: 'Nursing clinic',
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  english: 'English',
  french: 'French',
  spanish: 'Spanish',
  mandarin: 'Mandarin',
  cantonese: 'Cantonese',
  tamil: 'Tamil',
  hindi: 'Hindi',
  polish: 'Polish',
  persian: 'Persian',
  arabic: 'Arabic',
};
