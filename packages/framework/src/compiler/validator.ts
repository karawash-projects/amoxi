// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { BeanModel, Diagnostic, Injection } from './model';

export interface ResolvedGraph {
  /** Beans in topological order; position == runtime bean id. */
  readonly ordered: readonly BeanModel[];
  /** bean.index -> runtime id */
  readonly idOf: ReadonlyMap<number, number>;
  /** Resolved candidates (bean indices) per injection point. */
  readonly resolution: ReadonlyMap<Injection, readonly number[]>;
  /** bean.index -> indices of beans it directly depends on */
  readonly dependencies: ReadonlyMap<number, readonly number[]>;
  /** bean.index -> method -> interceptor bean indices */
  readonly interceptors: ReadonlyMap<number, ReadonlyMap<string, readonly number[]>>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Everything that Spring/NestJS-style containers discover at startup (missing beans,
 * ambiguous candidates, dependency cycles, duplicate routes) is detected here, at build time.
 */
export function validateGraph(beans: readonly BeanModel[]): ResolvedGraph {
  const diagnostics: Diagnostic[] = [];
  const byType = new Map<string, BeanModel[]>();
  for (const bean of beans) {
    for (const key of bean.types) {
      const list = byType.get(key) ?? [];
      list.push(bean);
      byType.set(key, list);
    }
  }

  const resolution = new Map<Injection, number[]>();
  const dependencies = new Map<number, number[]>();

  const interceptors = new Map<number, Map<string, number[]>>();
  const byIndex = new Map(beans.map((b) => [b.index, b]));

  for (const bean of beans) {
    const deps = new Set<number>();
    if (bean.factory) deps.add(bean.factory.ownerIndex);

    // AOP: each @Intercept type must be exactly one bean; the intercepted bean depends on it.
    for (const ic of bean.interceptors) {
      const found = byType.get(ic.typeKey) ?? [];
      if (found.length !== 1) {
        diagnostics.push({
          message: found.length === 0
            ? `Interceptor '${ic.typeName}' used on '${bean.name}.${ic.method}' is not a bean. Add @Singleton to it.`
            : `Interceptor type '${ic.typeName}' matches several beans: ${found.map((b) => b.name).join(', ')}`,
          loc: ic.loc,
        });
        continue;
      }
      const methods = interceptors.get(bean.index) ?? new Map<string, number[]>();
      const list = methods.get(ic.method) ?? [];
      if (!list.includes(found[0].index)) list.push(found[0].index);
      methods.set(ic.method, list);
      interceptors.set(bean.index, methods);
      deps.add(found[0].index);
    }

    for (const inj of bean.injections) {
      if (inj.kind === 'request') {
        if (bean.scope !== 'request') {
          diagnostics.push({
            message: `'${bean.name}' injects RequestContext, which only exists during a request. Make it @RequestScope (route methods receive RequestContext as a parameter instead).`,
            loc: inj.loc,
          });
        }
        continue;
      }
      if (inj.kind !== 'bean' && inj.kind !== 'beans' && inj.kind !== 'provider') continue;
      const all = byType.get(inj.typeKey) ?? [];
      const candidates = inj.qualifier === undefined ? all : all.filter((b) => b.qualifier === inj.qualifier);
      const named = inj.qualifier ? ` named '${inj.qualifier}'` : '';
      let chosen: BeanModel[] = candidates;

      if (inj.kind === 'provider') {
        if (candidates.length === 0) {
          diagnostics.push({ message: `No bean of type '${inj.typeName}'${named} exists for Provider parameter '${inj.paramName}' of '${bean.name}'.`, loc: inj.loc });
        }
        // Lazy: no dependency edge, so providers can break cycles.
        resolution.set(inj, orderCandidates(candidates).map((b) => b.index));
        continue;
      }

      // Scope rule: a longer-lived bean must not capture a request-scoped instance.
      if (bean.scope !== 'request') {
        const scoped = candidates.find((c) => c.scope === 'request');
        if (scoped) {
          diagnostics.push({
            message: `'${bean.name}' (${bean.scope}) depends on request-scoped '${scoped.name}' and would keep the first request's instance. Inject 'Provider<${inj.typeName}>' and call get() during a request.`,
            loc: inj.loc,
          });
        }
      }

      if (inj.kind === 'bean') {
        if (candidates.length === 0) {
          chosen = [];
          if (!inj.optional) {
            const hint =
              inj.qualifier && all.length > 0
                ? ` Available qualifiers: ${all.map((b) => (b.qualifier ? `'${b.qualifier}'` : `${b.name} (unqualified)`)).join(', ')}.`
                : ` Annotate an implementation with @Singleton, or provide it from a @Factory @Bean method.`;
            diagnostics.push({
              message: `No bean of type '${inj.typeName}'${named} exists for parameter '${inj.paramName}' of '${bean.name}'.${hint}`,
              loc: inj.loc,
            });
          }
        } else if (candidates.length > 1) {
          const primaries = candidates.filter((b) => b.primary);
          const unconditional = candidates.filter((b) => !b.condition);
          if (primaries.length === 1 && !primaries[0].condition) {
            chosen = primaries;
          } else if (unconditional.length <= 1) {
            // @Requires alternatives, plus at most one unconditional default: chosen at startup.
            chosen = orderCandidates(candidates);
          } else {
            diagnostics.push({
              message:
                `Multiple beans of type '${inj.typeName}'${named} match parameter '${inj.paramName}' of '${bean.name}': ` +
                `${candidates.map((b) => b.name).join(', ')}. Add Named<${inj.typeName}, '...'> (or @Named('...')) to the parameter, mark one bean @Primary, ` +
                `or inject '${inj.typeName}[]' to receive all of them.`,
              loc: inj.loc,
            });
            chosen = [];
          }
        }
      }
      const ids = chosen.map((b) => b.index);
      resolution.set(inj, ids);
      ids.forEach((i) => deps.add(i));
    }
    dependencies.set(bean.index, [...deps]);
  }

  // Depth-first topological sort with cycle reporting.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Uint8Array(beans.length);
  const order: BeanModel[] = [];
  const stack: number[] = [];
  const reportedCycles = new Set<string>();

  const visit = (i: number): void => {
    if (color[i] === BLACK) return;
    if (color[i] === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(i)), i].map((j) => beans[j].name);
      const signature = [...new Set(cycle)].sort().join('|');
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        diagnostics.push({
          message: `Circular dependency: ${cycle.join(' -> ')}. Break the cycle by extracting shared logic into a third bean.`,
          loc: beans[i].loc,
        });
      }
      return;
    }
    color[i] = GRAY;
    stack.push(i);
    for (const d of dependencies.get(i) ?? []) visit(d);
    stack.pop();
    color[i] = BLACK;
    order.push(beans[i]);
  };
  for (let i = 0; i < beans.length; i++) if (color[i] === WHITE) visit(i);

  for (const bean of beans) {
    if (bean.scope === 'request' && bean.eager) diagnostics.push({ message: `'${bean.name}' can't be both @RequestScope and @Eager`, loc: bean.loc });
    if (bean.websocket && bean.scope !== 'singleton') diagnostics.push({ message: `@WebSocketEndpoint '${bean.name}' must be a singleton`, loc: bean.loc });
  }

  // Duplicate routes (`/users/:id` and `/users/:userId` are the same route). Conditional
  // controllers may share routes: @Requires decides which one exists.
  const seenRoutes = new Map<string, string>();
  for (const bean of beans) {
    if (bean.condition) continue;
    for (const r of bean.routes) {
      const key = `${r.method} ${r.path.replace(/:[^/]+/g, ':')}`;
      const where = `${bean.name}.${r.methodName}()`;
      const other = seenRoutes.get(key);
      if (other) diagnostics.push({ message: `Duplicate route '${r.method} ${r.path}' in ${where}, already declared by ${other}`, loc: r.loc });
      else seenRoutes.set(key, where);
    }
  }

  const errorStatuses = new Map<number, string>();
  for (const bean of beans) {
    for (const ep of bean.errorPages) {
      const where = `${bean.name}.${ep.methodName}()`;
      const other = errorStatuses.get(ep.status);
      if (other) diagnostics.push({ message: `Duplicate @ErrorPage(${ep.status}) in ${where}, already declared by ${other}`, loc: ep.loc });
      else errorStatuses.set(ep.status, where);
    }
  }

  for (const bean of beans) {
    if (bean.middlewareOrder !== undefined && bean.scope === 'prototype') {
      diagnostics.push({ message: `Middleware '${bean.name}' cannot be @Prototype`, loc: bean.loc });
    }
  }

  // Controllers are request-scoped singletons in this model.
  for (const bean of beans) {
    if (bean.routes.length > 0 && bean.scope === 'prototype') {
      diagnostics.push({ message: `Controller '${bean.name}' cannot be @Prototype`, loc: bean.loc });
    }
  }

  const idOf = new Map<number, number>();
  order.forEach((b, id) => idOf.set(b.index, id));
  void byIndex;
  return { ordered: order, idOf, resolution, dependencies, interceptors, diagnostics };
}

/** Conditional candidates first (declaration order), then the unconditional default, if any. */
function orderCandidates(candidates: readonly BeanModel[]): BeanModel[] {
  return [...candidates.filter((b) => b.condition), ...candidates.filter((b) => !b.condition)];
}
