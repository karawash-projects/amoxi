import { signal } from 'amoxi';
import type { User } from '../domain/user';
import { initials } from '../ui/format';

export interface PeopleListProps {
  users: User[];
  selectedId?: number;
}

/** Server-rendered list (works without JavaScript) that filters instantly once active. */
export default function PeopleList(props: PeopleListProps) {
  const [query, setQuery] = signal('');
  const matches = (u: User): boolean => {
    const q = query().trim().toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  };

  return (
    <div class="people-pane">
      <div class="search">
        <input
          type="search"
          placeholder="Search by name or email"
          aria-label="Search people"
          onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <ul class="people-list" aria-label="People">
        {() => {
          if (props.users.length === 0) {
            return (
              <li class="empty">
                <p>No people yet. Use Add person to create the first one.</p>
              </li>
            );
          }
          const shown = props.users.filter(matches);
          if (shown.length === 0) {
            return (
              <li class="empty">
                <p>No one matches "{query().trim()}".</p>
              </li>
            );
          }
          return shown.map((u) => (
            <li>
              <a class="person-link" href={`/people/${u.id}`} aria-current={props.selectedId === u.id ? 'true' : undefined}>
                <span class="initials" aria-hidden="true">{initials(u.name)}</span>
                <span>
                  <strong>{u.name}</strong>
                  <small>{u.email}</small>
                </span>
              </a>
            </li>
          ));
        }}
      </ul>
    </div>
  );
}
