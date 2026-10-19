// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Amoxi decorators are MARKERS ONLY.
 *
 * They are read from the TypeScript AST by the AOT compiler (`amoxi build`).
 * At runtime every decorator returns the same shared no-op function:
 *   - no `reflect-metadata`
 *   - no `emitDecoratorMetadata`
 *   - no global registries, no classpath/file scanning
 *
 * This is the TypeScript equivalent of Micronaut's annotation processors:
 * all the work happens at build time and the runtime only executes
 * pre-generated factory code.
 */

type AnyDecorator = ClassDecorator & MethodDecorator & ParameterDecorator & PropertyDecorator;

const marker = ((): void => undefined) as unknown as AnyDecorator;

/* ------------------------------------------------------------------ */
/* Bean definitions                                                    */
/* ------------------------------------------------------------------ */

/** A single shared instance per application context (lazy by default). */
export function Singleton(): ClassDecorator {
  return marker;
}

/** A new instance is created for every injection point. */
export function Prototype(): ClassDecorator & MethodDecorator {
  return marker;
}

/** Instantiate this singleton during startup instead of on first use (Micronaut's @Context). */
export function Eager(): ClassDecorator & MethodDecorator {
  return marker;
}

/** Preferred candidate when several beans implement the same type. */
export function Primary(): ClassDecorator & MethodDecorator {
  return marker;
}

/** Qualifier: name a bean (class / @Bean method) or select one (constructor parameter). */
export function Named(_name: string): ClassDecorator & MethodDecorator & ParameterDecorator {
  return marker;
}

/** A class whose @Bean methods produce beans (Micronaut's @Factory). */
export function Factory(): ClassDecorator {
  return marker;
}

/** A factory method producing a bean of its (explicit or inferred) return type. */
export function Bean(): MethodDecorator {
  return marker;
}

/**
 * Inject a configuration value: `@Value('${server.port:8080}')`.
 * The value is coerced to the parameter's declared type (string | number | boolean)
 * using code chosen at compile time.
 */
export function Value(_expression: string): ParameterDecorator {
  return marker;
}

/** Called once, right after the bean is constructed (synchronous). */
export function PostConstruct(): MethodDecorator {
  return marker;
}

/** Called when the application context closes, in reverse creation order (may be async). */
export function PreDestroy(): MethodDecorator {
  return marker;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** Marks a singleton bean whose methods are HTTP routes under the given base path. */
export function Controller(_path?: string): ClassDecorator {
  return marker;
}

export function Get(_path?: string): MethodDecorator {
  return marker;
}
export function Post(_path?: string): MethodDecorator {
  return marker;
}
export function Put(_path?: string): MethodDecorator {
  return marker;
}
export function Patch(_path?: string): MethodDecorator {
  return marker;
}
export function Delete(_path?: string): MethodDecorator {
  return marker;
}

/**
 * A server-rendered page: the method returns JSX, which Amoxi renders to an HTML document
 * (GET only). Parameters bind exactly like @Get routes.
 */
export function Page(_path?: string): MethodDecorator {
  return marker;
}

/**
 * Cache the response of a GET route or page in memory for `ttl` seconds, then serve it stale
 * for up to `staleWhileRevalidate` seconds while it re-renders in the background (Next.js ISR).
 * Only cache content that is the same for every visitor. Use `revalidatePath()` after changes.
 */
export function Cached(_ttl: number, _options?: { staleWhileRevalidate?: number }): MethodDecorator {
  return marker;
}

/**
 * Renders this page for HTML requests that fail with the given status (e.g. 404 or 500).
 * The method may take a RequestContext parameter (for the request id).
 */
export function ErrorPage(_status: number): MethodDecorator {
  return marker;
}

/**
 * A singleton that wraps every routed request (API and pages), in ascending `order`.
 * The class must implement `handle(ctx: RequestContext, next: () => Promise<unknown>)`.
 */
export function Middleware(_order?: number): ClassDecorator {
  return marker;
}

/** Bind a `:name` path segment (name defaults to the parameter name). */
export function PathParam(_name?: string): ParameterDecorator {
  return marker;
}

/** Bind a query-string parameter (name defaults to the parameter name). Optional if the param is optional. */
export function QueryParam(_name?: string): ParameterDecorator {
  return marker;
}

/** Bind a request header (case-insensitive). */
export function Header(_name: string): ParameterDecorator {
  return marker;
}

/** Bind the parsed JSON request body. */
export function Body(): ParameterDecorator {
  return marker;
}

/* ------------------------------------------------------------------ */
/* Conditions, scopes and interception                                 */
/* ------------------------------------------------------------------ */

export interface RequiresCondition {
  /** A configuration key that must be set (and not "false" or empty), or must equal `value`. */
  property?: string;
  value?: string;
  /** A configuration key that must NOT be set. */
  missing?: string;
  /** Only in these profiles (e.g. 'production'). */
  profile?: string | string[];
  /** Not in these profiles. */
  notProfile?: string | string[];
}

/**
 * Create this bean only when the condition holds for the configuration (evaluated once at startup).
 * An injection point may have several @Requires candidates (exactly one enabled), plus one
 * unconditional bean that acts as the default when none of them is enabled.
 */
export function Requires(_condition: RequiresCondition): ClassDecorator & MethodDecorator {
  return marker;
}

/**
 * One instance per HTTP request, disposed (@PreDestroy) when the request ends. Inject it into
 * singletons as `Provider<T>`; inject `RequestContext` into it to read the current request.
 */
export function RequestScope(): ClassDecorator {
  return marker;
}

/**
 * Wrap methods with interceptor beans (classes implementing MethodInterceptor). On a class it
 * applies to every public method declared in that class; interceptors run in the order listed.
 */
export function Intercept(..._interceptors: Array<abstract new (...args: any[]) => import('./types').MethodInterceptor>): ClassDecorator & MethodDecorator {
  return marker;
}

/* ------------------------------------------------------------------ */
/* WebSockets and uploads                                              */
/* ------------------------------------------------------------------ */

/**
 * A singleton handling WebSocket connections at `path` (path parameters allowed). Implement any of
 * `onOpen(socket)`, `onMessage(socket, data)` (required) and `onClose(socket, code, reason)`.
 */
export function WebSocketEndpoint(_path: string): ClassDecorator {
  return marker;
}

/** Bind a parsed multipart/form-data body (file uploads) as a MultipartForm. */
export function Multipart(): ParameterDecorator {
  return marker;
}
