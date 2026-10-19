import type { ChatItem } from 'amoxi';

/** One event of the agent stream protocol, as stored by the run store or received over SSE. */
export interface StreamEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, any>;
}

export interface FoldState {
  streaming?: string;
}

/**
 * Folds one run event into a list of chat items, replacing only the items that change (so a
 * keyed `For` keeps the DOM, and any generative component, of every other item). The same
 * reducer renders a run on the server and follows it live in the browser.
 */
export function applyEvent(list: ChatItem[], e: StreamEvent, state: FoldState): ChatItem[] {
  const d = e.data;
  switch (e.type) {
    case 'message.delta': {
      if (!state.streaming) {
        state.streaming = `a${Math.floor(e.seq)}`;
        return [...list, { kind: 'assistant', id: state.streaming, text: String(d.text ?? ''), streaming: true }];
      }
      const id = state.streaming;
      return list.map((i) => (i.id === id && i.kind === 'assistant' ? { ...i, text: i.text + String(d.text ?? '') } : i));
    }
    case 'message.completed': {
      const text = String(d.text ?? '');
      const id = state.streaming;
      state.streaming = undefined;
      if (id && list.some((i) => i.id === id)) return list.map((i) => (i.id === id ? { kind: 'assistant', id, text } : i));
      return [...list, { kind: 'assistant', id: `a${e.seq}`, text }];
    }
    case 'tool.started':
      return [...list, { kind: 'tool', id: String(d.callId), tool: String(d.tool), input: d.input, status: 'running' }];
    case 'tool.completed': {
      let next = list.map((i) => (i.kind === 'tool' && i.id === d.callId ? { ...i, status: d.isError ? ('error' as const) : ('done' as const), output: d.output } : i));
      next = next.map((i) => (i.kind === 'approval' && i.callId === d.callId && i.status === 'pending' ? { ...i, status: d.output?.declined ? ('denied' as const) : ('approved' as const) } : i));
      return next;
    }
    case 'ui':
      if (list.some((i) => i.id === String(d.id))) return list;
      return [...list, { kind: 'ui', id: String(d.id), component: String(d.component), props: (d.props ?? {}) as Record<string, unknown> }];
    case 'approval.required':
      if (list.some((i) => i.id === `ap-${d.callId}`)) return list;
      return [...list, { kind: 'approval', id: `ap-${d.callId}`, callId: String(d.callId), tool: String(d.tool), input: d.input, reason: d.reason ?? undefined, status: 'pending' }];
    case 'progress': {
      const text = String(d.message ?? '');
      // Approval decisions are recorded as progress; reflect them on the card too.
      const decided = /^(Approved|Declined): /.exec(text);
      const base = decided
        ? list.map((i) => (i.kind === 'approval' && i.status === 'pending' && i.tool.replace(/_/g, ' ') === text.slice(decided[0].length) ? { ...i, status: decided[1] === 'Approved' ? ('approved' as const) : ('denied' as const) } : i))
        : list;
      return [...base, { kind: 'progress', id: `p${e.seq}`, text }];
    }
    case 'run.status':
      if (d.status === 'cancelled') return [...list, { kind: 'progress', id: `p${e.seq}`, text: 'Cancelled' }];
      return list;
    case 'run.failed':
      return [...list, { kind: 'error', id: `e${e.seq}`, text: String(d.error ?? 'The run failed') }];
    default:
      return list;
  }
}

export function foldEvents(events: readonly StreamEvent[]): ChatItem[] {
  const state: FoldState = {};
  return events.reduce<ChatItem[]>((list, e) => applyEvent(list, e, state), []);
}

/** Run status implied by the last status-bearing event. */
export function statusFrom(events: readonly StreamEvent[], initial: string): string {
  let status = initial;
  for (const e of events) {
    if (e.type === 'run.status' && typeof e.data.status === 'string') status = e.data.status;
    else if (e.type === 'run.completed') status = 'completed';
    else if (e.type === 'run.failed') status = 'failed';
  }
  return status;
}

/**
 * Sensible next requests after what the agents just did: assign a fresh plan, text the drivers
 * of an assigned one, or move freight to the recovery truck an incident assessment recommended.
 */
export function suggestFrom(items: readonly ChatItem[]): string[] {
  let next: string[] = [];
  for (const i of items) {
    if (i.kind !== 'tool' || i.status !== 'done') continue;
    const out = (i.output ?? {}) as { planId?: string | null; vehicleId?: string; recommendation?: { vehicleId?: string } | null };
    if (i.tool === 'plan_routes') next = out.planId ? [`Assign plan ${out.planId} to its vehicles`] : [];
    else if (i.tool === 'assign_plan' && out.planId) next = [`Notify drivers for plan ${out.planId}`];
    else if (i.tool === 'notify_drivers' || i.tool === 'reassign_shipments') next = [];
    else if (i.tool === 'assess_vehicle_incident') next = out.recommendation?.vehicleId && out.vehicleId ? [`Reassign shipments from ${out.vehicleId} to ${out.recommendation.vehicleId}`] : [];
  }
  return next;
}
