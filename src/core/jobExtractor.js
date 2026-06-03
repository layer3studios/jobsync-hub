// FILE: src/core/jobExtractor.js
// Shared array helpers for ATS extractors.

/**
 * Trim, dedupe (case-insensitive), and drop empty strings from an array.
 */
export function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
