import { navigate, signal } from 'amoxi';

interface Choice {
  id: string;
  name: string;
  city: string;
  since: number;
  persona: string;
}

/** Demo sign-in: choose one of the fictional customers. */
export default function SignIn(props: { customers: Choice[]; next?: string }) {
  const [busy, setBusy] = signal<string | undefined>(undefined);
  const [error, setError] = signal('');

  const choose = async (id: string): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: id, ...(props.next ? { next: props.next } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { next?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `The bank answered ${res.status}`);
      await navigate(data.next ?? '/assistant');
    } catch (err) {
      setError(`Sign-in failed: ${(err as Error).message}. Try again.`);
      setBusy(undefined);
    }
  };

  return (
    <div class="signin-choices">
      <ul>
        {props.customers.map((c) => (
          <li>
            <button type="button" class="customer-choice" onClick={() => void choose(c.id)} disabled={() => busy() !== undefined} aria-describedby={`persona-${c.id}`}>
              <span class="choice-initials" aria-hidden="true">
                {c.name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')}
              </span>
              <span class="choice-text">
                <span class="choice-name">{c.name}</span>
                <span class="ledger-sub">
                  {c.city}, customer since {c.since}
                </span>
                <span class="choice-persona" id={`persona-${c.id}`}>
                  {c.persona}
                </span>
              </span>
              <span class="choice-go">{() => (busy() === c.id ? 'Signing in…' : 'Sign in')}</span>
            </button>
          </li>
        ))}
      </ul>
      <p class="form-error" role="alert">
        {error}
      </p>
    </div>
  );
}
