import type { Clinician, Patient } from './types';

/** Fictional clinic, people and policies. Pure data: pages, islands and tools share it. */

export const CLINIC = {
  name: 'Demo Clinic',
  address: '418 Larkvane Lane, Toronto, ON',
  phone: '416-555-0142',
  site: 'Main floor, Demo Clinic building',
} as const;

/** Opening hours by weekday (0 = Sunday). */
export const HOURS: ReadonlyArray<{ readonly day: number; readonly open?: string; readonly close?: string }> = [
  { day: 1, open: '08:30', close: '18:00' },
  { day: 2, open: '08:30', close: '18:00' },
  { day: 3, open: '08:30', close: '19:30' },
  { day: 4, open: '08:30', close: '18:00' },
  { day: 5, open: '08:30', close: '16:30' },
  { day: 6, open: '09:00', close: '13:00' },
  { day: 0 },
];

export const CLINICIANS: readonly Clinician[] = [
  {
    id: 'DR-101',
    name: 'Dr. Amara Obrelle',
    role: 'Family physician',
    specialty: 'family',
    languages: ['english', 'french'],
    pronouns: 'she/her',
    bio: 'Twelve years in family practice, with a particular interest in preventive care, chronic-condition follow-up and care for newcomers to Canada.',
    focus: ['Annual physicals', 'Chronic-condition follow-up', 'Newcomer health'],
    days: [1, 2, 3, 5],
    accepting: true,
    visitMinutes: 30,
    room: 'Room 2',
  },
  {
    id: 'DR-102',
    name: 'Dr. Daniel Reyes-Varenwold',
    role: 'Family physician',
    specialty: 'family',
    languages: ['english', 'spanish'],
    pronouns: 'he/him',
    bio: 'Family physician who also leads the clinic’s sports-injury and travel-health appointments. Runs the Saturday morning clinic.',
    focus: ['Sports injuries', 'Travel health', 'Men’s health'],
    days: [1, 3, 4, 6],
    accepting: true,
    visitMinutes: 30,
    room: 'Room 3',
  },
  {
    id: 'DR-103',
    name: 'Dr. Mei-Lin Tsaoray',
    role: 'Pediatrician',
    specialty: 'pediatrics',
    languages: ['english', 'mandarin', 'cantonese'],
    pronouns: 'she/her',
    bio: 'Sees babies, children and teens: well-baby checks, growth and development, school forms and childhood vaccinations.',
    focus: ['Well-baby checks', 'Child development', 'Teen health'],
    days: [2, 3, 4],
    accepting: true,
    visitMinutes: 30,
    room: 'Room 5 (family room)',
  },
  {
    id: 'DR-104',
    name: 'Dr. Farid Haddavane',
    role: 'Dermatologist (visiting)',
    specialty: 'dermatology',
    languages: ['english', 'persian', 'french'],
    pronouns: 'he/him',
    bio: 'Visiting dermatologist two days a week. Sees patients by referral from a Demo Clinic clinician or a partner organisation.',
    focus: ['Skin checks', 'Eczema and acne', 'Referral consultations'],
    days: [2, 4],
    accepting: true,
    visitMinutes: 20,
    room: 'Room 6',
  },
  {
    id: 'NP-105',
    name: 'Priya Ravelund, NP',
    role: 'Nurse practitioner',
    specialty: 'womens-health',
    languages: ['english', 'tamil', 'hindi'],
    pronouns: 'she/her',
    bio: 'Nurse practitioner focused on women’s health, contraception counselling, cervical screening and prenatal check-ins.',
    focus: ['Cervical screening', 'Contraception', 'Prenatal check-ins'],
    days: [1, 2, 4, 5],
    accepting: true,
    visitMinutes: 30,
    room: 'Room 4',
  },
  {
    id: 'DR-106',
    name: 'Dr. Tomasz Wierzbolan',
    role: 'Family physician, mental health focus',
    specialty: 'mental-health',
    languages: ['english', 'polish'],
    pronouns: 'he/him',
    bio: 'Family physician with additional training in mental health. Offers longer appointments for anxiety, low mood and sleep concerns.',
    focus: ['Anxiety and low mood', 'Sleep', 'Stress and burnout'],
    days: [1, 3, 5],
    accepting: false,
    visitMinutes: 45,
    room: 'Room 1 (quiet room)',
  },
  {
    id: 'RN-107',
    name: 'Grace Mensavor, RN',
    role: 'Registered nurse',
    specialty: 'nursing',
    languages: ['english', 'french', 'arabic'],
    pronouns: 'she/her',
    bio: 'Runs the nursing clinic: blood tests, vaccinations and flu shots, blood-pressure checks and wound care.',
    focus: ['Blood tests', 'Vaccinations and flu shots', 'Blood-pressure checks'],
    days: [1, 2, 3, 4, 5, 6],
    accepting: true,
    visitMinutes: 15,
    room: 'Nursing station',
  },
];

/** Fictional demo patients. In production identity comes from the clinic's patient portal login. */
export const PATIENTS: readonly Patient[] = [
  { id: 'P-1001', name: 'Jordan Averlin', dob: '1988-04-12', preferredLanguage: 'english' },
  { id: 'P-1002', name: 'Samira Elbarenne', dob: '1975-09-30', preferredLanguage: 'french' },
];

export function clinicianById(id: string): Clinician | undefined {
  const key = id.trim().toUpperCase();
  return CLINICIANS.find((c) => c.id === key || c.id.slice(3) === key);
}

/** "101" → DR-101 (the number used in slot ids). */
export function clinicianByNumber(n: string): Clinician | undefined {
  return CLINICIANS.find((c) => c.id.slice(3) === n);
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/^Dr\.\s+/, '')
    .replace(/,.*$/, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/** A clinic policy: shown on /policies and ingested into the 'clinic' knowledge base for the assistant. */
export interface PolicySection {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Short paragraphs (each under ~220 characters, so each is one searchable passage). */
  readonly points: readonly string[];
}

export const POLICIES: readonly PolicySection[] = [
  {
    id: 'cancellation',
    title: 'Cancellation and missed appointments',
    summary: 'Cancel at least 24 hours ahead so someone else can have the time.',
    points: [
      'Cancellation policy: please cancel at least 24 hours before your appointment, in the assistant, the portal or by phone.',
      'Late cancellation (less than 24 hours notice) or a missed appointment may carry a $40 fee for uninsured services. It is waived once a year and always waived if you are unwell.',
      'Cancelling never affects your care. If you cancel because you feel worse, tell us so we can offer an urgent same-day visit instead.',
    ],
  },
  {
    id: 'blood-tests',
    title: 'Blood tests: how to prepare',
    summary: 'Most blood tests need no preparation; fasting tests need 8 to 12 hours without food.',
    points: [
      'To prepare for a blood test: most tests need no preparation. Drink water as usual, since being hydrated makes the draw easier.',
      'Fasting blood tests (some cholesterol and glucose tests): no food for 8 to 12 hours before. Water is fine. Your requisition says if fasting is needed.',
      'Bring your requisition form and health card to the nursing clinic. Keep taking your usual medicines unless your clinician told you otherwise.',
      'Blood test results go to the clinician who ordered them, usually within 3 to 5 business days. We call you if anything needs follow-up.',
    ],
  },
  {
    id: 'vaccinations',
    title: 'Vaccinations and flu shots',
    summary: 'Flu shots and routine vaccinations are given at the nursing clinic, by appointment.',
    points: [
      'Vaccinations: the nursing clinic gives routine adult and childhood vaccinations and seasonal flu shots by appointment with Grace Mensavor, RN.',
      'Bring your vaccination record if you have one. Plan to wait 15 minutes after a vaccine so the nurse can check you feel well.',
      'Travel vaccines need an appointment with Dr. Reyes-Varenwold at least 6 weeks before you leave.',
    ],
  },
  {
    id: 'prescriptions',
    title: 'Prescription renewals',
    summary: 'Renewals need 3 business days and are reviewed by your clinician.',
    points: [
      'Prescription renewal: ask your pharmacy to send a renewal request, or request one at the front desk. Allow 3 business days.',
      'Your clinician reviews every renewal. Some medicines need a visit first, for example when tests or a blood-pressure check are due.',
      'The assistant cannot prescribe, renew or recommend medicines or doses. It can book you a visit with your clinician.',
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy and your health information',
    summary: 'Your record is used only for your care; every access is logged and visible to you.',
    points: [
      'Privacy: your health information is used only to provide your care. Every time the assistant or a partner touches your record, it is logged.',
      'You can see who accessed your data on the "Who accessed my data" page. The log uses a pseudonymous code, never your name.',
      'The assistant remembers only preferences you ask it to keep, such as a preferred clinician or language. It never remembers symptoms or health details.',
      'Partner organisations can send referrals but cannot read your record through the assistant.',
    ],
  },
  {
    id: 'coverage',
    title: 'Coverage and fees',
    summary: 'Insured visits are covered by your ProvinceCare health card (fictional plan).',
    points: [
      'Insurance and coverage: visits that are medically necessary are covered by your ProvinceCare health card (a fictional provincial plan in this demo).',
      'Uninsured services, such as sick notes, forms for work or school, and travel consultations, have fees listed at the front desk. Private insurance may reimburse them.',
      'Bring your health card to every visit. If it has expired, we can still see you; the front desk will explain the options.',
    ],
  },
  {
    id: 'urgent',
    title: 'Emergencies and urgent care',
    summary: 'The clinic is not an emergency department. Call 911 for emergencies.',
    points: [
      'Emergencies: call 911 or go to the nearest emergency department for chest pain, trouble breathing, signs of stroke, severe bleeding or thoughts of suicide.',
      'For thoughts of suicide or a mental-health crisis you can also call or text 9-8-8 at any time.',
      'Same-day urgent visits are held back every weekday morning. Ask the assistant or call the front desk at 416-555-0142.',
    ],
  },
  {
    id: 'visits',
    title: 'Before your visit',
    summary: 'Arrive 10 minutes early with your health card and a list of your medicines.',
    points: [
      'Before your visit: arrive 10 minutes early, bring your health card and a list of medicines you take.',
      'Interpretation: tell us your preferred language. Several clinicians speak French, Spanish, Mandarin, Cantonese, Tamil, Hindi, Polish, Persian or Arabic.',
    ],
  },
];
