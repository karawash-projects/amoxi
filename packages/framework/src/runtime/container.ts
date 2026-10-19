// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Config } from './config';
import { requestScope } from './scope';
import type { ApplicationModule, BeanDefinition, BeanResolver, Invocation, MethodInterceptor, Provider, RequestContext } from './types';

/** A class (concrete or abstract) or the simple name of an interface / type. */
export type BeanToken<T = unknown> = string | (abstract new (...args: any[]) => T);

export class NoSuchBeanError extends Error {
  override name = 'NoSuchBeanError';
}

export class NonUniqueBeanError extends Error {
  override name = 'NonUniqueBeanError';
}

export class BeanCreationError extends Error {
  override name = 'BeanCreationError';
  constructor(
    readonly path: readonly string[],
    readonly rootMessage: string,
    options?: { cause?: unknown },
  ) {
    super(`Error instantiating bean [${path.join(' -> ')}]: ${rootMessage}`, options);
  }
}

const EMPTY: unique symbol = Symbol('amoxi.empty');

/**
 * The runtime container.
 *
 * The compiler already resolved, validated and topologically sorted the graph, so the container
 * is an array of instances indexed by bean id. What's left at runtime: evaluating @Requires
 * conditions once at startup, request-scoped instances, and AOP wrapping.
 */
export class ApplicationContext implements BeanResolver {
  private readonly instances: unknown[];
  private readonly creating: Uint8Array;
  /** 1 when the bean's @Requires condition holds (or it has none). */
  private readonly enabled: Uint8Array;
  private readonly destroyOrder: number[] = [];
  private closed = false;
  /** Filled in by AmoxiApplication.run(); exposed for status pages and /amoxi/info. */
  readonly startup = { ms: 0, startedAt: Date.now() };

  constructor(
    readonly module: ApplicationModule,
    readonly config: Config,
    overrides: ReadonlyArray<readonly [BeanToken<any>, unknown]> = [],
  ) {
    const n = module.beans.length;
    this.instances = new Array(n).fill(EMPTY);
    this.creating = new Uint8Array(n);
    this.enabled = new Uint8Array(n);
    for (const def of module.beans) this.enabled[def.id] = !def.condition || def.condition(config) ? 1 : 0;
    // A disabled factory disables its @Bean methods; dependencies on disabled beans are checked below.
    this.verify();
    for (const [token, instance] of overrides) {
      const ids = this.idsFor(token);
      if (ids.length === 0) throw new NoSuchBeanError(`Cannot override '${tokenName(token)}': no such bean`);
      for (const id of ids) this.instances[id] = instance;
    }
  }

  /** Fails fast at startup when @Requires leaves a required dependency without (or with several) candidates. */
  private verify(): void {
    for (const def of this.module.beans) {
      if (!this.enabled[def.id] || !def.needs) continue;
      for (const group of def.needs) {
        const live = group.filter((id) => this.enabled[id]);
        const conditional = live.filter((id) => this.module.beans[id].condition);
        if (live.length === 0) {
          const names = group.map((id) => this.module.beans[id].name).join(', ');
          throw new NoSuchBeanError(`'${def.name}' needs one of [${names}], but @Requires disabled all of them for this configuration (profile ${this.config.profile})`);
        }
        if (conditional.length > 1) {
          const names = conditional.map((id) => this.module.beans[id].name).join(', ');
          throw new NonUniqueBeanError(`'${def.name}' has several enabled candidates: ${names}. Make their @Requires conditions mutually exclusive.`);
        }
      }
    }
  }

  isEnabled(id: number): boolean {
    return this.enabled[id] === 1;
  }

  /** Hot path used by generated code. */
  get<T = any>(id: number): T {
    const existing = this.instances[id];
    if (existing !== EMPTY) return existing as T;
    const def = this.module.beans[id];
    if (!this.enabled[id]) throw new NoSuchBeanError(`Bean '${def.name}' is disabled by @Requires`);

    if (def.scope === 'request') {
      const scope = requestScope.getStore();
      if (!scope) throw new BeanCreationError([def.name], 'request-scoped bean used outside an HTTP request (inject Provider<T> and call get() during a request)');
      if (scope.beans.has(id)) return scope.beans.get(id) as T;
      const bean = this.instantiate<T>(def);
      scope.beans.set(id, bean);
      if (def.preDestroy) scope.destroy.push(() => def.preDestroy!(bean));
      return bean;
    }

    const bean = this.instantiate<T>(def);
    if (def.scope === 'singleton') {
      this.instances[id] = bean;
      if (def.preDestroy) this.destroyOrder.push(id);
    }
    return bean;
  }

  private instantiate<T>(def: BeanDefinition): T {
    const id = def.id;
    if (this.creating[id] === 1) throw new BeanCreationError([def.name], 'circular dependency');
    this.creating[id] = 1;
    try {
      const bean = def.create(this) as T;
      def.postConstruct?.(bean);
      return bean;
    } catch (err) {
      if (err instanceof BeanCreationError) {
        throw new BeanCreationError([def.name, ...err.path], err.rootMessage, { cause: err.cause });
      }
      throw new BeanCreationError([def.name], err instanceof Error ? err.message : String(err), { cause: err });
    } finally {
      this.creating[id] = 0;
    }
  }

  pick<T = any>(ids: readonly number[]): T {
    for (const id of ids) if (this.enabled[id]) return this.get<T>(id);
    throw new NoSuchBeanError(`No enabled bean among [${ids.map((i) => this.module.beans[i].name).join(', ')}]`);
  }

  pickOptional<T = any>(ids: readonly number[]): T | undefined {
    for (const id of ids) if (this.enabled[id]) return this.get<T>(id);
    return undefined;
  }

  getAll<T = any>(ids: readonly number[]): T[] {
    const out: T[] = [];
    for (const id of ids) if (this.enabled[id]) out.push(this.get<T>(id));
    return out;
  }

  request(): RequestContext {
    const scope = requestScope.getStore();
    if (!scope) throw new Error('RequestContext is only available during an HTTP request');
    return scope.ctx;
  }

  provider<T = any>(ids: readonly number[]): Provider<T> {
    const available = (): boolean => {
      const id = ids.find((i) => this.enabled[i]);
      if (id === undefined) return false;
      return this.module.beans[id].scope !== 'request' || requestScope.getStore() !== undefined;
    };
    return {
      get: () => this.pick<T>(ids),
      getIfAvailable: () => (available() ? this.pick<T>(ids) : undefined),
    };
  }

  intercept<T extends object>(instance: T, beanName: string, plan: Readonly<Record<string, readonly number[]>>): T {
    const target = instance as Record<string, unknown>;
    for (const method of Object.keys(plan)) {
      const original = target[method];
      if (typeof original !== 'function') continue;
      const ids = plan[method].filter((id) => this.enabled[id]);
      if (ids.length === 0) continue;
      const interceptors = ids.map((id) => this.get<MethodInterceptor>(id));
      target[method] = (...args: unknown[]): unknown => {
        let index = 0;
        const invocation: Invocation = {
          target: instance,
          bean: beanName,
          method,
          args,
          proceed: () => (index < interceptors.length ? interceptors[index++].intercept(invocation) : (original as (...a: unknown[]) => unknown).apply(instance, invocation.args)),
        };
        return invocation.proceed();
      };
    }
    return instance;
  }

  /** Manual lookup by class or interface name. Prefer constructor injection. */
  getBean<T>(token: BeanToken<T>, qualifier?: string): T {
    const ids = this.candidates(token, qualifier);
    if (ids.length === 0) {
      throw new NoSuchBeanError(`No bean of type '${tokenName(token)}'${qualifier ? ` named '${qualifier}'` : ''}`);
    }
    if (ids.length > 1) {
      const beans = this.module.beans;
      const primary = ids.find((id) => beans[id].primary);
      if (primary !== undefined) return this.get<T>(primary);
      // Same rule as constructor injection: enabled @Requires alternatives win over the single
      // unconditional default, in declaration order.
      const conditional = ids.filter((id) => beans[id].condition);
      if (ids.length - conditional.length <= 1) return this.get<T>(conditional[0]);
      const names = ids.map((id) => beans[id].name).join(', ');
      throw new NonUniqueBeanError(`Multiple beans of type '${tokenName(token)}': ${names}. Use a qualifier.`);
    }
    return this.get<T>(ids[0]);
  }

  findBean<T>(token: BeanToken<T>, qualifier?: string): T | undefined {
    return this.candidates(token, qualifier).length > 0 ? this.getBean(token, qualifier) : undefined;
  }

  getBeansOfType<T>(token: BeanToken<T>): T[] {
    return this.candidates(token).map((id) => this.get<T>(id));
  }

  /** Whether a singleton has been created yet (lazy beans are created on first use). */
  isInstantiated(id: number): boolean {
    return this.instances[id] !== EMPTY;
  }

  get beanDefinitions(): readonly BeanDefinition[] {
    return this.module.beans;
  }

  /** True when any bean is request-scoped (the HTTP layer then opens a scope per request). */
  get usesRequestScope(): boolean {
    return this.module.beans.some((b) => b.scope === 'request' && this.enabled[b.id]);
  }

  /**
   * Instantiate @Eager singletons (or every singleton when `eagerInitAll` is set).
   * Bean ids are topologically ordered, so a simple loop is enough.
   */
  start(eagerInitAll = false): number {
    let created = 0;
    for (const def of this.module.beans) {
      if (def.scope === 'singleton' && this.enabled[def.id] && (eagerInitAll || def.eager) && this.instances[def.id] === EMPTY) {
        this.get(def.id);
        created++;
      }
    }
    return created;
  }

  /** Run @PreDestroy hooks in reverse creation order. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (let i = this.destroyOrder.length - 1; i >= 0; i--) {
      const def = this.module.beans[this.destroyOrder[i]];
      try {
        await def.preDestroy!(this.instances[def.id]);
      } catch (err) {
        console.error(`[amoxi] @PreDestroy of ${def.name} failed:`, err);
      }
    }
  }

  private idsFor(token: BeanToken<any>): readonly number[] {
    return this.module.typeIndex[tokenName(token)] ?? [];
  }

  private candidates(token: BeanToken<any>, qualifier?: string): readonly number[] {
    return this.idsFor(token).filter((id) => this.enabled[id] && (qualifier === undefined || this.module.beans[id].qualifier === qualifier));
  }
}

function tokenName(token: BeanToken<any>): string {
  return typeof token === 'string' ? token : token.name;
}
