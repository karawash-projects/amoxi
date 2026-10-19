// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, resolve } from 'node:path';
import type { Config } from '../../runtime/config';
import type { ConversationStore, Embedder, RunStore, VectorStore } from '../types';
import { HashingEmbedder } from '../vector/hashing-embedder';
import { LocalVectorStore } from '../vector/local-vector-store';
import { OpenAiEmbedder } from '../vector/openai-embedder';
import { FileConversationStore } from './file-conversation-store';
import { FileRunStore } from './file-run-store';
import { MemoryConversationStore } from './memory-conversation-store';
import { MemoryRunStore } from './memory-run-store';

/** The storage of the AI module, chosen by configuration. */
export interface AiStores {
  readonly runs: RunStore;
  readonly conversations: ConversationStore;
  readonly vectors: VectorStore;
  readonly embedder: Embedder;
  /** Flushes pending writes and closes connections. */
  close(): Promise<void>;
}

export type AiStoreKind = 'file' | 'memory' | 'postgres';

function opt(config: Config, key: string): string | undefined {
  if (!config.has(key)) return undefined;
  const v = config.string(key).trim();
  return v === '' ? undefined : v;
}

/**
 * Builds the embedder from configuration (Factory + Strategy):
 *   ai.embeddings.provider   auto (default) | openai | offline
 *   ai.embeddings.api-key    else openai.api.key (env OPENAI_API_KEY)
 *   ai.embeddings.base-url   else openai.base.url (env OPENAI_BASE_URL), else https://api.openai.com/v1
 *   ai.embeddings.model      default text-embedding-3-small
 *   ai.embeddings.dimensions optional
 * 'auto' uses the OpenAI-compatible API when a key is configured, else the offline HashingEmbedder.
 */
export function createEmbedder(config: Config): Embedder {
  const provider = (opt(config, 'ai.embeddings.provider') ?? 'auto').toLowerCase();
  const apiKey = opt(config, 'ai.embeddings.api-key') ?? opt(config, 'openai.api.key');
  const baseUrl = opt(config, 'ai.embeddings.base-url') ?? opt(config, 'openai.base.url') ?? 'https://api.openai.com/v1';
  if (provider === 'offline') return new HashingEmbedder();
  if (provider !== 'auto' && provider !== 'openai') {
    throw new Error(`Unknown ai.embeddings.provider '${provider}': use 'auto', 'openai' or 'offline'.`);
  }
  if (provider === 'auto' && !apiKey) return new HashingEmbedder();
  const dims = opt(config, 'ai.embeddings.dimensions');
  return new OpenAiEmbedder({
    apiKey,
    baseUrl,
    model: opt(config, 'ai.embeddings.model') ?? 'text-embedding-3-small',
    ...(dims ? { dimensions: config.number('ai.embeddings.dimensions') } : {}),
  });
}

/** `ai.store` (or `ai.store.type`): file (default), memory (default for the test profile), postgres. */
export function storeKind(config: Config): AiStoreKind {
  const raw = (opt(config, 'ai.store') ?? opt(config, 'ai.store.type') ?? (config.profile === 'test' ? 'memory' : 'file')).toLowerCase();
  if (raw === 'file' || raw === 'memory') return raw;
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres';
  throw new Error(`Unknown ai.store '${raw}': use 'file', 'memory' or 'postgres'.`);
}

/**
 * Creates the AI module's stores from configuration (Factory). Keys:
 *   ai.store                  file | memory | postgres
 *   ai.store.dir              data/ai (file stores: runs/, threads/, vectors.json)
 *   ai.postgres.url           else database.url (env DATABASE_URL)
 *   ai.postgres.pool-size     default 10
 *   ai.postgres.table-prefix  default amoxi_
 * plus the ai.embeddings.* keys of createEmbedder. PostgreSQL loads the optional `pg` package
 * from the app's node_modules only when selected.
 */
export function createAiStores(config: Config, options: { cwd?: string } = {}): AiStores {
  const cwd = options.cwd ?? process.cwd();
  const embedder = createEmbedder(config);
  const kind = storeKind(config);

  if (kind === 'memory') {
    return { runs: new MemoryRunStore(), conversations: new MemoryConversationStore(), vectors: new LocalVectorStore(), embedder, close: async () => undefined };
  }

  if (kind === 'file') {
    const raw = opt(config, 'ai.store.dir') ?? join('data', 'ai');
    const dir = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const vectors = new LocalVectorStore({ file: join(dir, 'vectors.json') });
    return {
      runs: new FileRunStore(join(dir, 'runs')),
      conversations: new FileConversationStore(join(dir, 'threads')),
      vectors,
      embedder,
      close: () => vectors.flush(),
    };
  }

  const url = opt(config, 'ai.postgres.url') ?? opt(config, 'database.url');
  if (!url) {
    throw new Error('ai.store=postgres needs a connection string: set ai.postgres.url or DATABASE_URL (e.g. postgres://user:pass@localhost:5432/app).');
  }
  // Loaded lazily so apps that don't use PostgreSQL never need `pg`.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { loadPg } = require('../pg/pg-loader') as typeof import('../pg/pg-loader');
  const { PgRunStore } = require('../pg/pg-run-store') as typeof import('../pg/pg-run-store');
  const { PgConversationStore } = require('../pg/pg-conversation-store') as typeof import('../pg/pg-conversation-store');
  const { PgVectorStore } = require('../pg/pg-vector-store') as typeof import('../pg/pg-vector-store');
  const pg = loadPg(cwd);
  const pool = new pg.Pool({ connectionString: url, max: config.number('ai.postgres.pool-size', '10') });
  const tablePrefix = opt(config, 'ai.postgres.table-prefix') ?? 'amoxi_';
  return {
    runs: new PgRunStore({ db: pool, tablePrefix }),
    conversations: new PgConversationStore({ db: pool, tablePrefix }),
    vectors: new PgVectorStore({ db: pool, tablePrefix, ...(embedder.dimensions > 0 ? { dimensions: embedder.dimensions } : {}) }),
    embedder,
    close: () => pool.end(),
  };
}
