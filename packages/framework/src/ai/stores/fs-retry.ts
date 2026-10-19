// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

/**
 * On Windows, renaming over a file, or opening one, fails with EPERM, EACCES or EBUSY while another
 * process briefly has it open (another worker reading it, an antivirus scan, the search indexer).
 * Those errors are transient there, so retry for up to about 2 seconds, as graceful-fs does.
 * Elsewhere they are real permission errors and are thrown at once.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function retryOnWindows<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (process.platform !== 'win32' || !code || !TRANSIENT.has(code) || attempt >= 25) throw err;
      await new Promise((r) => setTimeout(r, Math.min(10 * (attempt + 1), 100)));
    }
  }
}

/**
 * Whether creating a lock file with the 'wx' flag failed only because another process holds it:
 * EEXIST everywhere, and on Windows also EPERM, EACCES or EBUSY, which is what creating a file
 * reports while another process is deleting it ("delete pending").
 */
export function isLockBusy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EEXIST') return true;
  return process.platform === 'win32' && code !== undefined && TRANSIENT.has(code);
}

/** Writes through a temporary file and a rename, so readers never see a half-written file. */
export async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await retryOnWindows(() => rename(tmp, file));
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** readFile with the Windows retry. */
export function readFileRetry(file: string): Promise<string> {
  return retryOnWindows(() => readFile(file, 'utf8'));
}

/**
 * Runs `fn` while holding a lock file shared by every process using the same path (created with
 * the exclusive 'wx' flag). A lock older than `staleMs` was left by a crashed process and is taken over.
 *
 * On Windows, creating the lock while another process is deleting it fails with EPERM (the file is
 * "delete pending") instead of EEXIST, so those errors also mean "held, wait". Only a long unbroken
 * run of them (about 10 seconds) is treated as a real permission error.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 10_000): Promise<T> {
  const token = `${process.pid} ${randomBytes(6).toString('hex')} ${Date.now()}`;
  let transientInARow = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(lockPath, token, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if (!isLockBusy(err)) throw err;
      transientInARow = (err as NodeJS.ErrnoException).code === 'EEXIST' ? 0 : transientInARow + 1;
      if (transientInARow > 200) throw err;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > staleMs) await unlink(lockPath).catch(() => undefined);
      } catch {
        /* released meanwhile */
      }
      if (attempt > 3000) throw new Error(`Timed out waiting for the lock ${lockPath}`);
      await new Promise((r) => setTimeout(r, Math.min(5 + attempt, 50)));
    }
  }
  try {
    return await fn();
  } finally {
    const current = await readFileRetry(lockPath).catch(() => undefined);
    if (current === token) await retryOnWindows(() => unlink(lockPath)).catch(() => undefined);
  }
}
