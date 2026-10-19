# create-amoxi-app

Creates a new [Amoxi](https://www.npmjs.com/package/amoxi) app.

```bash
npx create-amoxi-app@latest my-app
# or
npm create amoxi-app@latest my-app
```

It asks which template to use when run in a terminal. Options: `--template web|agent|api` (pages, islands and a JSON API; the same plus an AI agent with a streaming chat; or an API only), `--no-install`, `--no-git`, `--yes`.

The generated `Dockerfile` installs with whichever lockfile the project has (npm, pnpm, yarn or bun), so run your package manager's install once before `docker build`.

Documentation: [karawash-projects.github.io/amoxi/docs](https://karawash-projects.github.io/amoxi/docs/).
