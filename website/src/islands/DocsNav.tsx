import { onMount, signal } from 'amoxi';

interface Entry {
  id: string;
  title: string;
  children: readonly { id: string; title: string }[];
}

/**
 * The documentation's contents: marks the section you are reading, filters topics as you type, and
 * turns on the copy buttons of the page's code blocks. Without JavaScript it is a plain list of links.
 */
export default function DocsNav(props: { sections: Entry[] }) {
  const [active, setActive] = signal(props.sections[0]?.id ?? '');
  const [query, setQuery] = signal('');
  let details: HTMLDetailsElement | undefined;

  const matches = (title: string): boolean => title.toLowerCase().includes(query().trim().toLowerCase());
  const sectionShown = (s: Entry): boolean => !query().trim() || matches(s.title) || s.children.some((c) => matches(c.title));
  const childShown = (s: Entry, title: string): boolean => !query().trim() || matches(s.title) || matches(title);
  const sectionActive = (s: Entry): boolean => active() === s.id || s.children.some((c) => c.id === active());

  onMount(() => {
    // On small screens the contents start folded, so the reading starts right away.
    if (details && window.matchMedia('(max-width: 900px)').matches) details.open = false;

    const ids = props.sections.flatMap((s) => [s.id, ...s.children.map((c) => c.id)]);
    const headings = ids.map((id) => document.getElementById(id)).filter((h): h is HTMLElement => h !== null);
    const update = (): void => {
      let current = headings[0]?.id ?? '';
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= 140) current = h.id;
        else break;
      }
      setActive(current);
    };
    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const block of document.querySelectorAll<HTMLElement>('.docs-code')) {
      const button = block.querySelector<HTMLButtonElement>('.docs-copy');
      const code = block.querySelector('pre');
      if (!button || !code) continue;
      button.hidden = false;
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? '');
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Select and copy';
        }
        timers.push(setTimeout(() => (button.textContent = 'Copy'), 2000));
      });
    }
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
    };
  });

  return (
    <details class="docs-toc" open ref={(el: Element) => (details = el as HTMLDetailsElement)}>
      <summary>Contents</summary>
      <label class="docs-filter">
        <span class="visually-hidden">Filter topics</span>
        <input type="search" placeholder="Filter topics" autocomplete="off" onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)} />
      </label>
      <ol class="docs-toc-list">
        {props.sections.map((s) => (
          <li hidden={() => !sectionShown(s)} class={() => (sectionActive(s) ? 'is-active' : '')}>
            <a href={`#${s.id}`} aria-current={() => (active() === s.id ? 'location' : undefined)}>
              {s.title}
            </a>
            {s.children.length > 0 ? (
              <ol>
                {s.children.map((c) => (
                  <li hidden={() => !childShown(s, c.title)}>
                    <a href={`#${c.id}`} aria-current={() => (active() === c.id ? 'location' : undefined)}>
                      {c.title}
                    </a>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
      <p class="docs-filter-empty" hidden={() => props.sections.some(sectionShown)}>
        No topic matches. Try a shorter word.
      </p>
    </details>
  );
}
