import { initialsOf } from '../domain/clinic-data';
import { askAssistant, type ClinicianCardsProps } from '../ui/cards';

/** @generative Shows Demo Clinic clinicians as cards: role, languages, focus, whether they accept new patients and their next open day, with a button to see open times. */
export default function ClinicianCards(props: ClinicianCardsProps) {
  return (
    <section class="gen gen-clinicians" aria-label={props.title}>
      <h3 class="gen-title">{props.title}</h3>
      <ul class="clin-grid">
        {props.clinicians.map((c) => (
          <li class="clin-card">
            <div class="clin-head">
              <span class={`avatar spec-${c.specialty.toLowerCase().replace(/[^a-z]+/g, '-')}`} aria-hidden="true">
                {initialsOf(c.name)}
              </span>
              <div>
                <a class="clin-name" href={`/clinicians/${c.id}`}>
                  {c.name}
                </a>
                <p class="clin-role">{c.role}</p>
              </div>
            </div>
            <p class="clin-langs">
              <span class="sr-only">Speaks </span>
              {c.languages.join(', ')}
            </p>
            <p class="clin-focus">{c.focus.join(' / ')}</p>
            <div class="clin-foot">
              {c.accepting ? (
                <span class="clin-next">{c.nextOpenLabel ? `Next opening ${c.nextOpenLabel}` : 'No openings in the next two weeks'}</span>
              ) : (
                <span class="clin-next muted">Not accepting new patients</span>
              )}
              {c.accepting && c.nextOpenDate && (
                <button type="button" class="btn btn-small" onClick={() => askAssistant(`Show available slots for ${c.id} on ${c.nextOpenDate}`)}>
                  See open times
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
