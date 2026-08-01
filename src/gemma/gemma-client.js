// FILE: src/gemma/gemma-client.js
// HTTP client for Google AI Studio's Gemini-compatible generateContent endpoint.
// Rotates keys per call, backs off on 429, blacklists invalid keys, and retries
// transient 5xx once (R3). Gemma 4 is a reasoning model: response parts flagged
// thought:true are chain-of-thought and are filtered out — we return the last
// non-thought part's text (R1). fetchFn is injectable so tests never hit HTTP.

export class GemmaApiError extends Error {
  constructor(status, body, isRetryable = false) {
    super(`Gemma API error ${status}`);
    this.name = 'GemmaApiError';
    this.status = status;
    this.body = body;
    this.isRetryable = isRetryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GemmaClient {
  constructor({ keyManager, model, baseUrl, fetchFn } = {}) {
    this.keyManager = keyManager;
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  buildBody(systemInstruction, userMessage, { temperature = 0.1, responseMimeType = 'application/json' } = {}) {
    return {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { temperature, responseMimeType },
    };
  }

  static readText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return '';
    const answers = parts.filter((p) => p && p.thought !== true && typeof p.text === 'string');
    const last = answers[answers.length - 1];
    return last ? last.text : '';
  }

  /**
   * opts.model / opts.apiKey let a caller (the ModelCascade) drive the exact
   * model+key for this one call. When apiKey is given the cascade owns the
   * retry/rotation policy, so this method makes a SINGLE attempt and lets the
   * error propagate — retrying here would double-spend the cascade's budget.
   */
  async generateContent(systemInstruction, userMessage, opts = {}) {
    const model = opts.model || this.model;
    const pinnedKey = opts.apiKey || null;
    const maxRetries = pinnedKey ? 0 : (opts.maxRetries ?? 3);
    const body = this.buildBody(systemInstruction, userMessage, opts);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const key = pinnedKey || this.keyManager.getNextKey();
      if (!key) throw new GemmaApiError(0, 'No live Gemma API keys');

      const url = `${this.baseUrl}/models/${model}:generateContent?key=${key}`;
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) return GemmaClient.readText(await response.json());

      const text = await response.text().catch(() => '');
      // Pinned-key mode: surface everything so the cascade can classify it.
      if (pinnedKey) throw new GemmaApiError(response.status, text, response.status >= 500);
      if (response.status === 429) {
        await sleep(2 ** attempt * 1000 + Math.floor(Math.random() * 250));
        continue; // rotate to the next key and retry
      }
      if (response.status === 400 && /api key not valid/i.test(text)) {
        this.keyManager.blacklistKey(key);
        continue; // rotate to a surviving key and retry
      }
      if (response.status === 400) throw new GemmaApiError(400, text, false);
      if (response.status === 500 || response.status === 503) {
        if (attempt >= maxRetries) throw new GemmaApiError(response.status, text, true);
        await sleep(2000);
        continue;
      }
      throw new GemmaApiError(response.status, text, false);
    }
    throw new GemmaApiError(429, 'Gemma retries exhausted', true);
  }
}

export default GemmaClient;
