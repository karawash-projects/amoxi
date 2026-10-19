import { mountComponent, onMount, signal, type ChatItem } from 'amoxi';
import { inputSummary, plural, toolLabel } from './labels';

/** Browser-safe renderers for conversation items, shared by the planner chat and the run viewer. */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>;

interface PlanBrief {
  id: string;
  status: string;
  date: string;
  totalKm: number;
  held: number;
  routes: Array<{ vehicleId: string; driver: string; stops: number; pallets: number; km: number }>;
}

function StepRow(props: { item: ToolItem }) {
  const { item } = props;
  const summary = inputSummary(item.input);
  return (
    <div class={`step step-${item.status}`} role="group" aria-label={`${toolLabel(item.tool)}: ${item.status}`}>
      <span class="step-icon" aria-hidden="true">
        {item.status === 'running' ? <span class="spinner" /> : item.status === 'done' ? (
          <svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
        ) : (
          <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        )}
      </span>
      <span class="step-name">{toolLabel(item.tool)}</span>
      {summary ? <span class="step-args">{summary}</span> : null}
      {item.status === 'error' ? <span class="step-note">{errorOf(item.output)}</span> : null}
    </div>
  );
}

function errorOf(output: unknown): string {
  if (output && typeof output === 'object' && 'error' in output) return String((output as { error: unknown }).error).slice(0, 200);
  return 'Failed';
}

/** What the approval will do, in the dispatcher's words. */
function ApprovalDetail(props: { item: ApprovalItem }) {
  const input = (props.item.input ?? {}) as Record<string, string>;
  if (props.item.tool === 'assign_plan' && input.planId) {
    const [plan, setPlan] = signal<PlanBrief | undefined>(undefined);
    onMount(() => {
      fetch(`/api/plans/${encodeURIComponent(input.planId)}`, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<PlanBrief>) : undefined))
        .then((p) => p && setPlan(p))
        .catch(() => undefined);
    });
    return (
      <div class="approval-detail">
        <p>
          Book every routed shipment of <strong>{input.planId}</strong> on its truck. Drivers are not texted until you ask.
        </p>
        {() => {
          const p = plan();
          if (!p) return null;
          return (
            <ul class="approval-routes">
              {p.routes.map((r) => (
                <li>
                  <span class="mono-num">{r.vehicleId}</span> {r.driver}: {plural(r.stops, 'stop')}, {plural(r.pallets, 'pallet')}, {r.km} km
                </li>
              ))}
              {p.held > 0 ? <li class="held-note">{p.held} stop{p.held === 1 ? '' : 's'} held for you to place by hand</li> : null}
            </ul>
          );
        }}
      </div>
    );
  }
  if (props.item.tool === 'reassign_shipments') {
    return (
      <div class="approval-detail">
        <p>
          Move today's open freight from <strong>{input.fromVehicleId}</strong> to <strong>{input.toVehicleId}</strong> and text the recovery driver.
        </p>
      </div>
    );
  }
  return (
    <div class="approval-detail">
      <p>{props.item.reason ?? 'The agent wants to run this action.'}</p>
    </div>
  );
}

export function ApprovalCard(props: { item: ApprovalItem; onDecide: (approved: boolean) => void; busy?: () => boolean }) {
  const { item } = props;
  const title = item.tool === 'assign_plan' ? 'Approve plan assignment' : item.tool === 'reassign_shipments' ? 'Approve freight transfer' : `Approve: ${toolLabel(item.tool)}`;
  return (
    <section class={`approval approval-${item.status}`} aria-label={title}>
      <header>
        <svg class="approval-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 2.5 20h19Z" />
          <path d="M12 10v4.5M12 17v.5" />
        </svg>
        <h3>{title}</h3>
      </header>
      <ApprovalDetail item={item} />
      {item.status === 'pending' ? (
        <div class="approval-actions">
          <button type="button" class="btn btn-approve" disabled={() => props.busy?.() ?? false} onClick={() => props.onDecide(true)}>
            {item.tool === 'assign_plan' ? 'Approve and book' : 'Approve'}
          </button>
          <button type="button" class="btn btn-ghost" disabled={() => props.busy?.() ?? false} onClick={() => props.onDecide(false)}>
            Decline
          </button>
        </div>
      ) : (
        <p class={`decision decision-${item.status}`}>{item.status === 'approved' ? 'Approved' : 'Declined'}</p>
      )}
    </section>
  );
}

/** Renders one conversation item. */
export function renderItem(item: ChatItem, decide?: (callId: string, approved: boolean) => void, busy?: () => boolean): unknown {
  switch (item.kind) {
    case 'user':
      return (
        <div class="msg msg-user">
          <p>{item.text}</p>
        </div>
      );
    case 'assistant':
      return (
        <div class={item.streaming ? 'msg msg-agent streaming' : 'msg msg-agent'}>
          <p>{item.text}</p>
        </div>
      );
    case 'tool':
      return <StepRow item={item} />;
    case 'progress':
      return <p class="progress-line">{item.text}</p>;
    case 'ui':
      return <div class="gen-ui" ref={(el: HTMLElement) => mountComponent(el, item.component, item.props)} />;
    case 'approval':
      return <ApprovalCard item={item} busy={busy} onDecide={(yes) => decide?.(item.callId, yes)} />;
    case 'error':
      return (
        <p class="msg-error" role="alert">
          {item.text}
        </p>
      );
    default:
      return null;
  }
}
