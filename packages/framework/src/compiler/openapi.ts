// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { BeanModel, Constraints, RouteModel, Schema } from './model';

type Json = Record<string, unknown>;

function constraints(c: Constraints | undefined): Json {
  if (!c) return {};
  const out: Json = {};
  if (c.minLength !== undefined) out.minLength = c.minLength;
  if (c.maxLength !== undefined) out.maxLength = c.maxLength;
  if (c.pattern !== undefined) out.pattern = c.pattern;
  if (c.format !== undefined) out.format = c.format;
  if (c.minimum !== undefined) out.minimum = c.minimum;
  if (c.maximum !== undefined) out.maximum = c.maximum;
  if (c.minItems !== undefined) out.minItems = c.minItems;
  if (c.maxItems !== undefined) out.maxItems = c.maxItems;
  return out;
}

/** Converts a validation schema (derived from a TypeScript type) into JSON Schema. */
export function toJsonSchema(s: Schema): Json {
  switch (s.k) {
    case 'any':
      return {};
    case 'string':
      return { type: 'string', ...constraints(s.c) };
    case 'number':
      return { type: s.c?.integer ? 'integer' : 'number', ...constraints(s.c) };
    case 'boolean':
      return { type: 'boolean' };
    case 'literal':
      return s.values.length === 1 ? { const: s.values[0] } : { enum: [...s.values] };
    case 'array':
      return { type: 'array', items: toJsonSchema(s.items), ...constraints(s.c) };
    case 'object': {
      const required = s.fields.filter((f) => !f.optional).map((f) => f.name);
      return {
        type: 'object',
        properties: Object.fromEntries(s.fields.map((f) => [f.name, f.description ? { ...toJsonSchema(f.schema), description: f.description } : toJsonSchema(f.schema)])),
        ...(required.length ? { required } : {}),
      };
    }
    case 'record':
      return { type: 'object', additionalProperties: toJsonSchema(s.values) };
    case 'nullable':
      return { anyOf: [toJsonSchema(s.inner), { type: 'null' }] };
    case 'union':
      return { anyOf: s.options.map(toJsonSchema) };
  }
}

const STATUS_TEXT: Record<string, string> = { '200': 'OK', '201': 'Created', '204': 'No Content', '400': 'Invalid request', '404': 'Not found' };

/** Builds an OpenAPI 3.1 document from the analysed routes (pages are excluded). */
export function generateOpenApi(beans: readonly BeanModel[], info: { title: string; version: string }): Json {
  const paths: Record<string, Json> = {};
  const components: Record<string, Json> = {};
  const ref = (name: string | undefined, schema: Schema): Json => {
    const json = toJsonSchema(schema);
    if (!name || name.startsWith('__') || !/^[A-Za-z_][\w]*$/.test(name) || schema.k !== 'object') return json;
    components[name] ??= json;
    return { $ref: `#/components/schemas/${name}` };
  };
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };

  for (const bean of beans) {
    for (const r of bean.routes) {
      if (r.page) continue;
      const oaPath = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const parameters = r.params.flatMap((p) =>
        p.kind === 'path' || p.kind === 'query' || p.kind === 'header'
          ? [{ name: p.name, in: p.kind, required: p.kind === 'path' || p.required, schema: { type: p.coerce } }]
          : [],
      );
      const op: Json = { operationId: `${bean.name}_${r.methodName}`, tags: [bean.name.replace(/Controller$/, '')] };
      if (r.doc?.summary) op.summary = r.doc.summary;
      if (r.doc?.description) op.description = r.doc.description;
      if (r.doc?.deprecated) op.deprecated = true;
      if (parameters.length) op.parameters = parameters;

      const body = r.params.find((p) => p.kind === 'body');
      if (body && body.kind === 'body') {
        op.requestBody = { required: true, content: { 'application/json': { schema: body.schema ? ref(r.bodyName, body.schema) : {} } } };
      }
      if (r.params.some((p) => p.kind === 'multipart')) {
        op.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', additionalProperties: true } } } };
      }

      const responses: Json = {};
      const typed = r.response && r.response.k !== 'any' ? r.response : undefined;
      const success = r.method === 'POST' ? '201' : r.response ? '200' : '204';
      responses[success] = typed
        ? { description: STATUS_TEXT[success], content: { 'application/json': { schema: ref(r.responseName, typed) } } }
        : { description: STATUS_TEXT[success] ?? 'OK' };
      if (r.method === 'POST' && !r.response) responses['201'] = { description: 'Created' };
      if (body || parameters.some((p) => p.in !== 'header')) {
        responses['400'] = { description: 'Invalid request', content: { 'application/json': { schema: error } } };
      }
      if (r.path.includes(':')) responses['404'] = { description: 'Not found', content: { 'application/json': { schema: error } } };
      op.responses = responses;
      (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
    }
  }
  return { openapi: '3.1.0', info, paths, components: { schemas: components } };
}

export type { RouteModel };
