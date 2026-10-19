/** Props of the generative components (validated by Amoxi against these types) and the browser events that connect them. */

export interface ClinicianCard {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly specialty: string;
  readonly languages: string[];
  readonly accepting: boolean;
  readonly focus: string[];
  /** yyyy-mm-dd of the next open time, when there is one in the next two weeks. */
  readonly nextOpenDate?: string;
  readonly nextOpenLabel?: string;
}

export interface ClinicianCardsProps {
  readonly title: string;
  readonly clinicians: ClinicianCard[];
}

export interface SlotPickerProps {
  readonly clinicianId: string;
  readonly clinicianName: string;
  readonly role: string;
  /** yyyy-mm-dd */
  readonly date: string;
  readonly dateLabel: string;
  readonly note?: string;
  readonly slots: Array<{ id: string; time: string; label: string }>;
  /** Other days with open times, for quick switching. */
  readonly otherDays: Array<{ date: string; label: string }>;
}

export interface AppointmentConfirmationProps {
  readonly appointmentId: string;
  readonly clinicianName: string;
  readonly role: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
  readonly minutes: number;
  readonly location: string;
  readonly reason: string;
  readonly preparation: string[];
  /** "Cancel before Monday, Oct 19 at 9:30 AM to avoid the late fee." */
  readonly cancelBy: string;
}

export interface UrgentCareNoticeProps {
  readonly level: 'emergency' | 'urgent';
  readonly headline: string;
  readonly actions: string[];
  readonly redFlags: string[];
  /** '911' or '988' */
  readonly callNumber?: string;
  readonly disclaimer: string;
}

/** Event a component dispatches on document to send a message in the chat: detail { text }. */
export const ASK_EVENT = 'demo-clinic:ask';
/** Event the chat dispatches after a booking or cancellation, so side panels refresh. */
export const CHANGED_EVENT = 'demo-clinic:changed';

/** Sends a message to the assistant from any island on the page. */
export function askAssistant(text: string): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text } }));
}

/** What the side panel shows for an appointment. */
export interface AppointmentView {
  readonly id: string;
  readonly clinician: string;
  readonly role: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
  readonly startsAt: string;
  readonly reason: string;
  readonly within24h: boolean;
}
