// Pure scheduling for the site run. Knows nothing about browsers, sites, or
// AI — the same pure/impure seam as paginate vs makePuppeteerDriver, and for
// the same reason: the scheduler has to be testable without a live run.

// Runs `worker(item, index)` over `items`, at most `concurrency` in flight.
// NEVER rejects: every item yields { ok: true, value } or { ok: false, error },
// which is what preserves today's per-iteration try/catch isolation — one site
// blowing up must not abort the run or any sibling.
// Results come back in INPUT order regardless of completion order, so the run
// summary is deterministic even though execution is not.
async function runPool(items, worker, { concurrency = 4 } = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let next = 0;

  // One long-lived slot: pulls the next index and runs it, until the queue is
  // drained. Dispatch is per-slot, NOT per-batch — a fast site must never wait
  // on a slow one, or the speedup collapses to the slowest member of a chunk.
  async function slot() {
    while (next < list.length) {
      const i = next++; // claim the index synchronously, before any await
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, slot));
  return results;
}

// Bounds one task so a hung site costs one slot, not the whole run.
//
// IMPORTANT, and deliberate: this frees the SLOT, it does not abort the WORK.
// The orphaned promise keeps running and closes its own browser in its
// `finally`; the Chrome process may linger for a few seconds past the
// deadline. Truly aborting would mean threading an AbortSignal through the
// driver, the paginate loop, and both custom scrapers — decided against.
function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  if (!(ms > 0)) return p;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });

  // Attach a handler to the orphan so a late rejection — arriving after we
  // have stopped waiting — never becomes an unhandled rejection and kills the run.
  p.catch(() => {});

  // clearTimeout so a fast task does not hold the event loop open to the deadline.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { runPool, withTimeout };
