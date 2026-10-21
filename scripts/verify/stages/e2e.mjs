// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { APPS, loadModule, pagePaths } from '../lib/apps.mjs';
import { startProduction } from './production.mjs';

/** Playwright, if the project (or PLAYWRIGHT_MODULE) provides it. It's optional. */
export function loadPlaywright(root) {
  const req = createRequire(path.join(root, 'package.json'));
  for (const id of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
    try {
      return req(id);
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

/** Runs in the page: accessibility basics a reviewer would check first. */
const AUDIT = () => {
  const problems = [];
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim() || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim() : '');
  if (!document.documentElement.lang) problems.push('<html> has no lang');
  if (!document.title.trim()) problems.push('empty <title>');
  if (document.querySelectorAll('h1').length === 0) problems.push('no <h1>');
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) problems.push(`img without alt: ${img.src}`);
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')) {
    const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.getAttribute('title');
    if (!labelled) problems.push(`form field without a label: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of document.querySelectorAll('button, a[href]')) {
    // Hidden from assistive technology and out of the tab order (e.g. a duplicate image link): needs no name.
    if (el.closest('[aria-hidden="true"]') && el.getAttribute('tabindex') === '-1') continue;
    const svgTitle = el.querySelector('svg title')?.textContent;
    if (!name(el) && !svgTitle && !el.querySelector('img[alt]:not([alt=""])')) problems.push(`${el.tagName.toLowerCase()} without an accessible name: ${el.outerHTML.slice(0, 80)}`);
  }
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`duplicate ids: ${[...new Set(dup)].join(', ')}`);
  if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`horizontal scroll: page is ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px window`);
  return problems;
};

/**
 * Opens a page and waits until it has settled. Pages with live connections (SSE, WebSocket) never
 * reach "network idle", so that wait is short and best-effort after the load event.
 */
async function open(page, url) {
  const res = await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
  return res;
}

const STEP = { timeoutMs: 3 * 60_000 };

/**
 * Waits for a streamed response to end, failing (instead of hanging) after `ms`. The chat client stops
 * reading once it has seen the final event, which Chromium reports as a cancelled request rather than a
 * finished one, so both count.
 */
async function streamEnds(page, response, what, ms = 30_000) {
  const request = response.request();
  let onFailed;
  const failed = new Promise((resolve) => {
    onFailed = (r) => r === request && resolve(true);
    page.on('requestfailed', onFailed);
  });
  try {
    const ended = await Promise.race([response.finished().then(() => true), failed, new Promise((r) => setTimeout(() => r(false), ms).unref())]);
    if (!ended) throw new Error(`${what}: the event stream (HTTP ${response.status()}) did not end within ${ms / 1000} s`);
  } finally {
    page.off('requestfailed', onFailed);
  }
}

const CHAT_PAGE = { 'banking-assistant': '/assistant', 'clinic-assistant': '/assistant', 'shopping-assistant': '/assistant', 'dispatch-agent': '/' };

export const e2e = {
  id: 'e2e',
  title: 'Browser end to end',
  description: 'real Chromium: every page on desktop and phone, CSP violations, accessibility basics, agent chat flows',
  quick: false,
  needs: ['build'],
  async run(ctx) {
    const pw = loadPlaywright(ctx.root);
    if (!pw) ctx.skip('Playwright is not installed. To enable: npm install --no-save playwright, then npx playwright install chromium');
    const browser = await pw.chromium.launch({ timeout: 60_000 });
    try {
      // VERIFY_E2E_APPS=banking-assistant,... narrows the run while investigating a failure.
      const only = process.env.VERIFY_E2E_APPS?.split(',');
      for (const app of APPS.filter((a) => !only || only.includes(a.id))) {
        const module = loadModule(ctx.root, app);
        const { base, server } = await startProduction(ctx, app, { workers: 1 });
        for (const [label, viewport] of [
          ['desktop', { width: 1440, height: 900 }],
          ['phone', { width: 390, height: 844 }],
        ]) {
          const context = await browser.newContext({ viewport, baseURL: base });
          const page = await context.newPage();
          page.setDefaultTimeout(20_000);
          page.setDefaultNavigationTimeout(30_000);
          const errors = [];
          const agentTraffic = [];
          page.on('response', (r) => {
            const u = new URL(r.url());
            if (u.pathname.startsWith('/agents/')) agentTraffic.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`);
          });
          // On failure: a screenshot in the report folder, the agent requests made, and the server's log.
          const evidence = async (name, fn) => {
            try {
              return await fn();
            } catch (err) {
              const file = path.join(ctx.options.report, `e2e-${app.id}-${label}-${name}.png`);
              await mkdir(ctx.options.report, { recursive: true }).catch(() => undefined);
              await page.screenshot({ path: file }).catch(() => undefined);
              err.detail = [`screenshot: ${file}`, `agent requests: ${agentTraffic.join(', ') || 'none'}`, 'server log (last lines):', server.tail().split('\n').slice(-15).join('\n')].join('\n');
              throw err;
            }
          };
          page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
          page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
          await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
          if (app.session) await page.request.post(app.session.path, { data: app.session.body, headers: { 'sec-fetch-site': 'same-origin' } });

          await ctx.check(`${app.id} (${label}): every page loads without errors, CSP violations or accessibility basics missing`, async () => {
            const problems = [];
            for (const p of pagePaths(module)) {
              const res = await open(page, p);
              if (!res || res.status() >= 400) {
                problems.push(`${p}: status ${res?.status()}`);
                continue;
              }
              await page.waitForTimeout(150);
              for (const issue of await page.evaluate(AUDIT)) problems.push(`${p}: ${issue}`);
            }
            problems.push(...errors.splice(0));
            ctx.assert.deepEqual(problems, []);
          }, STEP);

          if (app.agent && CHAT_PAGE[app.id]) {
            await ctx.check(`${app.id} (${label}): the chat streams an answer in the browser`, () => evidence('chat', async () => {
              await open(page, CHAT_PAGE[app.id]);
              const form = page.locator('form:has(button[type=submit])').filter({ has: page.locator('textarea, input[type=text], input:not([type])') }).first();
              await form.locator('textarea, input[type=text], input:not([type])').first().fill(app.prompt);
              const done = page.waitForResponse((r) => /\/agents\/[^/]+\/runs$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30_000 });
              await form.locator('button[type=submit]').first().click();
              const response = await done;
              await streamEnds(page, response, 'chat run');
              await page.waitForTimeout(800);
              ctx.assert.equal(response.status(), 200);
              const body = await page.locator('body').innerText();
              ctx.assert.ok(body.includes(app.prompt), 'the message is not shown in the conversation');
              ctx.assert.deepEqual(errors.splice(0), []);
              ctx.assert.deepEqual((await page.evaluate(AUDIT)).filter((p) => p.startsWith('horizontal')), []);
            }), STEP);
          }
          if (app.approvalPrompt) {
            await ctx.check(`${app.id} (${label}): an approval card appears, and approving completes the action`, () => evidence('approval', async () => {
              await open(page, CHAT_PAGE[app.id]);
              const form = page.locator('form:has(button[type=submit])').first();
              await form.locator('textarea, input[type=text], input:not([type])').first().fill(app.approvalPrompt);
              await form.locator('button[type=submit]').first().click();
              const approve = page.getByRole('button', { name: /^Approve/ }).first();
              await approve.waitFor({ timeout: 20_000 });
              const done = page.waitForResponse((r) => r.url().includes('/approvals/'), { timeout: 30_000 });
              await approve.click();
              await streamEnds(page, await done, 'approval');
              await page.getByText(/Transfer posted|posted/i).first().waitFor({ timeout: 15_000 });
              ctx.assert.deepEqual(errors.splice(0), []);
            }), STEP);
          }
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
};

