/* ————————————————————————————————————————————————————————————————
   HIKARI JOBS — one queue for all background work.

   Before this, background work was a handful of functions that each
   invented their own rules: prefetchArtPool had a `poolAttempted` Set that
   never retried, queueLiteEnrich had a 3s debounce, fillFranchiseLater had
   nothing, autoScanTick had a 5-minute gate and a `notified` boolean. None
   of them survived a restart, none could be seen, and two of them could run
   at the same time and fight over the AniList rate limiter.

   Everything is a job now: {type, key, payload}. The queue is persistent,
   priority-ordered, deduplicated by key, and drained by ONE worker so the
   limiter sees a single consumer. Handlers are registered by app.js — this
   file knows nothing about anime.

   Loaded before app.js; nothing runs until start() is called.
   ———————————————————————————————————————————————————————————————— */
(() => {
  const STORE = 'hikariJobs.v1';
  const MAX_ATTEMPTS = 4;
  const DONE_KEEP = 40;              // recent history, for the activity panel

  /* Lower number runs first. Anything the user is waiting on outranks
     anything they are not — that distinction is the whole point. */
  const PRIORITY = {
    interactive: 0,                  // user is looking at it right now
    visible: 10,                     // on screen but not blocking
    soon: 20,                        // queued because something changed
    idle: 30                         // housekeeping sweeps
  };

  const handlers = new Map();        // type -> async (payload, job) => void
  const listeners = new Set();

  let queue = [];                    // pending + running
  let history = [];                  // recently finished, newest first
  let running = null;
  let draining = false;
  let started = false;
  let paused = false;
  let timer = null;

  /* —— persistence ————————————————————————————————
     Jobs outlive the window. A sweep interrupted by a quit resumes rather
     than silently never happening, which is how half a library ends up
     without artwork and nobody can say why. */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      queue = (raw.queue || []).filter((j) => j && j.type);
      history = (raw.history || []).slice(0, DONE_KEEP);
      /* anything mid-flight when we died goes back to pending */
      for (const j of queue) if (j.state === 'running') { j.state = 'pending'; j.attempts = (j.attempts || 0); }
    } catch { queue = []; history = []; }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify({
          queue: queue.slice(0, 600),          // a runaway producer must not fill storage
          history: history.slice(0, DONE_KEEP)
        }));
      } catch { /* quota: the queue still works in memory */ }
    }, 400);
  }

  function emit() {
    for (const fn of listeners) { try { fn(snapshot()); } catch {} }
  }
  function snapshot() {
    return {
      running: running ? { ...running } : null,
      pending: queue.filter((j) => j.state === 'pending').length,
      failed: queue.filter((j) => j.state === 'failed').length,
      queue: queue.map((j) => ({ ...j })),
      history: history.map((j) => ({ ...j })),
      paused
    };
  }

  /* —— enqueue ————————————————————————————————————
     `key` is the identity of the WORK, not of the request: asking twice for
     the same show's artwork is one job. A repeat ask at a higher priority
     promotes the existing job instead of duplicating it. */
  function add(type, payload = {}, opts = {}) {
    const key = opts.key || `${type}:${payload.id ?? JSON.stringify(payload)}`;
    const priority = typeof opts.priority === 'number'
      ? opts.priority : (PRIORITY[opts.priority] ?? PRIORITY.soon);
    const existing = queue.find((j) => j.key === key);
    if (existing) {
      if (priority < existing.priority) {
        existing.priority = priority;
        if (existing.state === 'failed') { existing.state = 'pending'; existing.attempts = 0; }
        existing.nextAt = Math.min(existing.nextAt || 0, Date.now());
        save(); emit(); kick();
      }
      return existing.key;
    }
    queue.push({
      key, type, payload, priority,
      label: opts.label || type,
      state: 'pending',
      attempts: 0,
      nextAt: opts.delay ? Date.now() + opts.delay : 0,
      addedAt: Date.now()
    });
    save(); emit(); kick();
    return key;
  }

  const has = (key) => queue.some((j) => j.key === key);
  function drop(key) {
    const i = queue.findIndex((j) => j.key === key);
    if (i >= 0 && queue[i].state !== 'running') { queue.splice(i, 1); save(); emit(); }
  }

  /* —— the worker ————————————————————————————————
     Deliberately one at a time. The AniList limiter is per-IP and shared
     with everything the user does by hand; a pool of workers here would
     just push the user's own actions further down the same queue. */
  function nextJob() {
    const now = Date.now();
    let best = null;
    for (const j of queue) {
      if (j.state !== 'pending') continue;
      if ((j.nextAt || 0) > now) continue;
      if (!handlers.has(j.type)) continue;         // handler not registered yet
      if (!best || j.priority < best.priority
        || (j.priority === best.priority && j.addedAt < best.addedAt)) best = j;
    }
    return best;
  }

  function kick() {
    if (!started || paused || draining) return;
    clearTimeout(timer);
    timer = setTimeout(drain, 0);
  }

  async function drain() {
    if (draining || paused || !started) return;
    draining = true;
    try {
      for (;;) {
        const job = nextJob();
        if (!job) break;
        job.state = 'running';
        job.startedAt = Date.now();
        running = job;
        emit();
        try {
          await handlers.get(job.type)(job.payload, job);
          finish(job, 'done');
        } catch (err) {
          job.attempts = (job.attempts || 0) + 1;
          job.error = (err && err.message) || String(err);
          if (job.attempts >= MAX_ATTEMPTS) {
            finish(job, 'failed', job.error);
          } else {
            /* exponential backoff: a provider having a bad minute should not
               burn all four attempts inside ten seconds */
            job.state = 'pending';
            job.nextAt = Date.now() + Math.min(5 * 60_000, 4000 * 2 ** (job.attempts - 1));
            running = null;
            save(); emit();
          }
        }
        running = null;
      }
    } finally {
      draining = false;
      running = null;
      emit();
      /* something may have become due while we were busy */
      const soonest = queue.filter((j) => j.state === 'pending' && (j.nextAt || 0) > Date.now())
        .reduce((m, j) => Math.min(m, j.nextAt), Infinity);
      if (soonest !== Infinity) {
        clearTimeout(timer);
        timer = setTimeout(drain, Math.max(500, Math.min(soonest - Date.now(), 5 * 60_000)));
      }
    }
  }

  function finish(job, state, error) {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    history.unshift({
      key: job.key, type: job.type, label: job.label, state,
      error: error || null, finishedAt: Date.now(),
      ms: Date.now() - (job.startedAt || Date.now())
    });
    history = history.slice(0, DONE_KEEP);
    save(); emit();
  }

  /* —— control ———————————————————————————————————— */
  function register(type, fn) { handlers.set(type, fn); kick(); }
  function start() { if (started) return; started = true; load(); emit(); kick(); }
  function pause() { paused = true; emit(); }
  function resume() { paused = false; emit(); kick(); }
  function subscribe(fn) { listeners.add(fn); try { fn(snapshot()); } catch {} return () => listeners.delete(fn); }
  function clearFailed() {
    queue = queue.filter((j) => j.state !== 'failed');
    save(); emit();
  }
  function retryFailed() {
    for (const j of queue) if (j.state === 'failed') { j.state = 'pending'; j.attempts = 0; j.nextAt = 0; }
    save(); emit(); kick();
  }

  window.hikariJobs = {
    PRIORITY, add, has, drop, register, start, pause, resume,
    subscribe, snapshot, clearFailed, retryFailed
  };
})();
