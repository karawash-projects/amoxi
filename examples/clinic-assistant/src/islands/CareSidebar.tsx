import { onMount, signal } from 'amoxi';
import { askAssistant, CHANGED_EVENT, type AppointmentView } from '../ui/cards';

/** The patient's upcoming appointments beside the conversation; refreshes after the assistant books or cancels. */
export default function CareSidebar(props: { appointments: AppointmentView[] }) {
  const [list, setList] = signal<AppointmentView[]>(props.appointments);
  const [fresh, setFresh] = signal<string | undefined>(undefined);

  onMount(() => {
    const reload = (): void => {
      void fetch('/api/me/appointments', { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((body: { appointments: AppointmentView[] } | undefined) => {
          if (!body) return;
          const known = new Set(list().map((a) => a.id));
          setFresh(body.appointments.find((a) => !known.has(a.id))?.id);
          setList(body.appointments);
        })
        .catch(() => undefined);
    };
    document.addEventListener(CHANGED_EVENT, reload);
    return () => document.removeEventListener(CHANGED_EVENT, reload);
  });

  return (
    <section class="panel" aria-labelledby="appts-title">
      <h2 id="appts-title" class="panel-title">
        Upcoming appointments
      </h2>
      {() =>
        list().length === 0 ? (
          <p class="panel-empty">No upcoming appointments. Ask the assistant for open times.</p>
        ) : (
          <ul class="appts">
            {list().map((a) => (
              <li class={fresh() === a.id ? 'appt appt-new' : 'appt'}>
                <div class="appt-when">
                  <span class="appt-date">{a.dateLabel}</span>
                  <span class="appt-time">{a.timeLabel}</span>
                </div>
                <p class="appt-who">{a.clinician}</p>
                <p class="appt-why">
                  {a.reason} <span class="appt-id">{a.id}</span>
                </p>
                {a.within24h && <p class="appt-soon">Within 24 hours</p>}
                <button type="button" class="link-btn" onClick={() => askAssistant(`Cancel appointment ${a.id}`)}>
                  Cancel {a.id}
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </section>
  );
}
