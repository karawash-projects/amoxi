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

No environment variables are required. Settings come from `application.json`, then `application-<profile>.json`, then `.env` files, then environment variables. The profile is `production` under `npm start` and `development` under `npm run dev`.

## Deploy

```bash
docker build -t {{APP_NAME}} .
docker run -p 8080:8080 {{APP_NAME}}
```

Health checks: `GET /amoxi/health/live` and `GET /amoxi/health/ready`.
