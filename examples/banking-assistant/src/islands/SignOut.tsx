import { navigate, signal } from 'amoxi';

/** Signs the customer out (ends the encrypted session) and returns to the sign-in page. */
export default function SignOut() {
  const [busy, setBusy] = signal(false);
  const out = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch('/api/session/end', { method: 'POST' });
    } finally {
      await navigate('/signin');
    }
  };
  return (
    <button type="button" class="link-btn signout" onClick={() => void out()} disabled={busy}>
      Sign out
    </button>
  );
}
