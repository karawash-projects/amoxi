/** Clinic time helpers. Everything the patient sees is in the clinic's zone, America/Toronto. Pure (islands use it). */

export const CLINIC_TZ = 'America/Toronto';

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local date (yyyy-mm-dd), time (HH:MM) and weekday (0 = Sunday) of an instant in Toronto. */
export function clinicParts(instant: Date): { date: string; time: string; weekday: number } {
  const p: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS[p.weekday] ?? 0 };
}

/** The UTC instant of a Toronto wall-clock date and time (handles daylight saving). */
export function clinicInstant(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // Toronto is UTC-4 or UTC-5: start from -5 and correct by the observed difference.
  let guess = wanted + 5 * 3600_000;
  for (let i = 0; i < 2; i++) {
    const seen = clinicParts(new Date(guess));
    const [sy, sm, sd] = seen.date.split('-').map(Number);
    const [sh, smin] = seen.time.split(':').map(Number);
    guess += wanted - Date.UTC(sy, sm - 1, sd, sh, smin);
  }
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tuesday, Oct 20" */
export function dateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${DAY_NAMES[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}`;
}

/** "Tue, Oct 20" */
export function shortDateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${DAY_NAMES[weekdayOf(date)].slice(0, 3)}, ${MONTHS[m - 1]} ${d}`;
}

/** "9:30 AM" */
export function timeLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function dayName(weekday: number): string {
  return DAY_NAMES[weekday] ?? '';
}

/** Decodes a slot id (S-101-20261020-0930) without a server round trip. */
export function parseSlotId(id: string): { clinicianId: string; date: string; time: string } | undefined {
  const m = /^S-(\d{3})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(id.trim());
  if (!m) return undefined;
  return { clinicianId: m[1], date: `${m[2]}-${m[3]}-${m[4]}`, time: `${m[5]}:${m[6]}` };
}

export function slotIdOf(clinicianNumber: string, date: string, time: string): string {
  return `S-${clinicianNumber}-${date.replace(/-/g, '')}-${time.replace(':', '')}`;
}
