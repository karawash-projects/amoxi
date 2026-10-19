import { navigate, signal } from 'amoxi';

/** Posts to the JSON API, then re-renders the current page in place to show the new note. */
export default function AddNote() {
  let input!: HTMLInputElement;
  const [error, setError] = signal('');
  const [busy, setBusy] = signal(false);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: input.value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { details?: Array<{ message: string }>; error?: string };
        throw new Error(body.details?.[0] ? `Note ${body.details[0].message}.` : (body.error ?? `Request failed (${res.status}).`));
      }
      input.value = '';
      await navigate(location.pathname, { replace: true, keepScroll: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="add-note" onSubmit={submit}>
      <label for="note-text" class="visually-hidden">New note</label>
      <input id="note-text" ref={(el: HTMLInputElement) => (input = el)} placeholder="Write a note" maxlength="280" autocomplete="off" />
      <button type="submit" class="button" disabled={busy}>Add note</button>
      <p class="error" role="alert">{error}</p>
    </form>
  );
}
