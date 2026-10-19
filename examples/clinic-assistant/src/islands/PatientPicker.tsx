import { navigate, signal } from 'amoxi';

interface DemoPatient {
  readonly id: string;
  readonly name: string;
  readonly dobLabel: string;
  readonly note: string;
}

/** "Continue as demo patient": starts a demo session (production uses the clinic's patient portal login). */
export default function PatientPicker(props: { patients: DemoPatient[]; next: string }) {
  const [busy, setBusy] = signal<string | undefined>(undefined);
  const [error, setError] = signal<string | undefined>(undefined);

  const choose = async (id: string): Promise<void> => {
    setBusy(id);
    setError(undefined);
    try {
      const res = await fetch('/session/demo-patient', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patientId: id }) });
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
      navigate(props.next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(undefined);
    }
  };

  return (
    <div class="picker">
      <ul class="picker-list">
        {props.patients.map((p) => (
          <li class="picker-card">
            <span class="avatar avatar-patient" aria-hidden="true">
              {p.name
                .split(' ')
                .map((w) => w[0])
                .join('')}
            </span>
            <div class="picker-who">
              <p class="picker-name">{p.name}</p>
              <p class="picker-meta">
                {p.id}, born {p.dobLabel}
              </p>
              <p class="picker-note">{p.note}</p>
            </div>
            <button type="button" class="btn btn-primary" disabled={() => busy() !== undefined} onClick={() => void choose(p.id)}>
              {() => (busy() === p.id ? 'Opening…' : `Continue as ${p.name.split(' ')[0]}`)}
            </button>
          </li>
        ))}
      </ul>
      {() => error() && <p class="chat-error" role="alert">{error()}</p>}
    </div>
  );
}
