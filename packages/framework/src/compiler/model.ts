// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

export interface Diagnostic {
  readonly message: string;
  readonly loc?: SourceLocation;
}

export type Coercion = 'string' | 'number' | 'boolean';

/** A constructor or @Bean-method parameter, resolved statically from the AST + type checker. */
export type Injection =
  | {
      readonly kind: 'bean';
      readonly paramName: string;
      /** Globally unique type key: `<relative file>#<Name>` */
      readonly typeKey: string;
      readonly typeName: string;
      readonly qualifier?: string;
      readonly optional: boolean;
      readonly loc: SourceLocation;
    }
  | {
      /** `T[]` / `readonly T[]` / `Array<T>`: every bean of type T. */
      readonly kind: 'beans';
      readonly paramName: string;
      readonly typeKey: string;
      readonly typeName: string;
      readonly qualifier?: string;
      readonly loc: SourceLocation;
    }
  | {
      readonly kind: 'value';
      readonly paramName: string;
      readonly key?: string;
      readonly fallback?: string;
      /** Constant (no `${...}` placeholder). */
      readonly literal?: string;
      readonly coerce: Coercion;
      readonly loc: SourceLocation;
    }
  /** The ApplicationContext itself. */
  | { readonly kind: 'context'; readonly paramName: string }
  /** The current RequestContext (request-scoped beans only). */
  | { readonly kind: 'request'; readonly paramName: string; readonly loc: SourceLocation }
  /** Provider<T>: resolved lazily on each get(). */
  | {
      readonly kind: 'provider';
      readonly paramName: string;
      readonly typeKey: string;
      readonly typeName: string;
      readonly qualifier?: string;
      readonly loc: SourceLocation;
    }
  /** Analysis already reported an error for this parameter. */
  | { readonly kind: 'invalid'; readonly paramName: string };

/** Constraints from JSDoc tags on body properties (@minLength, @format email, ...). */
export interface Constraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Message used when `pattern` doesn't match (JSDoc @patternMessage). */
  patternMessage?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  minItems?: number;
  maxItems?: number;
}

/** JSON shape derived from a TypeScript type, used to generate request-body validators. */
export type Schema =
  | { readonly k: 'string'; readonly c?: Constraints }
  | { readonly k: 'number'; readonly c?: Constraints }
  | { readonly k: 'boolean' }
  | { readonly k: 'literal'; readonly values: ReadonlyArray<string | number | boolean> }
  | { readonly k: 'array'; readonly items: Schema; readonly c?: Constraints }
  | { readonly k: 'object'; readonly fields: ReadonlyArray<{ name: string; schema: Schema; optional: boolean; description?: string }> }
  | { readonly k: 'record'; readonly values: Schema }
  | { readonly k: 'nullable'; readonly inner: Schema }
  | { readonly k: 'union'; readonly options: readonly Schema[] }
  | { readonly k: 'any' };

export type RouteParam =
  | {
      readonly kind: 'path' | 'query' | 'header';
      readonly name: string;
      readonly coerce: Coercion;
      readonly required: boolean;
    }
  | { readonly kind: 'body'; readonly schema?: Schema }
  | { readonly kind: 'multipart' }
  | { readonly kind: 'context' };

export interface RouteModel {
  readonly method: string;
  readonly path: string;
  readonly methodName: string;
  /** @Page: the result is rendered to an HTML document. */
  readonly page: boolean;
  /** @Cached(ttl, { staleWhileRevalidate }) in seconds. */
  readonly cache?: { readonly ttl: number; readonly swr: number };
  /** For OpenAPI: JSDoc summary/description and the response body schema. */
  readonly doc?: { summary?: string; description?: string; deprecated?: boolean };
  readonly response?: Schema;
  readonly responseName?: string;
  readonly bodyName?: string;
  readonly params: readonly RouteParam[];
  readonly loc: SourceLocation;
}

/** A @Tool method: callable by agents (and MCP clients) with JSON arguments. */
export interface ToolModel {
  readonly name: string;
  readonly description: string;
  readonly methodName: string;
  /** Schema of the input parameter (always an object), or undefined when the method takes none. */
  readonly input?: Schema;
  readonly output?: Schema;
  /** Position of the ToolContext parameter, if any. */
  readonly contextIndex?: number;
  readonly inputIndex?: number;
  readonly approval: boolean;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly expose: boolean;
  readonly loc: SourceLocation;
}

/** An @Agent class. */
export interface AgentModel {
  readonly name: string;
  readonly description: string;
  /** Classes whose @Tool methods the agent may call (the agent's own tools are always included). */
  readonly toolClasses: Array<{ typeKey: string; typeName: string; loc: SourceLocation }>;
  /** Generative UI islands it may show; 'all' = every @generative island. */
  readonly ui: readonly string[] | 'all';
  readonly knowledge: readonly string[];
  readonly recall: number;
  readonly rememberTool: boolean;
  readonly examples: readonly string[];
  readonly maxTurns?: number;
  readonly model?: string;
  readonly hooks: { principal: boolean; owner: boolean; beforeToolCall: boolean; onRunFinished: boolean };
  readonly loc: SourceLocation;
}

export interface BeanModel {
  /** Discovery order; ids are assigned later in topological order. */
  readonly index: number;
  readonly name: string;
  /** 'builtin': a framework-provided service (amoxi/ai) the app didn't implement itself. */
  readonly kind: 'class' | 'factory-method' | 'builtin';
  /** Exported class to import in generated code (the factory class for factory-method beans). */
  readonly importName: string;
  readonly importFile: string;
  readonly scope: 'singleton' | 'prototype' | 'request';
  readonly eager: boolean;
  readonly primary: boolean;
  readonly qualifier?: string;
  /** Type keys this bean satisfies (itself, superclasses, implemented interfaces). */
  readonly types: string[];
  readonly typeNames: string[];
  readonly injections: Injection[];
  readonly factory?: { readonly ownerIndex: number; readonly method: string };
  postConstruct?: string;
  preDestroy?: string;
  /** Set for @Middleware beans. */
  middlewareOrder?: number;
  /** @Requires condition. */
  readonly condition?: Condition;
  /** @Intercept bindings: method name -> interceptor types (in order). */
  readonly interceptors: Array<{ method: string; typeKey: string; typeName: string; loc: SourceLocation }>;
  /** @WebSocketEndpoint. */
  /** Argument counts of the handlers (false when absent), so generated calls match their signatures. */
  websocket?: { path: string; open: number | false; message: number; close: number | false };
  /** @ErrorPage(status) methods. */
  readonly errorPages: Array<{ status: number; methodName: string; params: RouteParam[]; loc: SourceLocation }>;
  readonly routes: RouteModel[];
  /** @Tool methods. */
  readonly tools: ToolModel[];
  /** Set for @Agent classes. */
  agent?: AgentModel;
  readonly loc: SourceLocation;
}

export interface Condition {
  readonly property?: string;
  readonly value?: string;
  readonly missing?: string;
  readonly profile?: readonly string[];
  readonly notProfile?: readonly string[];
}
