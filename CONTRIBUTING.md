# Contributing to Amoxi

Thanks for helping. This guide covers setting up the repository, the checks a change must pass, and how contributions are licensed.

## Setup

Requires Node.js 22 or newer and npm 10 or newer. Each command is on its own line so the steps work in PowerShell, Command Prompt, bash and zsh.

```bash
git clone https://github.com/karawash-projects/amoxi.git
cd amoxi
npm install
npm run build
npm test
```

`npm run build` builds the framework (`packages/framework`), then all five example apps (`examples/*`) and the project website (`website`). `npm test` runs the framework, generator, example and website tests. `npm start` runs the reference app (`examples/user-service`, which exercises nearly every feature) on http://localhost:8080. Before a pull request, `npm run verify -- --quick` runs the checks CI runs; `npm run verify` adds the browser, load and crash-recovery stages.

To try your changes in a fresh app, create one from your checkout; the generator detects the repository and packs your local framework build into the new app's `vendor/` folder:

```bash
npm run create -- ../my-test-app
```

## Repository layout

| Path | What it is |
|---|---|
| `packages/framework` | The `amoxi` package: runtime (`src/runtime`), AI agents (`src/ai`, published as `amoxi/ai`), browser runtime (`src/client`), compiler and CLI (`src/compiler`), and the framework tests (`test`) |
| `packages/create-amoxi-app` | The `create-amoxi-app` generator, its starter templates (`templates`) and its tests (`test`) |
| `examples/user-service` | The reference app: every core feature, with its tests |
| `examples/banking-assistant`, `clinic-assistant`, `shopping-assistant`, `dispatch-agent` | Agent-first sector examples, each with its tests |
| `website` | The project website (an Amoxi app exported to static files for GitHub Pages), including the documentation page built from `README.md` |
| `scripts` | Release checks (`check-licenses.mjs`, `check-package.mjs`, `check-commit-messages.mjs`), the git hook in `git-hooks`, and the verification suite in `verify` |
| `bench` | The startup benchmark (`npm run bench`) |
| `.github` | CI, CodeQL, release and website workflows, issue templates and `CODEOWNERS` |

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed before you invest time.
2. Keep changes focused; one topic per pull request.
3. Add or update tests next to the code you change: `packages/framework/test` for the framework, `packages/create-amoxi-app/test` for the generator, and the app's own `test` folder for an example. Bugs need a test that fails without the fix.
4. Update `README.md` when behaviour or configuration changes, and add an entry under "Unreleased" in `CHANGELOG.md`.
5. Run `npm run build`, `npm test` and `npm run check:licenses` before opening the pull request. CI runs them on Windows, macOS and Linux.
6. Every pull request needs the approval of a code owner (`.github/CODEOWNERS`) and passing CI before it is merged.

Code style: TypeScript in strict mode, two-space indentation, LF line endings (enforced by `.gitattributes` and `.editorconfig`). Prefer small, well-named functions and comments that explain why rather than what. New runtime dependencies need a strong reason, since every company using Amoxi has to review them; they must use a permissive license (see `scripts/check-licenses.mjs`).

## Developer Certificate of Origin

Every commit must be signed off, certifying that you wrote the change or have the right to submit it under the project's license ([Developer Certificate of Origin 1.1](https://developercertificate.org/)). Add the sign-off with `-s`:

```bash
git commit -s -m "Fix cookie parsing for quoted values"
```

which appends `Signed-off-by: Your Name <you@example.com>` using your Git name and email.

## Commit messages

Commits are authored and signed off by people. A commit message must not list an AI assistant as a co-author (a `Co-authored-by:` line naming one) or carry an assistant's session link (a `Claude-Session:` line). CI refuses pull requests with such lines (`node scripts/check-commit-messages.mjs`). To catch them before you commit, turn on the repository's hook once per clone:

```bash
git config core.hooksPath scripts/git-hooks
```

## License of contributions

Amoxi is licensed under the Apache License 2.0. As stated in section 5 of that license, any contribution you intentionally submit is licensed under the same terms, without additional conditions. Contributions to the starter templates (`packages/create-amoxi-app/templates`) are licensed under 0BSD, like the templates themselves, so generated projects carry no obligations. New source files should start with:

```ts
// Copyright 2026 Ahmad Karawash and Amoxi contributors
// SPDX-License-Identifier: Apache-2.0
```

## Reporting bugs and security issues

Use the issue templates for bugs and feature requests. Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
