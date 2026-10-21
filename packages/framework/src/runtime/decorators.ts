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

/**
 * Class decorator type that works with standard decorators (the TypeScript 5 default) and with the
 * legacy `experimentalDecorators` flag. Every Amoxi decorator is the same no-op at runtime.
 */
export interface ClassMarker {
  (value: abstract new (...args: any[]) => unknown, context: ClassDecoratorContext): void;
  (target: Function): void;
}

/** Method decorator type for standard decorators and for `experimentalDecorators`. */
export interface MethodMarker {
  (value: (this: any, ...args: any[]) => any, context: ClassMethodDecoratorContext): void;
  (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void;
}

/**
 * Parameter decorators need `experimentalDecorators`: standard decorators have none. Each one has
 * a type of the same name that works in both modes, e.g. `id: PathParam<number>` for `@PathParam() id: number`.
 */
export type ParameterMarker = ParameterDecorator;

type AnyDecorator = ClassMarker & MethodMarker & ParameterMarker & PropertyDecorator;

const marker = ((): void => undefined) as unknown as AnyDecorator;

/* ------------------------------------------------------------------ */
/* Bean definitions                                                    */
/* ------------------------------------------------------------------ */

/** A single shared instance per application context (lazy by default). */
export function Singleton(): ClassMarker {
  return marker;
}

/** A new instance is created for every injection point. */
export function Prototype(): ClassMarker & MethodMarker {
  return marker;
}

/** Instantiate this singleton during startup instead of on first use (Micronaut's @Context). */
export function Eager(): ClassMarker & MethodMarker {
  return marker;
}

/** Preferred candidate when several beans implement the same type. */
export function Primary(): ClassMarker & MethodMarker {
  return marker;
}

/** Qualifier: name a bean (class / @Bean method) or select one (constructor parameter). */
export function Named(_name: string): ClassMarker & MethodMarker & ParameterMarker {
  return marker;
}

/** A class whose @Bean methods produce beans (Micronaut's @Factory). */
export function Factory(): ClassMarker {
  return marker;
}

/** A factory method producing a bean of its (explicit or inferred) return type. */
export function Bean(): MethodMarker {
  return marker;
}

/**
 * Inject a configuration value: `@Value('${server.port:8080}')`.
 * The value is coerced to the parameter's declared type (string | number | boolean)
 * using code chosen at compile time.
 */
export function Value(_expression: string): ParameterMarker {
  return marker;
}

/** Called once, right after the bean is constructed (synchronous). */
export function PostConstruct(): MethodMarker {
  return marker;
}

/** Called when the application context closes, in reverse creation order (may be async). */
export function PreDestroy(): MethodMarker {
  return marker;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** Marks a singleton bean whose methods are HTTP routes under the given base path. */
export function Controller(_path?: string): ClassMarker {
  return marker;
}

export function Get(_path?: string): MethodMarker {
  return marker;
}
export function Post(_path?: string): MethodMarker {
  return marker;
}
export function Put(_path?: string): MethodMarker {
  return marker;
}
export function Patch(_path?: string): MethodMarker {
  return marker;
}
export function Delete(_path?: string): MethodMarker {
  return marker;
}

/**
 * A server-rendered page: the method returns JSX, which Amoxi renders to an HTML document
 * (GET only). Parameters bind exactly like @Get routes.
 */
export function Page(_path?: string): MethodMarker {
  return marker;
}

/**
 * Cache the response of a GET route or page in memory for `ttl` seconds, then serve it stale
 * for up to `staleWhileRevalidate` seconds while it re-renders in the background (Next.js ISR).
 * Only cache content that is the same for every visitor. Use `revalidatePath()` after changes.
 */
export function Cached(_ttl: number, _options?: { staleWhileRevalidate?: number }): MethodMarker {
  return marker;
}

/**
 * Renders this page for HTML requests that fail with the given status (e.g. 404 or 500).
 * The method may take a RequestContext parameter (for the request id).
 */
export function ErrorPage(_status: number): MethodMarker {
  return marker;
}

/**
 * A singleton that wraps every routed request (API and pages), in ascending `order`.
 * The class must implement `handle(ctx: RequestContext, next: () => Promise<unknown>)`.
 */
export function Middleware(_order?: number): ClassMarker {
  return marker;
}

/** Bind a `:name` path segment (name defaults to the parameter name). */
export function PathParam(_name?: string): ParameterMarker {
  return marker;
}

/** Bind a query-string parameter (name defaults to the parameter name). Optional if the param is optional. */
export function QueryParam(_name?: string): ParameterMarker {
  return marker;
}

/** Bind a request header (case-insensitive). */
export function Header(_name: string): ParameterMarker {
  return marker;
}

/** Bind the parsed JSON request body. */
export function Body(): ParameterMarker {
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
export function Requires(_condition: RequiresCondition): ClassMarker & MethodMarker {
  return marker;
}

/**
 * One instance per HTTP request, disposed (@PreDestroy) when the request ends. Inject it into
 * singletons as `Provider<T>`; inject `RequestContext` into it to read the current request.
 */
export function RequestScope(): ClassMarker {
  return marker;
}

/**
 * Wrap methods with interceptor beans (classes implementing MethodInterceptor). On a class it
 * applies to every public method declared in that class; interceptors run in the order listed.
 */
export function Intercept(..._interceptors: Array<abstract new (...args: any[]) => import('./types').MethodInterceptor>): ClassMarker & MethodMarker {
  return marker;
}

/* ------------------------------------------------------------------ */
/* WebSockets and uploads                                              */
/* ------------------------------------------------------------------ */

/**
 * A singleton handling WebSocket connections at `path` (path parameters allowed). Implement any of
 * `onOpen(socket)`, `onMessage(socket, data)` (required) and `onClose(socket, code, reason)`.
 */
export function WebSocketEndpoint(_path: string): ClassMarker {
  return marker;
}

/** Bind a parsed multipart/form-data body (file uploads) as a MultipartForm. */
export function Multipart(): ParameterMarker {
  return marker;
}

/* ------------------------------------------------------------------ */
/* Parameter markers as types (standard decorators)                    */
/* ------------------------------------------------------------------ */
// Each type has the name of the parameter decorator it replaces and is just `T` to the compiler,
// so the parameter keeps its plain type inside the method. `amoxi build` reads the marker and its
// type arguments from the source, as it reads the decorators. They work with or without
// `experimentalDecorators`.

/** A `:name` path segment: `id: PathParam<number>`; `PathParam<number, 'orderId'>` names another segment. */
export type PathParam<T, _Name extends string = never> = T;

/** A query-string parameter: `page?: QueryParam<number>`, or `QueryParam<string, 'q'>` for another name. */
export type QueryParam<T, _Name extends string = never> = T;

/** A request header (case-insensitive): `requestId: Header<string, 'x-request-id'>`. */
export type Header<T, _Name extends string> = T;

/** The parsed and validated JSON request body: `body: Body<NewNote>`. */
export type Body<T> = T;

/** A parsed multipart/form-data body (file uploads): `form: Multipart`. */
export type Multipart = import('./multipart').MultipartForm;

/**
 * A configuration value for a constructor parameter: `port: Value<number, 'server.port', 8080>`.
 * The default may be left out; the value is coerced to `T` (string, number or boolean).
 */
export type Value<T, _Key extends string, _Default extends string | number | boolean = never> = T;

/** Select a named bean for a constructor parameter: `greeter: Named<Greeter, 'formal'>`. */
export type Named<T, _Name extends string> = T;

