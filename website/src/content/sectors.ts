/** The sector example apps in examples/, as presented on the site. */

export interface SectorFeature {
  /** The Amoxi feature, in plain words. */
  feature: string;
  /** Why it matters in this sector. */
  why: string;
}

export interface Screen {
  /** File in public/shots/ without extension; "-desktop.jpg" and "-mobile.jpg" variants exist. */
  file: string;
  caption: string;
}

export interface Sector {
  slug: string;
  sector: string;
  /** Fictional company the example is built for. */
  brand: string;
  folder: string;
  /** One line: what the app is. */
  summary: string;
  /** The business problem, in the sector's own terms. */
  problem: string;
  /** Three outcomes a team gets from building it this way. */
  outcomes: string[];
  features: SectorFeature[];
  screens: Screen[];
  /** Brand colour of the example app, used as a thin accent next to its screenshots. */
  accent: string;
  port: number;
}

export const SECTORS: Sector[] = [
  {
    slug: 'finance',
    sector: 'Finance and banking',
    brand: 'Demo Bank',
    folder: 'examples/banking-assistant',
    summary: 'A banking assistant that answers from the customer\'s real accounts and moves money only with their approval.',
    problem:
      'Banks want an assistant that can act, not just chat, without giving up control: it must only touch the signed-in customer\'s accounts, respect limits, never move money twice, ask before anything irreversible, and leave an audit trail that shows if anyone edited it.',
    outcomes: [
      'Transfers and card freezes pause until the customer approves them in the conversation',
      'Guardrails refuse over-limit transfers and other customers\' accounts before anyone is asked',
      'Every action lands in a hash-chained audit log that detects tampering',
    ],
    features: [
      { feature: 'Tools with approval', why: 'Money-moving tools need the customer\'s confirmation; nothing runs before it, and a declined action is reported back to the agent.' },
      { feature: 'Guardrails and principals', why: 'The agent acts as the signed-in customer only; beforeToolCall refuses limits and foreign accounts as a second line of defence.' },
      { feature: 'Idempotent steps (ctx.step)', why: 'A transfer interrupted by a restart is never posted twice.' },
      { feature: 'Generative UI', why: 'Balances, transactions, a spending chart and transfer receipts appear as components, not walls of text.' },
      { feature: 'Knowledge base (RAG)', why: 'Fee and policy questions are answered from the bank\'s own documents.' },
      { feature: 'Interceptors and audit hooks', why: 'Every call to the transfer service and every run is recorded in a tamper-evident log.' },
      { feature: 'MCP, read-only', why: 'Only the public exchange-rate quote is offered to outside AI agents; customer tools stay private.' },
    ],
    screens: [
      { file: 'finance-assistant', caption: 'Spending insights as a chart' },
      { file: 'finance-approval', caption: 'Transfer waiting for approval' },
      { file: 'finance-receipt', caption: 'Receipt after approval' },
    ],
    accent: '#1F5C4A',
    port: 8081,
  },
  {
    slug: 'healthcare',
    sector: 'Healthcare',
    brand: 'Demo Clinic',
    folder: 'examples/clinic-assistant',
    summary: 'A patient assistant that books appointments, answers policy questions and screens urgency safely, without ever diagnosing.',
    problem:
      'Clinics want patients to book and get answers at any hour, but an assistant must never diagnose, must send emergencies to emergency care immediately, must keep each patient\'s data private, and must let partner organisations send referrals without exposing patient records.',
    outcomes: [
      'Red-flag symptoms trigger emergency guidance and a clear notice, never a diagnosis',
      'Bookings and cancellations wait for the patient\'s confirmation and can\'t be made for someone else',
      'Patients can see a pseudonymous log of every access to their data',
    ],
    features: [
      { feature: 'Safety checks on answers', why: 'A wrapper around the model holds back any sentence that diagnoses or recommends a medicine, so it is never shown or saved.' },
      { feature: 'Tools with approval', why: 'The patient confirms each booking and cancellation; double bookings are refused.' },
      { feature: 'Guardrails', why: 'Booking for another patient is refused before the patient is ever asked to confirm.' },
      { feature: 'Generative UI', why: 'Clinician cards, a time-slot picker, confirmations and an emergency notice the patient can act on.' },
      { feature: 'Knowledge base (RAG)', why: 'Cancellation, vaccination, prescription and privacy questions are answered from clinic policies, with the section cited.' },
      { feature: 'Memory with consent', why: 'Only preferences such as a preferred clinician or language are remembered, never clinical details.' },
      { feature: 'A2A for partners', why: 'Pharmacies and hospitals send referrals agent to agent, and the clinic can tell partner requests apart from patients.' },
    ],
    screens: [
      { file: 'healthcare-slots', caption: 'Choosing a time slot' },
      { file: 'healthcare-approval', caption: 'Confirming a booking' },
      { file: 'healthcare-emergency', caption: 'Red-flag symptoms' },
    ],
    accent: '#2E6F78',
    port: 8082,
  },
  {
    slug: 'retail',
    sector: 'Retail and e-commerce',
    brand: 'Demo Outdoor Store',
    folder: 'examples/shopping-assistant',
    summary: 'A shopping assistant that sells through product cards and comparisons, remembers sizes, and is open to shopping agents.',
    problem:
      'Stores want conversational shopping that converts: showing products instead of describing them, remembering what a customer wears, confirming totals before charging, and being findable by the AI shopping agents customers increasingly send on their behalf.',
    outcomes: [
      'Products, comparisons and the cart appear as interactive components in the conversation',
      'Orders are placed only after the shopper confirms the total, and never twice',
      'External shopping agents can search the catalog over MCP, A2A and /llms.txt',
    ],
    features: [
      { feature: 'Generative UI, React included', why: 'The product carousel is a React component the agent shows with validated props; the rest of the store ships little JavaScript.' },
      { feature: 'Memory', why: 'Sizes and preferences are remembered across visits and recalled when relevant.' },
      { feature: 'Tools with approval', why: 'Placing an order and starting a return wait for the shopper\'s confirmation.' },
      { feature: 'Knowledge base (RAG)', why: 'Gear guides and the returns policy answer "which bag for -10°C?" style questions.' },
      { feature: 'Agentic commerce', why: 'Search and comparison tools are offered to outside agents over MCP and A2A, and every product page has markdown and JSON versions.' },
      { feature: 'Cached pages with revalidation', why: 'Catalog pages are served from cache and refreshed when an order changes stock.' },
    ],
    screens: [
      { file: 'retail-assistant', caption: 'Products as a carousel' },
      { file: 'retail-compare', caption: 'Comparing two products' },
      { file: 'retail-order', caption: 'Confirming an order' },
    ],
    accent: '#3F5A2B',
    port: 8083,
  },
  {
    slug: 'logistics',
    sector: 'Logistics and operations',
    brand: 'Demo Freight',
    folder: 'examples/dispatch-agent',
    summary: 'A dispatch agent that plans routes for minutes in the background and reacts to vehicle events on its own.',
    problem:
      'Operations teams need agents that work like colleagues: planning a day\'s routes takes many slow steps, breakdowns happen while nobody is typing, and a deploy in the middle of planning must not lose the work or message drivers twice.',
    outcomes: [
      'Route planning runs for minutes in the background, with live progress and cancellation',
      'Telematics events start an exception-handling agent with no human typing',
      'A run interrupted by a restart resumes without notifying drivers twice',
    ],
    features: [
      { feature: 'Durable long-running runs', why: 'Planning survives deploys and crashes, resuming from its last step on any server.' },
      { feature: 'Event-driven agents', why: 'A webhook starts the exception handler through the injectable AgentPlatform; schedules can too.' },
      { feature: 'Progress streaming and cancellation', why: 'Dispatchers see each step as it happens and can stop a plan mid-way.' },
      { feature: 'Tools with approval', why: 'Assigning a plan to vehicles waits for the dispatcher; analysis runs straight away.' },
      { feature: 'Generative UI', why: 'The proposed plan appears as a route map with stops and vehicles.' },
      { feature: 'MCP and A2A', why: 'Partner carriers\' agents request capacity quotes and track shipments.' },
    ],
    screens: [
      { file: 'logistics-console', caption: 'Operations console' },
      { file: 'logistics-plan', caption: 'Route plan from a long run' },
      { file: 'logistics-exception', caption: 'Exception from a vehicle event' },
    ],
    accent: '#24476B',
    port: 8084,
  },
];

export const sectorBySlug = (slug: string): Sector | undefined => SECTORS.find((s) => s.slug === slug);
