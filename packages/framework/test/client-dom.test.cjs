// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Browser runtime (client/dom, client/signals) on a minimal DOM: enough to check that keyed lists
// clean up after themselves and keep their rows' nodes together.
const test = require('node:test');
const assert = require('node:assert/strict');

/* A small DOM: nodes, text, fragments and elements, with only what the runtime uses. */
class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
  }
  get nextSibling() {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document.body;
  }
  insertBefore(child, before) {
    if (child.nodeType === 11) {
      for (const c of [...child.childNodes]) this.insertBefore(c, before);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (before && i < 0) throw new Error('the reference node is not a child');
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  append(...children) {
    for (const c of children) this.appendChild(c);
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...children);
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) this.data = v;
    else this.replaceChildren(new FakeText(v));
  }
}
class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = tag;
    this.attrs = {};
    this.style = {};
  }
  setAttribute(n, v) {
    this.attrs[n] = v;
  }
  removeAttribute(n) {
    delete this.attrs[n];
  }
  getAttribute(n) {
    return this.attrs[n] ?? null;
  }
  addEventListener() {}
}
globalThis.Node = FakeNode;
globalThis.document = {
  body: new FakeElement('body'),
  createTextNode: (d) => new FakeText(d),
  createDocumentFragment: () => new FakeNode(11),
  createElement: (t) => new FakeElement(t),
  createElementNS: (_ns, t) => new FakeElement(t),
};

const { load } = require('./dist.cjs');
const { jsx, For, mount, onMount } = load('client/dom');
const { signal, effect } = load('client/signals');

function host() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('For rows are disposed with the scope that rendered the list', () => {
  const log = [];
  const [tick, setTick] = signal(0);
  const [items] = signal([{ id: 1 }, { id: 2 }]);
  const [show, setShow] = signal(true);
  const Row = (item) => {
    onMount(() => {
      log.push(`mount${item.id}`);
      return () => log.push(`cleanup${item.id}`);
    });
    effect(() => {
      tick();
      log.push(`effect${item.id}`);
    });
    return jsx('li', { children: String(item.id) });
  };
  const el = host();
  const teardown = mount(el, () => jsx('ul', { children: () => (show() ? For({ each: items, key: (i) => i.id, children: Row }) : 'hidden') }), {});
  assert.deepEqual(log.splice(0), ['effect1', 'effect2', 'mount1', 'mount2']);
  setTick(1);
  assert.deepEqual(log.splice(0), ['effect1', 'effect2']);

  setShow(false);
  assert.deepEqual(log.splice(0), ['cleanup1', 'cleanup2'], 'hiding the list runs the rows\' cleanups');
  setTick(2);
  assert.deepEqual(log.splice(0), [], 'rows of a hidden list keep running');

  setShow(true);
  assert.deepEqual(log.splice(0), ['effect1', 'effect2', 'mount1', 'mount2'], 'rows shown again mount again');
  teardown();
  assert.deepEqual(log.splice(0), ['cleanup1', 'cleanup2'], 'tearing the island down runs the rows\' cleanups');
  setTick(3);
  assert.deepEqual(log.splice(0), []);
});

test('For keeps a row\'s nodes together when its top level re-renders, through reorders and removals', () => {
  const [items, setItems] = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const [mode, setMode] = signal('a');
  const Row = (item) => () => (mode() === 'a' ? jsx('li', { children: `A${item.id}` }) : [jsx('li', { children: `B${item.id}` }), jsx('li', { children: `b${item.id}` })]);
  const el = host();
  mount(el, () => jsx('ul', { children: For({ each: items, key: (i) => i.id, children: Row }) }), {});
  assert.equal(el.textContent, 'A1A2A3');
  setMode('b');
  assert.equal(el.textContent, 'B1b1B2b2B3b3');
  const [a, b, c] = items();
  setItems([c, a, b]);
  assert.equal(el.textContent, 'B3b3B1b1B2b2');
  setItems([c]);
  assert.equal(el.textContent, 'B3b3');
});
