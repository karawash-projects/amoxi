# {{APP_TITLE}}

Created with `create-amoxi-app`.

## Commands

| | |
|---|---|
| `npm run dev` | Development server on http://localhost:8080; rebuilds and refreshes the browser on save |
| `npm run build` | Production build: `amoxi build` (wiring, validators, browser bundles) then `tsc` |
| `npm start` | Run the production build on every CPU core (`NODE_ENV=production`) |
| `npm test` | Build, then run the tests in `test/` |

## Configuration

Settings come from `application.json`, then `application-<profile>.json`, then `.env` files, then environment variables. The profile is `production` under `npm start` and `development` under `npm run dev`.

Production needs one secret, `AMOXI_SESSION_SECRET`, which encrypts session cookies: 32 or more random characters, the same on every instance, never committed. `create-amoxi-app` put one in `.env.production.local` so `npm start` works on this machine; that file is git-ignored and kept out of Docker images, so set the variable on each server (for Docker: `docker run -e AMOXI_SESSION_SECRET=...`).

## Deploy

```bash
docker build -t {{APP_NAME}} .
docker run -p 8080:8080 {{APP_NAME}}
```

Health checks: `GET /amoxi/health/live` and `GET /amoxi/health/ready`.

## The AI assistant

`src/agent/` holds an agent (`@Agent`) and its tools (`@Tool`); `src/islands/Assistant.tsx` is the chat and `src/islands/NoteList.tsx` a component the agent can show (`@generative`). Open http://localhost:8080/assistant and try the suggested prompts.

- **No API key needed:** without one, Amoxi uses an offline demo model that picks tools by keyword. To use a real model, create `.env` (git-ignored, so the key is never committed) with `ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...` (`OPENAI_BASE_URL` for Ollama, Azure OpenAI or another compatible server).
- **API:** `POST /agents/assistant/runs` with `{ "input": "Show my notes" }` (add `Accept: text/event-stream` to stream), then `GET /agents/assistant/runs/<id>`.
- **Storage:** conversations and runs are kept in `data/ai/`. Use PostgreSQL in production (see the Amoxi README, "AI agents").
- **Tests:** `test/agent.test.ts` shows the offline model and a scripted model (`ScriptedChatModel`) driving the agent deterministically.
