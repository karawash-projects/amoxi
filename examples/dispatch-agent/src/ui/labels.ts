/** Display names and formatting shared by pages and islands (browser-safe, no server imports). */

export const TOOL_LABELS: Record<string, string> = {
  list_unassigned_shipments: 'Unassigned shipments',
  fleet_status: 'Fleet status',
  plan_routes: 'Route optimisation',
  assign_plan: 'Assign plan to trucks',
  notify_drivers: 'Text drivers',
  capacity_quote: 'Capacity quote',
  track_shipment: 'Shipment tracking',
  assess_vehicle_incident: 'Incident assessment',
  reassign_shipments: 'Move freight to recovery truck',
  post_ops_alert: 'Ops board alert',
};

export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name.replace(/_/g, ' ');

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const VEHICLE_STATUS: Record<string, string> = {
  available: 'At depot',
  on_route: 'On route',
  maintenance: 'In the shop',
  breakdown: 'Broken down',
};

export const VEHICLE_KIND: Record<string, string> = {
  dry_van: '53 ft dry van',
  reefer: '53 ft reefer',
  straight_truck: 'Straight truck',
};

export const SOURCE_LABELS: Record<string, string> = {
  dispatcher: 'Dispatcher',
  telematics: 'Telematics event',
  schedule: 'Schedule',
  partner: 'Partner agent',
};

/** "1 stop", "3 stops". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function hoursText(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-CA')}.${String(abs % 100).padStart(2, '0')}`;
}

/** "3 min ago" from an ISO time, relative to `now` (ms). */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** "14:05" in the viewer's time zone. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Mon 19 Oct" for a yyyy-mm-dd date. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getDay()]} ${d} ${months[m - 1]}`;
}

/** Short summary of a tool's input for the step row, e.g. "Toronto, 2026-10-19". */
export function inputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.values(input as Record<string, unknown>)
    .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map((v) => (typeof v === 'boolean' ? '' : String(v)))
    .filter(Boolean)
    .join(', ')
    .slice(0, 80);
}
