// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * amoxi/ai: AI agents with compile-time tools, durable long-running runs, token streaming,
 * generative UI, memory and knowledge (RAG), and MCP/A2A servers.
 *
 * Imported only by apps that use it (the generated module adds it when the app has @Agent,
 * @Tool or @generative islands), so apps without AI pay nothing at startup.
 */

// Declaring agents and tools
export { Agent, Tool, type AgentOptions, type ToolOptions } from './decorators';
export * from './types';

// Runtime (used by generated code and by apps that inject these services)
export { aiExtension } from './runtime/extension';
export { AiServices, KnowledgeBases, MemoryService, $aiService, type AiServiceName } from './runtime/services';
export { DefaultAgentPlatform } from './runtime/platform';
export { toChatItems, textOf, sealMessages, type ChatItem } from './runtime/messages';
export { readAiSettings, type AiSettings } from './runtime/settings';
export { publicRun, userOwner } from './runtime/endpoints';

// Chat models
export { AnthropicChatModel, type AnthropicChatModelOptions } from './models/anthropic';
export { OpenAiChatModel, type OpenAiChatModelOptions } from './models/openai';
export { OfflineChatModel } from './models/offline';
export { ScriptedChatModel, type ScriptedTurn } from './models/scripted';
export { createChatModel, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from './models/factory';
export { parseSse } from './models/sse';

// Embeddings, vectors, memory and knowledge
export { HashingEmbedder } from './vector/hashing-embedder';
export { OpenAiEmbedder, type OpenAiEmbedderOptions } from './vector/openai-embedder';
export { LocalVectorStore } from './vector/local-vector-store';
export { VectorAgentMemory } from './vector/agent-memory';
export { KnowledgeBase, chunkText } from './vector/knowledge-base';
export { cosineSimilarity } from './vector/math';

// Conversation and run stores
export { MemoryRunStore } from './stores/memory-run-store';
export { FileRunStore } from './stores/file-run-store';
export { MemoryConversationStore } from './stores/memory-conversation-store';
export { FileConversationStore } from './stores/file-conversation-store';
export { createAiStores, type AiStores } from './stores/factory';

// PostgreSQL / pgvector (the optional `pg` package is loaded only when used)
export { PgVectorStore } from './pg/pg-vector-store';
export { PgRunStore } from './pg/pg-run-store';
export { PgConversationStore } from './pg/pg-conversation-store';
export { loadPg, type PgQueryable } from './pg/pg-loader';

// Protocols for other agents
export { mcpRoutes, type McpOptions, type McpResourceProvider } from './protocols/mcp';
export { a2aRoutes, type A2aOptions } from './protocols/a2a';
