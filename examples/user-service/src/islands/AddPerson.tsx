import { navigate, signal } from 'amoxi';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Add person" button plus its dialog; posts to the JSON API and opens the new person's page. */
export default function AddPerson() {
  let dialog!: HTMLDialogElement;
  let form!: HTMLFormElement;
  let nameInput!: HTMLInputElement;
  let emailInput!: HTMLInputElement;
  const [error, setError] = signal('');
  const [invalid, setInvalid] = signal<'name' | 'email' | null>(null);
  const [busy, setBusy] = signal(false);

  const open = (): void => {
    form.reset();
    setError('');
    setInvalid(null);
    dialog.showModal();
    nameInput.focus();
  };

  const fail = (field: 'name' | 'email', message: string): void => {
    setInvalid(field);
    setError(message);
    (field === 'name' ? nameInput : emailInput).focus();
  };

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setInvalid(null);
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    if (!name) return fail('name', 'Enter a name.');
    if (!EMAIL.test(email)) return fail('email', 'Enter a valid email address, like ada@example.com.');

    setBusy(true);
    try {
      const res = await fetch('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: number; error?: string; details?: Array<{ path: string; message: string }> };
      if (!res.ok) {
        const detail = data.details?.[0];
        throw new Error(detail ? `${detail.path === 'email' ? 'Email' : 'Name'} ${detail.message}.` : (data.error ?? `The server answered with status ${res.status}.`));
      }
      dialog.close();
      setBusy(false);
      await navigate(`/people/${data.id}?flash=added`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <button class="btn primary" type="button" onClick={open}>
        Add person
      </button>
      <dialog
        ref={(el: HTMLDialogElement) => (dialog = el)}
        aria-labelledby="add-title"
        onClick={(e: MouseEvent) => e.target === dialog && dialog.close()}
      >
        <form ref={(el: HTMLFormElement) => (form = el)} novalidate onSubmit={submit}>
          <h2 id="add-title">Add person</h2>
          <label for="add-name">Name</label>
          <input
            id="add-name"
            ref={(el: HTMLInputElement) => (nameInput = el)}
            autocomplete="name"
            maxlength="80"
            required
            aria-invalid={() => (invalid() === 'name' ? 'true' : undefined)}
          />
          <label for="add-email">Email</label>
          <input
            id="add-email"
            ref={(el: HTMLInputElement) => (emailInput = el)}
            type="email"
            inputmode="email"
            autocomplete="email"
            required
            aria-invalid={() => (invalid() === 'email' ? 'true' : undefined)}
          />
          <p class="form-error" role="alert">{error}</p>
          <div class="dialog-actions">
            <button type="button" class="btn" onClick={() => dialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn primary" disabled={busy}>
              Add person
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
