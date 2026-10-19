// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import type { IslandModel } from './analyzer';
import type { BeanModel, Condition, Constraints, Injection, RouteModel, RouteParam, Schema } from './model';
import { toJsonSchema } from './openapi';
import type { ResolvedGraph } from './validator';

export { COMPILER_VERSION } from './version';
import { COMPILER_VERSION } from './version';

export interface CodegenOptions {
  /** Absolute path of the generated file. */
  readonly outFile: string;
  /** Module specifier of the runtime. */
  readonly runtimeModule: string;
  /** Browser bundles for islands and stylesheets, if any. */
  readonly client?: { readonly hydrate: string; readonly islands: Readonly<Record<string, string>>; readonly styles?: Readonly<Record<string, string>> };
  readonly i18n?: { defaultLocale: string; locales: string[]; messages: Record<string, Record<string, string>> };
  readonly openapi?: unknown;
  readonly sessionKey?: string;
  /** React islands: registered so the server renders them with react-dom/server. */
  readonly reactIslands?: ReadonlyArray<{ name: string; file: string }>;
  /** Set when the app uses amoxi/ai: its islands (generative ones become UI components). */
  readonly ai?: { readonly islands: readonly IslandModel[] };
}

/** Turns a @Requires condition into a predicate over the runtime Config. */
function conditionCode(c: Condition): string {
  const parts: string[] = [];
  if (c.property !== undefined) {
    parts.push(c.value !== undefined ? `c.has(${q(c.property)}) && c.string(${q(c.property)}) === ${q(c.value)}` : `c.has(${q(c.property)}) && !['', 'false'].includes(c.string(${q(c.property)}))`);
  }
  if (c.missing !== undefined) parts.push(`!c.has(${q(c.missing)})`);
  if (c.profile) parts.push(`${q(c.profile)}.includes(c.profile)`);
  if (c.notProfile) parts.push(`!${q(c.notProfile)}.includes(c.profile)`);
  return parts.map((p) => `(${p})`).join(' && ') || 'true';
}

/** Emits validator code for body schemas, hoisting constants so validation allocates little. */
class ValidatorEmitter {
  readonly decls: string[] = [];
  private n = 0;

  private hoist(prefix: string, code: string): string {
    // Underscore-prefixed so they never clash with the C<n>/R<n>/G<n> import aliases.
    const name = `_${prefix}${this.n++}`;
    this.decls.push(`const ${name} = ${code};`);
    return name;
  }

  private constraints(c: Constraints): string {
    const parts = Object.entries(c).map(([k, v]) => (k === 'pattern' ? `pattern: new RegExp(${q(v)})` : `${k}: ${q(v)}`));
    return this.hoist('K', `{ ${parts.join(', ')} }`);
  }

  check(s: Schema): string {
    switch (s.k) {
      case 'any':
        return '$v.any';
      case 'string':
        return s.c ? `(x: unknown, e: any, p: string) => $v.str(x, e, p, ${this.constraints(s.c)})` : '$v.str';
      case 'number':
        return s.c ? `(x: unknown, e: any, p: string) => $v.num(x, e, p, ${this.constraints(s.c)})` : '$v.num';
      case 'boolean':
        return '$v.bool';
      case 'literal':
        return `(x: unknown, e: any, p: string) => $v.lit(x, e, p, ${this.hoist('L', q(s.values))})`;
      case 'array': {
        const item = this.hoist('C', this.check(s.items));
        return `(x: unknown, e: any, p: string) => $v.arr(x, e, p, ${item}${s.c ? `, ${this.constraints(s.c)}` : ''})`;
      }
      case 'object': {
        const fields = s.fields.map((f) => `[${q(f.name)}, ${this.check(f.schema)}, ${f.optional}]`);
        const list = this.hoist('F', `[${fields.join(', ')}] as const`);
        return `(x: unknown, e: any, p: string) => $v.obj(x, e, p, ${list})`;
      }
      case 'record':
        return `(x: unknown, e: any, p: string) => $v.rec(x, e, p, ${this.hoist('C', this.check(s.values))})`;
      case 'nullable':
        return `(x: unknown, e: any, p: string) => $v.nul(x, e, p, ${this.hoist('C', this.check(s.inner))})`;
      case 'union':
        return `(x: unknown, e: any, p: string) => $v.union(x, e, p, [${s.options.map((o) => this.check(o)).join(', ')}])`;
    }
  }

  validator(s: Schema): string {
    return this.hoist('V', this.check(s));
  }
}

const q = JSON.stringify;

/**
 * Emits a plain TypeScript module. The generated code is ordinary `new` expressions and
 * method calls, so the TypeScript compiler type-checks the wiring too (wrong arity,
 * renamed lifecycle methods, etc. become compile errors).
 */
export function generateModule(graph: ResolvedGraph, options: CodegenOptions): string {
  const { ordered, idOf, resolution, dependencies, interceptors } = graph;
  const byIndex = new Map(ordered.map((b) => [b.index, b]));
  const isConditional = (index: number): boolean => {
    const b = byIndex.get(index)!;
    return !!b.condition || (!!b.factory && !!byIndex.get(b.factory.ownerIndex)!.condition);
  };
  const outDir = path.dirname(options.outFile);

  // Imports: one alias per (file, class)
  const aliases = new Map<string, string>();
  const importLines: string[] = [];
  const aliasFor = (bean: BeanModel): string => {
    const key = `${bean.importFile}#${bean.importName}`;
    let alias = aliases.get(key);
    if (!alias) {
      alias = `C${aliases.size}`;
      aliases.set(key, alias);
      let spec = path.relative(outDir, bean.importFile).split(path.sep).join('/').replace(/\.(ts|tsx|mts|cts)$/, '');
      if (!spec.startsWith('.')) spec = `./${spec}`;
      importLines.push(`import { ${bean.importName} as ${alias} } from ${q(spec)};`);
    }
    return alias;
  };

  let needs: number[][] = [];
  const injectionExpr = (inj: Injection): string => {
    switch (inj.kind) {
      case 'bean': {
        const ids = resolution.get(inj) ?? [];
        if (ids.length === 0) return 'undefined';
        const runtimeIds = ids.map((i) => idOf.get(i)!);
        if (ids.length === 1 && !isConditional(ids[0])) return `r.get(${runtimeIds[0]})`;
        // @Requires alternatives: resolved once against the configuration.
        if (inj.optional) return `r.pickOptional(${q(runtimeIds)})`;
        needs.push(runtimeIds);
        return `r.pick(${q(runtimeIds)})`;
      }
      case 'beans': {
        const ids = resolution.get(inj) ?? [];
        return ids.some(isConditional) ? `r.getAll(${q(ids.map((i) => idOf.get(i)!))})` : `[${ids.map((i) => `r.get(${idOf.get(i)})`).join(', ')}]`;
      }
      case 'provider':
        return `r.provider(${q((resolution.get(inj) ?? []).map((i) => idOf.get(i)!))})`;
      case 'request':
        return 'r.request()';
      case 'value':
        if (inj.literal !== undefined) {
          return inj.coerce === 'number'
            ? String(Number(inj.literal))
            : inj.coerce === 'boolean'
              ? String(['true', '1', 'yes'].includes(inj.literal.toLowerCase()))
              : q(inj.literal);
        }
        return `r.config.${inj.coerce}(${q(inj.key)}${inj.fallback !== undefined ? `, ${q(inj.fallback)}` : ''})`;
      case 'context':
        return '(r as any)';
      case 'invalid':
        return 'undefined';
    }
  };

  const beanLines: string[] = [];
  for (const bean of ordered) {
    const id = idOf.get(bean.index)!;
    if (bean.kind === 'builtin') {
      // An amoxi/ai service the app didn't implement: created from configuration on first use.
      beanLines.push(
        `// built-in (amoxi/ai)\nbeans.push({\n  id: ${id},\n  name: ${q(bean.name)},\n  scope: "singleton",\n  eager: false,\n  primary: false,\n  types: ${q(bean.typeNames)},\n  dependencies: [],\n  create: (r: BeanResolver) => $aiService(r, ${q(bean.name)}),\n});`,
      );
      continue;
    }
    const alias = aliasFor(bean);
    needs = [];
    const args = bean.injections.map(injectionExpr).join(', ');
    let instance = bean.factory ? `(r.get(${idOf.get(bean.factory.ownerIndex)}) as ${alias}).${bean.factory.method}(${args})` : `new ${alias}(${args})`;
    const plan = interceptors.get(bean.index);
    if (plan && plan.size > 0) {
      const entries = [...plan].map(([m, list]) => `${q(m)}: ${q(list.map((i) => idOf.get(i)!))}`);
      instance = `r.intercept(${instance}, ${q(bean.name)}, { ${entries.join(', ')} })`;
    }
    const create = `(r: BeanResolver) => ${instance}`;
    const conditions = [bean.condition, bean.factory ? byIndex.get(bean.factory.ownerIndex)!.condition : undefined].filter((c): c is Condition => !!c);
    const bType = bean.kind === 'class' ? alias : 'any';

    const fields = [
      `id: ${id}`,
      `name: ${q(bean.name)}`,
      `scope: ${q(bean.scope)}`,
      `eager: ${bean.eager}`,
      `primary: ${bean.primary}`,
      ...(bean.qualifier !== undefined ? [`qualifier: ${q(bean.qualifier)}`] : []),
      `types: ${q(bean.typeNames)}`,
      ...(conditions.length ? [`condition: (c: Config) => ${conditions.map(conditionCode).join(' && ')}`] : []),
      ...(needs.length ? [`needs: ${q(needs)}`] : []),
      `dependencies: ${q((dependencies.get(bean.index) ?? []).map((i) => idOf.get(i)!).sort((a, b) => a - b))}`,
      `create: ${create}`,
      ...(bean.postConstruct ? [`postConstruct: (b: ${bType}) => b.${bean.postConstruct}()`] : []),
      ...(bean.preDestroy ? [`preDestroy: (b: ${bType}) => b.${bean.preDestroy}()`] : []),
    ];
    // One statement per bean: each object literal is contextually typed on its own, which keeps
    // type-checking linear for apps with thousands of beans (a single array literal hits TS2590).
    beanLines.push(`// ${bean.loc.file}:${bean.loc.line}\nbeans.push({\n  ${fields.join(',\n  ')},\n});`);
  }

  // Type index for manual lookups: primary beans first.
  const typeIndex: Record<string, number[]> = {};
  for (const bean of ordered) {
    for (const t of bean.typeNames) (typeIndex[t] ??= []).push(idOf.get(bean.index)!);
  }
  for (const ids of Object.values(typeIndex)) {
    ids.sort((a, b) => Number(ordered[b].primary) - Number(ordered[a].primary) || a - b);
  }

  const validators = new ValidatorEmitter();
  const routeLines: string[] = [];
  for (const bean of ordered) {
    for (const route of bean.routes) routeLines.push(routeEntry(route, idOf.get(bean.index)!, aliasFor(bean), validators));
  }
  const socketLines: string[] = [];
  for (const bean of ordered) {
    const ws = bean.websocket;
    if (!ws) continue;
    const paramNames: string[] = [];
    const source = ws.path
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '\\/([^/]+)';
        }
        return '\\/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    const alias = aliasFor(bean);
    socketLines.push(`websockets.push({
  path: ${q(ws.path)},
  pattern: ${paramNames.length ? String(new RegExp(`^${source}$`)) : 'null'},
  paramNames: ${q(paramNames)},
  beanId: ${idOf.get(bean.index)},${ws.open !== false ? `\n  open: (c: ${alias}, s: WebSocketConnection) => c.onOpen(${['s'].slice(0, ws.open).join(', ')}),` : ''}
  message: (c: ${alias}, s: WebSocketConnection, d: string | Buffer) => c.onMessage(${['s', 'd'].slice(0, ws.message).join(', ')}),${ws.close !== false ? `\n  close: (c: ${alias}, s: WebSocketConnection, code: number, reason: string) => c.onClose(${['s', 'code', 'reason'].slice(0, ws.close).join(', ')}),` : ''}
});`);
  }

  const aiCode = options.ai ? aiSection(graph, options.ai.islands, aliasFor, validators, outDir, importLines) : undefined;

  const errorPageLines: string[] = [];
  for (const bean of ordered) {
    for (const ep of bean.errorPages) {
      const args = ep.params.map(() => 'x').join(', ');
      errorPageLines.push(`  ${ep.status}: { beanId: ${idOf.get(bean.index)}, handler: (c: ${aliasFor(bean)}, x: RequestContext) => $page(c.${ep.methodName}(${args}), x) },`);
    }
  }

  const middleware = ordered
    .filter((b) => b.middlewareOrder !== undefined)
    .sort((a, b) => a.middlewareOrder! - b.middlewareOrder! || idOf.get(a.index)! - idOf.get(b.index)!)
    .map((b) => idOf.get(b.index)!);

  const emitted = [...routeLines, ...errorPageLines, ...validators.decls, aiCode ?? ''].join('\n');
  // React islands: mark the component functions so <Island> renders them with react-dom/server.
  const reactLines = (options.reactIslands ?? []).map((island, i) => {
    let spec = path.relative(outDir, island.file).split(path.sep).join('/').replace(/\.(tsx|jsx)$/, '');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    importLines.push(`import R${i} from ${q(spec)};`);
    return `$reactIsland(R${i});`;
  });

  const helpers = ['$reactIsland', '$str', '$optStr', '$num', '$optNum', '$bool', '$optBool', '$header', '$page', '$validate', '$v'].filter((h) =>
    new RegExp(`\\${h}[(.<]`).test(emitted + reactLines.join('\n')),
  );
  const runtimeImports = [...helpers, 'type ApplicationModule', 'type BeanDefinition', 'type BeanResolver', 'type Config', 'type RequestContext', 'type RouteDefinition', 'type WebSocketConnection', 'type WebSocketDefinition'];

  if (options.ai) {
    const aiImports = ['aiExtension', ...(ordered.some((b) => b.kind === 'builtin') ? ['$aiService'] : []), 'type AiModule', 'type ToolContext'];
    importLines.unshift(`import { ${aiImports.join(', ')} } from ${q(`${options.runtimeModule}/ai`)};`);
  }

  return `/* eslint-disable */
// @generated by Amoxi AOT compiler v${COMPILER_VERSION}. DO NOT EDIT.
// Regenerate with \`amoxi build\`. This file contains the fully resolved dependency graph:
// no reflection, no decorator metadata and no scanning happen at runtime.
// ${ordered.length} beans, ${routeLines.length} routes.

import { ${runtimeImports.join(', ')} } from ${q(options.runtimeModule)};
${importLines.join('\n')}

const beans: BeanDefinition[] = [];
${beanLines.join('\n')}

const typeIndex: Record<string, readonly number[]> = ${q(typeIndex)};

${validators.decls.length ? `// Request-body validators generated from your TypeScript types.\n${validators.decls.join('\n')}\n` : ''}
const routes: RouteDefinition[] = [];
${routeLines.join('\n')}
${errorPageLines.length ? `\nconst errorPages = {\n${errorPageLines.join('\n')}\n};\n` : ''}

const middleware: readonly number[] = ${q(middleware)};
${reactLines.length ? `\n${reactLines.join('\n')}\n` : ''}

const websockets: WebSocketDefinition[] = [];
${socketLines.join('\n')}
${options.i18n ? `\nconst i18n = ${q(options.i18n)};\n` : ''}${options.sessionKey ? `\n// Session encryption key generated at build time (server-only; never sent to browsers).\nconst sessionKey = ${q(options.sessionKey)};\n` : ''}${options.openapi ? `\nconst openapi = ${q(options.openapi)};\n` : ''}
${options.client ? `\nconst client = ${q(options.client)};\n` : ''}${aiCode ? `\n// Agents, tools and generative UI components (amoxi/ai).\n${aiCode}\n` : ''}
export const applicationModule: ApplicationModule = {
  beans,
  typeIndex,
  routes,
  middleware,
  websockets,${options.client ? '\n  client,' : ''}${aiCode ? '\n  ai,\n  extensions: [aiExtension],' : ''}${errorPageLines.length ? '\n  errorPages,' : ''}${options.i18n ? '\n  i18n,' : ''}${options.openapi ? '\n  openapi,' : ''}${options.sessionKey ? '\n  sessionKey,' : ''}
  buildInfo: { generatedAt: ${q(new Date().toISOString())}, compilerVersion: ${q(COMPILER_VERSION)} },
};

export default applicationModule;
`;
}

function routeEntry(route: RouteModel, beanId: number, alias: string, validators: ValidatorEmitter): string {
  const paramNames: string[] = [];
  const source = route.path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '\\/([^/]+)';
      }
      return '\\/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  // Static routes skip regex matching entirely (Map lookup at runtime).
  const pattern = paramNames.length === 0 ? 'null' : String(new RegExp(`^${source}$`));
  const call = `c.${route.methodName}(${route.params.map((p) => paramExpr(p, validators)).join(', ')})`;
  const needsBody = route.params.some((p) => p.kind === 'body');
  const multipart = route.params.some((p) => p.kind === 'multipart');

  return `routes.push({
  method: ${q(route.method)},
  path: ${q(route.path)},
  pattern: ${pattern},
  paramNames: ${q(paramNames)},
  beanId: ${beanId},
  needsBody: ${needsBody},${route.page ? '\n  page: true,' : ''}${multipart ? '\n  multipart: true,' : ''}${route.cache ? `\n  cache: { ttl: ${route.cache.ttl}, swr: ${route.cache.swr} },` : ''}
  handler: (c: ${alias}, x: RequestContext) => ${route.page ? `$page(${call}, x)` : call},
});`;
}

function paramExpr(p: RouteParam, validators: ValidatorEmitter): string {
  switch (p.kind) {
    case 'body':
      return p.schema ? `$validate<any>(x.body, ${validators.validator(p.schema)})` : 'x.body as any';
    case 'context':
      return 'x';
    case 'multipart':
      return 'x.body as any';
    default: {
      const raw =
        p.kind === 'path' ? `x.params[${q(p.name)}]` : p.kind === 'query' ? `x.query.get(${q(p.name)})` : `$header(x, ${q(p.name)})`;
      const fn = { string: 'Str', number: 'Num', boolean: 'Bool' }[p.coerce];
      return p.required ? `$${fn.toLowerCase()}(${raw}, ${q(p.name)}, ${q(p.kind)})` : `$opt${fn}(${raw}, ${q(p.name)}, ${q(p.kind)})`;
    }
  }
}

/**
 * Emits the `ai` section: tool definitions with JSON Schemas and validators generated from the
 * tool methods' parameter types, agent definitions, and generative UI components.
 */
function aiSection(
  graph: ResolvedGraph,
  islands: readonly IslandModel[],
  aliasFor: (bean: BeanModel) => string,
  validators: ValidatorEmitter,
  outDir: string,
  importLines: string[],
): string {
  const { ordered, idOf } = graph;
  const lines: string[] = ['const tools: AiModule["tools"][number][] = [];'];
  for (const bean of ordered) {
    if (bean.tools.length === 0) continue;
    const alias = aliasFor(bean);
    for (const t of bean.tools) {
      const argc = Math.max(t.inputIndex ?? -1, t.contextIndex ?? -1) + 1;
      const args = Array.from({ length: argc }, (_, i) => (i === t.inputIndex ? 'i' : i === t.contextIndex ? 't' : 'undefined')).join(', ');
      const inputSchema = t.input ? toJsonSchema(t.input) : { type: 'object', properties: {} };
      const validate = t.input ? `(x: unknown) => $validate<any>(x ?? {}, ${validators.validator(t.input)})` : '(_x: unknown) => ({})';
      lines.push(`tools.push({
  name: ${q(t.name)},
  description: ${q(t.description)},
  beanId: ${idOf.get(bean.index)},
  inputSchema: ${q(inputSchema)},${t.output ? `\n  outputSchema: ${q(toJsonSchema(t.output))},` : ''}
  validate: ${validate},
  invoke: (b: ${alias}, i: any, t: ToolContext) => b.${t.methodName}(${args}),
  approval: ${t.approval},
  readOnly: ${t.readOnly},
  idempotent: ${t.idempotent},
  expose: ${t.expose},
  source: ${q(`${bean.name}.${t.methodName}`)},
});`);
    }
  }

  const generative = islands.filter((i) => i.generative);
  lines.push('const components: AiModule["components"][number][] = [];');
  generative.forEach((island, n) => {
    let spec = path.relative(outDir, island.file).split(path.sep).join('/').replace(/\.(tsx|jsx|ts|js)$/, '');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    importLines.push(`import G${n} from ${q(spec)};`);
    const g = island.generative!;
    lines.push(`components.push({
  name: ${q(island.name)},
  description: ${q(g.description)},
  propsSchema: ${q(toJsonSchema(g.props))},
  validate: (x: unknown) => $validate<any>(x ?? {}, ${validators.validator(g.props)}),
  component: G${n} as (props: any) => unknown,
});`);
  });

  lines.push('const agents: AiModule["agents"][number][] = [];');
  for (const bean of ordered) {
    const a = bean.agent;
    if (!a) continue;
    const toolNames = [...bean.tools.map((t) => t.name)];
    for (const ref of a.toolClasses) {
      const provider = ordered.find((b) => b.types.includes(ref.typeKey));
      for (const t of provider?.tools ?? []) if (!toolNames.includes(t.name)) toolNames.push(t.name);
    }
    const ui = a.ui === 'all' ? generative.map((i) => i.name) : a.ui;
    const fields = [
      `name: ${q(a.name)}`,
      `description: ${q(a.description)}`,
      `beanId: ${idOf.get(bean.index)}`,
      `tools: ${q(toolNames)}`,
      `ui: ${q(ui)}`,
      `knowledge: ${q(a.knowledge)}`,
      `recall: ${a.recall}`,
      `rememberTool: ${a.rememberTool}`,
      `examples: ${q(a.examples)}`,
      ...(a.maxTurns !== undefined ? [`maxTurns: ${a.maxTurns}`] : []),
      ...(a.model !== undefined ? [`model: ${q(a.model)}`] : []),
      `hooks: ${q(a.hooks)}`,
    ];
    lines.push(`// ${a.loc.file}:${a.loc.line}\nagents.push({\n  ${fields.join(',\n  ')},\n});`);
  }
  lines.push('const ai: AiModule = { tools, agents, components };');
  return lines.join('\n');
}
