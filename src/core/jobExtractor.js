/**
 * jobExtractor.js — shared helpers for ATS config extractors.
 */

/**
 * Deduplicate and clean an array of strings.
 * Filters out nulls, empty strings, trims whitespace, removes exact dupes.
 */
export function normalizeArray(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const result = [];
    for (const item of arr) {
        if (item == null) continue;
        const trimmed = String(item).trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}
