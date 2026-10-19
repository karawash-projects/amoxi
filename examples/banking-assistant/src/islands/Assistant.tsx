import { For, agentChat, followRun, mountComponent, navigate, onMount, signal, type AgentEvent, type ChatItem } from 'amoxi';
import { ACCOUNTS_CHANGED, TOOL_LABELS, money } from '../ui/format';

const AGENT = 'banking-assistant';
/** Tools whose success changes balances or card status: the accounts panel refreshes after them. */
const MONEY_TOOLS = new Set(['transfer_between_accounts', 'freeze_card', 'unfreeze_card']);

interface Prompt {
  label: string;
  text: string;
}

interface PendingApproval {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
}

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

/** The conversation with the assistant: streaming answers, tool steps, approvals and generative components. */
export default function Assistant(props: {
  firstName: string;
  initial: ChatItem[];
  threadId?: string;
  prompts: Prompt[];
  /** Account and card ids -> names, for approval cards. */
  names: Record<string, string>;
  /** Which model answers, e.g. "Offline demo model". */
  model: string;
  /** A run from before a reload that still waits for a decision. */
  pending?: { runId: string; approvals: PendingApproval[] };
}) {
  const onEvent = (e: AgentEvent): void => {
    if (e.type === 'tool.completed' && MONEY_TOOLS.has(String(e.data.tool)) && !e.data.isError) {
      window.dispatchEvent(new CustomEvent(ACCOUNTS_CHANGED));
    }
  };
  const chat = agentChat(AGENT, { initial: props.initial, threadId: props.threadId, onEvent });
  const [draft, setDraft] = signal('');
  const [restoring, setRestoring] = signal<string | undefined>(undefined);
  let log!: HTMLElement;
  let stream!: HTMLElement;
  let input!: HTMLTextAreaElement;

  const send = (text: string): void => {
    const t = text.trim();
    if (!t || chat.status() !== 'idle' || props.pending) return;
    setDraft('');
    pinned = true;
    if (input) input.value = '';
    void chat.send(t);
  };

  let pinned = true;
  onMount(() => {
    // Keep the newest message in view while the answer streams (and components load), unless the
    // reader scrolled up to read something earlier.
    let ours = -1;
    const onScroll = (): void => {
      if (log.scrollTop === ours) return; // our own scroll, not the reader's
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    };
    const follow = (): void => {
      if (!pinned) return;
      log.scrollTop = log.scrollHeight;
      ours = log.scrollTop;
    };
    log.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(follow);
    resize.observe(stream);
    follow();
    return () => {
      log.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  });

  /** Decides an approval left over from before a reload, then reloads when the run finishes. */
  const decideRestored = async (callId: string, approved: boolean): Promise<void> => {
    const run = props.pending!.runId;
    setRestoring(approved ? 'Approved. Finishing up' : 'Declined. Finishing up');
    try {
      const res = await fetch(`/agents/${AGENT}/runs/${run}/approvals/${encodeURIComponent(callId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok && res.status !== 409) throw new Error(`The bank answered ${res.status}`);
      await followRun(`/agents/${AGENT}/runs/${run}/events`, { onEvent: () => undefined });
      window.dispatchEvent(new CustomEvent(ACCOUNTS_CHANGED));
      await navigate('/assistant');
    } catch (err) {
      setRestoring(`Couldn't send your decision: ${(err as Error).message}`);
    }
  };

  const statusText = (): string => {
    const s = chat.status();
    if (s === 'working') return 'The assistant is working';
    if (s === 'awaiting_approval') return 'Waiting for your approval';
    return '';
  };

  return (
    <section class="chat" aria-label="Conversation with the assistant">
      <div class="chat-log" ref={(el: HTMLElement) => (log = el)} role="log" aria-live="polite" aria-relevant="additions" tabindex="0">
        <div class="chat-stream" ref={(el: HTMLElement) => (stream = el)}>
        {() =>
          chat.items().length === 0 && !props.pending ? (
            <div class="welcome">
              <h2>Hello {props.firstName}. What would you like to do?</h2>
              <p>Ask in your own words. The assistant reads your accounts to answer, and asks you before it moves money or changes a card.</p>
            </div>
          ) : null
        }
        <For each={chat.items} key={(i: ChatItem) => i.id}>
          {(item: ChatItem) => renderItem(item)}
        </For>
        {props.pending && (
          <div class="restored">
            <p class="progress-line">This conversation is waiting for your decision.</p>
            {props.pending.approvals.map((a) => (
              <ApprovalSlip
                tool={a.tool}
                input={a.input}
                status="pending"
                names={props.names}
                onDecide={(yes) => void decideRestored(a.callId, yes)}
              />
            ))}
            <p class="progress-line" role="status">
              {restoring}
            </p>
          </div>
        )}
        </div>
      </div>

      <div class="composer-zone">
        <div class="prompt-row" role="group" aria-label="Suggested questions">
          {props.prompts.map((p) => (
            <button type="button" class="prompt-chip" onClick={() => send(p.text)} disabled={() => chat.status() !== 'idle' || !!props.pending} title={p.text}>
              {p.label}
            </button>
          ))}
        </div>
        <form
          class="composer"
          onSubmit={(e: Event) => {
            e.preventDefault();
            send(draft());
          }}
        >
          <label for="chat-input" class="visually-hidden">
            Message the assistant
          </label>
          <textarea
            id="chat-input"
            ref={(el: HTMLTextAreaElement) => (input = el)}
            rows="1"
            maxlength="2000"
            placeholder="Ask about your money"
            onInput={(e: Event) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(draft());
              }
            }}
          />
          {() =>
            chat.status() === 'working' ? (
              <button type="button" class="btn btn-quiet" onClick={() => void chat.cancel()}>
                Stop
              </button>
            ) : (
              <button type="submit" class="btn btn-primary" disabled={() => !draft().trim() || chat.status() !== 'idle' || !!props.pending}>
                Send
              </button>
            )
          }
        </form>
        <div class="composer-foot">
          <p class={() => `chat-status ${chat.status()}`} role="status">
            {statusText}
          </p>
          <span class="composer-meta">
            <span class="model-tag">{props.model}</span>
            <button type="button" class="link-btn" onClick={() => void navigate('/assistant?new=1')}>
              New conversation
            </button>
          </span>
        </div>
      </div>
    </section>
  );

  function renderItem(item: ChatItem): unknown {
    switch (item.kind) {
      case 'user':
        return (
          <div class="msg msg-user">
            <p>{item.text}</p>
          </div>
        );
      case 'assistant':
        return (
          <div class={`msg msg-agent ${(item as { streaming?: boolean }).streaming ? 'is-streaming' : ''}`}>
            <span class="agent-mark" aria-hidden="true">
              D
            </span>
            <div class="msg-body">{renderText(item.text)}</div>
          </div>
        );
      case 'tool':
        return <ToolStep item={item} />;
      case 'ui':
        return <div class="gen-host" ref={(el: HTMLElement) => mountComponent(el, item.component, item.props)} />;
      case 'approval':
        return (
          <ApprovalSlip
            tool={item.tool}
            input={(item.input ?? {}) as Record<string, unknown>}
            status={item.status}
            names={props.names}
            onDecide={(yes) => void chat.decide(item.callId, yes)}
          />
        );
      case 'progress':
        return <p class="progress-line">{item.text}</p>;
      case 'error':
        return (
          <p class="msg-error" role="alert">
            {item.text}
          </p>
        );
    }
  }
}

function ToolStep(props: { item: Item<'tool'> }) {
  const { item } = props;
  const name = item.tool.replace(/_/g, ' ');
  const [running, done, failed] = TOOL_LABELS[item.tool] ?? [`Running ${name}`, `Ran ${name}`, `${name} failed`];
  const error = item.status === 'error' ? errorOf(item.output) : undefined;
  return (
    <div class={`tool-step is-${item.status}`}>
      <span class="tool-icon" aria-hidden="true">
        {item.status === 'running' ? <span class="spinner" /> : item.status === 'done' ? (
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M2.5 6.3 5 8.6 9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        ) : (
          '!'
        )}
      </span>
      <span class="tool-text">
        {item.status === 'running' ? `${running}…` : item.status === 'done' ? done : failed}
        {error && <span class="tool-error">{error}</span>}
      </span>
    </div>
  );
}

function errorOf(output: unknown): string {
  if (output && typeof output === 'object') {
    const o = output as { error?: unknown; declined?: unknown };
    if (o.declined) return 'You declined it.';
    if (typeof o.error === 'string') return o.error === 'The person declined this action.' ? 'You declined it.' : o.error;
  }
  return 'It did not complete.';
}

/** The approval card: a transfer slip the customer signs off (or declines). */
function ApprovalSlip(props: {
  tool: string;
  input: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
  names: Record<string, string>;
  onDecide: (approved: boolean) => void;
}) {
  const { input, names } = props;
  const isTransfer = props.tool === 'transfer_between_accounts';
  const freeze = props.tool === 'freeze_card';
  const amount = typeof input.amountCents === 'number' ? input.amountCents : 0;
  const title = isTransfer ? 'Approve this transfer?' : freeze ? 'Freeze this card?' : props.tool === 'unfreeze_card' ? 'Unfreeze this card?' : `Allow ${props.tool.replace(/_/g, ' ')}?`;
  const label = (id: unknown): string => (typeof id === 'string' ? `${names[id.toUpperCase()] ?? 'Unknown account'}` : '');
  return (
    <section class={`slip is-${props.status}`} aria-label={title}>
      <header class="slip-head">
        <h3>{title}</h3>
        <span class="slip-status">{props.status === 'pending' ? 'Needs your approval' : props.status === 'approved' ? 'Approved' : 'Declined'}</span>
      </header>
      {isTransfer ? (
        <div class="slip-body">
          <dl class="slip-legs">
            <div>
              <dt>From</dt>
              <dd>
                {label(input.fromAccountId)} <span class="ledger-sub">{String(input.fromAccountId ?? '')}</span>
              </dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>
                {label(input.toAccountId)} <span class="ledger-sub">{String(input.toAccountId ?? '')}</span>
              </dd>
            </div>
            {typeof input.memo === 'string' && input.memo && (
              <div>
                <dt>Note</dt>
                <dd>{input.memo}</dd>
              </div>
            )}
          </dl>
          <p class="slip-amount num">{money(amount)}</p>
        </div>
      ) : (
        <div class="slip-body">
          <dl class="slip-legs">
            <div>
              <dt>Card</dt>
              <dd>
                {label(input.cardId)} <span class="ledger-sub">{String(input.cardId ?? '')}</span>
              </dd>
            </div>
          </dl>
          <p class="slip-effect">{freeze ? 'New purchases and withdrawals will be declined until you unfreeze it.' : 'The card will work again right away.'}</p>
        </div>
      )}
      {props.status === 'pending' && (
        <div class="slip-actions">
          <button type="button" class="btn btn-primary" onClick={() => props.onDecide(true)}>
            {isTransfer ? 'Approve transfer' : freeze ? 'Approve freeze' : 'Approve'}
          </button>
          <button type="button" class="btn btn-quiet" onClick={() => props.onDecide(false)}>
            Decline
          </button>
        </div>
      )}
    </section>
  );
}

/** Minimal formatting for answers: paragraphs, "- " bullet lists and **bold**. */
function renderText(text: string): unknown {
  const blocks: unknown[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) blocks.push(<ul>{list.map((l) => <li>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p>{inline(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return blocks;
}

function inline(text: string): unknown {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong>{part.slice(2, -2)}</strong> : part));
}
