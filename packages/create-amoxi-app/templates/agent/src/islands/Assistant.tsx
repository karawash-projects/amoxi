import { agentChat, For, mountComponent, onMount, type ChatItem } from 'amoxi';

/**
 * A chat with the `assistant` agent. Answers stream in token by token; tool steps, approvals and
 * components the agent shows (generative UI) appear in the conversation.
 */
export default function Assistant(props: { examples: string[] }) {
  const chat = agentChat('assistant');
  let input: HTMLInputElement | undefined;
  let log!: HTMLElement;

  // Text the agent writes just before using a tool ("Let me check that.") is narration, not an
  // answer: it is shown as a quiet status line next to the step, and only answers get a bubble.
  const isNarration = (item: ChatItem): boolean => {
    const items = chat.items();
    const next = items[items.findIndex((i) => i.id === item.id) + 1];
    return next !== undefined && (next.kind === 'tool' || next.kind === 'approval' || next.kind === 'ui');
  };

  // Keep the newest message in view while answers stream in, unless the reader scrolled up.
  let pinned = true;
  onMount(() => {
    const onScroll = (): void => {
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    };
    const follow = (): void => {
      if (pinned) log.scrollTop = log.scrollHeight;
    };
    const watcher = new MutationObserver(follow);
    watcher.observe(log, { childList: true, subtree: true, characterData: true });
    log.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      watcher.disconnect();
      log.removeEventListener('scroll', onScroll);
    };
  });

  const send = (text: string): void => {
    pinned = true;
    void chat.send(text);
    if (input) input.value = '';
  };

  const render = (item: ChatItem) => {
    switch (item.kind) {
      case 'user':
        return <p class="msg user">{item.text}</p>;
      case 'assistant':
        return <p class={() => (isNarration(item) ? 'msg narration' : 'msg answer')}>{item.text}</p>;
      case 'tool':
        return <p class="msg step">{item.status === 'running' ? 'Working: ' : 'Used '}{item.tool.replace(/_/g, ' ')}</p>;
      case 'ui':
        return <div class="msg ui" ref={(el: HTMLElement) => mountComponent(el, item.component, item.props)} />;
      case 'approval':
        return (
          <div class="msg approval">
            <p>Allow “{item.tool.replace(/_/g, ' ')}”?</p>
            {item.status === 'pending' ? (
              <p>
                <button type="button" onClick={() => void chat.decide(item.callId, true)}>Allow</button>{' '}
                <button type="button" onClick={() => void chat.decide(item.callId, false)}>Decline</button>
              </p>
            ) : (
              <p class="muted">{item.status === 'approved' ? 'Allowed' : 'Declined'}</p>
            )}
          </div>
        );
      default:
        return <p class={`msg ${item.kind}`}>{'text' in item ? item.text : ''}</p>;
    }
  };

  return (
    <section class="chat" aria-label="Assistant">
      <div class="conversation" aria-live="polite" ref={(el: HTMLElement) => (log = el)}>
        <For each={chat.items} key={(i) => i.id}>{render}</For>
        {() => (chat.status() === 'working' ? <p class="msg step">Thinking…</p> : null)}
      </div>
      <div class="examples">
        {props.examples.map((e) => (
          <button type="button" onClick={() => send(e)}>{e}</button>
        ))}
      </div>
      <form
        class="composer"
        onSubmit={(e: Event) => {
          e.preventDefault();
          if (input?.value.trim()) send(input.value);
        }}
      >
        <label for="message" class="visually-hidden">Message</label>
        <input id="message" ref={(el: HTMLInputElement) => (input = el)} placeholder="Ask about your notes…" autocomplete="off" />
        <button type="submit" disabled={() => chat.status() !== 'idle'}>Send</button>
      </form>
    </section>
  );
}
