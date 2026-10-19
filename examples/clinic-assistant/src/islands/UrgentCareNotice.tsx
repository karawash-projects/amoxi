import type { UrgentCareNoticeProps } from '../ui/cards';

/** @generative Shows an urgent-care or emergency notice after the symptom safety screen: what to do now (call 911, 9-8-8, same-day visit), the red flags mentioned, and that it is not a diagnosis. */
export default function UrgentCareNotice(props: UrgentCareNoticeProps) {
  const emergency = props.level === 'emergency';
  const crisis = props.callNumber === '988';
  return (
    <section class={`gen notice notice-${props.level}`} role={emergency ? 'alert' : 'status'} aria-label={props.headline}>
      <div class="notice-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 3 2.5 20h19L12 3Z" />
          <path d="M12 10v4.5M12 17.2v.1" />
        </svg>
      </div>
      <div class="notice-body">
        <h3 class="notice-headline">{props.headline}</h3>
        <ul class="notice-actions">
          {props.actions.map((a) => (
            <li>{a}</li>
          ))}
        </ul>
        {emergency && (
          <div class="notice-calls">
            <a class="btn btn-emergency" href="tel:911">
              Call 911
            </a>
            {crisis && (
              <a class="btn btn-crisis" href="tel:988">
                Call or text 9-8-8
              </a>
            )}
          </div>
        )}
        {props.redFlags.length > 0 && <p class="notice-flags">What you mentioned: {props.redFlags.join('; ')}.</p>}
        <p class="notice-disclaimer">{props.disclaimer}</p>
      </div>
    </section>
  );
}
