import { ApplicationContext, Singleton } from 'amoxi';
import { createChatModel, type ChatModel, type ChatRequest, type ModelEvent } from 'amoxi/ai';

/**
 * Post-check on everything the model writes: sentences that state a diagnosis or recommend a
 * medicine or dose are replaced before the patient sees them (and before they are saved), and an
 * answer after an emergency screen always opens with the emergency number. The instructions
 * already ask for this; the check makes it a guarantee instead of a hope.
 */

const CONDITIONS =
  'infection|disease|disorder|syndrome|cancer|diabetes|flu|influenza|pneumonia|migraine|strep(?: throat)?|covid|asthma|depression|bronchitis|sinusitis|uti|hypertension|tumou?r|fracture|appendicitis|heart attack|angina|stroke|concussion|shingles|eczema|psoriasis|allergy';
const MEDICINES = 'ibuprofen|acetaminophen|paracetamol|tylenol|advil|aspirin|antibiotics?|amoxicillin|penicillin|prednisone|codeine|naproxen|antihistamines?|benadryl|melatonin|sertraline|steroids?';

const FORBIDDEN: readonly RegExp[] = [
  new RegExp(`\\byou (?:probably |likely |most likely |definitely |clearly |may |might |could )?(?:have|'ve got|have got|are suffering from|are having) (?:a |an |some )?(?:[a-z-]+ ){0,2}(?:${CONDITIONS})\\b`, 'i'),
  new RegExp(`\\b(?:sounds|looks|seems) like (?:you have )?(?:a |an )?(?:[a-z-]+ ){0,2}(?:${CONDITIONS})\\b`, 'i'),
  new RegExp(`\\b(?:this|it) (?:is|'s) (?:probably|likely|almost certainly|definitely) (?:a |an )?(?:[a-z-]+ ){0,2}(?:${CONDITIONS})\\b`, 'i'),
  /\b(?:my|the likely|a likely|your) diagnosis (?:is|would be)\b/i,
  /\bI (?:would )?diagnose\b/i,
  new RegExp(`\\b(?:take|try|start|use|increase|double|give (?:him|her|them|your child)) (?:\\d+(?:\\.\\d+)?\\s?(?:mg|milligrams?|ml|mcg|tablets?|pills?|capsules?)|(?:some |an? |the )?(?:${MEDICINES}))\\b`, 'i'),
  /\b\d+(?:\.\d+)?\s?(?:mg|mcg)\b.{0,40}\b(?:every|twice|once|daily|hours?)\b/i,
  /\bI (?:can |will |'ll )?(?:prescribe|renew your prescription)\b/i,
];

export const SAFETY_REPLACEMENT =
  "[Removed by Demo Clinic's safety check: the assistant can't diagnose conditions or recommend medicines or doses. A clinician can assess this with you, and I can book that visit.]";

/** True when a sentence diagnoses or prescribes. */
export function violatesClinicalPolicy(sentence: string): boolean {
  return FORBIDDEN.some((re) => re.test(sentence));
}

/**
 * Filters a model's event stream sentence by sentence: text is held until a sentence ends (so a
 * forbidden sentence is never shown, not even for a moment), then passed on or replaced.
 * Tool calls, usage and finish events pass through in order.
 */
export async function* clinicalSafetyFilter(events: AsyncIterable<ModelEvent>, onBlocked?: (sentence: string) => void, lead?: string): AsyncGenerator<ModelEvent> {
  let buffer = '';
  let replaced = false;
  let needsLead = lead;
  const release = (raw: string): ModelEvent | undefined => {
    if (!raw) return undefined;
    // After an emergency screen the answer must open with the emergency number.
    let text = raw;
    if (needsLead) {
      if (!/\b911\b|9-8-8/.test(text)) text = `${needsLead} ${text}`;
      needsLead = undefined;
    }
    if (!violatesClinicalPolicy(text)) return { type: 'text', delta: text };
    onBlocked?.(text);
    if (replaced) return undefined;
    replaced = true;
    return { type: 'text', delta: `${SAFETY_REPLACEMENT}${/\s$/.test(text) ? text.match(/\s+$/)![0] : ' '}` };
  };
  for await (const ev of events) {
    if (ev.type !== 'text') {
      const out = release(buffer);
      buffer = '';
      if (out) yield out;
      yield ev;
      continue;
    }
    buffer += ev.delta;
    // Release every complete sentence (end punctuation followed by whitespace, or a line break).
    for (;;) {
      const m = /[.!?](?=\s)\s*|\n+/.exec(buffer);
      if (!m) break;
      const end = m.index + m[0].length;
      const out = release(buffer.slice(0, end));
      buffer = buffer.slice(end);
      if (out) yield out;
    }
  }
  const out = release(buffer);
  if (out) yield out;
}

/**
 * When the last tool result is an emergency screen, the sentence the answer must open with.
 * The model is told to do this; the post-check makes sure it happens, whatever the model writes.
 */
export function emergencyLead(request: ChatRequest): string | undefined {
  const last = request.messages[request.messages.length - 1];
  const screen = last?.content.find((p) => p.type === 'tool_result' && p.name === 'check_symptom_urgency' && !p.isError) as { output?: { urgency?: string; callNow?: string } } | undefined;
  if (screen?.output?.urgency !== 'emergency') return undefined;
  return screen.output.callNow === '988'
    ? 'If you are in danger now, call 911; you can also call or text 9-8-8 at any time.'
    : 'Call 911 now or go to the nearest emergency department.';
}

/** Wraps any chat model with the clinical post-check. */
export function safeguard(inner: ChatModel, onBlocked?: (sentence: string) => void): ChatModel {
  return {
    provider: inner.provider,
    model: inner.model,
    stream: (request: ChatRequest) => clinicalSafetyFilter(inner.stream(request), onBlocked, emergencyLead(request)),
  };
}

/**
 * The app's ChatModel: the configured provider (Anthropic, OpenAI-compatible or the offline demo
 * model, chosen from configuration exactly as Amoxi would) behind the clinical post-check.
 * Declaring a bean that implements ChatModel replaces the built-in one everywhere.
 */
@Singleton()
export class SafeguardedChatModel implements ChatModel {
  private inner?: ChatModel;
  /** Sentences removed since startup (for monitoring). */
  blocked = 0;

  constructor(private readonly context: ApplicationContext) {}

  private base(): ChatModel {
    return (this.inner ??= createChatModel(this.context.config));
  }

  get provider(): string {
    return this.base().provider;
  }

  get model(): string {
    return this.base().model;
  }

  stream(request: ChatRequest): AsyncIterable<ModelEvent> {
    return clinicalSafetyFilter(this.base().stream(request), () => this.blocked++, emergencyLead(request));
  }
}
