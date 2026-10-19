// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Vector math shared by embedders and vector stores. All arithmetic is done in Float64 so
 * scores are stable regardless of how the vectors were stored.
 */

/** Euclidean length of a vector. */
export function norm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** Dot product of two vectors (the shorter length wins if they differ). */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is all zeros (instead of NaN), so a
 * blank text never matches anything.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  const s = ab / (Math.sqrt(aa) * Math.sqrt(bb));
  return s > 1 ? 1 : s < -1 ? -1 : s;
}

/** Returns a unit-length copy of `v` (a zero vector stays all zeros). */
export function l2Normalize(v: ArrayLike<number>): number[] {
  const n = norm(v);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = n === 0 ? 0 : v[i] / n;
  return out;
}
