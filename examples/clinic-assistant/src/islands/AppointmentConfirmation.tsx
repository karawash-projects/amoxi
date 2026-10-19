import type { AppointmentConfirmationProps } from '../ui/cards';

/** @generative Shows a booked appointment as a confirmation: clinician, date, time, place, how to prepare and the cancellation deadline. */
export default function AppointmentConfirmation(props: AppointmentConfirmationProps) {
  const [weekday, ...rest] = props.dateLabel.split(', ');
  return (
    <section class="gen gen-confirm" aria-label={`Appointment ${props.appointmentId} booked`}>
      <div class="confirm-date" aria-hidden="true">
        <span class="confirm-weekday">{weekday}</span>
        <span class="confirm-day">{rest.join(', ')}</span>
        <span class="confirm-time">{props.timeLabel}</span>
      </div>
      <div class="confirm-body">
        <p class="confirm-status">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10.5 8 14.5 16 6" />
          </svg>
          Booked, reference {props.appointmentId}
        </p>
        <h3 class="gen-title">
          {props.clinicianName}
          <span class="confirm-role">{props.role}</span>
        </h3>
        <dl class="confirm-facts">
          <dt>When</dt>
          <dd>
            {props.dateLabel} at {props.timeLabel} ({props.minutes} min)
          </dd>
          <dt>Where</dt>
          <dd>{props.location}</dd>
          <dt>For</dt>
          <dd>{props.reason}</dd>
        </dl>
        <h4>Before you come</h4>
        <ul class="confirm-prep">
          {props.preparation.map((p) => (
            <li>{p}</li>
          ))}
        </ul>
        <p class="confirm-cancel">{props.cancelBy}</p>
      </div>
    </section>
  );
}
