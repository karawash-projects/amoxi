// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Embedder } from '../types';
import { l2Normalize } from './math';

/** Bounds the work per text: longer inputs are truncated (enough for any chunk or memory). */
const MAX_CHARS = 100_000;

/** 32-bit FNV-1a hash of a string. */
function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Offline, deterministic embedder (feature hashing, "the hashing trick"): lower-cased word
 * unigrams, word bigrams and character trigrams are hashed into `dims` buckets with a signed
 * hash (to cancel collisions on average), weighted by sublinear term frequency (1 + ln tf), and
 * the vector is L2-normalised.
 *
 * It needs no network or API key, so agents with memory and knowledge bases work out of the box
 * and in tests. It captures lexical overlap (shared words and word fragments such as
 * "reset"/"resetting"), not meaning: configure an OpenAI-compatible embedder for semantic search.
 */
export class HashingEmbedder implements Embedder {
  readonly model = 'amoxi-hashing-v1';
  readonly dimensions: number;

  constructor(options: { dims?: number } = {}) {
    const dims = options.dims ?? 512;
    if (!Number.isInteger(dims) || dims < 8 || dims > 65_536) {
      throw new RangeError(`HashingEmbedder dims must be an integer between 8 and 65536, got ${dims}`);
    }
    this.dimensions = dims;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    return texts.map((t) => this.embedOne(t));
  }

  /** Synchronous variant for callers that don't need a Promise. */
  embedOne(text: string): number[] {
    const counts = new Map<string, number>();
    const add = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);
    const lower = String(text ?? '').slice(0, MAX_CHARS).toLowerCase();
    const words = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (let i = 0; i < words.length; i++) {
      add(`w:${words[i]}`);
      if (i + 1 < words.length) add(`b:${words[i]} ${words[i + 1]}`);
      // Character trigrams of the padded word give partial credit to inflections and typos.
      const padded = ` ${words[i]} `;
      for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`);
    }
    const vec = new Float64Array(this.dimensions);
    for (const [feature, tf] of counts) {
      // Word features weigh more than character fragments.
      const kind = feature.charCodeAt(0);
      const weight = (kind === 0x63 /* c */ ? 0.5 : 1) * (1 + Math.log(tf));
      const h = fnv1a(feature, 0);
      const sign = fnv1a(feature, 0x9e3779b9) & 1 ? 1 : -1;
      vec[h % this.dimensions] += sign * weight;
    }
    return l2Normalize(vec);
  }
}
