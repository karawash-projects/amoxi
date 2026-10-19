import { Controller, ErrorPage, Island, Page, PathParam, QueryParam, type RequestContext, withData, withStatus } from 'amoxi';
import { AgentPlatform, TERMINAL_STATUSES, toChatItems, userOwner, type ChatItem, type RunStore } from 'amoxi/ai';
import { CLINIC, CLINICIANS, HOURS, PATIENTS, POLICIES, clinicianById, initialsOf } from '../domain/clinic-data';
import { addDays, clinicParts, dateLabel, dayName, shortDateLabel, timeLabel } from '../domain/time';
import { LANGUAGE_LABELS, SPECIALTY_LABELS, type Clinician, type Language, type Patient, type Specialty } from '../domain/types';
import Assistant from '../islands/Assistant';
import CareSidebar from '../islands/CareSidebar';
import PatientPicker from '../islands/PatientPicker';
import { AccessLog, type Access } from '../services/access-log';
import { ClinicDirectory } from '../services/clinic-directory';
import type { Clock } from '../services/clock';
import { PatientRecords } from '../services/patient-records';
import type { AppointmentView } from '../ui/cards';
import { Layout } from '../ui/layout';
import { currentPatient } from '../web/patient-session';

const AGENT = 'clinic-assistant';

/** An in-progress run the chat island continues after a reload. */
interface ResumeRun {
  id: string;
  status: string;
  lastSeq: number;
}
const AS_PORTAL: Access = { actor: 'patient-portal', purpose: 'You opened the assistant page' };

const SUGGESTIONS = [
  'Find a clinician who speaks French',
  'Show available slots tomorrow',
  'How do I prepare for a blood test?',
  'What is the cancellation policy?',
  'Check my symptoms: chest pain spreading to my left arm',
  'Show my upcoming appointments',
  'Remember my preference: "I prefer Dr. Obrelle, in French"',
];

const ACTOR_LABELS: Record<string, string> = {
  assistant: 'Demo Clinic assistant (AI), for you',
  'patient-portal': 'You, in the patient portal',
  'partner-agent': 'Partner organisation agent (A2A)',
  'front-desk': 'Front desk staff',
};

const SPECIALTIES = Object.keys(SPECIALTY_LABELS) as Specialty[];
const LANGUAGES = Object.keys(LANGUAGE_LABELS) as Language[];

function HoursTable(props: { today: number }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <table class="hours">
      <caption class="sr-only">Opening hours</caption>
      <tbody>
        {order.map((d) => {
          const h = HOURS.find((x) => x.day === d)!;
          return (
            <tr class={d === props.today ? 'is-today' : undefined}>
              <th scope="row">
                {dayName(d)}
                {d === props.today && <span class="sr-only"> (today)</span>}
              </th>
              <td>{h.open && h.close ? `${timeLabel(h.open)} to ${timeLabel(h.close)}` : 'Closed'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UrgencyLadder() {
  const steps: Array<[string, string, string]> = [
    ['routine', 'Routine', 'Book a regular visit with your clinician.'],
    ['soon', 'Within days', 'A visit in the next 2 to 3 days.'],
    ['urgent', 'Today', 'Same-day urgent visit or urgent care.'],
    ['emergency', 'Emergency', 'Call 911 now. The assistant says so first.'],
  ];
  return (
    <ol class="ladder" aria-label="Urgency levels, from routine to emergency">
      {steps.map(([key, label, text]) => (
        <li class={`rung rung-${key}`}>
          <span class="rung-label">{label}</span>
          <span class="rung-text">{text}</span>
        </li>
      ))}
    </ol>
  );
}

function ClinicianRow(props: { c: Clinician; next?: string }) {
  const c = props.c;
  return (
    <li class="roster-row">
      <span class={`avatar avatar-lg spec-${SPECIALTY_LABELS[c.specialty].toLowerCase().replace(/[^a-z]+/g, '-')}`} aria-hidden="true">
        {initialsOf(c.name)}
      </span>
      <div class="roster-main">
        <h3>
          <a href={`/clinicians/${c.id}`}>{c.name}</a>
        </h3>
        <p class="roster-role">
          {c.role}, {SPECIALTY_LABELS[c.specialty]}
        </p>
        <p class="roster-langs">Speaks {c.languages.map((l) => LANGUAGE_LABELS[l]).join(', ')}</p>
      </div>
      <p class={c.accepting ? 'roster-status' : 'roster-status muted'}>{c.accepting ? (props.next ? `Next opening ${props.next}` : 'Accepting patients') : 'Not accepting new patients'}</p>
    </li>
  );
}

/** Server-rendered pages. Each is also available as markdown (/page.md) and JSON for other agents. */
@Controller()
export class Pages {
  constructor(
    private readonly directory: ClinicDirectory,
    private readonly records: PatientRecords,
    private readonly accessLog: AccessLog,
    private readonly platform: AgentPlatform,
    private readonly runStore: RunStore,
    private readonly clock: Clock,
  ) {}

  private nextOpen(c: Clinician): string | undefined {
    if (!c.accepting) return undefined;
    const d = this.records.nextOpenDate(c.id, this.directory.today());
    return d ? shortDateLabel(d) : undefined;
  }

  private views(patientId: string): AppointmentView[] {
    const now = this.clock.now().getTime();
    return this.records.appointmentsOf(AS_PORTAL, patientId).map((a) => {
      const c = clinicianById(a.clinicianId);
      return { id: a.id, clinician: c?.name ?? a.clinicianId, role: c?.role ?? '', dateLabel: dateLabel(a.date), timeLabel: timeLabel(a.time), startsAt: a.startsAt, reason: a.reason, within24h: Date.parse(a.startsAt) - now < 24 * 3600_000 };
    });
  }

  @Page('/')
  home(ctx: RequestContext) {
    const patient = currentPatient(ctx);
    const status = this.directory.openStatus();
    const today = clinicParts(this.clock.now()).weekday;
    return (
      <Layout title="Family clinic in Toronto" description="Demo Clinic: family medicine, pediatrics, women's health and a patient assistant that books appointments and screens symptoms safely." active="home" patient={patient}>
        <section class="hero">
          <div class="hero-copy">
            <p class={status.open ? 'open-pill is-open' : 'open-pill'}>{status.label}</p>
            <h1>Family care on Larkvane Lane, and an assistant that knows its limits.</h1>
            <p class="lede">
              Seven clinicians, one front desk, and a patient assistant that answers clinic questions, checks how urgent a symptom is and books appointments you confirm yourself. It never
              diagnoses, never suggests medicines, and every look at your record is logged for you to see.
            </p>
            <div class="hero-actions">
              <a class="btn btn-primary btn-large" href="/assistant">
                Open the assistant
              </a>
              <a class="btn btn-outline btn-large" href="/clinicians">
                Meet the clinicians
              </a>
            </div>
          </div>
          <aside class="charter" aria-labelledby="charter-title">
            <h2 id="charter-title">What the assistant does, and never does</h2>
            <div class="charter-cols">
              <div>
                <h3>Does</h3>
                <ul class="ticks">
                  <li>Answers questions from the clinic handbook, with the source</li>
                  <li>Screens symptoms for red flags and tells you how soon to get care</li>
                  <li>Shows open times and books or cancels when you confirm</li>
                  <li>Remembers preferences you ask it to, like a clinician or language</li>
                </ul>
              </div>
              <div>
                <h3>Never</h3>
                <ul class="crosses">
                  <li>Diagnoses or names a likely condition</li>
                  <li>Recommends, renews or doses medicines</li>
                  <li>Books for anyone but the signed-in patient</li>
                  <li>Keeps symptoms or health details in memory</li>
                </ul>
              </div>
            </div>
          </aside>
        </section>

        <section class="band" aria-labelledby="urgency-title">
          <div class="band-head">
            <h2 id="urgency-title">How urgency is decided</h2>
            <p>
              When you describe a symptom, published red-flag rules (chest pain, trouble breathing, stroke signs, severe bleeding, thoughts of suicide) set the level, not the language model. For an
              emergency the first thing you read is to call 911.
            </p>
          </div>
          <UrgencyLadder />
        </section>

        <section class="split" aria-labelledby="services-title">
          <div>
            <h2 id="services-title">Services</h2>
            <dl class="services">
              <dt>Family medicine</dt>
              <dd>Check-ups, chronic-condition follow-up, sick visits and same-day urgent slots every weekday morning.</dd>
              <dt>Children and teens</dt>
              <dd>Well-baby checks, development, school forms and childhood vaccinations with Dr. Tsaoray.</dd>
              <dt>Women's health</dt>
              <dd>Cervical screening, contraception and prenatal check-ins with Priya Ravelund, NP.</dd>
              <dt>Mental health</dt>
              <dd>Longer appointments for anxiety, low mood and sleep with Dr. Wierzbolan.</dd>
              <dt>Nursing clinic</dt>
              <dd>Blood tests, vaccinations, flu shots and blood-pressure checks, six days a week.</dd>
              <dt>Dermatology</dt>
              <dd>Visiting dermatologist by referral, including referrals from partner pharmacies and hospitals.</dd>
            </dl>
          </div>
          <div class="hours-card">
            <h2>Hours</h2>
            <HoursTable today={today} />
            <p class="address">
              {CLINIC.address}
              <br />
              Front desk <a href={`tel:${CLINIC.phone}`}>{CLINIC.phone}</a>
            </p>
          </div>
        </section>

        <section class="band band-plain" aria-labelledby="team-title">
          <div class="band-head">
            <h2 id="team-title">Clinicians</h2>
            <p>Between them they speak ten languages. The assistant can find the right person for you.</p>
          </div>
          <ul class="roster">
            {CLINICIANS.slice(0, 4).map((c) => (
              <ClinicianRow c={c} next={this.nextOpen(c)} />
            ))}
          </ul>
          <p>
            <a href="/clinicians">All {CLINICIANS.length} clinicians</a>
          </p>
        </section>

        <section class="split split-privacy" aria-labelledby="privacy-title">
          <div>
            <h2 id="privacy-title">Your privacy, shown not promised</h2>
            <p>
              Every time the assistant, a partner organisation or the portal touches your record, a line is added to your access log, using a pseudonymous code instead of your name. Signed-in
              patients can read their own log on <a href="/my-data">Who accessed my data</a>.
            </p>
            <p>Assistant pages are never cached and never send your address bar to other sites.</p>
          </div>
          <div>
            <h2>For pharmacies and hospitals</h2>
            <p>
              Partner organisations' agents can send referral requests straight to the referral desk over the open Agent2Agent protocol. They can't read patient records through it.{' '}
              <a href="/partners">How partners connect</a>
            </p>
          </div>
        </section>
      </Layout>
    );
  }

  @Page('/clinicians')
  clinicians(@QueryParam() specialty: string | undefined, @QueryParam() language: string | undefined, ctx: RequestContext) {
    const s = SPECIALTIES.includes(specialty as Specialty) ? (specialty as Specialty) : undefined;
    const l = LANGUAGES.includes(language as Language) ? (language as Language) : undefined;
    const list = this.directory.clinicians({ specialty: s, language: l });
    const page = (
      <Layout title="Clinicians" description="Demo Clinic's family physicians, pediatrician, nurse practitioner, nurse and visiting dermatologist." active="clinicians" patient={currentPatient(ctx)}>
        <header class="page-head">
          <h1>Clinicians</h1>
          <p class="lede">Find someone by area of care or language. Every clinician can arrange an interpreter.</p>
        </header>
        <form class="filters" method="get" action="/clinicians">
          <div class="field">
            <label for="f-specialty">Area of care</label>
            <select id="f-specialty" name="specialty">
              <option value="">Any</option>
              {SPECIALTIES.map((x) => (
                <option value={x} selected={x === s}>
                  {SPECIALTY_LABELS[x]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="f-language">Speaks</label>
            <select id="f-language" name="language">
              <option value="">Any language</option>
              {LANGUAGES.map((x) => (
                <option value={x} selected={x === l}>
                  {LANGUAGE_LABELS[x]}
                </option>
              ))}
            </select>
          </div>
          <button class="btn btn-primary" type="submit">
            Show clinicians
          </button>
        </form>
        {list.length === 0 ? (
          <p class="empty">No clinician matches both filters. Try one filter, or ask the front desk for an interpreter.</p>
        ) : (
          <ul class="roster roster-full">
            {list.map((c) => (
              <ClinicianRow c={c} next={this.nextOpen(c)} />
            ))}
          </ul>
        )}
      </Layout>
    );
    return withData(page, { clinicians: list.map((c) => ({ id: c.id, name: c.name, role: c.role, specialty: c.specialty, languages: c.languages, accepting: c.accepting })) });
  }

  @Page('/clinicians/:id')
  clinician(@PathParam() id: string, ctx: RequestContext) {
    const c = clinicianById(id);
    if (!c) return withStatus(404, this.notFoundPage(ctx));
    const today = this.directory.today();
    const days: Array<{ date: string; times: string[] }> = [];
    for (let d = 0; d < 14 && days.length < 3 && c.accepting; d++) {
      const date = addDays(today, d);
      const open = this.records.openSlots(c.id, date);
      if (open.length) days.push({ date, times: open.slice(0, 6).map((x) => timeLabel(x.time)) });
    }
    const ask = encodeURIComponent(`Show available slots for ${c.id}${days[0] ? ` on ${days[0].date}` : ''}`);
    const page = (
      <Layout title={c.name} description={`${c.name}, ${c.role} at Demo Clinic.`} active="clinicians" patient={currentPatient(ctx)}>
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="/clinicians">Clinicians</a>
        </nav>
        <section class="profile">
          <div class="profile-id">
            <span class={`avatar avatar-xl spec-${SPECIALTY_LABELS[c.specialty].toLowerCase().replace(/[^a-z]+/g, '-')}`} aria-hidden="true">
              {initialsOf(c.name)}
            </span>
            <div>
              <h1>{c.name}</h1>
              <p class="lede">
                {c.role}, {SPECIALTY_LABELS[c.specialty]} <span class="muted">({c.pronouns})</span>
              </p>
            </div>
          </div>
          <div class="profile-grid">
            <div>
              <p>{c.bio}</p>
              <h2>Focus</h2>
              <ul>
                {c.focus.map((f) => (
                  <li>{f}</li>
                ))}
              </ul>
              <h2>Languages</h2>
              <p>{c.languages.map((l) => LANGUAGE_LABELS[l]).join(', ')}</p>
              <h2>In clinic</h2>
              <p>
                {c.days.map((d) => dayName(d)).join(', ')}. {c.visitMinutes}-minute visits, {c.room}.
              </p>
            </div>
            <aside class="profile-times" aria-labelledby="times-title">
              <h2 id="times-title">Next open times</h2>
              {!c.accepting ? (
                <p>Not accepting new patients. Your family physician can refer you.</p>
              ) : days.length === 0 ? (
                <p>No open times in the next two weeks.</p>
              ) : (
                days.map((d) => (
                  <div class="times-day">
                    <h3>{dateLabel(d.date)}</h3>
                    <p>{d.times.join(', ')}</p>
                  </div>
                ))
              )}
              {c.accepting && (
                <a class="btn btn-primary" href={`/assistant?ask=${ask}`}>
                  Book with the assistant
                </a>
              )}
            </aside>
          </div>
        </section>
      </Layout>
    );
    return withData(page, { clinician: { id: c.id, name: c.name, role: c.role, specialty: c.specialty, languages: c.languages, accepting: c.accepting, days: c.days } });
  }

  @Page('/policies')
  policies(ctx: RequestContext) {
    return (
      <Layout title="Clinic policies" description="Cancellation, blood tests, vaccinations, prescription renewals, privacy and coverage at Demo Clinic." active="policies" patient={currentPatient(ctx)}>
        <header class="page-head">
          <h1>Clinic policies</h1>
          <p class="lede">The handbook the assistant answers from. When it quotes a policy, it names the section.</p>
        </header>
        <div class="policy-layout">
          <nav class="toc" aria-label="Policies">
            <ul>
              {POLICIES.map((p) => (
                <li>
                  <a href={`#${p.id}`}>{p.title}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div class="policy-list">
            {POLICIES.map((p) => (
              <section id={p.id} class="policy-section" aria-labelledby={`${p.id}-t`}>
                <h2 id={`${p.id}-t`}>{p.title}</h2>
                <p class="policy-summary">{p.summary}</p>
                {p.points.map((pt) => (
                  <p>{pt}</p>
                ))}
              </section>
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  @Page('/partners')
  partners(ctx: RequestContext) {
    const sample = JSON.stringify(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: { role: 'user', messageId: 'msg-001', parts: [{ kind: 'text', text: 'Referral for patient P-1002 to dermatology' }] },
          metadata: { skill: AGENT },
        },
      },
      null,
      2,
    );
    return (
      <Layout title="For partner organisations" description="How partner pharmacies and hospitals send referrals to Demo Clinic over A2A." active="partners" patient={currentPatient(ctx)}>
        <header class="page-head">
          <h1>For pharmacies and hospitals</h1>
          <p class="lede">Your agent can send referral requests to our referral desk using the Agent2Agent (A2A) protocol. Requests are logged on the patient's own access page.</p>
        </header>
        <div class="split">
          <div>
            <h2>How it works</h2>
            <ol class="steps">
              <li>
                Read our agent card at <code>/.well-known/agent-card.json</code>. It lists the <code>{AGENT}</code> skill.
              </li>
              <li>
                Send a <code>message/send</code> request to <code>/a2a</code> with your bearer token.
              </li>
              <li>The referral desk agent records the request and answers with a referral id. It never returns patient details.</li>
              <li>Our staff review it within 2 business days and contact the patient directly.</li>
            </ol>
            <p class="muted">The demo token in application.json is fake and public; production issues each partner its own secret.</p>
          </div>
          <div>
            <h2>Sample request</h2>
            <pre class="code" tabindex="0">
              <code>{sample}</code>
            </pre>
          </div>
        </div>
      </Layout>
    );
  }

  @Page('/assistant')
  async assistant(@QueryParam() ask: string | undefined, @QueryParam('new') fresh: string | undefined, ctx: RequestContext) {
    const patient = currentPatient(ctx);
    if (!patient) return this.signInPage(ctx);

    let initial: ChatItem[] = [];
    let threadId: string | undefined;
    let resume: ResumeRun | undefined;
    if (fresh === undefined) {
      const [latest] = await this.platform.threads(userOwner(patient.id), AGENT);
      const found = latest ? await this.platform.thread(latest.id) : undefined;
      if (found) {
        // A run still in progress brings its finished steps and any approval it waits for, so a
        // reload shows the pending booking card again and the chat continues the run's stream.
        const active = (await this.platform.runs(found.thread.id)).find((r) => !TERMINAL_STATUSES.has(r.status));
        initial = toChatItems([...found.messages, ...(active?.checkpoint ?? [])]);
        // A call waiting for approval hasn't started: show its approval card, not a "running" step.
        const waiting = new Set((active?.pending ?? []).filter((p) => !p.decision).map((p) => p.callId));
        initial = initial.filter((i) => !(i.kind === 'tool' && waiting.has(i.id)));
        for (const p of active?.pending ?? []) {
          if (!p.decision) initial.push({ kind: 'approval', id: `ap-${p.callId}`, callId: p.callId, tool: p.tool, input: p.input, reason: p.reason, status: 'pending' });
        }
        if (active) resume = { id: active.id, status: active.status, lastSeq: (await this.runStore.events(active.id, 0)).at(-1)?.seq ?? 0 };
        threadId = found.thread.id;
      }
    }
    const today = clinicParts(this.clock.now()).weekday;
    const status = this.directory.openStatus();
    const clinicians = Object.fromEntries(CLINICIANS.map((c) => [c.id.slice(3), { name: c.name, role: c.role }]));
    return (
      <Layout title="Assistant" active="assistant" patient={patient} app>
        <div class="workspace">
          <Island
            of={Assistant}
            agent={AGENT}
            firstName={patient.name.split(' ')[0]}
            initial={initial}
            threadId={threadId}
            suggestions={SUGGESTIONS}
            prefill={ask ? ask.slice(0, 300) : undefined}
            clinicians={clinicians}
            resume={resume}
          />
          <aside class="side" aria-label="Your care">
            <section class="emergency-strip" aria-labelledby="em-title">
              <h2 id="em-title">Emergency?</h2>
              <p>
                Call <a href="tel:911">911</a> or go to the nearest emergency department. For a mental-health crisis, call or text <a href="tel:988">9-8-8</a>.
              </p>
            </section>
            <section class="panel patient-card" aria-labelledby="pt-title">
              <h2 id="pt-title" class="panel-title">
                {patient.name}
              </h2>
              <p class="muted">
                {patient.id}, demo patient. <a href="/my-data">Who accessed my data</a>
              </p>
            </section>
            <Island of={CareSidebar} appointments={this.views(patient.id)} />
            <section class="panel" aria-labelledby="hours-title">
              <h2 id="hours-title" class="panel-title">
                Clinic hours
              </h2>
              <p class={status.open ? 'open-pill is-open' : 'open-pill'}>{status.label}</p>
              <HoursTable today={today} />
            </section>
            <p class="demo-note">Demo: fictional clinic and patients. Not medical advice.</p>
          </aside>
        </div>
      </Layout>
    );
  }

  private signInPage(ctx: RequestContext) {
    const patients = PATIENTS.map((p: Patient) => ({
      id: p.id,
      name: p.name,
      dobLabel: shortDateLabel(p.dob).replace(/^\w+, /, '') + `, ${p.dob.slice(0, 4)}`,
      note: p.id === 'P-1001' ? 'Has a physical and a blood test booked.' : 'Prefers French. A partner pharmacy may refer her.',
    }));
    return (
      <Layout title="Sign in" active="assistant" patient={currentPatient(ctx)}>
        <section class="signin">
          <div class="signin-copy">
            <h1>Continue as a demo patient</h1>
            <p class="lede">The assistant works on your own record, so it needs to know who you are. This demo has two fictional patients.</p>
            <p>
              In production, patients sign in with the clinic's patient portal login and the assistant receives only their patient id. Conversations belong to that patient: nobody else can open
              them.
            </p>
          </div>
          <Island of={PatientPicker} patients={patients} next="/assistant" />
        </section>
      </Layout>
    );
  }

  @Page('/my-data')
  myData(ctx: RequestContext) {
    const patient = currentPatient(ctx);
    if (!patient) return this.signInPage(ctx);
    const entries = this.accessLog.forPatient(patient.id);
    const code = this.accessLog.pseudonym(patient.id);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });
    return (
      <Layout title="Who accessed my data" active="my-data" patient={patient}>
        <header class="page-head">
          <h1>Who accessed my data</h1>
          <p class="lede">
            Every read or change of your appointments and referrals, by the assistant, a partner organisation or you. The log identifies you only by the code <code>{code}</code>, never by name.
          </p>
        </header>
        {entries.length === 0 ? (
          <p class="empty">Nothing yet. Open the assistant and ask about your appointments.</p>
        ) : (
          <div class="table-wrap" tabindex="0" role="region" aria-label="Access log">
            <table class="log">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Why</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr class={e.outcome === 'refused' ? 'is-refused' : undefined}>
                    <td>{fmt.format(new Date(e.at))}</td>
                    <td>{ACTOR_LABELS[e.actor] ?? e.actor}</td>
                    <td>{e.action}</td>
                    <td>{e.purpose}</td>
                    <td>{e.outcome === 'ok' ? 'Done' : 'Refused'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Layout>
    );
  }

  private notFoundPage(ctx: RequestContext) {
    return (
      <Layout title="Page not found" patient={currentPatient(ctx)}>
        <header class="page-head">
          <h1>That page isn't here</h1>
          <p class="lede">
            Try the <a href="/clinicians">clinicians</a>, the <a href="/policies">policies</a> or the <a href="/assistant">assistant</a>.
          </p>
        </header>
      </Layout>
    );
  }

  @ErrorPage(404)
  notFound(ctx: RequestContext) {
    return this.notFoundPage(ctx);
  }
}
