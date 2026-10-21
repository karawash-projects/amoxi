// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Parameter marker types (PathParam<T>, Body<T>, Value<T, 'key', default>, Named<T, 'name'>...)
// replace parameter decorators so apps can use standard decorators. These tests build small
// projects with and without `experimentalDecorators` and check what `amoxi build` reads.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { load } = require('./dist.cjs');

const { analyzeProject } = load('compiler/analyzer');
const { validateGraph } = load('compiler/validator');

// At the repository root, so `import ... from 'amoxi'` resolves to this package through the
// workspace link, and the app's own files are outside packages/framework (as in a real app).
const ROOT = path.join(__dirname, '..', '..', '..', '.tmp-marker-tests');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function analyze(files, { experimentalDecorators }) {
  const dir = path.join(ROOT, `p${process.pid}-${n++}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      moduleResolution: 'node10',
      lib: ['ES2022', 'DOM'],
      types: [],
      strict: true,
      skipLibCheck: true,
      experimentalDecorators,
      noEmit: true,
    },
    include: ['src'],
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src', name), body);
  const analysis = analyzeProject(path.join(dir, 'tsconfig.json'), path.join(dir, 'src', 'generated', 'amoxi.generated.ts'));
  const graph = validateGraph(analysis.beans);
  const typeErrors = ts
    .getPreEmitDiagnostics(analysis.program)
    // TypeScript reports paths with forward slashes, also on Windows: compare normalized paths.
    .filter((d) => d.file && path.normalize(d.file.fileName).startsWith(path.normalize(dir) + path.sep))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  const errors = [...analysis.diagnostics, ...graph.diagnostics].map((d) => d.message);
  const bean = (name) => analysis.beans.find((b) => b.name === name);
  return { analysis, errors, typeErrors, bean };
}

const APP = {
  'greeter.ts': `
import { Named, Singleton } from 'amoxi';
export interface Greeter { greet(name: string): string }
@Singleton() @Named('formal')
export class FormalGreeter implements Greeter { greet(n: string) { return 'Good morning, ' + n; } }
@Singleton() @Named('friendly')
export class FriendlyGreeter implements Greeter { greet(n: string) { return 'Hi ' + n; } }
`,
  'service.ts': `
import { Named, Singleton, Value } from 'amoxi';
import type { Greeter } from './greeter';
@Singleton()
export class GreetingService {
  constructor(
    private readonly greeter: Named<Greeter, 'formal'>,
    private readonly punctuation: Value<string, 'greeting.punctuation', '!'>,
    private readonly max: Value<number, 'notes.max', 100>,
    private readonly loud: Value<boolean, 'greeting.loud', false>,
    private readonly style: Value<string, 'greeting.style'>,
  ) {}
  message(n: string): string { return this.greeter.greet(n) + this.punctuation.repeat(this.max > 0 && !this.loud ? 1 : 2) + this.style.length; }
}
`,
  'controller.ts': `
import { Body, Controller, Get, Header, PathParam, Post, QueryParam, type RequestContext } from 'amoxi';
import { GreetingService } from './service';
export interface NewNote {
  /** @minLength 1 */
  readonly text: string;
}
@Controller('/api')
export class NoteController {
  constructor(private readonly greetings: GreetingService) {}
  @Get('/notes/:id')
  get(id: PathParam<number>, verbose?: QueryParam<boolean>, q?: QueryParam<string, 'search'> | undefined) {
    return { id: id + 1, verbose, q: q?.trim(), hello: this.greetings.message('Sam') };
  }
  @Get('/orders/:orderId')
  order(orderId: PathParam<string, 'orderId'>, requestId: Header<string, 'X-Request-Id'>, ctx: RequestContext) {
    return { orderId: orderId.toUpperCase(), requestId, path: ctx.path };
  }
  @Post('/notes')
  create(body: Body<NewNote>) { return body.text.trim(); }
}
`,
};

function checkApp(r) {
  assert.deepEqual(r.typeErrors, [], 'TypeScript accepts the app');
  assert.deepEqual(r.errors, [], 'amoxi build accepts the app');

  const routes = r.bean('NoteController').routes;
  const get = routes.find((x) => x.methodName === 'get');
  assert.deepEqual(get.params, [
    { kind: 'path', name: 'id', coerce: 'number', required: true },
    { kind: 'query', name: 'verbose', coerce: 'boolean', required: false },
    { kind: 'query', name: 'search', coerce: 'string', required: false },
  ]);
  const order = routes.find((x) => x.methodName === 'order');
  assert.deepEqual(order.params, [
    { kind: 'path', name: 'orderId', coerce: 'string', required: true },
    { kind: 'header', name: 'x-request-id', coerce: 'string', required: true },
    { kind: 'context' },
  ]);
  const create = routes.find((x) => x.methodName === 'create');
  assert.equal(create.params[0].kind, 'body');
  assert.ok(create.params[0].schema, 'the body gets a validator');
  assert.equal(create.bodyName, 'NewNote');

  const inj = r.bean('GreetingService').injections;
  assert.equal(inj[0].kind, 'bean');
  assert.equal(inj[0].typeName, 'Greeter');
  assert.equal(inj[0].qualifier, 'formal');
  const values = inj.slice(1).map(({ kind, key, fallback, coerce }) => ({ kind, key, fallback, coerce }));
  assert.deepEqual(values, [
    { kind: 'value', key: 'greeting.punctuation', fallback: '!', coerce: 'string' },
    { kind: 'value', key: 'notes.max', fallback: '100', coerce: 'number' },
    { kind: 'value', key: 'greeting.loud', fallback: 'false', coerce: 'boolean' },
    { kind: 'value', key: 'greeting.style', fallback: undefined, coerce: 'string' },
  ]);
}

test('marker types work with standard decorators (no experimentalDecorators)', () => {
  checkApp(analyze(APP, { experimentalDecorators: false }));
});

test('marker types work the same with experimentalDecorators', () => {
  checkApp(analyze(APP, { experimentalDecorators: true }));
});

test('parameter decorators still work with experimentalDecorators, alongside marker types', () => {
  const r = analyze(
    {
      ...APP,
      'legacy.ts': `
import { Body, Controller, PathParam, Post, Value, Singleton } from 'amoxi';
@Singleton()
export class Legacy { constructor(@Value('\${legacy.port:8080}') readonly port: number) {} }
@Controller('/legacy')
export class LegacyController {
  @Post('/:id') save(@PathParam() id: number, @Body() body: { name: string }) { return { id, body }; }
}
`,
    },
    { experimentalDecorators: true },
  );
  assert.deepEqual(r.typeErrors, []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.bean('LegacyController').routes[0].params.map((p) => p.kind), ['path', 'body']);
  const v = r.bean('Legacy').injections[0];
  assert.deepEqual([v.kind, v.key, v.fallback, v.coerce], ['value', 'legacy.port', '8080', 'number']);
});

test('without experimentalDecorators, parameter decorators are a TypeScript error; marker types are the way', () => {
  const r = analyze(
    {
      'c.ts': `
import { Body, Controller, Post } from 'amoxi';
@Controller() export class C { @Post() save(@Body() body: { name: string }) { return body; } }
`,
    },
    { experimentalDecorators: false },
  );
  assert.ok(r.typeErrors.some((m) => /Decorators are not valid here/.test(m)), r.typeErrors.join('\n'));
});

test('renamed imports of marker types are recognised', () => {
  const r = analyze(
    {
      'c.ts': `
import { Controller, Post, Body as Json, PathParam as Segment } from 'amoxi';
@Controller() export class C { @Post('/:id') save(id: Segment<number>, body: Json<{ name: string }>) { return { id, body }; } }
`,
    },
    { experimentalDecorators: false },
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.bean('C').routes[0].params.map((p) => p.kind), ['path', 'body']);
});

test('a look-alike type of the same name is not a marker', () => {
  const r = analyze(
    {
      'c.ts': `
import { Controller, Post } from 'amoxi';
type Body<T> = T;
@Controller() export class C { @Post() save(body: Body<{ name: string }>) { return body; } }
`,
    },
    { experimentalDecorators: false },
  );
  assert.ok(r.errors.some((m) => /needs a binding: PathParam<T>/.test(m)), r.errors.join('\n'));
});

test('marker mistakes fail the build with a clear message', () => {
  const r = analyze(
    {
      'c.ts': `
import { Body, Controller, Get, PathParam, Post, Singleton, Value } from 'amoxi';
@Singleton()
export class S {
  constructor(
    readonly port: Value<number, 'server.port', 'eighty'>,
    readonly id: PathParam<number>,
  ) {}
}
@Controller('/x')
export class C {
  @Get('/:id') one(id: PathParam<number, 'nope'>) { return id; }
  @Get('/two') two(port: Value<number, 'server.port'>) { return port; }
  @Post('/three') three(@Body() body: Body<{ a: string }>) { return body; }
}
`,
    },
    { experimentalDecorators: true },
  );
  const all = r.errors.join('\n');
  assert.match(all, /'eighty' is not a valid number/);
  assert.match(all, /PathParam<\.\.\.> on 'S\(id\)' only applies to route parameters/);
  assert.match(all, /Path parameter 'nope' in C\.one\(\): route 'GET \/x\/:id' has no ':nope' segment/);
  assert.match(all, /Value<\.\.\.> on 'port' of C\.two\(\): route parameters take PathParam/);
  assert.match(all, /uses both @Body and Body<\.\.\.>: use one/);
});
