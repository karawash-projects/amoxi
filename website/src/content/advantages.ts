/** Copy for the home page: advantages, the Next.js comparison and fit guidance. */

export interface Advantage {
  title: string;
  text: string;
  /** Slug of a sector example that shows it. */
  example?: string;
}

export interface AdvantageGroup {
  id: string;
  title: string;
  intro: string;
  items: Advantage[];
}

export const ADVANTAGES: AdvantageGroup[] = [
  {
    id: 'agents',
    title: 'Built for AI agents',
    intro: 'What teams usually assemble from five libraries and a job queue is part of the framework.',
    items: [
      {
        title: 'Agents that outlast the request',
        text: 'Runs execute in background workers and can take minutes. Every step is saved, so a run resumes after a deploy or a crash, on any server, without repeating payments or bookings.',
        example: 'logistics',
      },
      {
        title: 'Streaming and generative UI',
        text: 'Answers stream token by token. Agents show your own components, React ones included, with props checked against their TypeScript types.',
        example: 'retail',
      },
      {
        title: 'People stay in control',
        text: 'Sensitive actions pause until a person approves. Guardrails, audit hooks and per-user ownership of conversations are built in.',
        example: 'finance',
      },
      {
        title: 'Tool schemas from your types',
        text: 'The JSON Schema a model sees and the validator its arguments must pass are generated from your method signatures at build time. No Zod, no drift.',
      },
      {
        title: 'Memory and knowledge built in',
        text: 'Long-term memory per person and search over your documents work with no setup, and move to PostgreSQL with pgvector when you scale.',
        example: 'healthcare',
      },
      {
        title: 'Open to other agents',
        text: 'Every page is readable by AI as markdown or JSON, with /llms.txt, and your tools and agents can be offered to other agents over MCP and A2A.',
        example: 'retail',
      },
    ],
  },
  {
    id: 'speed',
    title: 'Fast where it counts',
    intro: 'The speed comes from doing the work at build time, not from tuning.',
    items: [
      {
        title: 'Starts in milliseconds',
        text: 'Wiring is generated code, so an app with 1,000 services is ready in about 11 ms. Fast start-up makes autoscaling, short-lived containers and rolling deploys cheaper and quicker.',
      },
      {
        title: 'Little JavaScript in the browser',
        text: 'Pages are server-rendered HTML. Only interactive islands send code to the browser, and each page loads only the islands it uses.',
        example: 'retail',
      },
      {
        title: 'Pages cached like Next.js ISR',
        text: 'Cached pages are served from memory and refreshed in the background, and revalidatePath updates them right after a change.',
        example: 'retail',
      },
    ],
  },
  {
    id: 'safety',
    title: 'Mistakes caught before deploy',
    intro: 'Problems that other frameworks find at runtime, Amoxi finds while it builds.',
    items: [
      {
        title: 'Wiring errors fail the build',
        text: 'A missing service, an ambiguous choice between two implementations or a dependency cycle stops the build with the file and line, instead of crashing after deploy.',
      },
      {
        title: 'Requests validated from your types',
        text: 'Request bodies are checked against their TypeScript types, with limits such as a maximum amount or an email format written as doc comments. Unknown fields are removed.',
        example: 'finance',
      },
      {
        title: 'Secure by default',
        text: 'Security headers, a Content Security Policy with a fresh nonce on every request, CSRF protection and encrypted sessions are on without any configuration.',
        example: 'healthcare',
      },
    ],
  },
  {
    id: 'operations',
    title: 'Simple to operate',
    intro: 'What operations teams usually add by hand is already there.',
    items: [
      {
        title: 'No environment variables required',
        text: 'Like Next.js, an app runs with no setup. Configuration lives in application.json, with .env files and profiles when you need them.',
      },
      {
        title: 'Production features built in',
        text: 'Liveness and readiness endpoints, graceful shutdown, JSON logs, compression, and one worker per CPU core with amoxi start.',
        example: 'logistics',
      },
      {
        title: 'Real-time and uploads included',
        text: 'WebSockets and streaming file uploads with size limits are part of the framework, so no custom server is needed.',
        example: 'logistics',
      },
    ],
  },
  {
    id: 'team',
    title: 'Easy for teams to adopt',
    intro: 'Familiar tools, and room for the code you already have.',
    items: [
      {
        title: 'Conventions you already know',
        text: 'create-amoxi-app, amoxi dev, build and start, and the project layout mirror Next.js. Developers who know Spring, Micronaut, Angular or NestJS will recognise the decorators.',
      },
      {
        title: 'Bring your React components',
        text: 'A React component can run as an island, so the design system and libraries your team already uses keep working.',
        example: 'retail',
      },
      {
        title: 'Swap behaviour with configuration',
        text: 'Choose implementations from configuration, such as built-in fraud rules or an external provider, without if-statements in your code.',
        example: 'finance',
      },
      {
        title: 'Apache License 2.0',
        text: 'Free to use in commercial and closed-source products. The licence includes a patent grant, and every runtime dependency is permissively licensed.',
      },
    ],
  },
];

export interface ComparisonRow {
  need: string;
  next: string;
  amoxi: string;
}

export const COMPARISON: ComparisonRow[] = [
  { need: 'Server-rendered pages', next: 'React Server Components', amoxi: 'JSX pages rendered to HTML on the server' },
  { need: 'Interactive parts', next: 'Client components, hydrated', amoxi: 'Islands, with signals or React, loaded only where used' },
  { need: 'API endpoints', next: 'Route handlers', amoxi: 'Controllers with typed routes' },
  { need: 'Dependency injection', next: 'Not included', amoxi: 'Built in, resolved and checked at build time' },
  { need: 'Request validation', next: 'A library such as Zod', amoxi: 'Generated from your TypeScript types' },
  { need: 'Page caching', next: 'ISR and revalidatePath', amoxi: '@Cached and revalidatePath' },
  { need: 'Sessions', next: 'cookies() plus an auth library', amoxi: 'Encrypted cookie sessions built in' },
  { need: 'WebSockets', next: 'Needs a custom server', amoxi: 'Built in' },
  { need: 'OpenAPI document', next: 'A separate library', amoxi: 'Generated from your types' },
  { need: 'Static export', next: "output: 'export'", amoxi: 'amoxi export' },
  { need: 'AI agents', next: 'Vercel AI SDK; long tasks hit function time limits on serverless hosts', amoxi: 'Built in: durable background runs that survive restarts' },
  { need: 'Agent UI', next: 'AI SDK generative UI (React)', amoxi: 'Your islands, with props validated against their types' },
  { need: 'Tool schemas', next: 'Zod', amoxi: 'Generated from your TypeScript types' },
  { need: 'MCP and A2A servers', next: 'Separate libraries', amoxi: 'Built in, off by default' },
  { need: 'Pages for AI agents', next: 'Add yourself', amoxi: 'Markdown and JSON for every page, /llms.txt' },
  { need: 'Image optimisation', next: 'next/image', amoxi: 'Not included; serve pre-sized images' },
  { need: 'Track record', next: 'Large ecosystem, widely deployed', amoxi: 'New: fully tested' },
];

export const FIT = [
  'You are adding AI agents to a product and need them to be reliable, streamed, approved and audited',
  'You build TypeScript services or full-stack apps and want start-up time and memory to stay small',
  'Your backend has many services and you want wiring mistakes caught at build time',
  'Most pages are content and forms, with interactive parts in specific places',
  'You want validation, sessions, WebSockets and uploads without assembling separate libraries',
];

// Code samples shown in "How it works", copied from examples/banking-assistant and its build output.
export const SOURCE_SAMPLE = `@Singleton()
export class BankingTools {
  /** Transfer money between two of the customer's own accounts.
      Runs only after the customer approves it. */
  @Tool({ approval: true, idempotent: true, expose: false })
  async transferBetweenAccounts(input: {
    /** Account to take the money from, e.g. CHQ-4417 */
    fromAccountId: string;
    toAccountId: string;
    /** Amount in cents @integer @minimum 1 */
    amountCents: number;
  }, ctx: ToolContext): Promise<TransferSummary> {
    const receipt = await ctx.step('post-transfer', () =>
      this.money.transfer({ customerId: customerOf(ctx), ...input }));
    ctx.ui('TransferReceipt', { ...receipt });
    return summary(receipt);
  }
}

@Agent({ tools: [BankingTools], ui: ['SpendingChart', 'TransferReceipt'],
         knowledge: ['fees'], memory: true })
export class BankingAssistant { instructions(ctx: AgentRunContext) { ... } }`;

export const BUILD_ERROR_SAMPLE = `> amoxi build

Amoxi found 1 problem(s):

  error AMOXI: src/agent/banking-assistant.ts:18
  @Agent 'BankingAssistant': ui component
  'BalanceSparkline' is not an island in src/islands/`;

export const GENERATED_SAMPLE = `tools.push({
  name: "transfer_between_accounts",
  inputSchema: {"type":"object","properties":{
    "fromAccountId":{"type":"string",
      "description":"Account to take the money from, e.g. CHQ-4417"},
    "amountCents":{"type":"integer","minimum":1}, ...},
    "required":["fromAccountId","toAccountId","amountCents"]},
  validate: (x) => $validate(x ?? {}, _V18),
  invoke: (b: C6, i, t) => b.transferBetweenAccounts(i, t),
  approval: true,
  idempotent: true,
  expose: false,
});`;
