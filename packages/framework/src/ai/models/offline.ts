// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { ChatMessage, ChatModel, ChatRequest, JsonSchema, ModelEvent, ToolResultPart, ToolSpec } from '../types';
import { sleep } from './http';

export interface OfflineChatModelOptions {
  /** Delay between streamed words, in ms. Default 15; use 0 in tests. */
  readonly delayMs?: number;
  /** Minimum keyword score for a tool to be called. Default 2 (one description word + ... or one name word). */
  readonly minScore?: number;
  /** Clock used for "today"/"tomorrow" (tests). Default: the system clock. */
  readonly now?: () => Date;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set(
  (
    'a an the and or but if of to in on at for with by from about as into onto over under than then so too very just also ' +
    'is are was were be been being am do does did doing done have has had having will would shall should can could may might must ' +
    'i me my mine myself you your yours we our ours us he him his she her it its they them their this that these those there here ' +
    'what which who whom whose how when where why all any some each every no not nor only own same such ' +
    'please want wanted need needs like let lets know tell give get got much many more most other again now ok okay hi hello hey thanks thank'
  ).split(' '),
);

/** Crude English stemmer: strips -ing/-ed/-es/-s, then a final 'e' and a doubled consonant, so "balances" ≈ "balance". */
export function stem(word: string): string {
  let s = word;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Lower-case word stems without punctuation and English stop words. */
export function tokenize(text: string): string[] {
  return words(text)
    .filter((w) => !STOP_WORDS.has(w))
    .map(stem);
}

/** Splits snake_case, kebab-case and camelCase identifiers into lower-case words. */
function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const ACRONYMS: Record<string, string> = { id: 'ID', ids: 'IDs', url: 'URL', iban: 'IBAN', api: 'API', uuid: 'UUID' };

/** "accountBalance" / "account_balance" → "Account balance". */
export function humanize(name: string): string {
  const w = splitIdentifier(name).map((x) => ACRONYMS[x] ?? x);
  if (w.length === 0) return name;
  const first = w[0];
  w[0] = first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1);
  return w.join(' ');
}

function firstSentence(text: string): string {
  const t = text.trim();
  for (const m of t.matchAll(/[.!?](?=\s|$)/g)) {
    const before = t.slice(0, m.index + 1);
    if (/(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|incl|no|mr|mrs|dr)\.$/i.test(before)) continue; // abbreviations
    return before.replace(/\s+/g, ' ');
  }
  return t.replace(/\s+/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

function textOf(message: ChatMessage | undefined): string {
  if (!message) return '';
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n')
    .trim();
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Tool selection (keyword scoring)                                     */
/* ------------------------------------------------------------------ */

/** Scores tools against the user's text: name words weigh 3, description words 1. */
export function scoreTools(text: string, tools: readonly ToolSpec[]): Array<{ tool: ToolSpec; score: number }> {
  const user = new Set(tokenize(text));
  const wantsMemory = /\b(remember|note|save)\b/i.test(text);
  return tools.map((tool) => {
    if (tool.name === 'remember' && !wantsMemory) return { tool, score: 0 };
    // Generative UI tools need props a real model composes; tools show UI themselves via ctx.ui().
    if (tool.name.startsWith('show_')) return { tool, score: 0 };
    const nameTokens = new Set(splitIdentifier(tool.name).filter((w) => !STOP_WORDS.has(w)).map(stem));
    const descTokens = new Set(tokenize(tool.description ?? ''));
    let score = 0;
    for (const u of user) {
      if (nameTokens.has(u)) score += 3;
      if (descTokens.has(u)) score += 1;
    }
    return { tool, score };
  });
}

/* ------------------------------------------------------------------ */
/* Argument extraction                                                  */
/* ------------------------------------------------------------------ */

type Schema = Record<string, any>;

/** Resolves `anyOf`/`oneOf` and nullable type arrays to the first concrete schema. */
function concrete(schema: Schema): Schema {
  const variants = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (Array.isArray(variants)) {
    const v = variants.find((x) => x && x.type !== 'null');
    if (v) return { ...v, description: schema.description ?? v.description };
  }
  if (Array.isArray(schema.type)) return { ...schema, type: schema.type.find((t: string) => t !== 'null') };
  return schema;
}

const TEXT_PROPS = new Set(['query', 'q', 'text', 'question', 'message', 'search', 'topic']);
const MONEY_WORDS = new Set(['amount', 'price', 'cost', 'total', 'cents', 'fee', 'balance', 'sum', 'payment', 'value']);

interface NumberCandidate {
  readonly value: number;
  readonly currency: boolean;
  used: boolean;
}

/** Facts pulled out of the user's text once, then handed to properties. */
class TextFacts {
  readonly emails: string[];
  readonly uuids: string[];
  readonly dateTimes: string[];
  readonly dates: string[];
  readonly quoted: string[];
  readonly ids: string[];
  readonly digitIds: string[];
  readonly numbers: NumberCandidate[] = [];
  readonly wordSet: Set<string>;
  readonly stemSet: Set<string>;
  private readonly lower: string;

  constructor(
    readonly text: string,
    now: Date,
  ) {
    this.lower = text.toLowerCase();
    const allWords = words(text);
    this.wordSet = new Set(allWords);
    this.stemSet = new Set(allWords.map(stem));
    let rest = text;
    const take = (re: RegExp): string[] => {
      const found = rest.match(re) ?? [];
      rest = rest.replace(re, ' ');
      return found;
    };
    this.quoted = [...text.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
    this.emails = take(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    this.uuids = take(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
    this.dateTimes = take(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g).map((s) => s.replace(' ', 'T'));
    const isoDates = take(/\b\d{4}-\d{2}-\d{2}\b/g);
    const relative: string[] = [];
    for (const [word, days] of [
      ['today', 0],
      ['tomorrow', 1],
      ['yesterday', -1],
    ] as const) {
      const idx = this.lower.search(new RegExp(`\\b${word}\\b`));
      if (idx >= 0) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12);
        relative.push(`${idx}:${localDate(d)}`);
      }
    }
    this.dates = [...this.dateTimes.map((s) => s.slice(0, 10)), ...isoDates, ...relative.sort((a, b) => parseInt(a) - parseInt(b)).map((s) => s.split(':')[1])];
    // Identifiers: ABC-1234 style first, then letters+digits tokens (not ordinals, times or sizes).
    const dashIds = take(/\b[A-Za-z]{1,12}-\d[A-Za-z0-9-]*\b/g);
    const mixed = (rest.match(/(?<![$€£\w.,])(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{4,}\b/g) ?? []).filter(
      (t) => !/^\d+(st|nd|rd|th|am|pm|k|m|x|h|hrs?|mins?|kg|km|gb|mb)$/i.test(t),
    );
    for (const t of mixed) rest = rest.replace(new RegExp(`\\b${escapeRegExp(t)}\\b`), ' ');
    this.ids = [...this.uuids, ...dashIds, ...mixed];
    this.digitIds = (rest.match(/(?<![$€£\d.,])#?\b\d{4,}\b(?![.,]\d)/g) ?? []).map((s) => s.replace('#', ''));
    const numberRe = /([$€£])?\s?(?<![\w.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![\w.]?\d)(\s*(?:dollars?|usd|eur|euros?|gbp|pounds?|bucks)\b)?/gi;
    for (const m of rest.matchAll(numberRe)) {
      const value = Number(m[2].replace(/,/g, ''));
      if (Number.isFinite(value)) this.numbers.push({ value, currency: Boolean(m[1] || m[3]), used: false });
    }
  }

  /** Marks a digit-only id as used so it is not also read as a number. */
  consumeDigitId(id: string): void {
    const n = Number(id);
    const c = this.numbers.find((x) => !x.used && x.value === n && !x.currency);
    if (c) c.used = true;
  }

  containsPhrase(value: string): boolean {
    const v = value.toLowerCase().trim();
    if (!v) return false;
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'u').test(this.lower)) return true;
    const parts = splitIdentifier(value);
    return parts.length > 0 && parts.every((p) => this.wordSet.has(p) || this.stemSet.has(stem(p)));
  }
}

/** Result of reading a tool's arguments out of free text. */
export interface ExtractedArguments {
  readonly args: Record<string, unknown>;
  /** Plain-words descriptions of required properties that could not be filled. */
  readonly missing: string[];
}

function inRange(value: number, s: Schema): boolean {
  if (typeof s.minimum === 'number' && value < s.minimum) return false;
  if (typeof s.maximum === 'number' && value > s.maximum) return false;
  if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return false;
  if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return false;
  return true;
}

/**
 * Builds tool arguments from the user's text using the JSON schema (enums, money amounts,
 * dates, emails, ids, booleans, free-text queries, quoted phrases). Deterministic.
 */
export function extractArguments(inputSchema: JsonSchema, text: string, now: Date = new Date()): ExtractedArguments {
  const props = (inputSchema.properties ?? {}) as Record<string, Schema>;
  const required = new Set<string>(Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : []);
  const facts = new TextFacts(text, now);
  const args: Record<string, unknown> = {};
  const names = Object.keys(props);
  const nameWords = (n: string) => splitIdentifier(n);
  const isIdName = (n: string) => nameWords(n).some((w) => w === 'id' || w === 'ids' || w === 'reference' || w === 'ref');
  // Identifiers first, so digit-only ids are not read as amounts.
  const ordered = [...names.filter((n) => isIdName(n)), ...names.filter((n) => !isIdName(n))];
  let quoteIndex = 0;
  const usedIds = new Set<string>();

  for (const name of ordered) {
    const s = concrete(props[name] ?? {});
    const lname = name.toLowerCase();
    let value: unknown;

    if ('const' in s) {
      value = s.const;
    } else if (Array.isArray(s.enum)) {
      value = s.enum.find((v: unknown) => (typeof v === 'string' || typeof v === 'number') && facts.containsPhrase(String(v)));
    } else if (s.type === 'number' || s.type === 'integer') {
      const cents = /cents$/i.test(name);
      const money = cents || nameWords(name).some((w) => MONEY_WORDS.has(w));
      const pools = money
        ? [facts.numbers.filter((c) => c.currency), facts.numbers.filter((c) => !c.currency)]
        : [facts.numbers.filter((c) => !c.currency), facts.numbers.filter((c) => c.currency)];
      outer: for (const pool of pools) {
        for (const c of pool) {
          if (c.used) continue;
          const v = cents ? Math.round(c.value * 100) : c.value;
          if (s.type === 'integer' && !Number.isInteger(v)) continue;
          if (!inRange(v, s)) continue;
          c.used = true;
          value = v;
          break outer;
        }
      }
    } else if (s.type === 'boolean') {
      for (const w of words(text)) {
        if (w === 'yes' || w === 'true') {
          value = true;
          break;
        }
        if (w === 'no' || w === 'false') {
          value = false;
          break;
        }
      }
    } else if (s.type === 'string' || s.type === undefined) {
      if (s.format === 'email') value = facts.emails[0];
      else if (s.format === 'uuid') value = facts.uuids[0];
      else if (s.format === 'date') value = facts.dates[0];
      else if (s.format === 'date-time') value = facts.dateTimes[0] ?? (facts.dates[0] ? `${facts.dates[0]}T00:00:00Z` : undefined);
      else if (isIdName(name)) {
        value = facts.ids.find((x) => !usedIds.has(x)) ?? facts.digitIds.find((x) => !usedIds.has(x));
        if (typeof value === 'string') {
          usedIds.add(value);
          if (/^\d+$/.test(value)) facts.consumeDigitId(value);
        }
      } else if (TEXT_PROPS.has(lname)) value = text.trim() || undefined;
      else if (/email/i.test(name)) value = facts.emails[0];
      else if (quoteIndex < facts.quoted.length) value = facts.quoted[quoteIndex++];
    }

    if (value === undefined && 'default' in s && required.has(name)) value = s.default;
    if (value !== undefined) args[name] = value;
  }

  const missing = names
    .filter((n) => required.has(n) && !(n in args))
    .map((n) => {
      const d = concrete(props[n] ?? {}).description;
      if (typeof d !== 'string' || !d.trim()) return humanize(n).toLowerCase();
      const plain = d.trim().replace(/\s+/g, ' ');
      return (plain.length > 160 ? firstSentence(plain) : plain).replace(/\.$/, '');
    });
  return { args, missing };
}

/* ------------------------------------------------------------------ */
/* Result summaries                                                     */
/* ------------------------------------------------------------------ */

const MAX_ITEMS = 8;
const MAX_FIELDS = 12;
const MAX_SUMMARY = 4000;

function label(key: string): string {
  return humanize(key.replace(/_?cents$/i, '') || key);
}

function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'number') return /cents$/i.test(key) && Number.isInteger(v) ? formatMoney(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (Array.isArray(v)) {
    const shown = v.slice(0, MAX_ITEMS).map((x) => (x !== null && typeof x === 'object' ? inlineObject(x as Record<string, unknown>) : formatValue(key, x)));
    return shown.join(', ') + (v.length > MAX_ITEMS ? ` and ${v.length - MAX_ITEMS} more` : '');
  }
  return inlineObject(v as Record<string, unknown>);
}

function inlineObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v === null || typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${label(k)}: ${formatValue(k, v)}`)
    .join(', ');
}

function bullets(items: readonly unknown[], indent = ''): string[] {
  const lines = items.slice(0, MAX_ITEMS).map((x) => `${indent}- ${x !== null && typeof x === 'object' && !Array.isArray(x) ? inlineObject(x as Record<string, unknown>) : formatValue('', x)}`);
  if (items.length > MAX_ITEMS) lines.push(`${indent}- and ${items.length - MAX_ITEMS} more`);
  return lines;
}

function summarizeOutput(output: unknown): string {
  if (output === null || output === undefined) return 'Done.';
  if (typeof output === 'string') return output.trim() || 'Done.';
  if (typeof output !== 'object') return `Result: ${formatValue('', output)}`;
  if (Array.isArray(output)) return output.length === 0 ? "I didn't find anything." : `Here's what I found:\n${bullets(output).join('\n')}`;
  const entries = Object.entries(output as Record<string, unknown>);
  if (entries.length === 0) return 'Done.';
  const lines: string[] = [];
  for (const [k, v] of entries.slice(0, MAX_FIELDS)) {
    if (Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object')) {
      lines.push(`${label(k)}:`, ...bullets(v, '  '));
    } else {
      lines.push(`${label(k)}: ${formatValue(k, v)}`);
    }
  }
  if (entries.length > MAX_FIELDS) lines.push(`and ${entries.length - MAX_FIELDS} more fields`);
  return `Here's what I found:\n${lines.join('\n')}`;
}

function errorText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.message === 'string') return o.message;
  }
  try {
    return JSON.stringify(output) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/** Readable text for the results of the last tool calls. */
/** Knowledge search results read as an answer with its source, not as a data dump. */
function summarizeKnowledge(output: unknown): string {
  const hits = (output as { results?: Array<{ title?: string; text?: string }> } | null)?.results ?? [];
  if (hits.length === 0) return "I couldn't find anything about that in our documents.";
  const [top, ...rest] = hits;
  const excerpt = String(top.text ?? '').replace(/\s+/g, ' ').trim();
  const short = excerpt.length > 420 ? `${excerpt.slice(0, 420).replace(/\s+\S*$/, '')}…` : excerpt;
  const more = rest.map((h) => h.title).filter(Boolean).slice(0, 2);
  return `${top.title ? `From "${top.title}": ` : ''}${short}${more.length ? `\n\nSee also: ${more.join(', ')}.` : ''}`;
}

export function summarizeResults(results: readonly ToolResultPart[]): string {
  const parts: string[] = [];
  let shown = false;
  for (const r of results) {
    let text: string;
    if (r.isError) text = `That didn't work: ${errorText(r.output)}`;
    else if (r.name.startsWith('show_')) {
      if (shown) continue;
      shown = true;
      text = "I've shown the details above.";
    } else if (r.name === 'search_knowledge') text = summarizeKnowledge(r.output);
    else text = summarizeOutput(r.output);
    parts.push(results.length > 1 && !r.name.startsWith('show_') ? `${humanize(r.name)}:\n${text}` : text);
  }
  const out = parts.join('\n\n') || 'Done.';
  return out.length > MAX_SUMMARY ? `${out.slice(0, MAX_SUMMARY)}…` : out;
}

/* ------------------------------------------------------------------ */
/* The model                                                            */
/* ------------------------------------------------------------------ */

/**
 * A deterministic, rule-based stand-in for an LLM, used when no provider key is configured so
 * demos and tests work out of the box. It picks a tool by keyword overlap, reads arguments from
 * the text with the tool's JSON schema, summarises tool results, and otherwise explains how to
 * configure a real model.
 */
export class OfflineChatModel implements ChatModel {
  readonly provider = 'offline';
  readonly model = 'amoxi-offline';
  private readonly delayMs: number;
  private readonly minScore: number;
  private readonly now: () => Date;

  constructor(options: OfflineChatModelOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 15);
    this.minScore = options.minScore ?? 2;
    this.now = options.now ?? (() => new Date());
  }

  async *stream(request: ChatRequest): AsyncGenerator<ModelEvent> {
    const { text, call } = this.respond(request);
    const signal = request.signal;
    if (signal?.aborted) throw signal.reason;
    const pieces = text.match(/\s*\S+\s*/g) ?? [];
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && this.delayMs > 0) await sleep(this.delayMs, signal);
      if (signal?.aborted) throw signal.reason;
      yield { type: 'text', delta: pieces[i] };
    }
    if (call) yield { type: 'tool_call', ...call };
    const inputChars = (request.system?.length ?? 0) + JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
    const outputChars = text.length + (call ? JSON.stringify(call).length : 0);
    yield { type: 'usage', inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(outputChars / 4) };
    yield { type: 'finish', reason: call ? 'tool_calls' : 'stop' };
  }

  /** Decides the whole reply up front (pure and deterministic given the clock). */
  private respond(request: ChatRequest): { text: string; call?: { id: string; name: string; input: unknown } } {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    const tools = request.tools ?? [];

    const results = last ? (last.content.filter((p) => p.type === 'tool_result') as ToolResultPart[]) : [];
    if (results.length > 0) {
      // A tool already showed a component (generative UI): point to it instead of repeating its data.
      const shown = last!.content.some((p) => p.type === 'ui');
      if (shown && results.every((r) => !r.isError)) return { text: "Here you go: I've put the details above." };
      return { text: summarizeResults(results) };
    }

    const userText = last?.role === 'user' ? textOf(last) : '';
    if (userText && tools.length > 0 && request.toolChoice !== 'none') {
      const scored = scoreTools(userText, tools);
      let best: { tool: ToolSpec; score: number } | undefined;
      for (const s of scored) if (!best || s.score > best.score) best = s;
      if (best && best.score >= this.minScore) {
        const { args, missing } = extractArguments(best.tool.inputSchema ?? {}, userText, this.now());
        if (missing.length === 0) {
          const n = messages.reduce((acc, m) => acc + m.content.filter((p) => p.type === 'tool_call').length, 0) + 1;
          return { text: 'Let me check that.', call: { id: `offline_${n}`, name: best.tool.name, input: args } };
        }
        return {
          text:
            `I can help with that (${humanize(best.tool.name).toLowerCase()}), but I need a bit more information:\n` +
            missing.map((m) => `- ${m}`).join('\n') +
            '\n\nPlease include it in your message.',
        };
      }
      // A question no tool matched: look it up in the agent's knowledge base, if it has one.
      const knowledge = tools.find((t) => t.name === 'search_knowledge');
      if (knowledge && /\?\s*$|^\s*(what|how|why|when|where|which|who|can|do|does|is|are|should)\b/i.test(userText)) {
        const n = messages.reduce((acc, m) => acc + m.content.filter((p) => p.type === 'tool_call').length, 0) + 1;
        return { text: 'Let me look that up.', call: { id: `offline_${n}`, name: knowledge.name, input: { query: userText.trim().slice(0, 500) } } };
      }
    }
    return { text: this.helpText(tools, Boolean(userText)) };
  }

  private helpText(tools: readonly ToolSpec[], hadQuestion: boolean): string {
    const lines: string[] = [];
    lines.push(
      (hadQuestion && tools.length > 0 ? "I couldn't match that to something I can do. " : '') +
        "I'm running in offline demo mode: no AI provider key is configured, so I follow simple keyword rules instead of a real language model.",
    );
    const visible = tools.filter((t) => !t.name.startsWith('show_') && t.description);
    if (visible.length > 0) {
      lines.push('', 'I can help with:');
      for (const t of visible.slice(0, 6)) lines.push(`- ${firstSentence(t.description)}`);
      lines.push('', 'Try asking about one of these in your own words.');
    }
    lines.push('', 'To use a real model, set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env and restart the app.');
    return lines.join('\n');
  }
}
