// FILE: src/gemma/circuit-breaker.js
// Per-(key, model) circuit breaker. After N consecutive failures the combo is
// skipped entirely for a cooldown, so a dead key or a broken model does not
// cost a network round-trip on every request. One probe is allowed after the
// cooldown (HALF_OPEN); its outcome decides whether the combo reopens or is
// shut for another cooldown.

export const BREAKER_STATES = Object.freeze({
  CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN',
});

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export class CircuitBreaker {
  constructor({ failureThreshold = DEFAULT_FAILURE_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.circuits = new Map();
  }

  static entryKey(apiKey, model) {
    return `${apiKey}::${model}`;
  }

  entryFor(apiKey, model) {
    const key = CircuitBreaker.entryKey(apiKey, model);
    let entry = this.circuits.get(key);
    if (!entry) {
      entry = { state: BREAKER_STATES.CLOSED, consecutiveFailures: 0, openedAt: 0 };
      this.circuits.set(key, entry);
    }
    return entry;
  }

  /** CLOSED/HALF_OPEN → usable. OPEN → usable only once the cooldown elapsed. */
  isAvailable(apiKey, model, now = Date.now()) {
    const entry = this.entryFor(apiKey, model);
    if (entry.state === BREAKER_STATES.CLOSED) return true;
    if (entry.state === BREAKER_STATES.HALF_OPEN) return true;
    if (now - entry.openedAt >= this.cooldownMs) {
      entry.state = BREAKER_STATES.HALF_OPEN; // let exactly one probe through
      return true;
    }
    return false;
  }

  recordSuccess(apiKey, model) {
    const entry = this.entryFor(apiKey, model);
    entry.state = BREAKER_STATES.CLOSED;
    entry.consecutiveFailures = 0;
    entry.openedAt = 0;
  }

  recordFailure(apiKey, model, now = Date.now()) {
    const entry = this.entryFor(apiKey, model);
    // A failed probe re-opens immediately — the combo is still unhealthy.
    if (entry.state === BREAKER_STATES.HALF_OPEN) {
      entry.consecutiveFailures += 1;
      entry.state = BREAKER_STATES.OPEN;
      entry.openedAt = now;
      return;
    }
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = BREAKER_STATES.OPEN;
      entry.openedAt = now;
    }
  }

  getState(apiKey, model) {
    return this.entryFor(apiKey, model).state;
  }
}

export default CircuitBreaker;
