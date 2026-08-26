'use strict';

class RequestCoordinator {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || 5 * 60 * 1000;
    this.maxCompleted = Number(options.maxCompleted) || 100;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.active = new Map();
    this.completed = new Map();
  }

  key(scope, requestId) {
    return `${scope}:${requestId}`;
  }

  prune() {
    const now = this.now();
    for (const [key, cached] of this.completed) {
      if (now - cached.ts > this.ttlMs) this.completed.delete(key);
    }
    while (this.completed.size > this.maxCompleted) {
      this.completed.delete(this.completed.keys().next().value);
    }
  }

  begin(scope, requestId) {
    this.prune();
    const key = this.key(scope, requestId);
    const cached = this.completed.get(key);
    if (cached) return { status: 'completed', key, result: cached.result };
    const active = this.active.get(key);
    if (active) return { status: 'active', key, controller: active };
    const controller = new AbortController();
    this.active.set(key, controller);
    return { status: 'started', key, controller };
  }

  complete(key, result) {
    this.completed.set(key, { ts: this.now(), result });
    this.prune();
    return result;
  }

  release(key) {
    this.active.delete(key);
  }

  cancel(scope, requestId) {
    const controller = this.active.get(this.key(scope, requestId));
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

module.exports = { RequestCoordinator };
