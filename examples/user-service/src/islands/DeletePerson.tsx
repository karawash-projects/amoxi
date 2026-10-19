import { navigate, signal } from 'amoxi';

/** Two-step delete: the first press arms the button for three seconds, the second deletes. */
export default function DeletePerson(props: { id: number }) {
  const [armed, setArmed] = signal(false);
  const [busy, setBusy] = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const click = async (): Promise<void> => {
    if (!armed()) {
      setArmed(true);
      timer = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timer);
    setBusy(true);
    const res = await fetch(`/users/${props.id}`, { method: 'DELETE' }).catch(() => undefined);
    if (res && (res.ok || res.status === 404)) {
      await navigate('/people?flash=deleted');
    } else {
      setBusy(false);
      setArmed(false);
      alert('The person could not be deleted. Check that the server is running and try again.');
    }
  };

  return (
    <button type="button" class={() => (armed() ? 'btn danger confirming' : 'btn danger')} disabled={busy} onClick={click}>
      {() => (armed() ? 'Confirm delete' : 'Delete person')}
    </button>
  );
}
