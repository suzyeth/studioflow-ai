// Minimal in-process job queue.
//
// This is the seam that Pub/Sub or Cloud Tasks replaces. The contract the rest of
// the code depends on is narrow on purpose: enqueue a job, it runs later, one at a
// time, and a failure is reported rather than thrown into whoever pushed it.
function createJobQueue({ onError } = {}) {
  const pending = [];
  let draining = false;
  let processed = 0;

  async function drain() {
    if (draining) return;
    draining = true;

    while (pending.length > 0) {
      const job = pending.shift();
      try {
        await job();
      } catch (error) {
        // A failed job must not stop the queue or crash the process.
        if (onError) onError(error);
      }
      processed += 1;
    }

    draining = false;
  }

  return {
    push(job) {
      pending.push(job);
      // Start on the next tick so the caller can respond before work begins.
      setImmediate(drain);
    },
    get depth() {
      return pending.length;
    },
    get processed() {
      return processed;
    },
    get busy() {
      return draining;
    },
    // Test helper: resolve once the queue has gone idle.
    async idle() {
      while (draining || pending.length > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

module.exports = { createJobQueue };
