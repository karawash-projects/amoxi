# Demo Clinic: a patient assistant built on Amoxi

Demo Clinic is a fictional seven-clinician family clinic in Toronto. Its patient assistant answers clinic questions from the clinic handbook, screens symptoms for urgency (it never diagnoses), finds clinicians and open times, and books or cancels appointments that the patient confirms. Partner pharmacies and hospitals can send referral requests to the clinic's agent over the Agent2Agent (A2A) protocol.

Privacy and safety are the point of the demo:

- **Urgency comes from rules, not the model.** Red flags (chest pain, trouble breathing, stroke signs, severe bleeding, thoughts of suicide) set the level. For an emergency the patient first reads "call 911" (and 9-8-8 for a crisis), and an emergency notice appears in the conversation.
- **No diagnoses, no medicine advice.** The instructions forbid it, and a post-check on everything the model writes replaces any sentence that diagnoses or recommends a medicine or dose before it is shown or saved. After an emergency screen the same check makes sure the answer opens with 911.
- **The patient confirms every booking and cancellation.** Bookings are idempotent and double booking is refused. Cancelling with less than 24 hours' notice is allowed, but the patient sees the late-fee policy before confirming.
- **Guardrails.** The assistant books only for the signed-in patient. Partner agents can only send referrals. Memory keeps only scheduling preferences, never health details.
- **Every access is logged, without names.** An interceptor writes each read or change of patient data to an access log keyed by a pseudonym. Patients can read their own entries on "Who accessed my data".
- **Nothing private is cached or leaked.** Assistant pages and agent routes are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

All data is fictional and kept in memory, seeded at startup relative to today's date. Not medical advice.

<!-- screenshots -->
## Screenshots

Taken from this app running with the offline demo model. All data is fictional.

**Choosing a time slot**

<img src="../../website/public/shots/healthcare-slots-desktop.jpg" alt="Choosing a time slot, desktop" width="100%">

**Confirming a booking**

<img src="../../website/public/shots/healthcare-approval-desktop.jpg" alt="Confirming a booking, desktop" width="100%">

**Red-flag symptoms**

<img src="../../website/public/shots/healthcare-emergency-desktop.jpg" alt="Red-flag symptoms, desktop" width="100%">

On a phone:

| Choosing a time slot | Confirming a booking | Red-flag symptoms |
|---|---|---|
| <img src="../../website/public/shots/healthcare-slots-mobile.jpg" alt="Choosing a time slot, phone" width="240"> | <img src="../../website/public/shots/healthcare-approval-mobile.jpg" alt="Confirming a booking, phone" width="240"> | <img src="../../website/public/shots/healthcare-emergency-mobile.jpg" alt="Red-flag symptoms, phone" width="240"> |

## What to try

Run the app, open http://localhost:8082, select **Open the assistant** and continue as a demo patient (Jordan has a physical and a blood test booked; Samira has a cervical screening). The suggested prompts all work offline:

| Prompt | What happens |
|---|---|
| Find a clinician who speaks French | `find_clinicians` shows **ClinicianCards**. "See open times" on a card asks for that clinician's times. |
| Show available slots tomorrow | `available_slots` shows a **SlotPicker** (it moves to the next open day if the clinic is closed). Choosing a time asks to book it. |
| *(choose a time)* | `book_appointment` waits for your approval. Confirm it and **AppointmentConfirmation** appears and the side panel updates. |
| How do I prepare for a blood test? / What is the cancellation policy? | `clinic_policy` searches the `clinic` knowledge base and cites the handbook section. |
| Check my symptoms: chest pain spreading to my left arm | `check_symptom_urgency` returns "emergency": the answer starts with 911 and an **UrgentCareNotice** appears. |
| Show my upcoming appointments | `upcoming_appointments` lists your own appointments. |
| Remember my preference: "I prefer Dr. Obrelle, in French" | The built-in `remember` tool saves it. "Remember that I have asthma" is refused. |
| *Cancel* in the side panel | `cancel_appointment` waits for approval. The card shows the 24-hour notice policy and the possible fee. |
| Book appointment slot S-101-20991231-0900 for patient P-1002 | The guardrail refuses to book for another patient. P-1002 sees the refused attempt in their access log. |

Then open **Who accessed my data** from the patient chip in the header.

### Partner referral over A2A

The agent card is at `/.well-known/agent-card.json`. In development the token is `demo-clinic-partner-token-NOT-A-SECRET` (from `application-development.json`), a **fake demo value** published on purpose. Production refuses it and the demo pseudonym key: set `AI_A2A_TOKEN` (or one token per partner with `ai.a2a.callers.<name>`) and `CLINIC_PSEUDONYMKEY`.

```bash
curl -s http://localhost:8082/a2a -H "content-type: application/json" -H "authorization: Bearer demo-clinic-partner-token-NOT-A-SECRET" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"user\",\"messageId\":\"msg-001\",\"parts\":[{\"kind\":\"text\",\"text\":\"Referral for patient P-1002 to dermatology\"}]},\"metadata\":{\"skill\":\"clinic-assistant\"}}}"
```

The request body, formatted:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": { "role": "user", "messageId": "msg-001", "parts": [{ "kind": "text", "text": "Referral for patient P-1002 to dermatology" }] },
    "metadata": { "skill": "clinic-assistant" }
  }
}
```

The result is a completed task whose answer gives a referral id (`RF-8001`) and the next step. No patient details are returned. The run uses a referral identity: A2A runs carry the principal `{ channel: 'a2a' }`, the agent gets referral-desk instructions, and patient tools are refused. Sign in as Samira (P-1002) and the referral appears on her access page as "Partner organisation agent (A2A)". MCP is off.

## Amoxi feature -> why it matters in healthcare

| Amoxi feature | Why it matters for a clinic |
|---|---|
| `@Agent` with `principal()` / `owner()` | Each run carries the patient id from the session. Conversations belong to that patient, and another patient gets a 404. |
| `@Tool({ approval: true })` | Nothing is booked or cancelled until the patient confirms in the app (human in the loop). |
| `ctx.step()` durable steps, `@Tool({ idempotent: true })` | A run resumed after a crash or deploy never books the same appointment twice. |
| `agentChat({ resume })` | Reload the page while a booking waits for confirmation: the approval card comes back and still works. |
| `beforeToolCall` guardrail | Hard rules outside the prompt: book only for the signed-in patient, referrals only from partners, memory only for preferences. A refused booking never even reaches the approval card. |
| `ctx.ui()` + `@generative` islands | Clinician cards, a time picker, a booking confirmation and an emergency notice appear in the conversation instead of walls of text. |
| Replaceable `ChatModel` bean | `SafeguardedChatModel` wraps whichever model is configured with a clinical post-check, sentence by sentence, before anything is streamed. |
| `knowledge: ['clinic']` (RAG) + `KnowledgeBases` | Answers come from the clinic handbook and cite the section, so staff own the content. |
| `memory: { recall: 3, remember: true }` | Remembers a preferred clinician or language across visits, with consent rules enforced by the guardrail. |
| A2A server (`ai.a2a`) | Partner pharmacies and hospitals send referrals agent to agent, with a bearer token. |
| `@Intercept` interceptors (AOP) | Every patient-data method is audited with a pseudonymous id. New methods can't forget to log. |
| `@Middleware` | `no-store` and `no-referrer` on assistant pages and `/agents/*`, and a sign-in gate for starting runs. |
| Offline model + `ScriptedChatModel` | The demo and 13 tests run without an API key, including approvals, guardrails and A2A. |
| Server-rendered pages, `.md`/JSON versions, `/llms.txt` | Clinicians, policies and partner docs are fast pages that other agents can read too. |
| Body validation from types | `POST /session/demo-patient` accepts only the demo patient ids. |

## Run it

From this folder (each command works in PowerShell, Command Prompt, bash and zsh):

```bash
npm run build
```

`npm start` runs in production, which refuses the demo secrets (they are in `application-development.json`, used by `npm run dev` only). Before the first start, create a file named `.env.production.local` in this folder (git ignores it) with your own values, each at least 16 characters:

```
AI_A2A_TOKEN=replace-with-a-long-random-value
CLINIC_PSEUDONYMKEY=replace-with-a-long-random-value
```

```bash
npm start
```

`npm start` runs one worker because this demo keeps its data in memory, which each worker process would hold separately. A production version with a database (and `ai.store.type` set to `postgres`) can run one worker per CPU core with `amoxi start dist/src/main.js --workers auto`.

Then open http://localhost:8082. Run the tests with:

```bash
npm test
```

To use a real model, create a `.env` file in this folder with one of these lines and restart. Never commit it.

```bash
ANTHROPIC_API_KEY=your-key
```

```bash
OPENAI_API_KEY=your-key
```

The same tools, guardrails, approvals and post-check apply. Without a key the built-in offline model picks tools by keyword, which is why the suggested prompts are phrased the way they are.

## File map

```
src/
  domain/          types, Toronto time helpers, fictional clinic data and policies (shared with islands)
  services/        ClinicDirectory (schedule), PatientRecords (audited patient data), AccessLog,
                   AccessAuditInterceptor (@Intercept), KnowledgeLoader (RAG ingest), Clock
  ai/              ClinicAssistant (@Agent, guardrails), ClinicTools (@Tool), triage rules,
                   clinical-safety (post-check ChatModel), identity (patient vs partner)
  web/             PrivacyMiddleware, demo sign-in and /api/me endpoints
  pages/pages.tsx  home, clinicians, profile, policies, partners, assistant, my-data, 404
  islands/         Assistant (chat), CareSidebar, PatientPicker, SignOut and the generative
                   ClinicianCards, SlotPicker, AppointmentConfirmation, UrgentCareNotice
  ui/              layout, chat client, component props and events, safe rich text
test/              assistant.test.ts (agent flows), privacy.test.ts (ownership, log, headers, A2A, pages)
```

## What production adds

- **Real identity:** the clinic's patient portal login (OIDC) instead of the demo picker, with staff roles for the front desk and the referral desk.
- **The clinic's EMR and scheduling system** behind `PatientRecords` and `ClinicDirectory`, in place of in-memory data.
- **PostgreSQL** for runs, conversations and memory (`ai.store.type=postgres`, `DATABASE_URL`), so runs survive restarts and scale across servers. The demo uses the in-memory store so conversations and the seeded schedule always match.
- **Secrets from the environment:** a per-partner A2A token, `clinic.pseudonym-key` and `AMOXI_SESSION_SECRET`.
- **Retention and export** of the access log to the clinic's audit system, and a clinical review of the triage rules and the post-check patterns.
- **Notifications:** booking confirmations and reminders by email or text.
