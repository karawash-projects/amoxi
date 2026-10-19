/** @generative Shows a list of notes as cards */
export default function NoteList(props: { title: string; notes: Array<{ id: number; text: string; createdAt: string }> }) {
  return (
    <section class="note-cards" aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.notes.length === 0 ? <p class="muted">No notes yet.</p> : null}
      <ul>
        {props.notes.map((n) => (
          <li>
            <p>{n.text}</p>
            <time datetime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
