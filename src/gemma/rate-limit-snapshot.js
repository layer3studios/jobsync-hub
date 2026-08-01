// FILE: src/gemma/rate-limit-snapshot.js
// Formats a RateLimitTracker's in-memory state for the admin dashboard,
// grouped model → keys. Split out of the tracker for file size.
//
// KEY SECRECY: the output carries a key's INDEX in the configured list, never
// the key itself. An unknown key (rotated out of the list mid-process) reports
// index -1 rather than leaking its value.

export function buildUsageSnapshot(tracker, keys = [], now = Date.now()) {
  const indexByKey = new Map(keys.map((key, index) => [key, index]));
  const byModel = new Map();

  for (const entryKey of tracker.usage.keys()) {
    const separator = entryKey.indexOf('::');
    const apiKey = entryKey.slice(0, separator);
    const model = entryKey.slice(separator + 2);
    if (!byModel.has(model)) byModel.set(model, []);

    const usage = tracker.getUsage(apiKey, model, now);
    const effective = tracker.effectiveLimits(model);
    byModel.get(model).push({
      keyIndex: indexByKey.has(apiKey) ? indexByKey.get(apiKey) : -1,
      rpm: { used: usage.rpm.used, limit: effective.rpm },
      rpd: { used: usage.rpd.used, limit: effective.rpd },
      tpm: { used: usage.tpm.used, limit: effective.tpm },
      exhausted: !tracker.canMakeRequest(apiKey, model, now),
    });
  }

  return {
    models: [...byModel.entries()].map(([model, keyRows]) => ({
      model, keys: keyRows.sort((a, b) => a.keyIndex - b.keyIndex),
    })),
  };
}

export default buildUsageSnapshot;
