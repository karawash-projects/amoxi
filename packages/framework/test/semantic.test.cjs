// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./dist.cjs');

const { htmlToDocument, MAX_HTML_LENGTH } = load('runtime/html-markdown');
const { negotiateRepresentation, markdownPath, withData, isPageWithData, PageWithData, toJson, renderRepresentation } = load('runtime/semantic');
const { buildLlmsTxt, buildLlmsFullTxt, markdownUrlFor } = load('runtime/llms');

const BASE = 'https://acme.test/pricing';

// A page as Amoxi streams it: layout, an island, an <Await> placeholder whose content arrives
// later as a <template data-amoxi-for> chunk plus a __amoxiSwap script, then the tail.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme &amp; Co &mdash; Pricing</title>
<meta name="description" content="Plans &amp; prices"><style>body{color:red}</style>
<script>var s = "<p>not content</p>";</script></head>
<body><a href="#main" class="skip-link">Skip to content</a>
<header><nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav></header>
<main id="main">
<h1 id="top">Pricing <small>2026</small></h1>
<p>Our plans are   <em>simple</em>,<strong> fair</strong> and use <code>a\`b</code>.<br>New line &#169; &#x1F600; 5 * 3 = 15_000 [x]</p>
<amoxi-island data-c="Counter" data-load="load" data-p="{&quot;start&quot;:0}"><button>Count: 0</button></amoxi-island>
<amoxi-slot id="ns1"><p>Loading stats…</p></amoxi-slot>
<ul><li>One<li>Two<ul><li>Two A</li><li>Two B</li></ul></li><li>Three</li></ul>
<ol start="3"><li>third</li><li>fourth</li></ol>
<table><thead><tr><th>Plan<th>Price</thead><tbody><tr><td>Basic | cheap<td>$5</tr><tr><td colspan=2>Enterprise</td></tr></tbody></table>
<dl><dt>SLA</dt><dd>99.9%</dd><dt>Support</dt><dd>Email</dd><dd>Chat</dd></dl>
<pre class="language-js"><code>const a = 1;
if (a &lt; 2) { }


done();</code></pre>
<blockquote><p>Great product</p><p>A customer</p></blockquote>
<hr>
<p>See <a href="/docs?a=1&amp;b=2">the docs</a> or <a href="javascript:alert(1)">this</a>. <img src="/logo.png" alt="Logo"></p>
<div hidden>secret one</div><p aria-hidden="true">secret two</p><p style="display:none">secret three</p>
<noscript>enable js</noscript><svg><title>icon</title><text>svg text</text></svg><iframe src="/x">frame</iframe>
<form action="/contact" method="post" name="contact">
 <h2>Contact us</h2>
 <label for="n">Your name *</label><input id="n" name="name" required>
 <label>Email <input type="email" name="email" required pattern=".+@.+"></label>
 <select name="topic" aria-label="Topic"><option value="">Choose</option><option>Sales<option value="support" selected>Support</select>
 <fieldset><legend>Plan</legend>
  <label><input type="radio" name="plan" value="basic" checked> Basic</label><label><input type="radio" name="plan" value="pro"> Pro</label>
 </fieldset>
 <input type="number" name="seats" min="1" max="50" aria-label="Seats">
 <input type="hidden" name="_csrf" value="tok">
 <input type="password" name="pw" value="leak">
 <textarea name="msg" placeholder="Message"></textarea>
 <button>Send</button>
</form>
</main>
<footer><p>&copy; Acme footer text</p><a href="/privacy">Privacy</a></footer>
<template data-amoxi-for="ns1"><section><h2>Live stats</h2><p>42 users online</p></section></template><script nonce="x">__amoxiSwap("ns1")</script>
</body></html>`;

test('page document: metadata, content selection and dropped noise', () => {
  const doc = htmlToDocument(PAGE, { baseUrl: BASE });
  assert.equal(doc.title, 'Acme & Co — Pricing');
  assert.equal(doc.description, 'Plans & prices');
  assert.equal(doc.lang, 'en');
  const md = doc.markdown;
  assert.ok(md.startsWith('# Pricing 2026\n'), md);
  for (const noise of ['Skip to content', 'Home', 'footer text', 'not content', 'color:red', 'secret', 'enable js', 'svg text', 'icon', 'frame', 'Loading stats']) {
    assert.ok(!md.includes(noise), `markdown must not contain "${noise}"`);
  }
  assert.ok(md.includes('Count: 0'), 'island inner HTML is kept');
});

test('streamed <Await> content replaces its placeholder in place', () => {
  const md = htmlToDocument(PAGE, { baseUrl: BASE }).markdown;
  const stats = md.indexOf('## Live stats');
  assert.ok(stats > md.indexOf('Count: 0') && stats < md.indexOf('- One'), 'streamed section sits where the slot was');
  assert.ok(md.includes('42 users online'));
  // Without the template (not streamed yet), the fallback is shown.
  const doc = htmlToDocument('<main><amoxi-slot id="ns9"><p>Loading…</p></amoxi-slot></main>');
  assert.equal(doc.markdown, 'Loading…\n');
});

test('inline formatting, escaping, entities and line breaks', () => {
  const md = htmlToDocument(PAGE, { baseUrl: BASE }).markdown;
  assert.ok(md.includes('Our plans are *simple*, **fair** and use ``a`b``.  \nNew line \u00A9 \u{1F600} 5 \\* 3 = 15_000 \\[x\\]'), md);
  assert.ok(md.includes('See [the docs](https://acme.test/docs?a=1&b=2) or this. ![Logo](https://acme.test/logo.png)'));
  assert.ok(!md.includes('javascript:'));
});

test('lists, tables, definition lists, code blocks, blockquotes, rules', () => {
  const md = htmlToDocument(PAGE, { baseUrl: BASE }).markdown;
  assert.ok(md.includes('- One\n- Two\n  - Two A\n  - Two B\n- Three'), md);
  assert.ok(md.includes('3. third\n4. fourth'));
  assert.ok(md.includes('| Plan | Price |\n| --- | --- |\n| Basic \\| cheap | $5 |\n| Enterprise |  |'));
  assert.ok(md.includes('**SLA**: 99.9%\n\n**Support**: Email; Chat'));
  assert.ok(md.includes('```js\nconst a = 1;\nif (a < 2) { }\n\n\ndone();\n```'), 'pre keeps whitespace and blank lines');
  assert.ok(md.includes('> Great product\n>\n> A customer'));
  assert.ok(md.includes('\n---\n'));
  assert.ok(!/\n\n\n/.test(md.replace(/```js[\s\S]*?```/, 'CODE')), 'never more than one blank line outside code');
});

test('headings outline with ids', () => {
  const doc = htmlToDocument(PAGE, { baseUrl: BASE });
  assert.deepEqual(doc.headings, [
    { level: 1, text: 'Pricing 2026', id: 'top' },
    { level: 2, text: 'Live stats' },
    { level: 2, text: 'Contact us' },
  ]);
});

test('links come from the whole body, absolute, deduplicated, without skip links or javascript:', () => {
  const doc = htmlToDocument(PAGE, { baseUrl: BASE });
  assert.deepEqual(doc.links, [
    { text: 'Home', href: 'https://acme.test/' },
    { text: 'Pricing', href: 'https://acme.test/pricing' },
    { text: 'the docs', href: 'https://acme.test/docs?a=1&b=2' },
    { text: 'Privacy', href: 'https://acme.test/privacy' },
  ]);
});

test('forms: labels (for, wrapping, aria, legend, placeholder), selects, required, hidden, no password values', () => {
  const [form] = htmlToDocument(PAGE, { baseUrl: BASE }).forms;
  assert.equal(form.action, 'https://acme.test/contact');
  assert.equal(form.method, 'POST');
  assert.equal(form.name, 'contact');
  const f = Object.fromEntries(form.fields.map((x) => [x.name, x]));
  assert.deepEqual(f.name, { name: 'name', type: 'text', required: true, label: 'Your name' });
  assert.deepEqual(f.email, { name: 'email', type: 'email', required: true, label: 'Email', pattern: '.+@.+' });
  assert.deepEqual(f.topic, { name: 'topic', type: 'select', required: false, label: 'Topic', options: ['', 'Sales', 'support'], value: 'support' });
  assert.deepEqual(f.plan, { name: 'plan', type: 'radio', required: false, label: 'Plan', options: ['basic', 'pro'], value: 'basic' });
  assert.equal(f.seats.min, '1');
  assert.equal(f.seats.max, '50');
  assert.equal(f._csrf.value, 'tok');
  assert.equal(f.pw.value, undefined, 'password values are never exposed');
  assert.equal(f.msg.label, 'Message');
  const md = htmlToDocument(PAGE, { baseUrl: BASE }).markdown;
  assert.ok(md.includes('Form "contact": `POST https://acme.test/contact`\n- **Your name** (`name`, text, required)'), md);
  assert.ok(!md.includes('_csrf'), 'hidden fields stay out of markdown');
});

test('form controls outside the form (form="id") and GET default', () => {
  const doc = htmlToDocument('<body><form id="s" action="/search"></form><input form="s" name="q" type="search" title="Search"></body>');
  assert.deepEqual(doc.forms, [{ action: '/search', method: 'GET', name: 's', fields: [{ name: 'q', type: 'search', required: false, label: 'Search' }] }]);
});

test('fallback content: body without header/nav/footer/aside, but article headers stay', () => {
  const doc = htmlToDocument(`<html><head><title>T</title></head><body><header>Brand</header><nav><a href="/a">A</a></nav><div role="navigation">Menu</div>
    <article><header><h1>Post</h1></header><p>Body text</p><footer>By Ann</footer></article><aside>Ads</aside><footer>Copyright</footer></body></html>`);
  assert.equal(doc.markdown, '# Post\n\nBody text\n\nBy Ann\n');
  assert.equal(doc.links.length, 1, 'nav links are still listed');
});

test('forgiving parser: unclosed tags, void elements, unquoted/valueless attributes, comments, CDATA, case', () => {
  const doc = htmlToDocument(`<MAIN><P CLASS=x>one<p>two<!-- <p>hidden comment</p> --><BR/>three<p><![CDATA[a<b]]> &amp &lt;tag&gt; &#0; &#xD800; &bogus;
    <img src=a.png alt=pic><input disabled><p>Tom&apos;s <a href='x y.html'>link (1)</a></main>`, { baseUrl: 'https://h.test/d/' });
  assert.equal(doc.markdown, 'one\n\ntwo  \nthree\n\na\\<b & \\<tag> \uFFFD \uFFFD \\&bogus; ![pic](https://h.test/d/a.png)\n\nTom\'s [link (1)](https://h.test/d/x%20y.html)\n');
});

test('markdown special characters at line starts are escaped', () => {
  const md = htmlToDocument('<main><p># not a heading</p><p>1. not a list</p><p>- nor this</p><p>> quote</p><h2>Issue #</h2></main>').markdown;
  assert.equal(md, '\\# not a heading\n\n1\\. not a list\n\n\\- nor this\n\n\\> quote\n\n## Issue \\#\n');
});

test('hostile input: deep nesting, huge size, many unmatched tags, script-looking text', () => {
  const deep = '<div>'.repeat(100_000) + 'deep' + '</div>'.repeat(100_000);
  let t = Date.now();
  assert.equal(htmlToDocument(deep).markdown, 'deep\n');
  const lists = '<ul><li>x'.repeat(5000) + '<blockquote>'.repeat(5000) + 'end';
  assert.ok(htmlToDocument(lists).markdown.includes('end'));
  const junk = '</p></div></x>'.repeat(200_000) + '<b><i>'.repeat(50_000) + 'tail';
  assert.ok(htmlToDocument(junk).markdown.includes('tail'));
  assert.ok(Date.now() - t < 5000, `hostile inputs took ${Date.now() - t}ms`);

  t = Date.now();
  const big = '<p>' + 'word '.repeat(1_500_000) + '</p><p>after</p>';
  const doc = htmlToDocument(big);
  assert.ok(doc.markdown.length <= MAX_HTML_LENGTH, 'input beyond the cap is ignored');
  assert.ok(!doc.markdown.includes('after'));
  assert.ok(Date.now() - t < 5000, `5 MB input took ${Date.now() - t}ms`);

  const tricky = htmlToDocument('<main><p onclick="x">a</p><script>document.write("<h1>x</h1>")</script><style><h1>y</h1></style><textarea><h1>z</h1></textarea><a href=" JaVa\nScRiPt:alert(1)">bad</a></main>');
  assert.equal(tricky.markdown, 'a\n\nbad\n');
  assert.equal(tricky.links.length, 0);
  assert.doesNotThrow(() => htmlToDocument('<a href="'));
  assert.doesNotThrow(() => htmlToDocument('<<<>>><!--'));
  assert.doesNotThrow(() => htmlToDocument('<td colspan=99999999><table><tr><td colspan=99999999>x'));
});

test('self-referencing or duplicated streamed templates cannot loop or explode', () => {
  let html = '<main><amoxi-slot id="a"></amoxi-slot><amoxi-slot id="a"></amoxi-slot></main>';
  html += '<template data-amoxi-for="a"><p>A</p><amoxi-slot id="a">fb</amoxi-slot><amoxi-slot id="b"></amoxi-slot></template>';
  html += '<template data-amoxi-for="b"><p>B</p><amoxi-slot id="a">fb2</amoxi-slot></template>';
  assert.equal(htmlToDocument(html).markdown, 'A\n\nfb\n\nB\n\nfb2\n');
});

test('negotiateRepresentation: q-values and browsers', () => {
  assert.equal(negotiateRepresentation(undefined), 'html');
  assert.equal(negotiateRepresentation(''), 'html');
  assert.equal(negotiateRepresentation('*/*'), 'html');
  assert.equal(negotiateRepresentation('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'), 'html');
  assert.equal(negotiateRepresentation('text/markdown'), 'markdown');
  assert.equal(negotiateRepresentation('text/x-markdown'), 'markdown');
  assert.equal(negotiateRepresentation('text/markdown, text/html;q=0.9, */*;q=0.8'), 'markdown');
  assert.equal(negotiateRepresentation('text/html, text/markdown;q=0.5'), 'html');
  assert.equal(negotiateRepresentation('text/markdown;q=0'), 'html');
  assert.equal(negotiateRepresentation('application/json'), 'json');
  assert.equal(negotiateRepresentation('application/json, text/plain, */*'), 'html', 'generic HTTP clients get the page');
  assert.equal(negotiateRepresentation('application/json, text/html;q=0.5'), 'json');
  assert.equal(negotiateRepresentation('text/html, application/json'), 'html');
  assert.equal(negotiateRepresentation('application/json;q=0.9, text/markdown'), 'markdown');
  assert.equal(negotiateRepresentation('application/json;q=abc'), 'html');
  assert.equal(negotiateRepresentation('TEXT/MARKDOWN ; Q=1'), 'markdown');
});

test('markdownPath', () => {
  assert.equal(markdownPath('/about.md'), '/about');
  assert.equal(markdownPath('/index.md'), '/');
  assert.equal(markdownPath('/docs/index.md'), '/docs');
  assert.equal(markdownPath('/docs/intro.md'), '/docs/intro');
  assert.equal(markdownPath('/about'), undefined);
  assert.equal(markdownPath('/.md'), undefined);
  assert.equal(markdownPath('/docs/.md'), undefined);
  assert.equal(markdownPath('about.md'), undefined);
});

test('withData, toJson and renderRepresentation', () => {
  const page = withData('<p>view</p>', { id: 7 });
  assert.ok(page instanceof PageWithData);
  assert.ok(isPageWithData(page));
  assert.ok(!isPageWithData({ view: 1, data: 2 }));
  assert.equal(page.view, '<p>view</p>');
  assert.deepEqual(page.data, { id: 7 });

  const json = renderRepresentation(PAGE, 'json', { url: BASE, data: { plans: 2 } });
  assert.equal(json.contentType, 'application/json');
  const parsed = JSON.parse(json.body);
  assert.deepEqual(Object.keys(parsed), ['url', 'title', 'description', 'lang', 'headings', 'content', 'links', 'forms', 'data']);
  assert.equal(parsed.url, BASE);
  assert.deepEqual(parsed.data, { plans: 2 });
  assert.ok(parsed.content.includes('42 users online'));
  assert.ok(!('data' in toJson(htmlToDocument('<p>x</p>'), '/x')));

  const md = renderRepresentation(PAGE, 'markdown', { url: BASE });
  assert.equal(md.contentType, 'text/markdown; charset=utf-8');
  assert.ok(md.body.startsWith(`# Pricing 2026\n\nSource: ${BASE}\n\nOur plans`), md.body.slice(0, 80));
  const untitled = renderRepresentation('<title>About us</title><main><p>Hi</p></main>', 'markdown', { url: 'https://a.test/about' });
  assert.equal(untitled.body, '# About us\n\nSource: https://a.test/about\n\nHi\n');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => renderRepresentation('<p>x</p>', 'json', { url: '/x', data: cyclic }), /not JSON-serialisable/);
});

test('llms.txt follows llmstxt.org', () => {
  const site = {
    name: 'Acme',
    description: 'Acme sells\nwidgets.',
    baseUrl: 'https://acme.test/',
    pages: [
      { path: '/', title: 'Home', description: 'Start here' },
      { path: '/getting-started' },
      { path: '/people/:id' },
      { path: '/legal', title: 'Legal [old]', optional: true },
    ],
    apis: [{ method: 'get', path: '/api/todos', summary: 'List todos' }],
    agents: [{ name: 'support', description: 'Answers questions', url: '/agents/support' }],
    links: { openapi: '/amoxi/openapi.json', mcp: '/mcp', agentCard: '/.well-known/agent-card.json', full: '/llms-full.txt' },
  };
  const txt = buildLlmsTxt(site);
  const lines = txt.split('\n');
  assert.equal(lines[0], '# Acme');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '> Acme sells widgets.');
  assert.ok(txt.includes('## Pages\n\n- [Home](https://acme.test/index.md): Start here\n- [Getting started](https://acme.test/getting-started.md)\n'));
  assert.ok(!txt.includes(':id'), 'parameterised routes are skipped');
  assert.ok(txt.includes('## API\n\n- [OpenAPI specification](https://acme.test/amoxi/openapi.json): '));
  assert.ok(txt.includes('- [GET /api/todos](https://acme.test/api/todos): List todos'));
  assert.ok(txt.includes('## Agents\n\n- [support](https://acme.test/agents/support): Answers questions\n- [MCP server](https://acme.test/mcp)'));
  assert.ok(txt.includes('## Optional\n\n- [Legal \\[old\\]](https://acme.test/legal.md)\n- [Full content](https://acme.test/llms-full.txt)'));
  assert.ok(txt.indexOf('## Optional') > txt.indexOf('## Agents'), 'Optional comes last');
  assert.equal(markdownUrlFor('/'), '/index.md');
  assert.equal(markdownUrlFor('/docs/'), '/docs.md');

  const full = buildLlmsFullTxt(site, [
    { url: 'https://acme.test/', markdown: '# Home\n\nSource: https://acme.test/\n\nWelcome\n' },
    { url: 'https://acme.test/x', markdown: 'Plain' },
  ]);
  assert.ok(full.startsWith('# Acme\n\n> Acme sells widgets.\n\n---\n\n# Home\n\nSource: https://acme.test/\n\nWelcome\n'));
  assert.ok(full.includes('---\n\nSource: https://acme.test/x\n\nPlain\n'));
  const capped = buildLlmsFullTxt(site, [{ url: '/a', markdown: 'x'.repeat(500) }], { maxBytes: 200 });
  assert.ok(capped.includes('1 more page(s) omitted'));
});
