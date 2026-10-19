import { Singleton } from 'amoxi';
import { CLINICIANS, HOURS, clinicianById, clinicianByNumber } from '../domain/clinic-data';
import { addDays, clinicInstant, clinicParts, dayName, slotIdOf, timeLabel, weekdayOf } from '../domain/time';
import type { Clinician, Language, Slot, Specialty } from '../domain/types';
import type { Clock } from './clock';

const LUNCH = ['12:00', '13:00'] as const;

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** FNV-1a, for deterministic "already booked by other patients" slots. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Clinicians, opening hours and the appointment grid. No patient data lives here. */
@Singleton()
export class ClinicDirectory {
  constructor(private readonly clock: Clock) {}

  clinicians(filter: { specialty?: Specialty; language?: Language } = {}): Clinician[] {
    return CLINICIANS.filter((c) => (!filter.specialty || c.specialty === filter.specialty) && (!filter.language || c.languages.includes(filter.language)));
  }

  clinician(id: string): Clinician | undefined {
    return clinicianById(id);
  }

  today(): string {
    return clinicParts(this.clock.now()).date;
  }

  hoursOn(date: string): { open: string; close: string } | undefined {
    const h = HOURS.find((x) => x.day === weekdayOf(date));
    return h?.open && h.close ? { open: h.open, close: h.close } : undefined;
  }

  /** "Open now until 6:00 PM" or "Closed, opens Monday at 8:30 AM". */
  openStatus(): { open: boolean; label: string } {
    const now = clinicParts(this.clock.now());
    const today = this.hoursOn(now.date);
    if (today && now.time >= today.open && now.time < today.close) return { open: true, label: `Open now until ${timeLabel(today.close)}` };
    for (let i = 0; i < 8; i++) {
      const date = addDays(now.date, i);
      const h = this.hoursOn(date);
      if (!h || (i === 0 && now.time >= h.open)) continue;
      return { open: false, label: `Closed, opens ${i === 0 ? 'today' : i === 1 ? 'tomorrow' : dayName(weekdayOf(date))} at ${timeLabel(h.open)}` };
    }
    return { open: false, label: 'Closed' };
  }

  /** Every position of a clinician's grid on a date (ignoring bookings and the clock). */
  grid(clinician: Clinician, date: string): Slot[] {
    const hours = this.hoursOn(date);
    if (!hours || !clinician.days.includes(weekdayOf(date))) return [];
    const out: Slot[] = [];
    const step = clinician.visitMinutes;
    const start = minutesOf(hours.open) + (clinician.specialty === 'nursing' ? 0 : 30);
    const end = minutesOf(hours.close) - 30;
    for (let m = start; m + step <= end; m += step) {
      const time = timeOf(m);
      if (m + step > minutesOf(LUNCH[0]) && m < minutesOf(LUNCH[1])) continue;
      out.push({ id: slotIdOf(clinician.id.slice(3), date, time), clinicianId: clinician.id, date, time, startsAt: clinicInstant(date, time).toISOString(), minutes: step });
    }
    return out;
  }

  /** A slot on the grid by id, or undefined when the id doesn't describe a real appointment time. */
  slot(id: string): Slot | undefined {
    const m = /^S-(\d{3})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(id.trim().toUpperCase());
    if (!m) return undefined;
    const clinician = clinicianByNumber(m[1]);
    if (!clinician) return undefined;
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    return this.grid(clinician, date).find((s) => s.id === id.trim().toUpperCase());
  }

  /** Slots other (fictional) patients already hold: deterministic, about half the grid. */
  heldByOthers(slotId: string): boolean {
    return hash(slotId) % 100 < 48;
  }

  /** Whether the slot starts far enough in the future to be booked online (30 minutes). */
  bookable(slot: Slot): boolean {
    return Date.parse(slot.startsAt) > this.clock.now().getTime() + 30 * 60_000;
  }
}
