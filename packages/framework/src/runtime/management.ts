// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { ApplicationContext } from './container';

export interface BeanInfo {
  id: number;
  name: string;
  scope: string;
  eager: boolean;
  primary: boolean;
  qualifier: string | null;
  types: readonly string[];
  dependencies: readonly number[];
  created: boolean;
}

export interface RouteInfo {
  method: string;
  path: string;
  controller: string;
}

export interface AppInfo {
  name: string;
  status: 'UP';
  startupMs: number;
  startedAt: string;
  uptimeSeconds: number;
  runtime: { node: string; platform: string; arch: string; pid: number; memoryRssMb: number; heapUsedMb: number };
  beans: { total: number; created: number };
  routes: number;
  build: { generatedAt: string; compilerVersion: string };
}

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

/** Bean definitions in creation order, with dependencies and whether each has been created. */
export function describeBeans(ctx: ApplicationContext): BeanInfo[] {
  return ctx.module.beans.map((b) => ({
    id: b.id,
    name: b.name,
    scope: b.scope,
    eager: b.eager,
    primary: b.primary,
    qualifier: b.qualifier ?? null,
    types: b.types,
    dependencies: b.dependencies ?? [],
    created: ctx.isInstantiated(b.id),
  }));
}

export function describeRoutes(ctx: ApplicationContext): RouteInfo[] {
  return ctx.module.routes.map((r) => ({ method: r.method, path: r.path, controller: ctx.module.beans[r.beanId].name }));
}

export function describeApp(ctx: ApplicationContext): AppInfo {
  const memory = process.memoryUsage();
  const beans = ctx.module.beans;
  return {
    name: ctx.config.string('app.name', 'application'),
    status: 'UP',
    startupMs: Math.round(ctx.startup.ms * 100) / 100,
    startedAt: new Date(ctx.startup.startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - ctx.startup.startedAt) / 1000),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      memoryRssMb: mb(memory.rss),
      heapUsedMb: mb(memory.heapUsed),
    },
    beans: { total: beans.length, created: beans.filter((b) => ctx.isInstantiated(b.id)).length },
    routes: ctx.module.routes.length,
    build: ctx.module.buildInfo,
  };
}

/**
 * Read-only introspection endpoints, similar to Micronaut's management endpoints.
 *   GET /amoxi/info    runtime + build information
 *   GET /amoxi/beans   bean definitions in creation order, with dependencies and state
 *   GET /amoxi/routes  HTTP routes and the controller handling each one
 */
export function createManagementHandler(ctx: ApplicationContext): (path: string) => unknown {
  return (path) => {
    switch (path) {
      case '/amoxi/info':
        return describeApp(ctx);
      case '/amoxi/beans':
        return describeBeans(ctx);
      case '/amoxi/routes':
        return describeRoutes(ctx);
      default:
        return undefined;
    }
  };
}
