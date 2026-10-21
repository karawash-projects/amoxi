# Security policy

## Supported versions

Amoxi is pre-1.0. Security fixes are released for the latest minor version only.

| Version | Supported |
|---|---|
| 0.6.x | Yes |
| < 0.6 | No |

## Reporting a vulnerability

Please do **not** open a public issue. Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/karawash-projects/amoxi/security/advisories/new).

Include what you found, the affected version, steps or a proof of concept to reproduce it, and the impact you expect. You'll receive an acknowledgement as soon as possible, normally within a week, followed by an assessment and a plan. Fixes are released as a patch version and announced in a GitHub security advisory and in [CHANGELOG.md](CHANGELOG.md), crediting you unless you prefer otherwise. Please give a reasonable time to release a fix before disclosing details publicly.

## Scope

In scope: the `amoxi` and `create-amoxi-app` packages, and the code this repository generates into apps. Out of scope: the example app's demo data and behaviour that the documentation describes as the application's responsibility (for example, what an app chooses to cache or expose).

## Security features and guidance

The framework's built-in protections (CSP with nonces, CSRF checks, secure cookies, encrypted sessions, request limits, path-traversal protection) and the deployment checklist are documented in the README under "Data and security" and "Hosting checklist". Published releases are built and published from GitHub Actions with npm provenance, so you can verify a package was built from this repository (`npm audit signatures`).
