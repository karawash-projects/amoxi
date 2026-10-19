import { agentChat, effect, For, mountComponent, onMount, signal, type AgentEvent, type ChatItem } from 'amoxi';
import { money } from '../ui/format';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>;

const AGENT = 'shopping-assistant';

/** What each tool step says while it runs and once it's done. */
const STEPS: Record<string, [string, string]> = {
  search_products: ['Searching the catalog', 'Searched the catalog'],
  compare_products: ['Comparing products', 'Compared products'],
  product_details: ['Checking details and stock', 'Checked details and stock'],
  add_to_cart: ['Adding to your cart', 'Updated your cart'],
  place_order: ['Placing your order', 'Placed your order'],
  track_order: ['Tracking the order', 'Tracked the order'],
  start_return: ['Opening the return', 'Opened the return'],
  remember: ['Saving to your profile', 'Saved to your profile'],
  search_knowledge: ['Reading the buying guides', 'Read the buying guides'],
};
const CART_TOOLS = new Set(['add_to_cart', 'place_order', 'start_return']);

const humanize = (name: string): string => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const emit = (name: string): void => void window.dispatchEvent(new CustomEvent(name));

/* ---------- rich text: paragraphs, bullet lists and **bold** ---------- */

function inline(text: string): unknown[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => (part.startsWith('**') && part.endsWith('**') ? <strong>{part.slice(2, -2)}</strong> : part));
}

function rich(text: string): unknown[] {
  const out: unknown[] = [];
  let list: string[] | undefined;
  const flush = (): void => {
    if (list) out.push(<ul>{list.map((i) => <li>{inline(i)}</li>)}</ul>);
    list = undefined;
  };
  for (const raw of text.split('\n')) {
    const bullet = raw.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      (list ??= []).push(bullet[1]);
      continue;
    }
    flush();
    if (raw.trim()) out.push(<p>{inline(raw.trim())}</p>);
  }
  flush();
  return out;
}

/* ---------- tool steps ---------- */

function ToolStep(props: { item: ToolItem }) {
  const { item } = props;
  const [running, done] = STEPS[item.tool] ?? [humanize(item.tool), humanize(item.tool)];
  const output = (item.output ?? {}) as Record<string, any>;
  const input = (item.input ?? {}) as Record<string, any>;
  let detail: unknown = null;
  if (item.status === 'error') detail = String(output.error ?? 'Something went wrong');
  else if (item.tool === 'remember' && input.fact) detail = `“${String(input.fact)}”`;
  else if (item.tool === 'search_knowledge' && Array.isArray(output.results)) {
    const seen = new Map<string, string>();
    for (const r of output.results as Array<{ title?: string; url?: string }>) if (r.title && !seen.has(r.title)) seen.set(r.title, r.url ?? '#');
    detail = [...seen].slice(0, 3).map(([title, url], i) => [i > 0 ? ', ' : '', <a href={url}>{title}</a>]);
  }
  return (
    <div class={`step step-${item.status}`}>
      <span class="blaze" aria-hidden="true" />
      <span class="step-label">{item.status === 'running' ? `${running}…` : item.status === 'error' ? `${running}: not possible` : done}</span>
      {detail ? <span class="step-detail">{detail}</span> : null}
    </div>
  );
}

/* ---------- approvals ---------- */

interface CartJson {
  lines: Array<{ name: string; option: string; quantity: number; lineCents: number }>;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}
interface EligibilityJson {
  eligible: boolean;
  reason: string;
  refundCents?: number;
}

function Approval(props: { item: ApprovalItem; decide: (approved: boolean) => void }) {
  const { item } = props;
  const [cart, setCart] = signal<CartJson | undefined>(undefined);
  const [check, setCheck] = signal<EligibilityJson | undefined>(undefined);
  const input = (item.input ?? {}) as Record<string, any>;
  const isOrder = item.tool === 'place_order';
  const isReturn = item.tool === 'start_return';
  if (typeof window !== 'undefined' && item.status === 'pending') {
    if (isOrder) void fetch('/api/cart', { headers: { accept: 'application/json' } }).then((r) => r.json()).then(setCart, () => undefined);
    if (isReturn && input.orderId) void fetch(`/api/orders/${encodeURIComponent(String(input.orderId))}/return-eligibility`, { headers: { accept: 'application/json' } }).then((r) => r.json()).then(setCheck, () => undefined);
  }
  const title = isOrder ? 'Confirm your order' : isReturn ? `Return order ${String(input.orderId ?? '')}?` : `Allow “${humanize(item.tool)}”?`;
  const yes = isOrder ? 'Place order' : isReturn ? 'Start return' : 'Allow';
  const no = isOrder ? 'Not yet' : isReturn ? 'Keep the order' : 'Decline';
  return (
    <section class={`approval approval-${item.status}`} aria-label={title}>
      <h3>{title}</h3>
      {item.status !== 'pending'
        ? null
        : isOrder
        ? () => {
            const c = cart();
            if (!c) return <p class="muted">Loading your cart…</p>;
            return (
              <div>
                <ul class="approval-lines">
                  {c.lines.map((l) => (
                    <li>
                      <span>
                        {l.quantity} × {l.name} <span class="muted">({l.option})</span>
                      </span>
                      <span>{money(l.lineCents)}</span>
                    </li>
                  ))}
                </ul>
                <p class="approval-total">
                  <span>
                    Total with {c.shippingCents === 0 ? 'free shipping' : `${money(c.shippingCents)} shipping`} and HST
                  </span>
                  <strong>{money(c.totalCents)}</strong>
                </p>
                <p class="muted small">Demo checkout: nothing is charged. Stock is reserved when you confirm.</p>
              </div>
            );
          }
        : isReturn
          ? () => {
              const c = check();
              if (!c) return <p class="muted">Checking the returns policy…</p>;
              return (
                <p class={c.eligible ? 'policy ok' : 'policy no'}>
                  {c.eligible ? `Eligible: ${c.reason} Refund ${money(c.refundCents ?? 0)}.` : `Not eligible: ${c.reason}`}
                </p>
              );
            }
          : <p class="muted">{item.reason ?? 'The assistant needs your go-ahead for this step.'}</p>}
      {item.status === 'pending' ? (
        <div class="approval-actions">
          <button type="button" class="btn btn-blaze" onClick={() => props.decide(true)}>
            {isOrder ? () => (cart() ? `${yes}, ${money(cart()!.totalCents)}` : yes) : yes}
          </button>
          <button type="button" class="btn" onClick={() => props.decide(false)}>
            {no}
          </button>
        </div>
      ) : (
        <p class={`decided ${item.status}`}>{item.status === 'approved' ? 'Confirmed' : 'Declined'}</p>
      )}
    </section>
  );
}

/* ---------- the chat ---------- */

export default function ShopAssistant(props: {
  initial: ChatItem[];
  threadId?: string;
  suggestions: string[];
  /** A question to send straight away (from "Ask the assistant" links). */
  ask?: string;
  /** A run still in progress when the page loaded (e.g. a checkout awaiting approval): continued, not restarted. */
  resume?: { id: string; status: string; lastSeq: number };
}) {
  const onEvent = (e: AgentEvent): void => {
    if (e.type === 'tool.completed') {
      if (CART_TOOLS.has(String(e.data.tool))) emit('demo-store:cart');
      if (e.data.tool === 'remember') emit('demo-store:profile');
    }
    if (e.type === 'run.completed') emit('demo-store:profile');
  };
  const chat = agentChat(AGENT, { initial: props.initial, threadId: props.threadId, resume: props.resume, onEvent });
  let input: HTMLTextAreaElement | undefined;
  let log: HTMLElement | undefined;

  const send = (text: string): void => {
    if (!text.trim() || chat.status() !== 'idle') return;
    void chat.send(text);
    if (input) {
      input.value = '';
      input.style.height = '';
    }
  };

  const decide = (item: ApprovalItem, approved: boolean): void => void chat.decide(item.callId, approved);

  onMount(() => {
    const onAsk = (e: Event): void => {
      const detail = (e as CustomEvent<{ text?: string; accepted?: boolean }>).detail;
      if (detail?.text && chat.status() === 'idle') {
        detail.accepted = true;
        send(detail.text);
        input?.focus();
      }
    };
    window.addEventListener('demo-store:ask', onAsk);
    // Follow the conversation while the shopper is at the bottom; leave them alone if they scrolled up.
    let pinned = true;
    const onScroll = (): void => {
      if (log) pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
    };
    log?.addEventListener('scroll', onScroll, { passive: true });
    const stop = effect(() => {
      chat.items();
      if (!pinned) return;
      // Generative components and approval details render a moment later: follow them too.
      const toEnd = (): void => void (log && (log.scrollTop = log.scrollHeight));
      requestAnimationFrame(toEnd);
      setTimeout(toEnd, 350);
    });
    if (props.ask) {
      history.replaceState(history.state, '', location.pathname);
      send(props.ask);
    }
    return () => {
      window.removeEventListener('demo-store:ask', onAsk);
      log?.removeEventListener('scroll', onScroll);
      stop();
    };
  });

  const render = (item: ChatItem): unknown => {
    switch (item.kind) {
      case 'user':
        return (
          <div class="msg msg-user">
            <p>{item.text}</p>
          </div>
        );
      case 'assistant':
        return <div class={item.streaming ? 'msg msg-agent streaming' : 'msg msg-agent'}>{rich(item.text)}</div>;
      case 'tool':
        return <ToolStep item={item} />;
      case 'ui':
        return (
          <div class="gen" data-component={item.component} ref={(el: HTMLElement) => mountComponent(el, item.component, item.props)} />
        );
      case 'approval':
        return <Approval item={item} decide={(yes) => decide(item, yes)} />;
      case 'progress':
        return <p class="progress">{item.text}</p>;
      case 'error':
        return (
          <p class="msg-error" role="alert">
            {item.text}
          </p>
        );
    }
  };

  return (
    <section class="chat" aria-label="Shopping assistant">
      <header class="chat-head">
        <div>
          <h1>Shop with the assistant</h1>
          <p class="chat-status" role="status" aria-live="polite">
            {() => (chat.status() === 'working' ? 'Working on it…' : chat.status() === 'awaiting_approval' ? 'Waiting for your confirmation' : 'Ready')}
          </p>
        </div>
        <div class="chat-tools">
          {() =>
            chat.status() === 'working' ? (
              <button type="button" class="btn btn-quiet" onClick={() => void chat.cancel()}>
                Stop
              </button>
            ) : null
          }
          <a class="btn btn-quiet" href="/assistant?new=1">
            New chat
          </a>
        </div>
      </header>
      <div class="chat-log" ref={(el: HTMLElement) => (log = el)} aria-live="polite" aria-relevant="additions">
        {() =>
          chat.items().length === 0 ? (
            <div class="chat-empty">
              <h2>Tell me about the trip.</h2>
              <p>
                Ask for gear in your own words and I'll show you products, compare them side by side, keep your sizes in mind and handle the cart, orders and returns. Try one of the
                suggestions below.
              </p>
            </div>
          ) : null
        }
        <For each={chat.items} key={(i) => i.id}>
          {render}
        </For>
        {() => (chat.status() === 'working' ? <div class="thinking" aria-hidden="true"><span /><span /><span /></div> : null)}
      </div>
      <div class={() => (chat.items().length > 0 ? 'composer has-items' : 'composer')}>
        <ul class="suggestions" aria-label="Suggested requests">
          {props.suggestions.map((s) => (
            <li>
              <button type="button" class="chip" disabled={() => chat.status() !== 'idle'} onClick={() => send(s)}>
                {s}
              </button>
            </li>
          ))}
        </ul>
        <form
          class="composer-form"
          onSubmit={(e: Event) => {
            e.preventDefault();
            if (input) send(input.value);
          }}
        >
          <label for="chat-input" class="sr-only">
            Message the assistant
          </label>
          <textarea
            id="chat-input"
            rows="1"
            placeholder="Ask about gear, sizes, orders…"
            maxlength="2000"
            ref={(el: HTMLTextAreaElement) => (input = el)}
            onInput={() => {
              if (!input) return;
              input.style.height = '';
              input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (input) send(input.value);
              }
            }}
          />
          <button type="submit" class="btn btn-blaze" disabled={() => chat.status() !== 'idle'}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
