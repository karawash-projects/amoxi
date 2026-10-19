// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { load } = require('./dist.cjs');

const { parseSse } = load('ai/models/sse');
const { retryAfterMs, extractErrorMessage, parseToolArguments, fetchWithRetry } = load('ai/models/http');
const { AnthropicChatModel, toAnthropicMessages } = load('ai/models/anthropic');
const { OpenAiChatModel } = load('ai/models/openai');
const { OfflineChatModel, extractArguments, stem } = load('ai/models/offline');
const { ScriptedChatModel } = load('ai/models/scripted');
const { createChatModel } = load('ai/models/factory');
const { ModelError } = load('ai/types');
const { Config, ConfigurationError } = load('runtime/config');

const enc = new TextEncoder();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function* chunksOf(...parts) {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p;
}
async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

/* ------------------------------------------------------------------ */
/* Local fake API server                                                */
/* ------------------------------------------------------------------ */

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))));

/** Starts a server; `handlers` are used in order (the last one repeats). */
async function fakeApi(...handlers) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
    requests.push(rec);
    const h = handlers[Math.min(requests.length - 1, handlers.length - 1)];
    try {
      await h(req, res, rec);
    } catch {
      res.destroy();
    }
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** Streams the given raw SSE pieces with a small pause between writes. */
function sse(pieces, { pause = 2, end = true } = {}) {
  return async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const p of pieces) {
      res.write(p);
      await wait(pause);
    }
    if (end) res.end();
  };
}

function json(status, body, headers = {}) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
}

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/* ------------------------------------------------------------------ */
/* SSE parser                                                           */
/* ------------------------------------------------------------------ */

describe('parseSse', () => {
  test('handles LF, CRLF and CR line endings, comments and multi-line data', async () => {
    const events = await collect(parseSse(chunksOf(': comment\n', 'event: a\ndata: one\ndata: two\n\n', 'data: crlf\r\n\r\n', 'data: cr\r\rdata:nospace\n\n')));
    assert.deepEqual(events, [{ event: 'a', data: 'one\ntwo' }, { data: 'crlf' }, { data: 'cr' }, { data: 'nospace' }]);
  });

  test('events, CRLF and UTF-8 characters split across chunks (one byte per chunk)', async () => {
    const bytes = enc.encode('data: héllo \u{1F600}\r\n\r\nevent: x\r\ndata: 2\r\n\r\n');
    const pieces = [...bytes].map((b) => new Uint8Array([b]));
    const events = await collect(parseSse(chunksOf(...pieces)));
    assert.deepEqual(events, [{ data: 'héllo \u{1F600}' }, { event: 'x', data: '2' }]);
  });

  test('id persists, retry is parsed, empty data events are skipped, unterminated final event is dropped', async () => {
    const events = await collect(parseSse(chunksOf('id: 7\ndata: a\n\n', 'retry: 3000\ndata: b\n\n', 'event: noop\n\n', 'data\n\n', 'data: tail')));
    assert.deepEqual(events, [{ data: 'a', id: '7' }, { data: 'b', id: '7', retry: 3000 }, { data: '', id: '7' }]);
  });

  test('accepts a ReadableStream and strips a BOM', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('﻿data: x\n\n'));
        c.close();
      },
    });
    assert.deepEqual(await collect(parseSse(stream)), [{ data: 'x' }]);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

describe('http helpers', () => {
  test('retry-after parsing', () => {
    assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' })), 250);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
    const now = Date.parse('2026-10-18T00:00:00Z');
    assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Sun, 18 Oct 2026 00:00:03 GMT' }), now), 3000);
    assert.equal(retryAfterMs(new Headers({})), undefined);
  });

  test('error message extraction', () => {
    assert.equal(extractErrorMessage('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'), 'bad (invalid_request_error)');
    assert.equal(extractErrorMessage('{"error":"model not found"}'), 'model not found');
    assert.equal(extractErrorMessage('<html>oops</html>'), '<html>oops</html>');
  });

  test('tool argument parsing', () => {
    assert.deepEqual(parseToolArguments(''), {});
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
    assert.deepEqual(parseToolArguments('{"a":'), { __invalid_json: '{"a":' });
  });

  test('network errors are retried, then reported as ModelError', async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    await assert.rejects(fetchWithRetry(failing, 'http://x', {}, { maxRetries: 2, baseDelayMs: 1 }), (e) => e instanceof ModelError && e.retryable && /fetch failed/.test(e.message));
    assert.equal(calls, 3);
  });
});

/* ------------------------------------------------------------------ */
/* Anthropic                                                            */
/* ------------------------------------------------------------------ */

const KEY = 'sk-ant-test-SECRET-123456';

const conversation = [
  { role: 'user', content: [{ type: 'text', text: 'Balance?' }, { type: 'text', text: '  ' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_call', id: 'tu_1', name: 'get_balance', input: { accountId: 'A-1' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'tu_1', name: 'get_balance', output: { cents: 1200 } },
      { type: 'ui', id: 'u1', component: 'Balance', props: {} },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'Thanks, and in euros?' }] },
];
const tools = [{ name: 'get_balance', description: 'Gets a balance.', inputSchema: { type: 'object', properties: { accountId: { type: 'string' } } } }];

describe('AnthropicChatModel', () => {
  test('streams text, ignores thinking/ping/unknown events, assembles split tool JSON, reports usage', async () => {
    const toolJson = '{"accountId": "A-1", "currency": "EUR"}';
    const api = await fakeApi(
      sse([
        ev('message_start', { message: { id: 'm', usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 1 } } }),
        ev('ping', {}),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret thoughts' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello' } }),
        // an event split mid-JSON across writes
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,',
        '"delta":{"type":"text_delta","text":" world"}}\n\n',
        ev('content_block_stop', { index: 1 }),
        ev('future_event', { foo: 1 }),
        ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_balance', input: {} } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '' } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: toolJson.slice(0, 7) } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: toolJson.slice(7, 23) } }),
        ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: toolJson.slice(23) } }),
        ev('content_block_stop', { index: 2 }),
        ev('content_block_start', { index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'noargs', input: {} } }),
        ev('content_block_stop', { index: 3 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
        ev('message_stop', {}),
      ]),
    );
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'claude-test', baseUrl: api.url + '/', temperature: 0.2 });
    const events = await collect(model.stream({ system: 'Be brief.', messages: conversation, tools, toolChoice: 'required', maxTokens: 100 }));
    assert.deepEqual(events, [
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_balance', input: { accountId: 'A-1', currency: 'EUR' } },
      { type: 'tool_call', id: 'toolu_2', name: 'noargs', input: {} },
      { type: 'usage', inputTokens: 18, outputTokens: 42 },
      { type: 'finish', reason: 'tool_calls' },
    ]);

    const [req] = api.requests;
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], KEY);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(req.body, {
      model: 'claude-test',
      max_tokens: 100,
      system: 'Be brief.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Balance?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu_1', name: 'get_balance', input: { accountId: 'A-1' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '{"cents":1200}' },
            { type: 'text', text: 'Thanks, and in euros?' },
          ],
        },
      ],
      tools: [{ name: 'get_balance', description: 'Gets a balance.', input_schema: tools[0].inputSchema }],
      tool_choice: { type: 'any' },
      stream: true,
      temperature: 0.2,
    });
  });

  test('message mapping: leading assistant gets a user message, errors flagged, string outputs kept', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'c', name: 't', output: 'boom', isError: true }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'd', name: 't', output: [1, 2] }] },
    ]);
    assert.equal(out[0].role, 'user');
    assert.equal(out[1].role, 'assistant');
    assert.deepEqual(out[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c', content: 'boom', is_error: true },
        { type: 'tool_result', tool_use_id: 'd', content: '[1,2]' },
      ],
    });
  });

  test('finish reasons and invalid tool JSON', async () => {
    const api = await fakeApi(
      sse([
        ev('message_start', { message: { usage: { input_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'x', input: {} } }),
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a": tru' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } }),
        ev('message_stop', {}),
      ]),
    );
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url });
    const events = await collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
    assert.deepEqual(events[0], { type: 'tool_call', id: 't', name: 'x', input: { __invalid_json: '{"a": tru' } });
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'max_tokens' });
    assert.equal(api.requests[0].body.tools, undefined);
    assert.equal(api.requests[0].body.max_tokens, 4096);
  });

  test('retries 429 (retry-after) and 529 (retry-after-ms), then succeeds', async () => {
    const ok = sse([ev('message_start', { message: { usage: { input_tokens: 2 } } }), ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), ev('message_stop', {})]);
    const api = await fakeApi(
      json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0' }),
      json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { 'retry-after-ms': '5' }),
      ok,
    );
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url });
    const events = await collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
    assert.equal(api.requests.length, 3);
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  });

  test('gives up after maxRetries with a retryable ModelError', async () => {
    const api = await fakeApi(json(503, { error: { message: 'unavailable' } }, { 'retry-after': '0' }));
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url, maxRetries: 1 });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => e instanceof ModelError && e.status === 503 && e.retryable === true);
    assert.equal(api.requests.length, 2);
  });

  test('400 error: provider message extracted, not retried, key never leaked', async () => {
    const api = await fakeApi(json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 1e9 > 64000' } }));
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => {
      assert.ok(e instanceof ModelError);
      assert.equal(e.status, 400);
      assert.equal(e.retryable, false);
      assert.match(e.message, /max_tokens: 1e9 > 64000/);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    assert.equal(api.requests.length, 1);
  });

  test('mid-stream error event throws ModelError', async () => {
    const api = await fakeApi(sse([ev('message_start', { message: { usage: { input_tokens: 2 } } }), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]));
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => e instanceof ModelError && /Overloaded/.test(e.message) && e.retryable);
  });

  test('abort via signal while streaming', async () => {
    const api = await fakeApi(
      sse([ev('message_start', { message: { usage: { input_tokens: 2 } } }), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } })], { end: false }),
    );
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url });
    const ctl = new AbortController();
    const seen = [];
    await assert.rejects(
      (async () => {
        for await (const e of model.stream({ messages: [], signal: ctl.signal })) {
          seen.push(e);
          ctl.abort();
        }
      })(),
      (e) => e.name === 'AbortError',
    );
    assert.deepEqual(seen, [{ type: 'text', delta: 'Hi' }]);
  });

  test('stalled stream fails with the idle timeout', async () => {
    const api = await fakeApi(sse([ev('message_start', { message: { usage: { input_tokens: 2 } } })], { end: false }));
    const model = new AnthropicChatModel({ apiKey: KEY, model: 'm', baseUrl: api.url, idleTimeoutMs: 80 });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => e instanceof ModelError && /stalled/.test(e.message));
  });
});

/* ------------------------------------------------------------------ */
/* OpenAI-compatible                                                    */
/* ------------------------------------------------------------------ */

const OKEY = 'sk-openai-test-SECRET-987654';
const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('OpenAiChatModel', () => {
  test('streams content, assembles interleaved tool calls by index, usage chunk, [DONE]', async () => {
    const api = await fakeApi(
      sse([
        chunk({ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }], obfuscation: 'xyz' }),
        chunk({ choices: [{ index: 0, delta: { content: 'Let me ' } }] }),
        chunk({ choices: [{ index: 0, delta: { content: 'look.' } }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"tz"' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':"UTC"}' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 12, total_tokens: 43 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const model = new OpenAiChatModel({ apiKey: OKEY, model: 'gpt-test', baseUrl: api.url + '/v1', maxTokens: 300, headers: { 'api-key': 'azure-key-1' } });
    const events = await collect(model.stream({ system: 'Sys.', messages: conversation, tools, toolChoice: 'auto' }));
    assert.deepEqual(events, [
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
      { type: 'tool_call', id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_call', id: 'call_b', name: 'get_time', input: { tz: 'UTC' } },
      { type: 'usage', inputTokens: 31, outputTokens: 12 },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    const [req] = api.requests;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${OKEY}`);
    assert.equal(req.headers['api-key'], 'azure-key-1');
    assert.deepEqual(req.body, {
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Sys.' },
        { role: 'user', content: 'Balance?' },
        { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'get_balance', arguments: '{"accountId":"A-1"}' } }] },
        { role: 'tool', tool_call_id: 'tu_1', content: '{"cents":1200}' },
        { role: 'user', content: 'Thanks, and in euros?' },
      ],
      tools: [{ type: 'function', function: { name: 'get_balance', description: 'Gets a balance.', parameters: tools[0].inputSchema } }],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
    });
  });

  test('servers that omit tool-call ids get a unique id per call, so later turns still run their tools', async () => {
    const turn = () =>
      sse([
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ]);
    const api = await fakeApi(turn(), turn());
    const model = new OpenAiChatModel({ model: 'llama', baseUrl: api.url });
    const first = (await collect(model.stream({ messages: [] }))).find((e) => e.type === 'tool_call');
    const second = (await collect(model.stream({ messages: [] }))).find((e) => e.type === 'tool_call');
    assert.ok(first.id && second.id);
    assert.notEqual(first.id, second.id);
  });

  test('max_completion_tokens only for api.openai.com; no auth header without key; null content for tool-only turns', () => {
    const official = new OpenAiChatModel({ apiKey: 'k', model: 'm', maxTokens: 50 });
    const body = official.buildBody({ messages: [{ role: 'assistant', content: [{ type: 'tool_call', id: 'x', name: 'f', input: {} }] }] });
    assert.equal(body.max_completion_tokens, 50);
    assert.equal(body.max_tokens, undefined);
    assert.deepEqual(body.messages[0], { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] });
  });

  test('finish reason length and content_filter; local server without key', async () => {
    const api = await fakeApi(
      sse([chunk({ choices: [{ index: 0, delta: { content: 'abc' }, finish_reason: 'length' }] }), 'data: [DONE]\n\n']),
      sse([chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }), 'data: [DONE]\n\n']),
    );
    const model = new OpenAiChatModel({ model: 'llama', baseUrl: api.url });
    const a = await collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));
    assert.deepEqual(a.at(-1), { type: 'finish', reason: 'max_tokens' });
    const b = await collect(model.stream({ messages: [] }));
    assert.deepEqual(b.at(-1), { type: 'finish', reason: 'refusal' });
    assert.equal(api.requests[0].headers.authorization, undefined);
  });

  test('401 error: message extracted, key redacted', async () => {
    const api = await fakeApi(json(401, { error: { message: `Incorrect API key provided: ${OKEY}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
    const model = new OpenAiChatModel({ apiKey: OKEY, model: 'm', baseUrl: api.url });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /Incorrect API key provided/);
      assert.ok(!e.message.includes(OKEY));
      return true;
    });
  });

  test('stream that ends without [DONE] or finish_reason is an error', async () => {
    const api = await fakeApi(sse([chunk({ choices: [{ index: 0, delta: { content: 'part' } }] })]));
    const model = new OpenAiChatModel({ model: 'm', baseUrl: api.url, maxRetries: 0 });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => e instanceof ModelError && /ended before/.test(e.message));
  });
});

/* ------------------------------------------------------------------ */
/* Offline model                                                        */
/* ------------------------------------------------------------------ */

const NOW = () => new Date(2026, 9, 18, 10, 0, 0);
const bankTools = [
  {
    name: 'get_account_balance',
    description: 'Returns the balance of a bank account. Read only.',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: 'The account ID, e.g. ACC-1234' } }, required: ['accountId'] },
  },
  {
    name: 'transfer_money',
    description: 'Transfers money between two accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        fromAccountId: { type: 'string', description: 'The account to take the money from' },
        toAccountId: { type: 'string', description: 'The account that receives the money' },
        amountCents: { type: 'integer', minimum: 1, description: 'The amount to transfer' },
        currency: { type: 'string', enum: ['USD', 'EUR'] },
        memo: { type: 'string' },
      },
      required: ['fromAccountId', 'toAccountId', 'amountCents'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Books an appointment with a doctor.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date' },
        kind: { type: 'string', enum: ['checkup', 'dental_cleaning'] },
        email: { type: 'string', format: 'email' },
        urgent: { type: 'boolean' },
        guests: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['date', 'kind', 'email'],
    },
  },
  { name: 'search_help', description: 'Searches the help center articles.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'remember', description: 'Saves a fact about the customer for later.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'show_balance_card', description: 'Shows a balance card.', inputSchema: { type: 'object', properties: {} } },
];

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const offline = new OfflineChatModel({ delayMs: 0, now: NOW });
async function ask(text, extra = {}) {
  const events = await collect(offline.stream({ messages: [user(text)], tools: bankTools, ...extra }));
  return {
    events,
    text: events.filter((e) => e.type === 'text').map((e) => e.delta).join(''),
    call: events.find((e) => e.type === 'tool_call'),
    finish: events.find((e) => e.type === 'finish').reason,
  };
}

describe('OfflineChatModel', () => {
  test('stemming is consistent', () => {
    assert.equal(stem('balances'), stem('balance'));
    assert.equal(stem('transferred'), stem('transfer'));
    assert.equal(stem('booking'), stem('book'));
  });

  test('picks a tool by keywords and reads an id', async () => {
    const r = await ask("What's the balance on account ACC-1234?");
    assert.deepEqual(r.call, { type: 'tool_call', id: 'offline_1', name: 'get_account_balance', input: { accountId: 'ACC-1234' } });
    assert.equal(r.text, 'Let me check that.');
    assert.equal(r.finish, 'tool_calls');
    assert.ok(r.events.filter((e) => e.type === 'text').length > 1, 'streams word by word');
    assert.ok(r.events.some((e) => e.type === 'usage' && e.inputTokens > 0 && e.outputTokens > 0));
  });

  test('money to cents, two ids in order, enum by case-insensitive match', async () => {
    const r = await ask('Please transfer $1,250.50 from ACC-1 to ACC-2 in eur, memo "rent"');
    assert.equal(r.call.name, 'transfer_money');
    assert.deepEqual(r.call.input, { fromAccountId: 'ACC-1', toAccountId: 'ACC-2', amountCents: 125050, currency: 'EUR', memo: 'rent' });
  });

  test('dates (tomorrow), enum words, email, boolean, range limits', async () => {
    const r = await ask('Book a dental cleaning appointment tomorrow for jo@example.com with 7 guests, urgent: yes');
    assert.equal(r.call.name, 'book_appointment');
    assert.deepEqual(r.call.input, { date: '2026-10-19', kind: 'dental_cleaning', email: 'jo@example.com', urgent: true });
    const iso = extractArguments(bankTools[2].inputSchema, 'checkup on 2026-12-01, a@b.io, 2 guests, no', NOW());
    assert.deepEqual(iso.args, { date: '2026-12-01', kind: 'checkup', email: 'a@b.io', urgent: false, guests: 2 });
  });

  test('missing arguments: asks in plain words instead of calling', async () => {
    const r = await ask('I want to transfer money to ACC-9');
    assert.equal(r.call, undefined);
    assert.equal(r.finish, 'stop');
    assert.match(r.text, /need a bit more information/);
    assert.match(r.text, /The amount to transfer/);
    assert.match(r.text, /The account that receives the money/);
    const e = extractArguments({ type: 'object', properties: { orderId: { type: 'string', description: 'The order number, e.g. ORD-1001.' } }, required: ['orderId'] }, 'where is it?');
    assert.deepEqual(e.missing, ['The order number, e.g. ORD-1001']);
    assert.deepEqual(extractArguments({ type: 'object', properties: { orderId: { type: 'string' } } }, 'status of order #12345').args, { orderId: '12345' });
  });

  test('free-text query and remember only when asked', async () => {
    const s = await ask('search the help center for refund policy');
    assert.deepEqual(s.call.input, { query: 'search the help center for refund policy' });
    const m = await ask('Remember that I prefer email');
    assert.equal(m.call.name, 'remember');
    const n = await ask('a fact about the customer for later');
    assert.notEqual(n.call?.name, 'remember');
  });

  test('help reply when nothing matches', async () => {
    const r = await ask('hello there');
    assert.equal(r.call, undefined);
    assert.match(r.text, /offline demo mode/);
    assert.match(r.text, /- Returns the balance of a bank account\./);
    assert.match(r.text, /ANTHROPIC_API_KEY or OPENAI_API_KEY/);
    assert.doesNotMatch(r.text, /balance card/);
    assert.doesNotMatch(r.text, /Read only/);
  });

  test('summarises tool results: objects, money, arrays, errors, show_* tools', async () => {
    const run = async (content) => {
      const events = await collect(offline.stream({ messages: [user('x'), { role: 'tool', content }], tools: bankTools }));
      return events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    };
    const obj = await run([{ type: 'tool_result', callId: 'c', name: 'get_account_balance', output: { accountId: 'ACC-1234', balanceCents: 123456, frozen: false } }]);
    assert.match(obj, /Account ID: ACC-1234/);
    assert.match(obj, /Balance: \$1,234\.56/);
    assert.match(obj, /Frozen: No/);
    const arr = await run([{ type: 'tool_result', callId: 'c', name: 'list', output: Array.from({ length: 10 }, (_, i) => ({ name: `Item ${i}`, priceCents: 100 * i })) }]);
    assert.match(arr, /- Name: Item 0, Price: \$0\.00/);
    assert.match(arr, /and 2 more/);
    const err = await run([{ type: 'tool_result', callId: 'c', name: 'x', output: { error: 'Account not found' }, isError: true }]);
    assert.equal(err, "That didn't work: Account not found");
    const shown = await run([{ type: 'tool_result', callId: 'c', name: 'show_balance_card', output: { ok: true } }]);
    assert.match(shown, /shown the details above/);
  });

  test('tool call ids count previous calls; toolChoice none answers in text', async () => {
    const events = await collect(
      offline.stream({
        messages: [user('a'), { role: 'assistant', content: [{ type: 'tool_call', id: 'offline_1', name: 'x', input: {} }] }, { role: 'tool', content: [] }, user('balance of ACC-7')],
        tools: bankTools,
      }),
    );
    assert.equal(events.find((e) => e.type === 'tool_call').id, 'offline_2');
    const none = await ask('balance of ACC-7', { toolChoice: 'none' });
    assert.equal(none.call, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Scripted model                                                       */
/* ------------------------------------------------------------------ */

describe('ScriptedChatModel', () => {
  test('plays turns, records requests, errors and exhaustion', async () => {
    const model = new ScriptedChatModel([
      { toolCalls: [{ name: 'f', input: { a: 1 } }] },
      (req) => ({ text: `You said ${req.messages.length} things and more words here`, usage: { inputTokens: 5, outputTokens: 6 } }),
      { error: 'provider down' },
    ]);
    const t1 = await collect(model.stream({ messages: [user('hi')] }));
    assert.deepEqual(t1, [
      { type: 'tool_call', id: 'call_1_1', name: 'f', input: { a: 1 } },
      { type: 'usage', inputTokens: 0, outputTokens: 0 },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    const t2 = await collect(model.stream({ messages: [user('a'), user('b')] }));
    const texts = t2.filter((e) => e.type === 'text');
    assert.ok(texts.length > 1);
    assert.equal(texts.map((e) => e.delta).join(''), 'You said 2 things and more words here');
    assert.deepEqual(t2.at(-2), { type: 'usage', inputTokens: 5, outputTokens: 6 });
    await assert.rejects(collect(model.stream({ messages: [] })), (e) => e instanceof ModelError && e.message === 'provider down');
    await assert.rejects(collect(model.stream({ messages: [] })), /script has 3 turn\(s\)/);
    assert.equal(model.requests.length, 4);
  });
});

/* ------------------------------------------------------------------ */
/* Factory                                                              */
/* ------------------------------------------------------------------ */

describe('createChatModel', () => {
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn() {}, error() {}, debug() {} };

  test('test profile: auto is always offline, with no delay', () => {
    const m = createChatModel(Config.of({ 'anthropic.api.key': 'sk-ant-xyz' }, 'test'), logger);
    assert.equal(m.provider, 'offline');
    assert.equal(m.delayMs, 0);
  });

  test('auto picks anthropic, then openai, then offline', () => {
    logs.length = 0;
    const a = createChatModel(Config.of({ 'anthropic.api.key': 'sk-ant-xyz', 'openai.api.key': 'sk-o' }, 'development'), logger);
    assert.equal(a.provider, 'anthropic');
    assert.equal(a.model, 'claude-sonnet-5-5');
    assert.deepEqual(logs, ['AI provider: anthropic (claude-sonnet-5-5)']);
    const o = createChatModel(Config.of({ ai: { openai: { 'api-key': 'sk-o', model: 'gpt-x' } } }, 'development'));
    assert.equal(o.provider, 'openai');
    assert.equal(o.model, 'gpt-x');
    const local = createChatModel(Config.of({ 'openai.base.url': 'http://localhost:11434/v1' }, 'development'));
    assert.equal(local.provider, 'openai');
    assert.equal(local.model, 'gpt-6-luna');
    logs.length = 0;
    const off = createChatModel(Config.of({}, 'development'), logger);
    assert.equal(off.provider, 'offline');
    assert.equal(off.delayMs, 15);
    assert.match(logs[0], /offline demo model \(set ANTHROPIC_API_KEY or OPENAI_API_KEY/);
    assert.ok(!logs.join().includes('sk-'));
  });

  test('explicit providers', () => {
    const m = createChatModel(Config.of({ ai: { provider: 'anthropic', anthropic: { 'api-key': 'k1', model: 'claude-x' } } }, 'test'));
    assert.equal(m.provider, 'anthropic');
    assert.equal(m.model, 'claude-x');
    assert.throws(() => createChatModel(Config.of({ ai: { provider: 'anthropic' } }, 'development')), (e) => e instanceof ConfigurationError && /ANTHROPIC_API_KEY/.test(e.message));
    assert.throws(() => createChatModel(Config.of({ ai: { provider: 'openai' } }, 'development')), (e) => e instanceof ConfigurationError && /OPENAI_API_KEY/.test(e.message));
    assert.throws(() => createChatModel(Config.of({ ai: { provider: 'gemini' } })), ConfigurationError);
    assert.equal(createChatModel(Config.of({ ai: { provider: 'offline', offline: { 'delay-ms': 3 } } }, 'development')).delayMs, 3);
  });
});
