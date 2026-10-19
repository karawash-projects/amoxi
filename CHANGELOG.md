# Changelog

All notable changes to `amoxi` and `create-amoxi-app` are documented here. Both packages are released together with the same version. This project follows [Semantic Versioning](https://semver.org); until 1.0, minor versions may contain breaking changes, which are always listed.

## Unreleased

## 0.5.0

AI agents, plus a security and reliability review of the whole framework and a verification suite that every release must pass. Apps that don't use `amoxi/ai` don't load it.

### Changes that can affect 0.4.0 apps

- **CSP nonces.** Only inline scripts written in JSX (and the framework's own) receive the request's nonce. HTML inserted with `raw()` never gets one, so scripts inside it no longer run: move such scripts into a JSX `<script>` element.
- **JSX attributes.** Invalid attribute names and string event handlers (`onclick="..."`) are dropped, so spreading untrusted props can't inject markup or script. Event handlers are functions, as before. An invalid element name throws.
- **Markdown views and middleware.** For `/x.md` and `/x/index.md`, middleware and handlers see the page's own path (`ctx.path === '/x'`), so access rules written for a page cover all its views. New `ctx.representation` (`'html' | 'markdown' | 'json'`).
- **`server.trust-proxy`.** The client address is the `X-Forwarded-For` entry added by your proxy (the last one), not the first, which the client can forge. With several proxies, set the number: `server.trust-proxy=2`.
- **CLI.** `amoxi -v` / `--version` prints the version (like Next.js); verbose build output is `--verbose`. Unknown options and invalid values (`--workers 0`, `--shutdown-timeout abc`) are errors instead of being ignored.
- **MCP and A2A callers.** Callers are no longer all one owner (`mcp` / `a2a`), which let one caller list another's A2A tasks and see facts remembered for another. Give each caller its own token with `ai.mcp.callers.<name>` / `ai.a2a.callers.<name>`: it then owns its conversations as `mcp:<name>` / `a2a:<name>`. Callers that can't be told apart (one shared `token`) get an owner per conversation. Code that looked runs up by the owner `'a2a'` or `'mcp'` should use the named callers.
- **Cached pages.** A `@Cached` page that reads cookies or the session, or a response that sets a cookie, is no longer stored and is sent with `Cache-Control: private, no-store`.
- **Script URLs.** `href`, `src`, `action` and other URL attributes with a `javascript:`, `vbscript:`, `file:` or (except images) `data:` URL are dropped by JSX, on the server and in the browser.
- **WebSockets.** `socket.close()` throws a `RangeError` for close codes RFC 6455 reserves (use 1000-1003, 1007-1014 or 3000-4999) and cuts the reason to 123 bytes. Messages arrive only after `onOpen` has finished.
- **`HttpResponse.file()`** returns a `FileBody` that opens the file when the body is sent, instead of a `Readable` stream.
- **Supervisor.** `amoxi start` always replaces crashed workers (backing off up to 30 s after more than 10 crashes a minute) instead of stopping the whole service, so repeated crashes can't cause a permanent outage. It stops with exit code 1 only when workers fail while starting.

### AI agents (`amoxi/ai`)

- **Agents and tools.** `@Agent` classes and `@Tool` methods; tool JSON Schemas and argument validators are generated at build time from TypeScript types and JSDoc. Agent hooks: `principal`, `owner`, `beforeToolCall` (guardrails), `onRunFinished` (audit).
- **Durable, long-running runs.** Runs execute in background workers, not in requests; every model turn and tool result is checkpointed, so runs resume after restarts and crashes, on any worker. `ctx.step()` makes side effects idempotent. Cancellation reaches running tools through an `AbortSignal`. Programmatic and event-driven runs via the injectable `AgentPlatform`.
- **Streaming.** Agent events over Server-Sent Events (tokens, tool steps, progress, approvals) with `Last-Event-ID` resume; `eventStream()` for any route.
- **Human in the loop.** `@Tool({ approval: true })` pauses runs until a person approves or declines. Approving and cancelling at the same moment is safe: `RunStore.update()` takes an optional compare-and-set condition (`status`, `revision`, `workerId`), implemented by every built-in store across processes.
- **Generative UI.** `@generative` islands (signals or React) that agents show with validated props; browser helpers `agentChat()`, `mountComponent()` and the keyed `For` list.
- **Memory and knowledge.** Per-person long-term memory, knowledge bases with chunking and semantic search (RAG), conversation history.
- **Models.** Anthropic and OpenAI-compatible adapters (Azure OpenAI, Ollama, vLLM, Groq, Mistral) without SDKs, with retries and streaming; an offline demo model so apps and tests run without an API key; `ScriptedChatModel` for tests.
- **Storage.** Local files by default, safe to share between cluster workers; PostgreSQL with pgvector (optional `pg` package) for multi-server deployments, with a shared run queue (`FOR UPDATE SKIP LOCKED`). Every store is an interface an app can replace.
- **Agent ecosystem.** MCP server (Streamable HTTP, protocol 2026-07-28 and 2025-11-25) and A2A server (1.0 and 0.3), both opt-in and token-protected. Neither lets a calling agent approve actions by default: the action is declined and the agent explains (`ai.mcp.approvals` / `ai.a2a.approvals`: `decline`, `wait` for a person in the app, or for A2A `caller` for trusted partners).
- **Stopping runs.** Cancelling a run, or deploying, while the model is answering records the run as cancelled or puts it back in the queue; it used to be marked failed. Two requests for one conversation at the same moment (a double click, two tabs) start one run, atomically in every built-in store.
- **`ctx.callId`.** Tools get the id of their call, stable when an interrupted call is resumed: use it as an idempotency key for your own systems.
- **Tool errors.** Throw `ToolError` for messages meant for the model and the person. In production, other errors reach them only as "internal error" with a reference that is logged with the details.
- **Pages for AI agents.** Markdown (`/page.md`, `Accept: text/markdown`) and JSON (`Accept: application/json`, with `withData()`) versions of every page, `/llms.txt`, and `Link` headers; `amoxi export` writes them too, and gains `--base-path` and `--site-url`. Absolute links use `app.url` when set, otherwise a validated `Host` header.

### Framework

- **Sessions.** Sessions have an `id` and `issuedAt`, and `regenerate()` gives a session a new id (use it on sign-in). The README shows how to make sign-out final with a server-side list of sessions.
- **Caching.** Pages in several languages are cached per language, with `Vary: Accept-Language, Cookie`. Cached markdown/JSON views are kept per host.
- **Hardening.** Malformed input is answered with 400, never a crash (WebSocket paths with bad `%`-encoding, broken multipart bodies, endless multipart padding). A failed upload write answers 500. A closed WebSocket stops buffering and is dropped after 5 s. File and event-stream responses wait for slow clients instead of buffering in memory. Request bodies of known size are read and discarded before an early error response (so Windows clients receive it), and unbounded ones get `Connection: close`. Email validation and markdown conversion run in linear time; a value that fails `maxLength` skips its pattern and format checks.
- **Resource limits.** A HEAD request to a file route no longer opens the file (each one used to leave a file handle open). A WebSocket client that floods the server without reading stops being read from and is then dropped (`server.websocket.max-buffered-size`); a message can be split into at most `server.websocket.max-fragments` frames, empty ones included; a large frame sent in small pieces is joined once instead of on every piece. Clients sending reserved close codes get a protocol error. The browser client waits longer and longer before reconnecting to an event stream that keeps closing early, instead of reconnecting in a tight loop.
- **Windows.** File stores retry briefly when Windows reports a file as busy (another worker or an antivirus scanner has it open).
- **Agent runs across workers.** A worker continues a run's event numbers after the newest stored event, not only the ones it saw itself, so events are never lost or duplicated when an approval moves a run to another worker. Approvals save their events before the run can be claimed, and a worker that stalled past its lease stops without writing once another worker takes the run over, so event numbers never clash. Final events are stored before a run's status changes. Each run's in-memory event buffer is freed shortly after the run finishes or pauses.
- **OpenAI-compatible servers** that omit tool-call ids get a unique id per call (a repeated fallback id stopped tools from running after the first turn).
- The supervisor stops gracefully when asked over IPC (`{ type: 'amoxi:shutdown' }`), the only graceful option on Windows. Slow clients are disconnected close to `server.headers-timeout`. `amoxi export` no longer links to its internal 404 probe path. `getBean()` prefers an enabled `@Requires` alternative over the unconditional default, like constructor injection.
- The CLI prints plain words ("ok", "warning", "error") instead of symbols, which display reliably in every terminal.
- The package no longer ships source maps (they pointed at sources it doesn't include).

### New projects (`create-amoxi-app`)

- Asks for the template whenever it runs in a terminal, also when a project name is given.
- Runs npm, the other package managers and git without a shell, so arguments are passed exactly and Node.js 24 shows no DEP0190 warning on Windows.
- `.env` and `.env.*` files are git-ignored and left out of Docker images (`.env.example` is kept), so API keys are never committed.
- The Dockerfile creates `/app/data`, owned by the app's user, so agent runs can be saved; the `api` template keeps its `public/` folder in git.
- The Dockerfile installs with whichever lockfile the project has (npm, pnpm, yarn or bun), and says so clearly when there is none.
- Ends with exit code 1 when installing dependencies fails. A run that stops partway removes the folder it created, so running it again works. Unknown options are errors instead of taking the project name as their value.

### Examples

- Four agent-first sector examples: banking assistant, clinic assistant, shopping assistant and dispatch agent. All data is fictional: invented people, businesses, products and streets, phone numbers in the reserved 555-01xx range and `example.com` e-mail addresses.
- Banking and clinic: sign-in regenerates the session id and sign-out revokes the session on the server.
- The agent examples run one worker (`--workers 1`) because their demo data lives in memory; with PostgreSQL, use `--workers auto`.
- Demo tokens and keys live in `application-development.json` only. In production each example refuses to start while a secret is missing or still a published demo value, and says which environment variable to set.
- Banking: two identical transfers in one conversation are two transfers (the idempotency key is the tool call), and the money service itself enforces the single-transfer limit for every client. Shopping: an order is placed only if the cart still matches the one the shopper approved. Clinic: booking a slot again after cancelling it books it again. Dispatch: partner agents call with their own tokens (`ai.a2a.callers.partner`).

### Repository

- The release workflow builds and tests in one job and publishes the packed tarballs from another that runs no third-party code; pre-release tags go to the `next` dist-tag. Every GitHub Action is pinned to a commit, and npm to an exact version.
- Pull requests are checked for commit messages with AI co-author or session trailers, and need a code owner's approval (`.github/CODEOWNERS`).
- The project website has the full documentation.
- `npm run verify`: a cross-platform verification suite that builds, tests, packs and installs the packages, scaffolds new apps, runs the examples as production servers and attacks them, load-tests them, kills workers mid-run and drives them in a real browser. It writes `verify-report/report.md` and fails on any defect. See "Verifying Amoxi yourself" in the README.

## 0.4.0

First public release, under the Apache License 2.0.

### Framework (`amoxi`)

- Compile-time dependency injection: `@Singleton`, `@Prototype`, `@Eager`, `@Primary`, `@Named`, `@Factory`/`@Bean`, `@Value`, `@PostConstruct`, `@PreDestroy`, collection and optional injection, `@Requires` conditional beans, `@RequestScope` with `Provider<T>`, and `@Intercept` method interceptors. The whole graph is validated at build time.
- HTTP: controllers and routes with typed parameters, middleware, request-body validation generated from TypeScript types, file uploads (`@Multipart`), WebSockets (`@WebSocketEndpoint`), response caching with stale-while-revalidate (`@Cached`, `revalidatePath`), error pages, cookies and encrypted sessions, compression, CSP with per-request nonces, CSRF protection, CORS, health checks, graceful shutdown and structured logs.
- Pages: server-rendered JSX (`@Page`), streaming (`<Await>`), islands with signals or React (`<Name>.react.tsx`), client-side navigation with prefetching, bundled CSS, internationalisation, OpenAPI generation and static export (`amoxi export`).
- CLI: `amoxi dev` (incremental rebuilds, live refresh, error overlay, free-port fallback), `amoxi build`, `amoxi start` (one worker per CPU) and `amoxi export`.
- Works with no environment variables: the session key is generated at build time; `AMOXI_SESSION_SECRET` is optional.

### Generator (`create-amoxi-app`)

- `npx create-amoxi-app@latest my-app` with `web` and `api` templates, a Dockerfile and tests. Templates are licensed 0BSD.
