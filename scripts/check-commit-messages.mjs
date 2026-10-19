// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

// Refuses commits whose messages carry AI-assistant trailers: a Co-authored-by line naming an AI
// assistant, or a session link line. Commits in this repository are authored and signed off by
// people (see CONTRIBUTING.md).
//
//   node scripts/check-commit-messages.mjs                  every commit reachable from HEAD
//   node scripts/check-commit-messages.mjs main..HEAD       a range (pull requests)
//   node scripts/check-commit-messages.mjs --file <path>    one message (the commit-msg hook)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Trailer lines that are refused, checked line by line and ignoring case. */
export const FORBIDDEN_TRAILERS = [
  { pattern: /^\s*co-authored-by:.*\b(claude|anthropic|copilot|chatgpt|openai|gemini)\b/i, why: 'an AI assistant listed as co-author' },
  { pattern: /^\s*claude-session:/i, why: 'an AI assistant session link' },
];

/** The refused lines of one commit message, with the reason for each. */
export function problemsIn(message) {
  const out = [];
  for (const line of message.split(/\r?\n/)) {
    for (const { pattern, why } of FORBIDDEN_TRAILERS) if (pattern.test(line)) out.push({ line: line.trim(), why });
  }
  return out;
}

/** Commits in `range` as { sha, subject, message }. */
export function commitsIn(range, cwd = process.cwd()) {
  const SEP = '\u001e';
  const out = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%B%x1e', range], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject, message] = c.split('\u001f');
      return { sha, subject, message: message ?? '' };
    });
}

function main() {
  const args = process.argv.slice(2);
  let failures = [];
  if (args[0] === '--file') {
    if (!args[1]) throw new Error('--file needs the path of the commit message');
    failures = problemsIn(readFileSync(args[1], 'utf8')).map((p) => ({ commit: 'this commit', ...p }));
  } else {
    for (const c of commitsIn(args[0] ?? 'HEAD')) for (const p of problemsIn(c.message)) failures.push({ commit: `${c.sha.slice(0, 10)} ${c.subject}`, ...p });
  }
  if (failures.length === 0) {
    console.log('Commit messages: ok');
    return;
  }
  console.error('Commit messages must not list AI assistants as co-authors or link their sessions:\n');
  for (const f of failures) {
    console.error(`  ${f.commit}`);
    console.error(`    ${f.line}  (${f.why})`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Commit message::${f.commit}: remove the line "${f.line.replace(/[\r\n%]/g, ' ')}"`);
  }
  console.error('\nRemove those lines (git commit --amend, or git rebase -i for older commits) and push again.');
  process.exit(1);
}

// Run as a command (not when imported by the verify suite).
if (process.argv[1]?.endsWith('check-commit-messages.mjs')) main();
