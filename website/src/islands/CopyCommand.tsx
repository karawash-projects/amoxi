import { signal } from 'amoxi';

/**
 * Shell commands with a copy button. Each command is on its own line, so they work in every
 * shell, including Windows PowerShell 5.1 (which doesn't support `&&`).
 */
export default function CopyCommand(props: { lines: string[]; label: string }) {
  const [state, setState] = signal<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.lines.join('\n'));
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer);
    timer = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <div class="command">
      <pre aria-label={props.label}>
        <code>
          {props.lines.map((line) => (
            <span class="command-line">{line}</span>
          ))}
        </code>
      </pre>
      <button type="button" class="command-copy" onClick={copy}>
        {() => (state() === 'copied' ? 'Copied' : state() === 'failed' ? 'Select and copy' : 'Copy')}
      </button>
      <span class="visually-hidden" role="status">
        {() => (state() === 'copied' ? 'Commands copied to the clipboard' : '')}
      </span>
    </div>
  );
}
