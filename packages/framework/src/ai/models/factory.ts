// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { ConfigurationError, type Config } from '../../runtime/config';
import type { Logger } from '../../runtime/logger';
import type { ChatModel } from '../types';
import { AnthropicChatModel } from './anthropic';
import { OfflineChatModel } from './offline';
import { OpenAiChatModel } from './openai';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

const PROVIDERS = ['auto', 'anthropic', 'openai', 'offline'] as const;
type Provider = (typeof PROVIDERS)[number];

/** A non-empty, trimmed config string, or undefined. */
function opt(config: Config, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (config.has(key)) {
      const v = config.string(key).trim();
      if (v !== '') return v;
    }
  }
  return undefined;
}

function optNumber(config: Config, key: string): number | undefined {
  return config.has(key) && config.string(key).trim() !== '' ? config.number(key) : undefined;
}

/**
 * Chooses and builds the chat model from configuration (Factory + Strategy).
 *
 * `ai.provider`: 'auto' (default) picks Anthropic when an Anthropic key is set, else an
 * OpenAI-compatible server when an OpenAI key (or an explicit base URL, e.g. local Ollama) is
 * set, else the offline demo model. In the 'test' profile 'auto' always means offline, so tests
 * never call paid APIs. Keys are never logged.
 */
export function createChatModel(config: Config, logger?: Logger): ChatModel {
  const raw = (opt(config, 'ai.provider') ?? 'auto').toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(raw)) {
    throw new ConfigurationError(`Unknown ai.provider '${raw}': use one of ${PROVIDERS.join(', ')}.`);
  }
  let provider = raw as Provider;
  const isTest = config.profile === 'test';

  const anthropicKey = opt(config, 'ai.anthropic.api-key', 'anthropic.api.key');
  const openaiKey = opt(config, 'ai.openai.api-key', 'openai.api.key');
  const openaiBaseUrl = opt(config, 'ai.openai.base-url', 'openai.base.url');

  if (provider === 'auto') {
    if (isTest) provider = 'offline';
    else if (anthropicKey) provider = 'anthropic';
    else if (openaiKey || openaiBaseUrl) provider = 'openai';
    else provider = 'offline';
  }

  const maxTokens = optNumber(config, 'ai.max-tokens') ?? 4096;
  const temperature = optNumber(config, 'ai.temperature');
  const timeoutMs = optNumber(config, 'ai.timeout-ms') ?? 120_000;
  const maxRetries = optNumber(config, 'ai.max-retries') ?? 2;

  if (provider === 'anthropic') {
    if (!anthropicKey) {
      throw new ConfigurationError(
        "ai.provider is 'anthropic' but no API key is configured: set ANTHROPIC_API_KEY in .env (or ai.anthropic.api-key in application.json).",
      );
    }
    const model = opt(config, 'ai.anthropic.model') ?? DEFAULT_ANTHROPIC_MODEL;
    logger?.info(`AI provider: anthropic (${model})`);
    return new AnthropicChatModel({
      apiKey: anthropicKey,
      model,
      baseUrl: opt(config, 'ai.anthropic.base-url'),
      maxTokens,
      temperature,
      timeoutMs,
      maxRetries,
    });
  }

  if (provider === 'openai') {
    if (!openaiKey && !openaiBaseUrl) {
      throw new ConfigurationError(
        "ai.provider is 'openai' but no API key is configured: set OPENAI_API_KEY in .env (or ai.openai.api-key), " +
          'or set OPENAI_BASE_URL (ai.openai.base-url) to a local OpenAI-compatible server such as Ollama.',
      );
    }
    const model = opt(config, 'ai.openai.model') ?? DEFAULT_OPENAI_MODEL;
    const baseUrl = openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
    logger?.info(`AI provider: openai (${model})${baseUrl !== DEFAULT_OPENAI_BASE_URL ? ` at ${safeOrigin(baseUrl)}` : ''}`);
    return new OpenAiChatModel({ apiKey: openaiKey, model, baseUrl, maxTokens, temperature, timeoutMs, maxRetries });
  }

  const delayMs = optNumber(config, 'ai.offline.delay-ms') ?? (isTest ? 0 : 15);
  logger?.info('AI provider: offline demo model (set ANTHROPIC_API_KEY or OPENAI_API_KEY to use a real model)');
  return new OfflineChatModel({ delayMs });
}

/** Origin only: a base URL may carry credentials or query tokens that must not be logged. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid URL)';
  }
}
