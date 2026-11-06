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
