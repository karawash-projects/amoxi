import { signal } from 'amoxi';

/** An island: rendered on the server, then made interactive in the browser. */
export default function Counter(props: { start: number }) {
  const [count, setCount] = signal(props.start);
  return (
    <button type="button" class="button" onClick={() => setCount((c) => c + 1)}>
      Clicked {count} {() => (count() === 1 ? 'time' : 'times')}
    </button>
  );
}
