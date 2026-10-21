// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import ts from 'typescript';
import { existsSync } from 'node:fs';
import type { AgentModel, BeanModel, Coercion, Condition, Constraints, Diagnostic, Injection, RouteModel, RouteParam, Schema, SourceLocation, ToolModel } from './model';

const BEAN_CLASS_DECORATORS = new Set(['Singleton', 'Prototype', 'Eager', 'Controller', 'Factory', 'Middleware', 'RequestScope', 'WebSocketEndpoint', 'Agent']);

/**
 * Services of `amoxi/ai` that beans can inject. When the app doesn't implement one itself,
 * the compiler adds a built-in bean for it (chosen by configuration at startup).
 */
export const AI_SERVICES = ['ChatModel', 'Embedder', 'VectorStore', 'ConversationStore', 'RunStore', 'AgentPlatform', 'KnowledgeBases', 'MemoryService'] as const;
const AI_SERVICE_SET: ReadonlySet<string> = new Set(AI_SERVICES);
/** Stable type key of an AI service, whatever path the framework is installed under. */
export const aiServiceKey = (name: string): string => `amoxi:ai#${name}`;
/** Tool names the runtime adds itself. */
const RESERVED_TOOLS = new Set(['remember', 'search_knowledge']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const HTTP_METHODS: Readonly<Record<string, string>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Page: 'GET',
};
const FRAMEWORK_FILE = /(node_modules[\\/]amoxi|packages[\\/]framework)[\\/]/;

/** Marker types that stand in for parameter decorators (they work with standard decorators). */
const PARAMETER_MARKERS = new Set(['PathParam', 'QueryParam', 'Header', 'Body', 'Multipart', 'Value', 'Named']);

interface DecoratorInfo {
  readonly name: string;
  readonly args: readonly ts.Expression[];
}

export interface IslandModel {
  readonly name: string;
  readonly file: string;
  /** A React component (file named <Name>.react.tsx), rendered and hydrated with React. */
  readonly react: boolean;
  /** `@generative`: agents may show it, with props validated against its props type. */
  readonly generative?: { readonly description: string; readonly props: Schema };
}

export interface AnalyzeOptions {
  readonly islandsDir?: string;
  readonly stylesDir?: string;
  /** Previous program, for fast incremental re-analysis in `amoxi dev`. */
  readonly oldProgram?: ts.Program;
  /** Keys of the default-locale bundle: `ctx.t('literal')` calls are checked against them. */
  readonly i18nKeys?: ReadonlySet<string>;
}

export interface AnalysisResult {
  readonly program: ts.Program;
  readonly beans: BeanModel[];
  readonly islands: IslandModel[];
  readonly diagnostics: Diagnostic[];
  readonly filesAnalyzed: number;
  /** The app uses amoxi/ai (agents, tools, generative islands or AI services). */
  readonly usesAi: boolean;
}

/**
 * Builds a TypeScript Program for the app and statically discovers every bean.
 * This is the equivalent of Micronaut's annotation processor: it uses the compiler's
 * type checker instead of runtime reflection to know what each constructor needs.
 */
export function analyzeProject(tsconfigPath: string, generatedFile: string, opts: AnalyzeOptions = {}): AnalysisResult {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const projectDir = path.dirname(tsconfigPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectDir);
  const generated = path.resolve(generatedFile);
  const program = ts.createProgram({
    rootNames: parsed.fileNames.filter((f) => path.resolve(f) !== generated),
    options: { ...parsed.options, noEmit: true },
    oldProgram: opts.oldProgram,
  });

  const analyzer = new Analyzer(program.getTypeChecker(), projectDir, opts.islandsDir ? path.resolve(opts.islandsDir) : undefined, opts.stylesDir ? path.resolve(opts.stylesDir) : undefined, opts.i18nKeys);
  let filesAnalyzed = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/') || path.resolve(sf.fileName) === generated) {
      continue;
    }
    filesAnalyzed++;
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt)) analyzer.visitClass(stmt);
    }
    analyzer.visitIslands(sf);
  }
  const usesAi = analyzer.finishAi();
  return { program, beans: analyzer.beans, islands: analyzer.islands, diagnostics: analyzer.diagnostics, filesAnalyzed, usesAi };
}

class Analyzer {
  readonly beans: BeanModel[] = [];
  readonly islands: IslandModel[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private readonly keyCache = new Map<ts.Symbol, string>();
  /** Some bean injects an AI service. */
  private injectsAi = false;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly projectDir: string,
    private readonly islandsDir: string | undefined,
    private readonly stylesDir: string | undefined,
    private readonly i18nKeys: ReadonlySet<string> | undefined,
  ) {}

  /** When set, unsupported types in schemas become `any` silently (used for OpenAPI response schemas). */
  private lenient = false;

  /* ---------------------------------------------------------------- */
  /* Islands                                                           */
  /* ---------------------------------------------------------------- */

  private inIslandsDir(file: string): boolean {
    return !!this.islandsDir && path.dirname(path.resolve(file)) === this.islandsDir;
  }

  /** Validates island modules and every `<Island of={X}>` usage in this file. */
  visitIslands(sf: ts.SourceFile): void {
    if (this.inIslandsDir(sf.fileName) && /\.(tsx?|jsx?)$/.test(sf.fileName)) {
      const react = /\.react\.(tsx|jsx)$/.test(sf.fileName);
      const expected = path.basename(sf.fileName).replace(react ? /\.react\.[^.]+$/ : /\.[^.]+$/, '');
      if (react && !/@jsxImportSource\s+react\b/.test(sf.text)) {
        this.error(
          `React island '${path.basename(sf.fileName)}' must start with /** @jsxImportSource react */ so TypeScript and the bundler compile its JSX with React`,
          this.loc(sf.statements[0] ?? sf),
        );
      }
      const fn = sf.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) &&
          !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
          !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
      );
      if (!fn) {
        this.error(`Island file must default-export a function component: 'export default function ${expected}(props) { ... }'`, this.loc(sf.statements[0] ?? sf));
      } else if (fn.name?.text !== expected) {
        this.error(`Island component must be named after its file: expected 'function ${expected}', found '${fn.name?.text ?? 'anonymous'}'`, this.loc(fn));
      } else {
        this.islands.push({ name: expected, file: sf.fileName, react, generative: this.generativeOf(fn, expected) });
      }
    }

    const visit = (node: ts.Node): void => {
      if (
        this.i18nKeys &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 't' &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        const sym = this.checker.getSymbolAtLocation(node.expression.name);
        if (FRAMEWORK_FILE.test(sym?.declarations?.[0]?.getSourceFile().fileName ?? '')) {
          const key = (node.arguments[0] as ts.StringLiteral).text;
          if (!this.i18nKeys.has(key)) this.error(`Translation key '${key}' doesn't exist in the default locale bundle (src/i18n/)`, this.loc(node));
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'asset') {
        const sym = this.resolveSymbol(this.checker.getSymbolAtLocation(node.expression));
        const fromFramework = FRAMEWORK_FILE.test(sym?.declarations?.[0]?.getSourceFile().fileName ?? '');
        const arg = node.arguments[0];
        if (fromFramework && arg && ts.isStringLiteral(arg) && arg.text.endsWith('.css')) {
          if (!this.stylesDir || !existsSync(path.join(this.stylesDir, arg.text))) {
            const dir = this.stylesDir ? path.relative(this.projectDir, this.stylesDir) : 'src/styles';
            this.error(`asset('${arg.text}'): no stylesheet named '${arg.text}' in ${dir}/`, this.loc(node));
          }
        }
      }
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === 'Island') {
        const of = node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'of');
        const expr = of?.initializer && ts.isJsxExpression(of.initializer) ? of.initializer.expression : undefined;
        if (!expr || !ts.isIdentifier(expr)) {
          this.error(`<Island> needs 'of={Component}' referencing an island component`, this.loc(node));
        } else {
          const sym = this.resolveSymbol(this.checker.getSymbolAtLocation(expr));
          const declFile = sym?.declarations?.[0]?.getSourceFile().fileName;
          if (!declFile || !this.inIslandsDir(declFile)) {
            const dir = this.islandsDir ? path.relative(this.projectDir, this.islandsDir) : 'src/islands';
            this.error(`'${expr.text}' is used as an island but is not defined in ${dir}/, so it has no browser bundle`, this.loc(node));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /* ---------------------------------------------------------------- */
  /* Classes                                                           */
  /* ---------------------------------------------------------------- */

  visitClass(cls: ts.ClassDeclaration): void {
    const decs = this.decorators(cls);
    const names = new Set(decs.map((d) => d.name));
    if (![...names].some((n) => BEAN_CLASS_DECORATORS.has(n))) return;

    const loc = this.loc(cls);
    if (!cls.name) return this.error('Bean classes must have a name', loc);
    const className = cls.name.text;
    const mods = ts.getModifiers(cls) ?? [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      this.error(`Bean class '${className}' must be exported so the generated code can import it`, loc);
    }
    if (mods.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) {
      this.error(`Bean class '${className}' cannot be abstract`, loc);
    }
    if ([names.has('Singleton'), names.has('Prototype'), names.has('RequestScope')].filter(Boolean).length > 1) {
      this.error(`'${className}' can have only one of @Singleton, @Prototype and @RequestScope`, loc);
    }

    const symbol = this.checker.getSymbolAtLocation(cls.name)!;
    const bean: BeanModel = {
      index: this.beans.length,
      name: className,
      kind: 'class',
      importName: className,
      importFile: cls.getSourceFile().fileName,
      scope: names.has('Prototype') ? 'prototype' : names.has('RequestScope') ? 'request' : 'singleton',
      eager: names.has('Eager'),
      primary: names.has('Primary'),
      qualifier: this.stringArg(decs, 'Named'),
      condition: this.conditionOf(decs, className, loc),
      types: [],
      typeNames: [],
      injections: this.constructorInjections(cls, className),
      routes: [],
      errorPages: [],
      interceptors: [],
      tools: [],
      loc,
    };
    const agentDec = decs.find((d) => d.name === 'Agent');
    if (agentDec) {
      if (names.has('Prototype') || names.has('RequestScope')) this.error(`@Agent '${className}' must be a singleton (remove @Prototype/@RequestScope)`, loc);
      bean.agent = this.agentOf(cls, agentDec, className, loc);
    }
    const classIntercept = decs.find((d) => d.name === 'Intercept');
    if (classIntercept) {
      for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const mods = ts.getModifiers(member) ?? [];
        if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword || m.kind === ts.SyntaxKind.StaticKeyword)) continue;
        if (ts.isPrivateIdentifier(member.name)) continue;
        const mdecs = this.decorators(member).map((d) => d.name);
        if (mdecs.includes('PostConstruct') || mdecs.includes('PreDestroy')) continue;
        this.addInterceptors(bean, member.name.getText(), classIntercept, this.loc(member));
      }
    }
    const ws = decs.find((d) => d.name === 'WebSocketEndpoint');
    if (ws) {
      const wsPath = this.literal(ws.args[0]);
      const arity = (n: string): number | false => {
        const m = cls.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === n);
        return m ? m.parameters.length : false;
      };
      const message = arity('onMessage');
      if (!wsPath || !wsPath.startsWith('/')) this.error(`@WebSocketEndpoint on '${className}' needs a path like '/ws/chat'`, loc);
      else if (message === false) this.error(`@WebSocketEndpoint '${className}' must implement onMessage(socket, data)`, loc);
      else bean.websocket = { path: joinPaths(wsPath), open: arity('onOpen'), message, close: arity('onClose') };
    }
    this.collectTypes(symbol, bean);
    Object.assign(bean, this.lifecycleOf(cls, className, true));
    const middleware = decs.find((d) => d.name === 'Middleware');
    if (middleware) {
      const arg = middleware.args[0];
      const order = arg === undefined ? 0 : ts.isNumericLiteral(arg) ? Number(arg.text) : ts.isPrefixUnaryExpression(arg) && ts.isNumericLiteral(arg.operand) ? -Number(arg.operand.text) : NaN;
      if (Number.isNaN(order)) this.error(`@Middleware order on '${className}' must be a number literal`, loc);
      const handle = cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === 'handle');
      if (!handle) this.error(`@Middleware '${className}' must implement 'handle(ctx: RequestContext, next: () => Promise<unknown>)'`, loc);
      bean.middlewareOrder = order;
    }
    this.beans.push(bean);

    const isFactory = names.has('Factory');
    const controller = decs.find((d) => d.name === 'Controller');
    const basePath = controller ? (this.literal(controller.args[0]) ?? '') : '';

    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const mdecs = this.decorators(member);
      if (mdecs.length === 0) continue;
      const methodName = member.name.getText();
      const mloc = this.loc(member);

      if (mdecs.some((d) => d.name === 'Bean' || d.name === 'ErrorPage' || HTTP_METHODS[d.name])) this.requirePublic(member, className, mloc);

      const methodIntercept = mdecs.find((d) => d.name === 'Intercept');
      if (methodIntercept && !mdecs.some((d) => d.name === 'Bean')) {
        this.requirePublic(member, className, mloc);
        this.addInterceptors(bean, methodName, methodIntercept, mloc);
      }

      const errorPage = mdecs.find((d) => d.name === 'ErrorPage');
      if (errorPage) {
        const arg = errorPage.args[0];
        const status = arg && ts.isNumericLiteral(arg) ? Number(arg.text) : NaN;
        if (!controller) this.error(`@ErrorPage on '${className}.${methodName}' requires the class to be a @Controller`, mloc);
        else if (!(status >= 400 && status <= 599)) this.error(`@ErrorPage on '${className}.${methodName}' needs a status between 400 and 599`, mloc);
        else {
          const params: RouteParam[] = member.parameters.map((p) => {
            if (p.type?.getText() !== 'RequestContext') {
              this.error(`@ErrorPage method '${className}.${methodName}' may only take a RequestContext parameter`, this.loc(p));
            }
            return { kind: 'context' };
          });
          bean.errorPages.push({ status, methodName, params, loc: mloc });
        }
      }

      const toolDec = mdecs.find((d) => d.name === 'Tool');
      if (toolDec) {
        this.requirePublic(member, className, mloc);
        if (bean.scope === 'request') this.error(`@Tool '${className}.${methodName}': tools run in the background, outside requests, so the class can't be @RequestScope`, mloc);
        else bean.tools.push(this.tool(className, member, toolDec));
      }

      if (mdecs.some((d) => d.name === 'Bean')) {
        if (!isFactory) this.error(`@Bean method '${className}.${methodName}' requires the class to be a @Factory`, mloc);
        else this.factoryMethod(bean, member, mdecs);
      }
      for (const d of mdecs) {
        if (!HTTP_METHODS[d.name]) continue;
        if (!controller) {
          this.error(`@${d.name} on '${className}.${methodName}' requires the class to be a @Controller`, mloc);
        } else {
          bean.routes.push(this.route(className, member, HTTP_METHODS[d.name], joinPaths(basePath, this.literal(d.args[0]) ?? ''), d.name === 'Page', mdecs));
        }
      }
    }
  }

  /** Finds @PostConstruct / @PreDestroy methods on a class declaration. */
  private lifecycleOf(
    cls: ts.ClassDeclaration,
    owner: string,
    report: boolean,
  ): { postConstruct?: string; preDestroy?: string } {
    const result: { postConstruct?: string; preDestroy?: string } = {};
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      for (const d of this.decorators(member)) {
        if (d.name !== 'PostConstruct' && d.name !== 'PreDestroy') continue;
        const field = d.name === 'PostConstruct' ? 'postConstruct' : 'preDestroy';
        const loc = this.loc(member);
        if (report) {
          if (result[field]) this.error(`'${owner}' declares more than one @${d.name} method`, loc);
          if (member.parameters.length > 0) this.error(`@${d.name} method '${owner}.${member.name.getText()}' must take no parameters`, loc);
          if (d.name === 'PostConstruct' && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            this.error(`@PostConstruct method '${owner}.${member.name.getText()}' must be synchronous`, loc);
          }
          this.requirePublic(member, owner, loc);
        }
        result[field] = member.name.getText();
      }
    }
    return result;
  }

  private conditionOf(decs: DecoratorInfo[], owner: string, loc: SourceLocation): Condition | undefined {
    const d = decs.find((x) => x.name === 'Requires');
    if (!d) return undefined;
    const arg = d.args[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      this.error(`@Requires on '${owner}' needs an object literal, e.g. @Requires({ property: 'feature.enabled' })`, loc);
      return undefined;
    }
    const c: { -readonly [K in keyof Condition]: Condition[K] } = {};
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        this.error(`@Requires on '${owner}': only plain properties are allowed`, loc);
        continue;
      }
      const key = prop.name.getText();
      const strings = (e: ts.Expression): string[] | undefined =>
        ts.isArrayLiteralExpression(e) ? (e.elements.every((x) => ts.isStringLiteral(x)) ? e.elements.map((x) => (x as ts.StringLiteral).text) : undefined) : ts.isStringLiteral(e) ? [e.text] : undefined;
      if (key === 'property' || key === 'value' || key === 'missing') {
        if (!ts.isStringLiteral(prop.initializer)) this.error(`@Requires on '${owner}': '${key}' must be a string literal`, loc);
        else c[key] = prop.initializer.text;
      } else if (key === 'profile' || key === 'notProfile') {
        const list = strings(prop.initializer);
        if (!list) this.error(`@Requires on '${owner}': '${key}' must be a string or an array of strings`, loc);
        else c[key] = list;
      } else {
        this.error(`@Requires on '${owner}': unknown option '${key}' (use property, value, missing, profile, notProfile)`, loc);
      }
    }
    if (c.value !== undefined && c.property === undefined) this.error(`@Requires on '${owner}': 'value' needs 'property'`, loc);
    if (Object.keys(c).length === 0) this.error(`@Requires on '${owner}' has no condition`, loc);
    return c;
  }

  private addInterceptors(bean: BeanModel, method: string, dec: DecoratorInfo, loc: SourceLocation): void {
    if (dec.args.length === 0) this.error(`@Intercept on '${bean.name}.${method}' needs at least one interceptor class`, loc);
    for (const arg of dec.args) {
      const sym = ts.isIdentifier(arg) ? this.resolveSymbol(this.checker.getSymbolAtLocation(arg)) : undefined;
      const decl = sym?.declarations?.find(ts.isClassDeclaration);
      if (!sym || !decl) {
        this.error(`@Intercept on '${bean.name}.${method}': '${arg.getText()}' is not a class`, loc);
        continue;
      }
      if (!decl.members.some((m) => ts.isMethodDeclaration(m) && m.name.getText() === 'intercept')) {
        this.error(`Interceptor '${sym.getName()}' must implement intercept(invocation: Invocation)`, this.loc(decl));
      }
      bean.interceptors.push({ method, typeKey: this.keyOf(sym), typeName: sym.getName(), loc });
    }
  }

  /* ---------------------------------------------------------------- */
  /* AI: tools, agents, generative UI                                  */
  /* ---------------------------------------------------------------- */

  /** `/** @generative Shows ... *\/` on an island's component: agents may show it. */
  private generativeOf(fn: ts.FunctionDeclaration, name: string): IslandModel['generative'] {
    const tag = ts.getJSDocTags(fn).find((t) => t.tagName.text === 'generative');
    if (!tag) return undefined;
    const tagText = (typeof tag.comment === 'string' ? tag.comment : ts.getTextOfJSDocComment(tag.comment) ?? '').trim();
    const sym = fn.name ? this.checker.getSymbolAtLocation(fn.name) : undefined;
    const doc = sym ? ts.displayPartsToString(sym.getDocumentationComment(this.checker)).trim() : '';
    const description = (tagText || doc).replace(/\s+/g, ' ');
    const loc = this.loc(fn);
    if (!description) this.error(`@generative island '${name}' needs a description the model can read, e.g. /** @generative Shows flight options with prices */`, loc);
    const param = fn.parameters[0];
    let props: Schema = { k: 'object', fields: [] };
    if (param?.type) {
      props = this.schemaOf(this.checker.getTypeFromTypeNode(param.type), `${name} props`, loc);
      if (props.k !== 'object') {
        this.error(`@generative island '${name}': props must be an object type`, loc);
        props = { k: 'object', fields: [] };
      }
    } else if (param) {
      this.error(`@generative island '${name}': give the props parameter a type so the compiler can validate what agents send`, loc);
    }
    return { description, props };
  }

  /** `@Agent({ name, description, tools, ui, knowledge, memory, examples, maxTurns, model })`. */
  private agentOf(cls: ts.ClassDeclaration, dec: DecoratorInfo, className: string, loc: SourceLocation): AgentModel {
    const opts = dec.args[0];
    const kebab = className.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    const agent: { -readonly [K in keyof AgentModel]: AgentModel[K] } = {
      name: kebab,
      description: '',
      toolClasses: [],
      ui: [],
      knowledge: [],
      recall: 0,
      rememberTool: false,
      examples: [],
      hooks: { principal: false, owner: false, beforeToolCall: false, onRunFinished: false },
      loc,
    };
    const where = `@Agent on '${className}'`;
    const strings = (e: ts.Expression, key: string): string[] => {
      if (ts.isArrayLiteralExpression(e) && e.elements.every((x) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x))) {
        return e.elements.map((x) => (x as ts.StringLiteral).text);
      }
      this.error(`${where}: '${key}' must be an array of string literals`, loc);
      return [];
    };
    const num = (e: ts.Expression, key: string): number | undefined => {
      if (ts.isNumericLiteral(e)) return Number(e.text);
      this.error(`${where}: '${key}' must be a number literal`, loc);
      return undefined;
    };
    if (opts !== undefined && !ts.isObjectLiteralExpression(opts)) {
      this.error(`${where} needs an object literal, e.g. @Agent({ description: 'Answers billing questions' })`, loc);
    } else if (opts) {
      for (const prop of opts.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          this.error(`${where}: only plain properties are allowed`, loc);
          continue;
        }
        const key = prop.name.getText();
        const v = prop.initializer;
        switch (key) {
          case 'name':
          case 'description':
          case 'model': {
            const text = this.literal(v);
            if (text === undefined) this.error(`${where}: '${key}' must be a string literal`, loc);
            else agent[key] = key === 'description' ? text.replace(/\s+/g, ' ').trim() : text;
            break;
          }
          case 'tools':
            if (!ts.isArrayLiteralExpression(v)) {
              this.error(`${where}: 'tools' must be an array of classes, e.g. tools: [AccountTools]`, loc);
              break;
            }
            for (const el of v.elements) {
              const sym = ts.isIdentifier(el) ? this.resolveSymbol(this.checker.getSymbolAtLocation(el)) : undefined;
              if (!sym || !sym.declarations?.some(ts.isClassDeclaration)) this.error(`${where}: '${el.getText()}' in 'tools' is not a class`, loc);
              else agent.toolClasses.push({ typeKey: this.keyOf(sym), typeName: sym.getName(), loc });
            }
            break;
          case 'ui':
            if (v.kind === ts.SyntaxKind.TrueKeyword) agent.ui = 'all';
            else agent.ui = strings(v, 'ui');
            break;
          case 'knowledge':
            agent.knowledge = strings(v, 'knowledge');
            break;
          case 'examples':
            agent.examples = strings(v, 'examples');
            break;
          case 'maxTurns':
            agent.maxTurns = num(v, key);
            break;
          case 'memory':
            if (v.kind === ts.SyntaxKind.TrueKeyword) {
              agent.recall = 5;
              agent.rememberTool = true;
            } else if (ts.isObjectLiteralExpression(v)) {
              for (const m of v.properties) {
                if (!ts.isPropertyAssignment(m)) continue;
                const mk = m.name.getText();
                if (mk === 'recall') agent.recall = num(m.initializer, 'memory.recall') ?? 0;
                else if (mk === 'remember') agent.rememberTool = m.initializer.kind === ts.SyntaxKind.TrueKeyword;
                else this.error(`${where}: unknown memory option '${mk}' (use recall, remember)`, loc);
              }
            } else if (v.kind !== ts.SyntaxKind.FalseKeyword) {
              this.error(`${where}: 'memory' must be true, false or { recall: 5, remember: true }`, loc);
            }
            break;
          default:
            this.error(`${where}: unknown option '${key}' (use name, description, tools, ui, knowledge, memory, examples, maxTurns, model)`, loc);
        }
      }
    }
    if (!AGENT_NAME.test(agent.name)) this.error(`${where}: name '${agent.name}' must be lower-case letters, digits and dashes (it is used in URLs)`, loc);
    if (!agent.description) {
      const sym = cls.name ? this.checker.getSymbolAtLocation(cls.name) : undefined;
      agent.description = sym ? ts.displayPartsToString(sym.getDocumentationComment(this.checker)).replace(/\s+/g, ' ').trim() : '';
      if (!agent.description) this.error(`${where} needs a description (option or JSDoc): other agents and MCP clients read it`, loc);
    }
    const method = (n: string): boolean => cls.members.some((m) => ts.isMethodDeclaration(m) && m.name.getText() === n);
    if (!method('instructions')) this.error(`@Agent '${className}' must implement instructions(ctx: AgentRunContext): string`, loc);
    agent.hooks = { principal: method('principal'), owner: method('owner'), beforeToolCall: method('beforeToolCall'), onRunFinished: method('onRunFinished') };
    return agent;
  }

  /** `@Tool('description')` or `@Tool({ description, name, approval, readOnly, expose })` on a bean method. */
  private tool(className: string, member: ts.MethodDeclaration, dec: DecoratorInfo): ToolModel {
    const methodName = member.name.getText();
    const loc = this.loc(member);
    const where = `@Tool '${className}.${methodName}'`;
    let name = methodName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    let description: string | undefined;
    let approval = false;
    let readOnly = false;
    let idempotent = false;
    let expose = true;
    const arg = dec.args[0];
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      description = arg.text;
    } else if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name.getText();
        const v = prop.initializer;
        const bool = v.kind === ts.SyntaxKind.TrueKeyword ? true : v.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
        if (key === 'description' || key === 'name') {
          const text = this.literal(v);
          if (text === undefined) this.error(`${where}: '${key}' must be a string literal`, loc);
          else if (key === 'name') name = text;
          else description = text;
        } else if (key === 'approval' || key === 'readOnly' || key === 'expose' || key === 'idempotent') {
          if (bool === undefined) this.error(`${where}: '${key}' must be true or false`, loc);
          else if (key === 'approval') approval = bool;
          else if (key === 'readOnly') readOnly = bool;
          else if (key === 'idempotent') idempotent = bool;
          else expose = bool;
        } else {
          this.error(`${where}: unknown option '${key}' (use description, name, approval, readOnly, idempotent, expose)`, loc);
        }
      }
    } else if (arg) {
      this.error(`${where}: pass a description string or an options object`, loc);
    }
    if (!description) {
      const doc = this.docOf(member);
      description = [doc?.summary, doc?.description].filter(Boolean).join('\n\n') || undefined;
    }
    if (!description) this.error(`${where} needs a description (argument or JSDoc): it's how the model decides when to call it`, loc);
    if (!TOOL_NAME.test(name)) this.error(`${where}: tool name '${name}' may only use letters, digits, '_' and '-' (max 64)`, loc);
    if (RESERVED_TOOLS.has(name) || name.startsWith('show_')) this.error(`${where}: tool name '${name}' is reserved by Amoxi`, loc);

    let input: Schema | undefined;
    let inputIndex: number | undefined;
    let contextIndex: number | undefined;
    member.parameters.forEach((p, i) => {
      const type = p.type ? this.checker.getTypeFromTypeNode(p.type) : undefined;
      const sym = type && this.resolveSymbol(type.aliasSymbol ?? type.getSymbol());
      if (sym?.getName() === 'ToolContext' && FRAMEWORK_FILE.test(sym.declarations?.[0]?.getSourceFile().fileName ?? '')) {
        contextIndex = i;
        return;
      }
      if (inputIndex !== undefined || !type) {
        this.error(`${where}: tools take an input object and/or a ToolContext, each typed (got '${p.getText()}')`, this.loc(p));
        return;
      }
      inputIndex = i;
      input = this.schemaOf(type, `${where} input`, this.loc(p));
      if (input.k !== 'object') {
        this.error(`${where}: the input must be an object type (models send JSON objects), e.g. (input: { accountId: string })`, this.loc(p));
        input = { k: 'object', fields: [] };
      }
    });

    let output: Schema | undefined;
    const sig = this.checker.getSignatureFromDeclaration(member);
    let rt = sig ? this.checker.getReturnTypeOfSignature(sig) : undefined;
    if (rt && rt.getSymbol()?.getName() === 'Promise') rt = this.checker.getTypeArguments(rt as ts.TypeReference)[0];
    if (rt && !(rt.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      this.lenient = true;
      try {
        output = this.schemaOf(rt, `${where} result`, loc);
      } finally {
        this.lenient = false;
      }
      if (output.k !== 'object') output = undefined; // MCP outputSchema must describe an object
    }
    return { name, description: description ?? '', methodName, input, output, inputIndex, contextIndex, approval, readOnly, idempotent, expose, loc };
  }

  /**
   * Cross-file checks once every file is analysed, and built-in beans for AI services the app
   * doesn't implement. Returns whether the app uses the AI module at all.
   */
  finishAi(): boolean {
    const agents = this.beans.filter((b) => b.agent);
    const toolBeans = this.beans.filter((b) => b.tools.length > 0);
    const generative = this.islands.filter((i) => i.generative);
    const usesAi = this.injectsAi || agents.length > 0 || toolBeans.length > 0 || generative.length > 0;
    if (!usesAi) return false;

    const toolOwners = new Map<string, string>();
    for (const bean of toolBeans) {
      for (const t of bean.tools) {
        const other = toolOwners.get(t.name);
        if (other) this.error(`Duplicate tool name '${t.name}' in ${bean.name}.${t.methodName}, already used by ${other}. Rename one with @Tool({ name: '...' })`, t.loc);
        toolOwners.set(t.name, `${bean.name}.${t.methodName}`);
      }
    }
    const agentNames = new Set<string>();
    for (const bean of agents) {
      const agent = bean.agent!;
      if (agentNames.has(agent.name)) this.error(`Duplicate agent name '${agent.name}' (${bean.name}); set a different @Agent({ name })`, agent.loc);
      agentNames.add(agent.name);
      for (const ref of agent.toolClasses) {
        const provider = this.beans.find((b) => b.types.includes(ref.typeKey));
        if (!provider) this.error(`@Agent '${bean.name}': '${ref.typeName}' in 'tools' is not a bean; annotate it with @Singleton`, ref.loc);
        else if (provider.tools.length === 0) this.error(`@Agent '${bean.name}': '${ref.typeName}' has no @Tool methods`, ref.loc);
      }
      if (agent.ui !== 'all') {
        for (const name of agent.ui) {
          const island = this.islands.find((i) => i.name === name);
          if (!island) this.error(`@Agent '${bean.name}': ui component '${name}' is not an island in src/islands/`, agent.loc);
          else if (!island.generative) this.error(`@Agent '${bean.name}': island '${name}' must be marked /** @generative <description> */ to be shown by agents`, agent.loc);
        }
      }
      if (bean.tools.length === 0 && agent.toolClasses.length === 0 && (agent.ui === 'all' ? generative.length === 0 : agent.ui.length === 0) && agent.knowledge.length === 0 && !agent.rememberTool) {
        this.warn(`@Agent '${bean.name}' has no tools, so it can only chat`, agent.loc);
      }
    }

    for (const service of AI_SERVICES) {
      const key = aiServiceKey(service);
      if (this.beans.some((b) => b.types.includes(key))) continue;
      this.beans.push({
        index: this.beans.length,
        name: service,
        kind: 'builtin',
        importName: service,
        importFile: '',
        scope: 'singleton',
        eager: false,
        primary: false,
        types: [key],
        typeNames: [service],
        injections: [],
        routes: [],
        errorPages: [],
        interceptors: [],
        tools: [],
        loc: { file: 'amoxi/ai', line: 0 },
      });
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Factories                                                         */
  /* ---------------------------------------------------------------- */

  private factoryMethod(owner: BeanModel, method: ts.MethodDeclaration, decs: DecoratorInfo[]): void {
    const methodName = method.name.getText();
    const loc = this.loc(method);
    const name = `${owner.name}.${methodName}`;
    const signature = this.checker.getSignatureFromDeclaration(method);
    const returnType = signature && this.checker.getReturnTypeOfSignature(signature);
    const symbol = returnType && this.resolveSymbol(returnType.aliasSymbol ?? returnType.getSymbol());

    if (!symbol || !this.isNominal(symbol)) {
      return this.error(`@Bean method '${name}' must return a class, interface or type alias type`, loc);
    }
    if (symbol.getName() === 'Promise') {
      return this.error(`@Bean method '${name}' cannot be async: create the resource lazily or use an @Eager bean with an init method`, loc);
    }

    const names = new Set(decs.map((d) => d.name));
    const bean: BeanModel = {
      index: this.beans.length,
      name,
      kind: 'factory-method',
      importName: owner.importName,
      importFile: owner.importFile,
      scope: names.has('Prototype') ? 'prototype' : 'singleton',
      eager: names.has('Eager'),
      primary: names.has('Primary'),
      qualifier: this.stringArg(decs, 'Named'),
      condition: this.conditionOf(decs, name, loc),
      types: [],
      typeNames: [],
      injections: method.parameters.map((p) => this.injection(p, name)),
      factory: { ownerIndex: owner.index, method: methodName },
      routes: [],
      errorPages: [],
      interceptors: [],
      tools: [],
      loc,
    };
    this.collectTypes(symbol, bean);
    // If the produced type is a class with lifecycle annotations, honour them statically.
    const decl = symbol.declarations?.find(ts.isClassDeclaration);
    if (decl) Object.assign(bean, this.lifecycleOf(decl, name, false));
    this.beans.push(bean);
  }

  /* ---------------------------------------------------------------- */
  /* Injection points                                                  */
  /* ---------------------------------------------------------------- */

  private constructorInjections(cls: ts.ClassDeclaration, owner: string): Injection[] {
    // Walk up the inheritance chain: a subclass without a constructor inherits its parent's.
    for (let current: ts.ClassDeclaration | undefined = cls; current; current = this.baseClassOf(current)) {
      const ctor = current.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
      if (ctor) {
        if (ts.getModifiers(ctor)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) {
          this.error(`Constructor of bean '${owner}' must be public`, this.loc(ctor));
        }
        return ctor.parameters.map((p) => this.injection(p, owner));
      }
    }
    return [];
  }

  private injection(p: ts.ParameterDeclaration, owner: string): Injection {
    const paramName = p.name.getText();
    const loc = this.loc(p);
    const decs = this.decorators(p);
    let optional = !!p.questionToken || !!p.initializer;

    const marker = this.typeMarker(p);
    if (marker && decs.some((d) => d.name === marker.name)) {
      this.error(`Parameter '${paramName}' of '${owner}' uses both @${marker.name} and ${marker.name}<...>: use one`, loc);
      return { kind: 'invalid', paramName };
    }
    if (marker?.name === 'Value') {
      const coerce = this.coercion(p, `${owner}(${paramName})`);
      const key = this.literalType(marker.args[1]);
      if (!key || !key.trim()) {
        this.error(`Value<...> on '${owner}(${paramName})' needs a configuration key, e.g. Value<number, 'server.port', 8080>`, loc);
        return { kind: 'invalid', paramName };
      }
      const fallback = marker.args[2] ? this.literalType(marker.args[2]) : undefined;
      if (marker.args[2] && fallback === undefined) {
        this.error(`Value<...> on '${owner}(${paramName})': the default must be a string, number or boolean literal`, loc);
        return { kind: 'invalid', paramName };
      }
      if (fallback !== undefined) this.checkLiteral(fallback, coerce, `default of Value<..., '${key}'>`, loc);
      return { kind: 'value', paramName, key: key.trim(), fallback, coerce, loc };
    }
    if (marker && marker.name !== 'Named') {
      this.error(`${marker.name}<...> on '${owner}(${paramName})' only applies to route parameters; constructor parameters take Value<...> or Named<...>`, loc);
      return { kind: 'invalid', paramName };
    }

    const value = decs.find((d) => d.name === 'Value');
    if (value) {
      const expr = this.literal(value.args[0]);
      if (expr === undefined) {
        this.error(`@Value on '${owner}(${paramName})' requires a string literal`, loc);
        return { kind: 'invalid', paramName };
      }
      const coerce = this.coercion(p, `${owner}(${paramName})`);
      const placeholder = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(expr);
      if (!placeholder) {
        if (expr.includes('${')) {
          this.error(`@Value('${expr}') on '${owner}(${paramName})': only a single '\${key:default}' placeholder is supported`, loc);
          return { kind: 'invalid', paramName };
        }
        this.checkLiteral(expr, coerce, `${owner}(${paramName})`, loc);
        return { kind: 'value', paramName, literal: expr, coerce, loc };
      }
      const [, key, fallback] = placeholder;
      if (fallback !== undefined) this.checkLiteral(fallback, coerce, `default of @Value('${expr}')`, loc);
      return { kind: 'value', paramName, key: key.trim(), fallback, coerce, loc };
    }

    let qualifier = this.stringArg(decs, 'Named');
    if (!p.type) {
      this.error(`Parameter '${paramName}' of '${owner}' needs an explicit type annotation (Amoxi resolves injection points statically)`, loc);
      return { kind: 'invalid', paramName };
    }

    let typeNode: ts.TypeNode = p.type;
    if (marker?.name === 'Named') {
      qualifier = this.literalType(marker.args[1]);
      if (!qualifier || !marker.args[0]) {
        this.error(`Named<...> on '${owner}(${paramName})' needs a type and a name, e.g. Named<Greeter, 'formal'>`, loc);
        return { kind: 'invalid', paramName };
      }
      typeNode = marker.args[0];
    }
    let many = false;
    let provider = false;
    if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments?.length === 1) {
      const sym = this.resolveSymbol(this.checker.getSymbolAtLocation(typeNode.typeName));
      if (sym?.getName() === 'Provider' && FRAMEWORK_FILE.test(sym.declarations?.[0]?.getSourceFile().fileName ?? '')) {
        provider = true;
        typeNode = typeNode.typeArguments[0];
      }
    }
    if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) typeNode = typeNode.type;
    if (ts.isArrayTypeNode(typeNode)) {
      many = true;
      typeNode = typeNode.elementType;
    } else if (
      ts.isTypeReferenceNode(typeNode) &&
      (typeNode.typeName.getText() === 'Array' || typeNode.typeName.getText() === 'ReadonlyArray') &&
      typeNode.typeArguments?.length === 1
    ) {
      many = true;
      typeNode = typeNode.typeArguments[0];
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const rest = typeNode.types.filter((t) => !isNullishTypeNode(t));
      if (rest.length === 1 && rest.length < typeNode.types.length) {
        typeNode = rest[0];
        optional = true;
      }
    }

    const type = this.checker.getTypeFromTypeNode(typeNode);
    const symbol = this.resolveSymbol(type.aliasSymbol ?? type.getSymbol());
    if (!symbol || !this.isNominal(symbol)) {
      this.error(
        `Cannot inject parameter '${paramName}' of '${owner}': '${typeNode.getText()}' is not a class, interface or type alias. ` +
          `Use Value<T, 'key'> (or @Value('\${key}')) for configuration values.`,
        loc,
      );
      return { kind: 'invalid', paramName };
    }
    const fromFramework = FRAMEWORK_FILE.test(symbol.declarations?.[0]?.getSourceFile().fileName ?? '');
    if (symbol.getName() === 'ApplicationContext' && fromFramework) {
      return { kind: 'context', paramName };
    }
    if (symbol.getName() === 'RequestContext' && fromFramework) {
      return { kind: 'request', paramName, loc };
    }
    const typeKey = this.keyOf(symbol);
    const typeName = symbol.getName();
    if (typeKey.startsWith('amoxi:ai#')) this.injectsAi = true;
    if (provider) return { kind: 'provider', paramName, typeKey, typeName, qualifier, loc };
    return many
      ? { kind: 'beans', paramName, typeKey, typeName, qualifier, loc }
      : { kind: 'bean', paramName, typeKey, typeName, qualifier, optional, loc };
  }

  /* ---------------------------------------------------------------- */
  /* Routes                                                            */
  /* ---------------------------------------------------------------- */

  private route(owner: string, method: ts.MethodDeclaration, httpMethod: string, fullPath: string, page: boolean, decs: DecoratorInfo[]): RouteModel {
    const methodName = method.name.getText();
    const where = `${owner}.${methodName}()`;
    const pathParams = new Set([...fullPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    const loc = this.loc(method);
    let bodyName: string | undefined;

    const params: RouteParam[] = method.parameters.map((p) => {
      const pname = p.name.getText();
      const inner = this.typeMarker(p)?.args[0] ?? p.type;
      const optional = !!p.questionToken || !!p.initializer || (!!inner && ts.isUnionTypeNode(inner) && inner.types.some(isNullishTypeNode));
      const decs = this.decorators(p);
      const marker = this.typeMarker(p);
      if (marker && decs.some((d) => d.name === marker.name)) {
        this.error(`Parameter '${pname}' of ${where} uses both @${marker.name} and ${marker.name}<...>: use one`, this.loc(p));
      }
      if (marker && (marker.name === 'Value' || marker.name === 'Named')) {
        this.error(`${marker.name}<...> on '${pname}' of ${where}: route parameters take PathParam, QueryParam, Header, Body or Multipart`, this.loc(p));
        return { kind: 'context' };
      }
      // A marker type works like the decorator of the same name; its second type argument is the name.
      const find = (n: string): DecoratorInfo | undefined => decs.find((d) => d.name === n) ?? this.markerAsDecorator(marker, n);

      const pp = find('PathParam');
      if (pp) {
        const name = this.literal(pp.args[0]) ?? pname;
        if (!pathParams.has(name)) {
          this.error(`Path parameter '${name}' in ${where}: route '${httpMethod} ${fullPath}' has no ':${name}' segment`, this.loc(p));
        }
        return { kind: 'path', name, coerce: this.coercion(p, where), required: true };
      }
      const qp = find('QueryParam');
      if (qp) {
        return { kind: 'query', name: this.literal(qp.args[0]) ?? pname, coerce: this.coercion(p, where), required: !optional };
      }
      const hp = find('Header');
      if (hp) {
        return { kind: 'header', name: (this.literal(hp.args[0]) ?? pname).toLowerCase(), coerce: this.coercion(p, where), required: !optional };
      }
      if (find('Multipart')) {
        if (httpMethod === 'GET') this.error(`Multipart in ${where}: GET requests have no body`, this.loc(p));
        return { kind: 'multipart' };
      }
      if (find('Body')) {
        if (httpMethod === 'GET') this.error(`Body in ${where}: GET requests have no body`, this.loc(p));
        if (!p.type) return { kind: 'body' };
        const bodyType = this.checker.getTypeFromTypeNode(p.type);
        const schema = this.schemaOf(bodyType, `${where} body`, this.loc(p));
        bodyName = (bodyType.aliasSymbol ?? bodyType.getSymbol())?.getName();
        return schema.k === 'any' ? { kind: 'body' } : { kind: 'body', schema };
      }
      if (p.type && p.type.getText() === 'RequestContext') return { kind: 'context' };

      this.error(
        `Parameter '${pname}' of ${where} needs a binding: PathParam<T>, QueryParam<T>, Header<T, 'name'>, Body<T> or Multipart ` +
          `(or @PathParam, @QueryParam, @Header, @Body, @Multipart with experimentalDecorators), or type RequestContext`,
        this.loc(p),
      );
      return { kind: 'context' };
    });

    for (const name of pathParams) {
      if (!params.some((p) => p.kind === 'path' && p.name === name)) {
        this.warn(`Route '${httpMethod} ${fullPath}' (${where}) does not bind path segment ':${name}'`, loc);
      }
    }
    let cache: RouteModel['cache'];
    const cachedDec = decs.find((d) => d.name === 'Cached');
    if (cachedDec) {
      const ttlArg = cachedDec.args[0];
      const ttl = ttlArg && ts.isNumericLiteral(ttlArg) ? Number(ttlArg.text) : NaN;
      let swr = 0;
      const opts = cachedDec.args[1];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'staleWhileRevalidate' && ts.isNumericLiteral(prop.initializer)) swr = Number(prop.initializer.text);
        }
      }
      if (httpMethod !== 'GET') this.error(`@Cached on ${where}: only GET routes and pages can be cached`, loc);
      else if (!(ttl > 0)) this.error(`@Cached on ${where} needs a positive number of seconds, e.g. @Cached(60)`, loc);
      else cache = { ttl, swr };
    }
    if (params.some((p) => p.kind === 'multipart') && params.some((p) => p.kind === 'body')) {
      this.error(`${where} can't take both a JSON body and a multipart form`, loc);
    }

    // OpenAPI metadata: JSDoc and the response type (Promise<T> and HttpResponse<T> unwrapped).
    const doc = this.docOf(method);
    let response: Schema | undefined;
    let responseName: string | undefined;
    if (!page) {
      const sig = this.checker.getSignatureFromDeclaration(method);
      let rt = sig ? this.checker.getReturnTypeOfSignature(sig) : undefined;
      const unwrap = (t: ts.Type | undefined, name: string): ts.Type | undefined => {
        if (t && t.getSymbol()?.getName() === name) return this.checker.getTypeArguments(t as ts.TypeReference)[0] ?? (t as ts.Type & { typeArguments?: ts.Type[] }).typeArguments?.[0];
        return t;
      };
      rt = unwrap(rt, 'Promise');
      if (rt?.isUnion()) {
        const parts = rt.types.filter((t) => t.getSymbol()?.getName() !== 'HttpResponse');
        rt = parts.length === 1 ? parts[0] : rt;
      }
      if (rt?.getSymbol()?.getName() === 'HttpResponse') {
        const args = (rt as ts.TypeReference).aliasTypeArguments ?? this.checker.getTypeArguments(rt as ts.TypeReference);
        rt = args?.[0];
      }
      if (rt && !(rt.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never))) {
        this.lenient = true;
        try {
          response = this.schemaOf(rt, `${where} response`, loc);
        } finally {
          this.lenient = false;
        }
        responseName = (rt.aliasSymbol ?? rt.getSymbol())?.getName();
        if (!responseName || responseName.startsWith('__') || responseName === 'Array') responseName = undefined;
      }
    }
    return { method: httpMethod, path: fullPath, methodName, page, cache, params, loc, doc, response, responseName, bodyName };
  }

  private docOf(method: ts.MethodDeclaration): RouteModel['doc'] {
    const sym = this.checker.getSymbolAtLocation(method.name);
    const text = sym ? ts.displayPartsToString(sym.getDocumentationComment(this.checker)).trim() : '';
    const deprecated = ts.getJSDocTags(method).some((t) => t.tagName.text === 'deprecated');
    if (!text && !deprecated) return undefined;
    const [summary, ...rest] = text.split(/\n\s*\n/);
    return { summary: summary?.replace(/\s+/g, ' ') || undefined, description: rest.join('\n\n') || undefined, deprecated: deprecated || undefined };
  }

  /* ---------------------------------------------------------------- */
  /* Body validation schemas                                           */
  /* ---------------------------------------------------------------- */

  /** Derives a JSON validation schema from a TypeScript type. */
  private schemaOf(type: ts.Type, where: string, loc: SourceLocation, c?: Constraints, depth = 0, stack: ts.Type[] = []): Schema {
    const F = ts.TypeFlags;
    if (depth > 12 || type.flags & (F.Any | F.Unknown)) return { k: 'any' };
    if (type.flags & F.StringLiteral) return { k: 'literal', values: [(type as ts.StringLiteralType).value] };
    if (type.flags & F.NumberLiteral) return { k: 'literal', values: [(type as ts.NumberLiteralType).value] };
    if (type.flags & F.BooleanLiteral) return { k: 'literal', values: [this.checker.typeToString(type) === 'true'] };
    if (type.flags & F.String) return c ? { k: 'string', c } : { k: 'string' };
    if (type.flags & F.Number) return c ? { k: 'number', c } : { k: 'number' };
    if (type.flags & F.Boolean) return { k: 'boolean' };
    if (type.isUnion()) {
      const parts = type.types.filter((t) => !(t.flags & (F.Undefined | F.Void)));
      const nonNull = parts.filter((t) => !(t.flags & F.Null));
      const nullable = nonNull.length !== parts.length;
      let inner: Schema;
      if (nonNull.length > 0 && nonNull.every((t) => t.flags & (F.StringLiteral | F.NumberLiteral | F.BooleanLiteral))) {
        const values = nonNull.map((t) => (t.flags & F.BooleanLiteral ? this.checker.typeToString(t) === 'true' : (t as ts.LiteralType).value as string | number));
        inner = values.length === 2 && values.includes(true) && values.includes(false) ? { k: 'boolean' } : { k: 'literal', values };
      } else if (nonNull.length === 1) {
        inner = this.schemaOf(nonNull[0], where, loc, c, depth + 1, stack);
      } else {
        inner = { k: 'union', options: nonNull.map((t) => this.schemaOf(t, where, loc, undefined, depth + 1, stack)) };
      }
      return nullable ? { k: 'nullable', inner } : inner;
    }
    if (type.flags & F.Object) {
      if (stack.includes(type)) return { k: 'any' }; // recursive type: validate the outer levels only
      const name = type.getSymbol()?.getName();
      if ((name === 'Array' || name === 'ReadonlyArray') && this.checker.getTypeArguments(type as ts.TypeReference).length === 1) {
        const [item] = this.checker.getTypeArguments(type as ts.TypeReference);
        return { k: 'array', items: this.schemaOf(item, `${where}[]`, loc, undefined, depth + 1, stack), ...(c ? { c } : {}) };
      }
      if (name === 'Date') {
        if (this.lenient) return { k: 'string', c: { format: 'date-time' } };
        this.error(`${where}: Date can't be sent as JSON; use string with /** @format date-time */`, loc);
        return { k: 'any' };
      }
      if (this.checker.isTupleType(type)) return { k: 'any' };
      const props = this.checker.getPropertiesOfType(type);
      const index = this.checker.getIndexInfosOfType(type);
      if (props.length === 0 && index.length > 0) {
        return { k: 'record', values: this.schemaOf(index[0].type, where, loc, undefined, depth + 1, stack) };
      }
      const fields: Array<{ name: string; schema: Schema; optional: boolean }> = [];
      stack.push(type);
      for (const prop of props) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        const propType = decl ? this.checker.getTypeOfSymbolAtLocation(prop, decl) : this.checker.getDeclaredTypeOfSymbol(prop);
        if (propType.getCallSignatures().length > 0) continue; // methods aren't data
        const optional = !!(prop.flags & ts.SymbolFlags.Optional) || (propType.isUnion() && propType.types.some((t) => t.flags & F.Undefined));
        const fieldWhere = `${where}.${prop.getName()}`;
        const constraints = this.constraintsOf(prop, fieldWhere, loc);
        const description = ts.displayPartsToString(prop.getDocumentationComment(this.checker)).replace(/\s+/g, ' ').trim() || undefined;
        fields.push({ name: prop.getName(), schema: this.schemaOf(propType, fieldWhere, loc, constraints, depth + 1, stack), optional, ...(description ? { description } : {}) });
      }
      stack.pop();
      return { k: 'object', fields };
    }
    if (!this.lenient) this.error(`${where}: type '${this.checker.typeToString(type)}' can't be validated as JSON`, loc);
    return { k: 'any' };
  }

  private constraintsOf(prop: ts.Symbol, where: string, loc: SourceLocation): Constraints | undefined {
    const c: Constraints = {};
    const NUMERIC = ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const;
    for (const tag of prop.getJsDocTags(this.checker)) {
      const text = (tag.text ?? []).map((t) => t.text).join('').trim();
      if ((NUMERIC as readonly string[]).includes(tag.name)) {
        const n = Number(text);
        if (text === '' || Number.isNaN(n)) this.error(`${where}: @${tag.name} needs a number`, loc);
        else c[tag.name as (typeof NUMERIC)[number]] = n;
      } else if (tag.name === 'pattern') {
        try {
          new RegExp(text);
          c.pattern = text;
        } catch {
          this.error(`${where}: @pattern '${text}' is not a valid regular expression`, loc);
        }
      } else if (tag.name === 'patternMessage') {
        c.patternMessage = text;
      } else if (tag.name === 'format') {
        if (!['email', 'url', 'uuid', 'date', 'date-time'].includes(text)) this.error(`${where}: unknown @format '${text}' (use email, url, uuid, date or date-time)`, loc);
        else c.format = text;
      } else if (tag.name === 'integer') {
        c.integer = true;
      }
    }
    return Object.keys(c).length > 0 ? c : undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Type helpers                                                      */
  /* ---------------------------------------------------------------- */

  /** Records every type a bean can be injected as: itself, base classes and interfaces (transitively). */
  private collectTypes(root: ts.Symbol, bean: BeanModel): void {
    const visit = (sym: ts.Symbol): void => {
      const key = this.keyOf(sym);
      if (bean.types.includes(key)) return;
      bean.types.push(key);
      if (!bean.typeNames.includes(sym.getName())) bean.typeNames.push(sym.getName());
      for (const decl of sym.declarations ?? []) {
        if (!ts.isClassDeclaration(decl) && !ts.isInterfaceDeclaration(decl)) continue;
        for (const clause of decl.heritageClauses ?? []) {
          for (const t of clause.types) {
            const s = this.resolveSymbol(this.checker.getSymbolAtLocation(t.expression));
            if (s) visit(s);
          }
        }
      }
    };
    visit(root);
  }

  private baseClassOf(cls: ts.ClassDeclaration): ts.ClassDeclaration | undefined {
    const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (!ext) return undefined;
    return this.resolveSymbol(this.checker.getSymbolAtLocation(ext.expression))?.declarations?.find(ts.isClassDeclaration);
  }

  private resolveSymbol(sym: ts.Symbol | undefined): ts.Symbol | undefined {
    return sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
  }

  private isNominal(sym: ts.Symbol): boolean {
    return !!sym.declarations?.some((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
  }

  /** `src/repo/user-repository.ts#UserRepository`: unique across the project, stable across builds. */
  private keyOf(sym: ts.Symbol): string {
    let key = this.keyCache.get(sym);
    if (!key) {
      const file = sym.declarations?.[0]?.getSourceFile().fileName ?? '<unknown>';
      key =
        AI_SERVICE_SET.has(sym.getName()) && FRAMEWORK_FILE.test(file)
          ? aiServiceKey(sym.getName())
          : `${path.relative(this.projectDir, file).split(path.sep).join('/')}#${sym.getName()}`;
      this.keyCache.set(sym, key);
    }
    return key;
  }

  private coercion(p: ts.ParameterDeclaration, where: string): Coercion {
    const raw = p.type ? this.checker.getTypeFromTypeNode(p.type) : this.checker.getTypeAtLocation(p.name);
    const t = this.checker.getNonNullableType(raw);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'string';
    const parts = t.isUnion() ? t.types : [t];
    if (parts.every((x) => x.flags & ts.TypeFlags.NumberLike)) return 'number';
    if (parts.every((x) => x.flags & ts.TypeFlags.BooleanLike)) return 'boolean';
    if (parts.every((x) => x.flags & ts.TypeFlags.StringLike)) return 'string';
    this.error(`Parameter '${p.name.getText()}' of ${where} must be string, number or boolean (got '${this.checker.typeToString(t)}')`, this.loc(p));
    return 'string';
  }

  private checkLiteral(value: string, coerce: Coercion, where: string, loc: SourceLocation): void {
    if (coerce === 'number' && (value.trim() === '' || Number.isNaN(Number(value)))) {
      this.error(`${where}: '${value}' is not a valid number`, loc);
    }
    if (coerce === 'boolean' && !['true', 'false', '1', '0', 'yes', 'no'].includes(value.toLowerCase())) {
      this.error(`${where}: '${value}' is not a valid boolean`, loc);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Syntax helpers                                                    */
  /* ---------------------------------------------------------------- */

  private decorators(node: ts.Node): DecoratorInfo[] {
    if (!ts.canHaveDecorators(node)) return [];
    return (ts.getDecorators(node) ?? []).map((d) => {
      const e = d.expression;
      const callee = ts.isCallExpression(e) ? e.expression : e;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
      return { name, args: ts.isCallExpression(e) ? e.arguments : [] };
    });
  }

  /**
   * A parameter typed with one of Amoxi's marker types (`PathParam<number>`, `Body<NewNote>`,
   * `Value<number, 'server.port', 8080>`...), the standard-decorators replacement for parameter
   * decorators. Resolved through the symbol, so renamed imports work and look-alikes don't match.
   */
  private typeMarker(p: ts.ParameterDeclaration): { name: string; args: readonly ts.TypeNode[] } | undefined {
    let t = p.type;
    if (!t) return undefined;
    // `verbose?: QueryParam<boolean> | undefined`
    if (ts.isUnionTypeNode(t)) {
      const rest = t.types.filter((x) => !isNullishTypeNode(x));
      if (rest.length !== 1) return undefined;
      t = rest[0];
    }
    if (!ts.isTypeReferenceNode(t)) return undefined;
    const sym = this.resolveSymbol(this.checker.getSymbolAtLocation(t.typeName));
    const name = sym?.getName();
    if (!name || !PARAMETER_MARKERS.has(name)) return undefined;
    if (!sym?.declarations?.some((d) => ts.isTypeAliasDeclaration(d) && FRAMEWORK_FILE.test(d.getSourceFile().fileName))) return undefined;
    return { name, args: t.typeArguments ?? [] };
  }

  /** The decorator a marker type stands for, with its name argument taken from the second type argument. */
  private markerAsDecorator(marker: { name: string; args: readonly ts.TypeNode[] } | undefined, name: string): DecoratorInfo | undefined {
    if (marker?.name !== name) return undefined;
    const label = marker.args[1] ? this.literalType(marker.args[1]) : undefined;
    return { name, args: label === undefined ? [] : [ts.factory.createStringLiteral(label)] };
  }

  /** The value of a literal type argument: `'server.port'`, `8080`, `-1`, `true`. */
  private literalType(node: ts.TypeNode | undefined): string | undefined {
    if (!node || !ts.isLiteralTypeNode(node)) return undefined;
    const lit = node.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit) || ts.isNumericLiteral(lit)) return lit.text;
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (ts.isPrefixUnaryExpression(lit) && lit.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(lit.operand)) return `-${lit.operand.text}`;
    return undefined;
  }

  private literal(expr: ts.Expression | undefined): string | undefined {
    return expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) ? expr.text : undefined;
  }

  private stringArg(decs: readonly DecoratorInfo[], name: string): string | undefined {
    const d = decs.find((x) => x.name === name);
    return d ? this.literal(d.args[0]) : undefined;
  }

  private requirePublic(member: ts.MethodDeclaration, owner: string, loc: SourceLocation): void {
    const hidden = ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
    if (hidden || ts.isPrivateIdentifier(member.name)) {
      this.error(`'${owner}.${member.name.getText()}' must be public: generated code calls it directly`, loc);
    }
  }

  private loc(node: ts.Node): SourceLocation {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return { file: path.relative(process.cwd(), sf.fileName), line: line + 1 };
  }

  private error(message: string, loc?: SourceLocation): void {
    this.diagnostics.push({ message, loc });
  }

  private warn(message: string, loc?: SourceLocation): void {
    const where = loc ? `${loc.file}:${loc.line} - ` : '';
    process.stderr.write(`warning AMOXI: ${where}${message}\n`);
  }
}

function isNullishTypeNode(t: ts.TypeNode): boolean {
  return (
    t.kind === ts.SyntaxKind.UndefinedKeyword ||
    t.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

export function joinPaths(...parts: string[]): string {
  return '/' + parts.join('/').split('/').filter(Boolean).join('/');
}
