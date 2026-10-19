import { day, money } from '../ui/format';

/** @generative Shows a started return: the return code to show at the parcel counter, the refund amount and the drop-off deadline */
export default function ReturnReceipt(props: {
  returnId: string;
  orderId: string;
  refundCents: number;
  lines: Array<{ name: string; option: string; quantity: number }>;
  /** yyyy-mm-dd */
  dropOffBy: string;
  instructions: string;
  reason?: string;
}) {
  return (
    <section class="returncard" aria-label={`Return ${props.returnId}`}>
      <div class="returncard-code">
        <span class="muted">Return code</span>
        <strong>{props.returnId}</strong>
        <span class="muted">for order {props.orderId}</span>
      </div>
      <div class="returncard-body">
        <p>
          Refund <strong>{money(props.refundCents)}</strong> once the parcel is scanned. Drop it off by <strong>{day(`${props.dropOffBy}T12:00:00Z`)}</strong>.
        </p>
        <ul>
          {props.lines.map((l) => (
            <li>
              {l.quantity} × {l.name} <span class="muted">({l.option})</span>
            </li>
          ))}
        </ul>
        {props.reason ? <p class="muted">Reason: {props.reason}</p> : null}
        <p class="muted small">{props.instructions}</p>
      </div>
    </section>
  );
}
