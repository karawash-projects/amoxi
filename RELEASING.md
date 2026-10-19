# Releasing (maintainers)

`amoxi` (`packages/framework`) and `create-amoxi-app` (`packages/create-amoxi-app`) are always released together with the same version, because the generator installs the framework version matching its own.

## Regular releases (GitHub Actions, with npm provenance)

1. Make sure `main` is green in CI, and run the full verification suite locally (it includes the browser, load and crash-recovery stages):

   ```bash
   npm ci
   npm run verify
   ```

   It must end with `PASSED`; attach `verify-report/report.md` to the release notes if you like.
2. Move the "Unreleased" entries in `CHANGELOG.md` under a new version heading.
3. Bump both packages and push the tag:

   ```bash
   npm version 0.4.1 -w amoxi -w create-amoxi-app --no-git-tag-version
   git commit -s -am "Release 0.4.1"
   git tag v0.4.1
   git push origin main --tags
   ```

4. The `Release` workflow runs three jobs:
   - **build** checks that the tag matches both package versions, installs, builds, runs the tests and the package checks, and packs both packages. It has a read-only token and no publish rights.
   - **publish** only uploads the packed tarballs to npm, with provenance. It doesn't check out the code or install dependencies, so no third-party code runs while it holds publish rights.
   - **notes** creates the GitHub release from `CHANGELOG.md`.

   A pre-release tag such as `v0.6.0-rc.1` is published under the npm dist-tag `next` (and marked as a pre-release on GitHub), so `npm install amoxi` keeps installing the latest stable version.

Every action in the workflows is pinned to a full commit, with the version it came from in a comment, and the release uses an exact npm version. Dependabot proposes updates for the actions (check the release notes before merging one); update the npm version in `release.yml` by hand.

The workflow uses npm trusted publishing (OIDC): no npm token is stored in GitHub. Set it up once per package on npmjs.com under **Settings → Trusted publishing**: repository `karawash-projects/amoxi`, workflow `release.yml`. Trusted publishing is configured in each package's settings, so the packages must exist first (see below).

The workflow runs in a GitHub environment named `npm`. Optionally, under the repository's **Settings → Environments → npm**, add yourself as a required reviewer so every release waits for your approval, and enter `npm` as the environment name in the trusted-publisher settings on npmjs.com.

## First release (manual)

The very first publish creates the packages on npm, so it is done by hand:

```bash
npm install
npm login
npm publish -w amoxi
npm publish -w create-amoxi-app
```

`prepublishOnly` checks the package (license files, metadata, LF line endings in the command files) and builds the framework, so a broken package can't be published by accident. Then configure trusted publishing as above, and enable **two-factor authentication** for your npm account and **"Require two-factor authentication and disallow tokens"** under each package's publishing access settings.

## After publishing

- Check https://www.npmjs.com/package/amoxi shows the new version (and, for workflow releases, a provenance badge).
- Try `npx create-amoxi-app@latest smoke-test` in an empty folder, then `npm run dev`.
