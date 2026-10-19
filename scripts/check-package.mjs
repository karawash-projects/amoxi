// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

// Runs before `npm publish` (prepublishOnly) in each package. Stops a release that would be
// broken for users: missing license files, or CLI entry points with Windows (CRLF) line endings,
// which make "#!/usr/bin/env node" fail on macOS and Linux.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const problems = [];

for (const file of ['LICENSE', 'NOTICE', 'README.md']) {
  if (!existsSync(join(dir, file))) problems.push(`${file} is missing`);
}
if (pkg.license !== 'Apache-2.0') problems.push(`package.json "license" is ${JSON.stringify(pkg.license)}, expected "Apache-2.0"`);
if (!pkg.repository?.url) problems.push('package.json "repository" is missing');

const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
for (const bin of bins) {
  const text = readFileSync(join(dir, bin), 'utf8');
  if (!text.startsWith('#!/usr/bin/env node\n')) problems.push(`${bin} must start with "#!/usr/bin/env node" followed by a LF line ending`);
  if (text.includes('\r')) problems.push(`${bin} has Windows (CRLF) line endings; run "git add --renormalize ." or convert it to LF`);
}

if (problems.length > 0) {
  console.error(`\nNot publishing ${pkg.name}@${pkg.version}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`${pkg.name}@${pkg.version}: package checks passed`);
