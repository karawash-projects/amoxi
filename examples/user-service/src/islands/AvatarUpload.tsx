import { navigate, signal } from 'amoxi';

/** Uploads a profile photo (multipart/form-data) and refreshes the page in place. */
export default function AvatarUpload(props: { id: number; hasPhoto: boolean }) {
  let input!: HTMLInputElement;
  const [error, setError] = signal('');
  const [busy, setBusy] = signal(false);

  const upload = async (): Promise<void> => {
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('avatar', file);
      const res = await fetch(`/users/${props.id}/avatar`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Upload failed (${res.status})`);
      await navigate(location.pathname + location.search, { replace: true, keepScroll: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      input.value = '';
    }
  };

  return (
    <div class="avatar-upload">
      <label class="btn" aria-disabled={() => (busy() ? 'true' : undefined)}>
        {() => (busy() ? 'Uploading…' : props.hasPhoto ? 'Change photo' : 'Add photo')}
        <input ref={(el: HTMLInputElement) => (input = el)} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="visually-hidden" onChange={upload} />
      </label>
      <p class="form-error" role="alert">{error}</p>
    </div>
  );
}
