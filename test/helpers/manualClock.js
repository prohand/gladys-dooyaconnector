// A clock the tests drive: `now()` only moves when told, and the intervals of
// the integration run when `tick()` says so (awaiting their async callbacks).

export function manualClock(start = Date.UTC(2026, 9, 16, 8, 0, 0)) {
  let now = start;
  const intervals = new Map();
  let next = 1;
  return {
    now: () => now,
    setInterval(callback, ms) {
      const id = next++;
      intervals.set(id, { callback, ms, due: now + ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    /** Move the clock by `ms`, running every interval that falls due, in order. */
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...intervals.entries()]
          .filter(([, interval]) => interval.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) {
          break;
        }
        const [id, interval] = due;
        now = Math.max(now, interval.due);
        interval.due += interval.ms;
        await interval.callback();
        if (!intervals.has(id)) {
          continue;
        }
      }
      now = end;
    },
    get pending() {
      return intervals.size;
    },
  };
}
