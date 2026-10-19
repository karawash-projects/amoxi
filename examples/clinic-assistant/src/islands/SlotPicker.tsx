import { signal } from 'amoxi';
import { askAssistant, type SlotPickerProps } from '../ui/cards';

/** @generative Shows a clinician's open appointment times for one day as a picker; choosing a time asks the assistant to book it (the patient then confirms). */
export default function SlotPicker(props: SlotPickerProps) {
  const [chosen, setChosen] = signal<string | undefined>(undefined);
  const morning = props.slots.filter((s) => s.time < '12:00');
  const afternoon = props.slots.filter((s) => s.time >= '12:00');

  const pick = (id: string): void => {
    setChosen(id);
    askAssistant(`Book appointment slot ${id}`);
  };

  const group = (label: string, list: SlotPickerProps['slots']) =>
    list.length > 0 && (
      <div class="slot-group" role="group" aria-label={`${label} times`}>
        <span class="slot-group-label">{label}</span>
        <div class="slot-row">
          {list.map((s) => (
            <button type="button" class={() => (chosen() === s.id ? 'slot chosen' : 'slot')} aria-pressed={() => (chosen() === s.id ? 'true' : 'false')} onClick={() => pick(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <section class="gen gen-slots" aria-label={`Open times with ${props.clinicianName}`}>
      <header class="slots-head">
        <div>
          <h3 class="gen-title">{props.dateLabel}</h3>
          <p class="slots-who">
            {props.clinicianName}, {props.role}
          </p>
        </div>
        <span class="slots-count">{props.slots.length} open</span>
      </header>
      {props.note && <p class="slots-note">{props.note}</p>}
      {group('Morning', morning)}
      {group('Afternoon', afternoon)}
      <p class="slots-hint">Choosing a time asks you to confirm before anything is booked.</p>
      {props.otherDays.length > 0 && (
        <div class="slot-days">
          <span>Other days:</span>
          {props.otherDays.map((d) => (
            <button type="button" class="chip" onClick={() => askAssistant(`Show available slots for ${props.clinicianId} on ${d.date}`)}>
              {d.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
