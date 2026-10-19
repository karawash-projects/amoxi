import { For, agentChat, onMount, type ChatItem } from 'amoxi';
import { renderItem } from '../ui/chat-view';
import { requestRefresh } from '../ui/live';
import { suggestFrom } from '../ui/run-events';

interface Props {
  /** The conversation reopened from the server (latest planner thread of the ops team). */
  initial: ChatItem[];
  threadId?: string;
  /** A run of this conversation still going or waiting for approval: the chat continues it. */
  activeRun?: { id: string; status: string; lastSeq: number };
  examples: string[];
}

/**
 * The dispatcher's conversation with the planner. Answers stream token by token; the
 * optimiser's progress, tool steps, the route map and approval cards appear inline.
 */
export default function PlannerChat(props: Props) {
  const chat = agentChat('dispatch-planner', {
    initial: props.initial,
    threadId: props.threadId,
    resume: props.activeRun ?? null,
    onEvent: (e) => {
      if (e.type === 'tool.completed' || e.type === 'run.completed' || e.type === 'approval.required') requestRefresh();
    },
  });
  let input: HTMLTextAreaElement | undefined;
  let log: HTMLElement | undefined;

  const send = (text: string): void => {
    if (!text.trim() || chat.status() !== 'idle') return;
    void chat.send(text);
    if (input) input.value = '';
  };

  onMount(() => {
    // Keep the newest message in view while the agent works, unless the dispatcher scrolled up.
    let pinned = true;
    const onScroll = (): void => {
      if (log) pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    };
    log?.addEventListener('scroll', onScroll);
    const observer = new MutationObserver(() => {
      if (pinned && log) log.scrollTop = log.scrollHeight;
    });
    if (log) {
      observer.observe(log, { childList: true, subtree: true, characterData: true });
      log.scrollTop = log.scrollHeight;
    }
    return () => {
      observer.disconnect();
      log?.removeEventListener('scroll', onScroll);
    };
  });

  const statusText = (): string => {
    const s = chat.status();
    if (s === 'awaiting_approval') return 'Waiting for your approval';
    if (s === 'working') {
      const last = [...chat.items()].reverse().find((i) => i.kind === 'progress' || i.kind === 'tool');
      if (last?.kind === 'progress') return last.text;
      if (last?.kind === 'tool' && last.status === 'running') return 'Working…';
      return 'Thinking…';
    }
    return 'Ready';
  };

  return (
    <section class="planner" aria-labelledby="planner-title">
      <header class="planner-head">
        <div>
          <h2 id="planner-title">Dispatch planner</h2>
          <p class="planner-sub">Plans routes in the background, books trucks after you approve, texts drivers.</p>
        </div>
        <div class="planner-state">
          <span class={() => `state-chip state-${chat.status()}`} role="status" aria-live="polite">
            <span class="state-dot" aria-hidden="true" />
            <span class="state-text">{statusText}</span>
          </span>
          {() =>
            chat.status() === 'working' ? (
              <button type="button" class="btn btn-small btn-ghost" onClick={() => void chat.cancel()}>
                Stop
              </button>
            ) : (
              <a class="btn btn-small btn-ghost" href="/?new=1" data-reload="">
                New conversation
              </a>
            )
          }
        </div>
      </header>

      <div class="planner-log" ref={(el: HTMLElement) => (log = el)} aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Conversation">
        {() =>
          chat.items().length === 0 ? (
            <div class="planner-empty">
              <p class="empty-title">Tomorrow's work is waiting.</p>
              <p>Ask for the unassigned freight, check the fleet, or have the planner build tomorrow's routes. Planning keeps running if you close this page.</p>
            </div>
          ) : null
        }
        <For each={chat.items} key={(i) => i.id}>
          {(item: ChatItem) => renderItem(item, (callId, yes) => void chat.decide(callId, yes), () => chat.status() === 'working')}
        </For>
      </div>

      <div class="planner-foot">
        <div class="chips" role="group" aria-label="Suggested requests">
          {() =>
            [...suggestFrom(chat.items()), ...props.examples].slice(0, 5).map((e, n) => (
              <button type="button" class={n === 0 && suggestFrom(chat.items()).length > 0 ? 'chip chip-next' : 'chip'} disabled={() => chat.status() !== 'idle'} onClick={() => send(e)}>
                {e}
              </button>
            ))
          }
        </div>
        <form
          class="composer"
          onSubmit={(e: Event) => {
            e.preventDefault();
            if (input) send(input.value);
          }}
        >
          <label for="planner-input" class="visually-hidden">
            Message the dispatch planner
          </label>
          <textarea
            id="planner-input"
            rows={1}
            ref={(el: HTMLTextAreaElement) => (input = el)}
            placeholder="e.g. Plan routes for Montreal depot tomorrow"
            autocomplete="off"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (input) send(input.value);
              }
            }}
          />
          <button type="submit" class="btn btn-primary" disabled={() => chat.status() !== 'idle'}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
