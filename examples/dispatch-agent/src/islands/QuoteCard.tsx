import { dayLabel, money } from '../ui/labels';

/** @generative Shows a linehaul capacity quote: lane, price in CAD, pickup and delivery dates, and whether there is room on the pickup date */
export default function QuoteCard(props: {
  quoteId: string;
  lane: string;
  pickupDate: string;
  deliverBy: string;
  pallets: number;
  weightKg: number;
  refrigerated: boolean;
  capacityAvailable: boolean;
  sparePallets: number;
  earliestPickupDate: string;
  priceCents: number;
  currency: string;
  validUntil: string;
}) {
  const [from, to] = props.lane.split('-');
  return (
    <article class={props.capacityAvailable ? 'quote' : 'quote quote-full'} aria-label={`Capacity quote ${props.quoteId}`}>
      <div class="quote-lane">
        <span class="quote-city">{from}</span>
        <svg viewBox="0 0 120 12" aria-hidden="true" preserveAspectRatio="none">
          <path d="M2 6H112" />
          <path d="M106 1.5 113 6 106 10.5" />
        </svg>
        <span class="quote-city">{to}</span>
      </div>
      <div class="quote-price">
        <span class="quote-amount">{money(props.priceCents)}</span>
        <span class="quote-cur">{props.currency}, fuel included</span>
      </div>
      <dl class="quote-facts">
        <div>
          <dt>Load</dt>
          <dd>
            {props.pallets} pallets, {props.weightKg.toLocaleString('en-CA')} kg{props.refrigerated ? ', reefer' : ''}
          </dd>
        </div>
        <div>
          <dt>Pickup</dt>
          <dd>{dayLabel(props.pickupDate)}</dd>
        </div>
        <div>
          <dt>Deliver by</dt>
          <dd>{dayLabel(props.deliverBy)}</dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd>{props.capacityAvailable ? `${props.sparePallets} pallets free that day` : `Full that day; earliest ${dayLabel(props.earliestPickupDate)}`}</dd>
        </div>
      </dl>
      <p class="quote-foot">
        Quote {props.quoteId}, valid until {dayLabel(props.validUntil)}
      </p>
    </article>
  );
}
