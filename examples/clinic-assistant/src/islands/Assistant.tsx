import { agentChat, For, mountComponent, navigate, onMount, signal, type ChatItem } from 'amoxi';
import { dateLabel, parseSlotId, timeLabel } from '../domain/time';
import { ASK_EVENT, CHANGED_EVENT } from '../ui/cards';
import { renderRichText } from '../ui/rich-text';

interface Props {
  readonly agent: string;
  readonly firstName: string;
  readonly initial: ChatItem[];
  readonly threadId?: string;
  readonly suggestions: string[];
  readonly prefill?: string;
  /** Clinician names by slot number ("101"), to describe booking approvals. */
  readonly clinicians: Record<string, { name: string; role: string }>;
  /** A run still in progress (e.g. a booking waiting for approval) to continue after a reload. */
  readonly resume?: { id: string; status: string; lastSeq: number };
}

/** What each tool did, in the patient's words: [while running, when done]. */
const STEPS: Record<string, [string, string]> = {
  find_clinicians: ['Looking up clinicians', 'Looked up clinicians'],
  available_slots: ['Checking open times', 'Checked open times'],
  book_appointment: ['Booking the appointment', 'Booked the appointment'],
  cancel_appointment: ['Cancelling the appointment', 'Cancelled the appointment'],
  upcoming_appointments: ['Opening your appointments', 'Opened your upcoming appointments'],
  check_symptom_urgency: ['Running the urgency safety screen', 'Ran the urgency safety screen'],
  clinic_policy: ['Searching the clinic handbook', 'Searched the clinic handbook'],
  search_knowledge: ['Searching the clinic handbook', 'Searched the clinic handbook'],
  remember: ['Saving your preference', 'Saved your preference'],
  request_referral: ['Logging the referral', 'Logged the referral'],
};

const CHANGES = new Set(['book_appointment', 'cancel_appointment']);

function stepLabel(tool: string, done: boolean): string {
  const s = STEPS[tool];
  return s ? s[done ? 1 : 0] : tool.replace(/_/g, ' ');
}

function refusal(output: unknown): string {
  if (output && typeof output === 'object' && 'error' in output) return String((output as { error: unknown }).error);
  return 'That step did not complete.';
}

/** Details of a pending appointment for a cancellation approval (the patient's own data API). */
function CancelDetails(props: { appointmentId: string }) {
  const [info, setInfo] = signal<{ text: string; late: boolean } | undefined>(undefined);
  if (typeof window !== 'undefined') {
    void fetch(`/api/me/appointments/${encodeURIComponent(props.appointmentId)}`, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((a: { clinician: string; dateLabel: string; timeLabel: string; within24h: boolean } | undefined) => {
        if (a) setInfo({ text: `${a.clinician}, ${a.dateLabel} at ${a.timeLabel}`, late: a.within24h });
      })
      .catch(() => undefined);
  }
  return (
    <div class="approval-detail">
      <p class="approval-what">{() => info()?.text ?? `Appointment ${props.appointmentId}`}</p>
      {() =>
        info()?.late ? (
          <p class="policy late">Less than 24 hours' notice: a $40 late-cancellation fee may apply for uninsured services. It is waived once a year and always if you are unwell.</p>
        ) : (
          <p class="policy">Cancelling 24 hours or more ahead has no fee. The time goes back to other patients.</p>
        )
      }
    </div>
  );
}

function ApprovalCard(props: { item: Extract<ChatItem, { kind: 'approval' }>; clinicians: Props['clinicians']; decide: (yes: boolean) => void }) {
  const input = (props.item.input ?? {}) as Record<string, unknown>;
  const booking = props.item.tool === 'book_appointment';
  const cancelling = props.item.tool === 'cancel_appointment';
  const slot = booking ? parseSlotId(String(input.slotId ?? '')) : undefined;
  const who = slot ? props.clinicians[slot.clinicianId] : undefined;
  const title = booking ? 'Confirm this booking' : cancelling ? 'Confirm this cancellation' : 'Confirm this action';
  const pending = props.item.status === 'pending';
  return (
    <div class={`approval approval-${props.item.status}`} role="group" aria-label={title}>
      <div class="approval-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6L12 3Z" />
          <path d="m8.8 12 2.2 2.2 4.3-4.4" />
        </svg>
        <h3>{title}</h3>
      </div>
      {booking && (
        <div class="approval-detail">
          <p class="approval-what">{slot && who ? `${who.name}, ${who.role}` : String(input.slotId ?? '')}</p>
          {slot && <p class="approval-when">{`${dateLabel(slot.date)} at ${timeLabel(slot.time)}`}</p>}
          <p class="policy">Nothing is booked until you confirm. You can cancel up to 24 hours before without a fee.</p>
        </div>
      )}
      {cancelling && <CancelDetails appointmentId={String(input.appointmentId ?? '')} />}
      {pending ? (
        <div class="approval-actions">
          <button type="button" class="btn btn-primary" onClick={() => props.decide(true)}>
            {booking ? 'Confirm booking' : cancelling ? 'Cancel appointment' : 'Confirm'}
          </button>
          <button type="button" class="btn btn-quiet" onClick={() => props.decide(false)}>
            {cancelling ? 'Keep appointment' : 'Not now'}
          </button>
        </div>
      ) : (
        <p class="approval-result">{props.item.status === 'approved' ? 'You confirmed this.' : 'You declined. Nothing was changed.'}</p>
      )}
    </div>
  );
}

/** The patient assistant: streaming conversation, tool steps, approvals and generative components. */
export default function Assistant(props: Props) {
  const chat = agentChat(props.agent, {
    initial: props.initial,
    threadId: props.threadId,
    resume: props.resume,
    onEvent: (e) => {
      if (e.type === 'tool.completed' && CHANGES.has(String(e.data.tool)) && !e.data.isError && typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent(CHANGED_EVENT));
      }
    },
  });
  const [draft, setDraft] = signal(props.prefill ?? '');
  const [notice, setNotice] = signal<string | undefined>(undefined);
  let log: HTMLElement | undefined;
  let stack: HTMLElement | undefined;

  const send = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    if (chat.status() !== 'idle') {
      setNotice(chat.status() === 'awaiting_approval' ? 'Confirm or decline the pending step first.' : 'One moment: the assistant is still working on your last message.');
      return;
    }
    setNotice(undefined);
    setDraft('');
    void chat.send(t);
  };

  onMount(() => {
    const onAsk = (e: Event): void => send(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ''));
    document.addEventListener(ASK_EVENT, onAsk);
    // Follow the conversation as it grows (text, tool steps, components that load later),
    // unless the patient scrolled up to read. Desktop scrolls the log; mobile scrolls the page.
    const scrollsInside = (): boolean => !!log && getComputedStyle(log).overflowY === 'auto';
    const distance = (): number => {
      if (!log) return 0;
      if (scrollsInside()) return log.scrollHeight - log.scrollTop - log.clientHeight;
      const composer = log.parentElement?.querySelector('.composer') as HTMLElement | null;
      return stack!.getBoundingClientRect().bottom - (window.innerHeight - (composer?.offsetHeight ?? 0));
    };
    let near = true;
    const toBottom = (): void => {
      if (!log || !near) return;
      if (scrollsInside()) log.scrollTop = log.scrollHeight;
      else window.scrollBy(0, Math.max(0, distance() + 12));
    };
    // While a restored conversation's components load, keep following the end.
    const settledAt = Date.now() + 1500;
    const onScroll = (): void => {
      near = Date.now() < settledAt || distance() < 160;
    };
    log?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(() => toBottom());
    if (stack) resize.observe(stack);
    if (log && scrollsInside()) log.scrollTop = log.scrollHeight;
    return () => {
      document.removeEventListener(ASK_EVENT, onAsk);
      log?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  });

  const render = (item: ChatItem) => {
    switch (item.kind) {
      case 'user':
        return (
          <div class="msg msg-user">
            <p class="sr-only">You said:</p>
            <div class="bubble">{item.text}</div>
          </div>
        );
      case 'assistant':
        return (
          <div class={'streaming' in item && item.streaming ? 'msg msg-agent streaming' : 'msg msg-agent'}>
            <span class="agent-mark" aria-hidden="true">
              C
            </span>
            <div class="agent-text">
              <p class="sr-only">Assistant:</p>
              {renderRichText(item.text)}
            </div>
          </div>
        );
      case 'tool': {
        const refused = item.status === 'error';
        return (
          <div class={`step step-${item.status}`}>
            <span class="step-dot" aria-hidden="true" />
            <span class="step-label">{item.status === 'running' ? `${stepLabel(item.tool, false)}…` : refused ? (/^Refused/.test(refusal(item.output)) ? 'Stopped by a safety rule' : `Could not finish: ${stepLabel(item.tool, false).toLowerCase()}`) : stepLabel(item.tool, true)}</span>
            {refused && <span class="step-why">{refusal(item.output)}</span>}
          </div>
        );
      }
      case 'ui':
        return <div class="gen-host" ref={(el: HTMLElement) => mountComponent(el, item.component, item.props)} />;
      case 'approval':
        return <ApprovalCard item={item} clinicians={props.clinicians} decide={(yes) => void chat.decide(item.callId, yes)} />;
      case 'progress':
        return <p class="progress-line">{item.text}</p>;
      case 'error':
        return (
          <p class="chat-error" role="alert">
            {item.text}
          </p>
        );
    }
  };

  return (
    <section class="chat" aria-label="Conversation with the Demo Clinic assistant">
      <header class="chat-head">
        <div>
          <h1 class="chat-title">Hello {props.firstName}, how can we help?</h1>
          <p class="chat-sub">Clinic questions, symptom safety checks, and appointments you confirm yourself.</p>
        </div>
        <div class="chat-tools">
          <span class={() => `status status-${chat.status()}`} role="status">
            {() => (chat.status() === 'working' ? 'Working' : chat.status() === 'awaiting_approval' ? 'Waiting for you' : 'Ready')}
          </span>
          <button type="button" class="btn btn-quiet btn-small" onClick={() => navigate('/assistant?new=1')}>
            New conversation
          </button>
        </div>
      </header>

      <div class="chat-log" role="log" aria-busy={() => (chat.status() === 'working' ? 'true' : 'false')} tabindex="0" aria-label="Messages" ref={(el: HTMLElement) => (log = el)}>
        <div class="chat-stack" ref={(el: HTMLElement) => (stack = el)}>
        {() =>
          chat.items().length === 0 && (
            <div class="chat-empty">
              <p>Ask in your own words, or start with one of these:</p>
            </div>
          )
        }
        <For each={chat.items} key={(i) => i.id}>
          {(item) => render(item)}
        </For>
        {() =>
          chat.status() === 'working' && (
            <div class="thinking" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )
        }
        </div>
      </div>

      <div class="composer">
        <div class="suggestions" aria-label="Suggested questions">
          {props.suggestions.map((s) => (
            <button type="button" class="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
        {() => notice() && <p class="composer-notice">{notice()}</p>}
        <form
          class="composer-form"
          onSubmit={(e: Event) => {
            e.preventDefault();
            send(draft());
          }}
        >
          <label for="chat-input" class="sr-only">
            Message the Demo Clinic assistant
          </label>
          <textarea
            id="chat-input"
            rows="2"
            placeholder="Ask about appointments, clinic policies or how urgent a symptom is…"
            value={draft}
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
              <button type="submit" class="btn btn-primary" disabled={() => chat.status() !== 'idle'}>
                Send
              </button>
            )
          }
        </form>
        <p class="composer-fine">Not for emergencies: call 911. The assistant never diagnoses or recommends medicines, and only remembers preferences you ask it to keep.</p>
      </div>
    </section>
  );
}
