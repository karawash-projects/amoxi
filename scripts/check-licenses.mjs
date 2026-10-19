// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

// Lists every package installed with the published packages (dependencies and optional
// dependencies, recursively; not devDependencies) and fails if any license is outside the
// permissive allowlist. Companies adopting Amoxi review exactly this set.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['packages/framework', 'packages/create-amoxi-app'];

function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

// "(MIT OR Apache-2.0)" is fine if any option is allowed; "A AND B" needs all of them.
function allowed(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/.test(clean)) return clean.split(/\s+OR\s+/).some((p) => allowed(p));
  return clean.split(/\s+AND\s+/).every((p) => ALLOWED.has(p.trim()));
}

const seen = new Map();
const problems = [];
for (const r of roots) {
  const dir = join(root, r);
  const own = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const queue = Object.keys({ ...own.dependencies, ...own.optionalDependencies }).map((name) => ({ name, from: dir, by: own.name }));
  while (queue.length > 0) {
    const { name, from, by } = queue.shift();
    const location = findPackage(name, from);
    if (!location) continue; // an optional, platform-specific package not installed here
    const pkg = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    const license = licenseOf(pkg);
    seen.set(key, { license, by });
    if (!allowed(license)) problems.push(`${key} (${license}), required by ${by}`);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) queue.push({ name: dep, from: location, by: pkg.name });
  }
}

console.log('Runtime dependencies of amoxi and create-amoxi-app:');
for (const [key, { license }] of [...seen].sort()) console.log(`  ${key.padEnd(40)} ${license}`);
if (problems.length > 0) {
  console.error(`\nLicenses outside the allowlist (${[...ALLOWED].join(', ')}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${seen.size} packages use permissive licenses. (Optional peer dependencies such as React are chosen by each app.)`);
