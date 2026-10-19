// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Attributes whose value is a URL the browser loads or navigates to. A script URL there
 * (`<a href="javascript:...">`) runs code when used, so values with an unsafe scheme are dropped.
 */
export const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'background', 'ping', 'data', 'codebase', 'manifest']);

const UNSAFE_SCHEME = /^(?:javascript|vbscript|data|file):/i;

/**
 * True for URLs that run script or reach local files: javascript:, vbscript:, file: and data:
 * (except data:image/..., which `allowDataImages` permits for images). Browsers ignore control
 * characters and whitespace inside the scheme, so they are ignored here too.
 */
export function isUnsafeUrl(value: string, allowDataImages = false): boolean {
  const compact = value.replace(/[\u0000- \u007f]/g, '');
  if (!UNSAFE_SCHEME.test(compact)) return false;
  return !(allowDataImages && /^data:image\//i.test(compact));
}
