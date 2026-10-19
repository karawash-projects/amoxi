// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config';
import type { Cookies } from './cookies';
import type { Session } from './session';

export type Scope = 'singleton' | 'prototype' | 'request';

/** What generated factory code uses to obtain dependencies. Lookups are array-index based: O(1), no maps, no reflection. */
export interface BeanResolver {
  readonly config: Config;
  get<T = any>(id: number): T;
  /** First enabled candidate (for injection points with @Requires alternatives). */
  pick<T = any>(ids: readonly number[]): T;
  pickOptional<T = any>(ids: readonly number[]): T | undefined;
  /** Every enabled candidate. */
  getAll<T = any>(ids: readonly number[]): T[];
  /** The current HTTP request (inside request-scoped beans). */
  request(): RequestContext;
  /** Lazy handle to a bean, resolved on each call (Provider<T> injection). */
  provider<T = any>(ids: readonly number[]): Provider<T>;
  /** Wraps the listed methods of `instance` with interceptor beans (AOP). */
  intercept<T extends object>(instance: T, beanName: string, plan: Readonly<Record<string, readonly number[]>>): T;
}

/**
 * Inject `Provider<T>` instead of `T` to resolve a bean lazily, on each `get()`. Use it to reach
 * request-scoped beans from singletons, or to break a dependency cycle.
 */
export interface Provider<T> {
  get(): T;
  /** Like get(), but returns undefined when the bean isn't available (e.g. request scope outside a request, or disabled by @Requires). */
  getIfAvailable(): T | undefined;
}

/** What an AOP interceptor receives. Call `proceed()` to continue to the next interceptor or the method. */
export interface Invocation {
  readonly target: object;
  readonly bean: string;
  readonly method: string;
  /** Arguments; interceptors may replace entries before calling proceed(). */
  readonly args: unknown[];
  proceed(): unknown;
}

/** Implemented by interceptor beans used with @Intercept. */
export interface MethodInterceptor {
  intercept(invocation: Invocation): unknown;
}

/** A bean definition emitted by the AOT compiler. */
export interface BeanDefinition<T = any> {
  readonly id: number;
  readonly name: string;
  readonly scope: Scope;
  readonly eager: boolean;
  readonly primary: boolean;
  readonly qualifier?: string;
  /** Simple names of every type this bean can be injected as (class, superclasses, interfaces). */
  readonly types: readonly string[];
  /** @Requires: the bean exists only when this returns true for the configuration. */
  readonly condition?: (config: Config) => boolean;
  /** Candidate groups for required single-bean injection points, checked at startup when @Requires is involved. */
  readonly needs?: ReadonlyArray<readonly number[]>;
  /** Ids of the beans this one depends on (for introspection; resolution is already baked into `create`). */
  readonly dependencies?: readonly number[];
  readonly create: (r: BeanResolver) => T;
  readonly postConstruct?: (bean: T) => void;
  readonly preDestroy?: (bean: T) => void | Promise<void>;
}

export interface RequestContext {
  /** Request id (from a valid incoming X-Request-Id, otherwise generated); echoed in the response and logs. */
  readonly id: string;
  readonly method: string;
  /**
   * The request path. For the markdown copy of a page (/x.md, /x/index.md) this is the page's own
   * path (/x), so middleware and access rules written for a page also cover its markdown and JSON views.
   */
  readonly path: string;
  /** How a page is being returned: 'html', or 'markdown'/'json' for AI agents (see `representation` in the README). */
  readonly representation: 'html' | 'markdown' | 'json';
  /** Raw query string without '?'. */
  readonly search: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  body: unknown;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly cookies: Cookies;
  /** Encrypted cookie session. Works without configuration (key generated at build time). */
  readonly session: Session;
  /** Per-request CSP nonce (added automatically to inline scripts in pages). */
  readonly nonce: string;
  /** Client IP (honours X-Forwarded-For when `server.trust-proxy` is on). */
  readonly ip: string;
  readonly protocol: 'http' | 'https';
  /** Scratch space for middleware, e.g. the authenticated user. */
  readonly state: Record<string, unknown>;
  /** Negotiated locale: ?lang= (remembered in a cookie), then the cookie, then Accept-Language, then the default. */
  readonly locale: string;
  /** Translate a key from src/i18n/<locale>.json; keys used with string literals are checked at build time. */
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

/** A route emitted by the AOT compiler. Path patterns are precompiled into regex literals at build time. */
export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  /** `null` for static routes (resolved via a Map lookup). */
  readonly pattern: RegExp | null;
  readonly paramNames: readonly string[];
  readonly beanId: number;
  readonly needsBody: boolean;
  /** @Page route (used by static export). */
  readonly page?: boolean;
  /** Body is multipart/form-data (@Multipart). */
  readonly multipart?: boolean;
  /** @Cached: serve from the response cache, refreshing in the background when stale. Seconds. */
  readonly cache?: { readonly ttl: number; readonly swr: number };
  readonly handler: (bean: any, ctx: RequestContext) => unknown;
}

export interface ErrorPageDefinition {
  readonly beanId: number;
  readonly handler: (bean: any, ctx: RequestContext) => unknown;
}

export interface ClientManifest {
  readonly hydrate: string;
  readonly islands: Readonly<Record<string, string>>;
  /** Bundled stylesheets: source file name -> hashed URL. */
  readonly styles?: Readonly<Record<string, string>>;
}

/** Everything the runtime needs, produced by `amoxi build`. */
export interface ApplicationModule {
  /** Bean definitions in topological order: every bean's dependencies have a lower id. */
  readonly beans: readonly BeanDefinition[];
  /** Simple type name -> bean ids (primary candidates first). Used only for manual `getBean()` lookups. */
  readonly typeIndex: Readonly<Record<string, readonly number[]>>;
  readonly routes: readonly RouteDefinition[];
  /** Bean ids of @Middleware beans, in execution order. */
  readonly middleware?: readonly number[];
  /** Browser bundles produced by `amoxi build` for islands. */
  readonly client?: ClientManifest;
  /** @WebSocketEndpoint handlers. */
  readonly websockets?: readonly WebSocketDefinition[];
  /** Translations from src/i18n/*.json. */
  readonly i18n?: { readonly defaultLocale: string; readonly locales: readonly string[]; readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>> };
  /** OpenAPI 3.1 description generated from routes and types. */
  readonly openapi?: unknown;
  /**
   * Session encryption key generated by `amoxi build` (like Next.js's Server Actions key), so
   * sessions need no configuration and every instance of the same build shares it.
   * `amoxi.session.secret` (AMOXI_SESSION_SECRET) overrides it.
   */
  readonly sessionKey?: string;
  /** @ErrorPage handlers by HTTP status, used for requests that accept HTML. */
  readonly errorPages?: Readonly<Record<number, ErrorPageDefinition>>;
  /** Agents, tools and generative UI components (amoxi/ai), generated from @Agent/@Tool/@generative. */
  readonly ai?: import('../ai/types').AiModule;
  /** Optional modules that add routes and lifecycle hooks (e.g. amoxi/ai). */
  readonly extensions?: readonly AmoxiExtension[];
  readonly buildInfo: { readonly generatedAt: string; readonly compilerVersion: string };
}

/** Implemented by @Middleware beans. Return `next()`'s result, a different result, or throw HttpError. */
export interface HttpMiddleware {
  handle(ctx: RequestContext, next: () => Promise<unknown>): unknown;
}

export interface WebSocketDefinition {
  readonly path: string;
  readonly pattern: RegExp | null;
  readonly paramNames: readonly string[];
  readonly beanId: number;
  readonly open?: (bean: any, socket: import('./websocket').WebSocketConnection) => unknown;
  readonly message: (bean: any, socket: import('./websocket').WebSocketConnection, data: string | Buffer) => unknown;
  readonly close?: (bean: any, socket: import('./websocket').WebSocketConnection, code: number, reason: string) => unknown;
}

/**
 * Plug-in point for optional modules (Open/Closed principle): an extension adds routes and
 * start/stop hooks without the core importing it. `amoxi/ai` is one.
 */
export interface AmoxiExtension {
  readonly name: string;
  /** Called once per application after the context is created. Keep it cheap: start-up time matters. */
  install(host: ExtensionHost): ExtensionInstance;
}

export interface ExtensionHost {
  readonly context: import('./container').ApplicationContext;
  readonly config: import('./config').Config;
  readonly logger: import('./logger').Logger;
}

export interface ExtensionRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path with optional `:param` segments, e.g. '/agents/:agent/runs/:id'. */
  readonly path: string;
  /** Read the JSON body before calling the handler. */
  readonly needsBody?: boolean;
  readonly handler: (ctx: RequestContext) => unknown;
}

/** What an extension adds to /llms.txt. */
export interface ExtensionDescription {
  readonly agents?: ReadonlyArray<{ name: string; description: string; url: string }>;
  readonly links?: { readonly mcp?: string; readonly agentCard?: string };
}

export interface ExtensionInstance {
  readonly routes?: readonly ExtensionRoute[];
  /** Entries for /llms.txt. */
  describe?(): ExtensionDescription;
  /** After the server is listening (port is undefined when the app doesn't serve HTTP). */
  start?(info: { port?: number }): void | Promise<void>;
  /** On shutdown, after the server stops accepting requests and before @PreDestroy hooks. */
  stop?(): void | Promise<void>;
}
