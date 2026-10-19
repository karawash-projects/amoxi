import { navigate } from 'amoxi';

/** Ends the demo patient session. */
export default function SignOut(props: { label: string }) {
  return (
    <button
      type="button"
      class="link-btn signout"
      onClick={async () => {
        await fetch('/session/sign-out', { method: 'POST' }).catch(() => undefined);
        navigate('/');
      }}
    >
      {props.label}
    </button>
  );
}
