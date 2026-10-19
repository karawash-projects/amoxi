// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ApplicationContext } from '../../runtime/container';
import { Logger } from '../../runtime/logger';
import type { BeanResolver } from '../../runtime/types';
import { createChatModel } from '../models/factory';
import { createAiStores, type AiStores } from '../stores/factory';
import type { AgentDefinition, AgentMemory, AgentPlatform, ChatModel, ConversationStore, Embedder, RunStore, UiComponentDefinition, VectorStore } from '../types';
import { VectorAgentMemory } from '../vector/agent-memory';
import { KnowledgeBase } from '../vector/knowledge-base';
import { AgentLoop } from './agent-loop';
import { RunEventHub } from './event-hub';
import { DefaultAgentPlatform } from './platform';
import { AgentRunner } from './runner';
import { readAiSettings, type AiSettings } from './settings';
import { ToolCatalog } from './tools';

/**
 * Named knowledge bases (RAG). Inject it to ingest documents, e.g. at startup:
 *
 *   constructor(private readonly knowledge: KnowledgeBases) {}
 *   @PostConstruct() load() { void this.knowledge.get('policies').ingest(POLICIES); }
 */
export class KnowledgeBases {
  private readonly bases = new Map<string, KnowledgeBase>();
  constructor(
    private readonly vectors: () => VectorStore,
    private readonly embedder: () => Embedder,
  ) {}
  get(name: string): KnowledgeBase {
    let kb = this.bases.get(name);
    if (!kb) this.bases.set(name, (kb = new KnowledgeBase(name, this.vectors(), this.embedder())));
    return kb;
  }
}

/** Long-term memory per subject (a person). Inject it to read or seed memories from your own code. */
export class MemoryService {
  constructor(
    private readonly vectors: () => VectorStore,
    private readonly embedder: () => Embedder,
  ) {}
  for(subject: string): AgentMemory {
    const embedder = this.embedder();
    return new VectorAgentMemory(this.vectors(), embedder, VectorAgentMemory.namespace(subject, embedder));
  }
}

export type AiServiceName = 'ChatModel' | 'Embedder' | 'VectorStore' | 'ConversationStore' | 'RunStore' | 'AgentPlatform' | 'KnowledgeBases' | 'MemoryService';

const registry = new WeakMap<ApplicationContext, AiServices>();

/**
 * Composition root of the AI module for one application context. Each service is resolved
 * through the container first, so an app bean implementing ChatModel, VectorStore, RunStore, ...
 * replaces the built-in one everywhere; otherwise the built-in is created from configuration on
 * first use (nothing is created at startup unless it's needed).
 */
export class AiServices {
  readonly settings: AiSettings;
  readonly hub = new RunEventHub();
  private logger: Logger;
  private readonly builtins = new Map<AiServiceName, unknown>();
  private stores?: AiStores;
  private engine?: { platform: DefaultAgentPlatform; runner: AgentRunner };

  private constructor(private readonly context: ApplicationContext) {
    this.settings = readAiSettings(context.config);
    this.logger = new Logger(context.config.string('amoxi.log.level', 'info') as never, context.config.isProduction);
  }

  static of(context: ApplicationContext): AiServices {
    let s = registry.get(context);
    if (!s) registry.set(context, (s = new AiServices(context)));
    return s;
  }

  useLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** The built-in implementation of a service (called by the generated built-in beans). */
  builtin(name: AiServiceName): unknown {
    let value = this.builtins.get(name);
    if (value !== undefined) return value;
    switch (name) {
      case 'ChatModel':
        value = createChatModel(this.context.config, this.logger);
        break;
      case 'Embedder':
        value = this.storeSet().embedder;
        break;
      case 'VectorStore':
        value = this.storeSet().vectors;
        break;
      case 'ConversationStore':
        value = this.storeSet().conversations;
        break;
      case 'RunStore':
        value = this.storeSet().runs;
        break;
      case 'KnowledgeBases':
        value = new KnowledgeBases(() => this.vectors(), () => this.embedder());
        break;
      case 'MemoryService':
        value = new MemoryService(() => this.vectors(), () => this.embedder());
        break;
      case 'AgentPlatform':
        value = this.runtime().platform;
        break;
    }
    this.builtins.set(name, value);
    return value;
  }

  /** The app's bean for a service if it has one, otherwise the built-in. */
  private resolve<T>(name: AiServiceName): T {
    return (this.context.findBean<T>(name) ?? this.builtin(name)) as T;
  }

  chatModel(): ChatModel {
    return this.resolve('ChatModel');
  }
  embedder(): Embedder {
    return this.resolve('Embedder');
  }
  vectors(): VectorStore {
    return this.resolve('VectorStore');
  }
  conversations(): ConversationStore {
    return this.resolve('ConversationStore');
  }
  runs(): RunStore {
    return this.resolve('RunStore');
  }
  knowledge(): KnowledgeBases {
    return this.resolve('KnowledgeBases');
  }
  memory(): MemoryService {
    return this.resolve('MemoryService');
  }
  platform(): AgentPlatform {
    return this.resolve('AgentPlatform');
  }

  /** The agent engine: loop, runner and platform, created on first use. */
  runtime(): { platform: DefaultAgentPlatform; runner: AgentRunner } {
    if (this.engine) return this.engine;
    const ai = this.context.module.ai ?? { tools: [], agents: [], components: [] };
    const agents = new Map<string, AgentDefinition>(ai.agents.map((a) => [a.name, a]));
    const components = new Map<string, UiComponentDefinition>(ai.components.map((c) => [c.name, c]));
    const catalog = new ToolCatalog(ai.tools, ai.components, this.context, () => this.knowledge());
    const runs = this.runs();
    const conversations = this.conversations();
    const loop = new AgentLoop({
      context: this.context,
      runs,
      conversations,
      hub: this.hub,
      model: () => this.chatModel(),
      memory: () => this.memory(),
      catalog,
      agents,
      components,
      settings: this.settings,
      logger: this.logger,
    });
    const runner = new AgentRunner({ runs, loop, settings: this.settings, logger: this.logger, workerId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}` });
    const platform = new DefaultAgentPlatform({
      context: this.context,
      runs,
      conversations,
      hub: this.hub,
      catalog,
      agents,
      runner,
      memory: () => this.memory(),
      settings: this.settings,
      logger: this.logger,
    });
    this.engine = { platform, runner };
    return this.engine;
  }

  async close(): Promise<void> {
    await this.engine?.runner.stop();
    await this.stores?.close();
  }

  private storeSet(): AiStores {
    return (this.stores ??= createAiStores(this.context.config));
  }
}

/** Used by generated code for built-in AI service beans. */
export function $aiService(r: BeanResolver, name: AiServiceName): unknown {
  return AiServices.of(r as unknown as ApplicationContext).builtin(name);
}
