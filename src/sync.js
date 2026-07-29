/* ————————————————————————————————————————————————————————————————
   HIKARI SYNC — Supabase account sync (library + settings)
   Loads after app.js. Everything is a no-op until the user signs in.

   Model: one cloud row per library record, keyed (user_id, media_id).
   Push  = hash-diff against last-known cloud state, debounced 4s after
           any persist(). Deletes propagate (row removed remotely).
   Pull  = manifest diff (media_id + updated_at only), then fetch just
           the changed rows. Merge is remote-wins EXCEPT: watched lists
           union (a sync can never un-tick an episode), and device-local
           fields (local file maps, resume positions) are preserved.
   Live  = realtime postgres_changes on the user's rows; other devices'
           edits apply within a second or two.
   ———————————————————————————————————————————————————————————————— */
(() => {
  const CFG = window.HIKARI_SYNC;
  if (!CFG || !window.supabase) {
    window.syncUI = { fill() {
      const so = document.getElementById('syncSignedOut');
      if (so) so.innerHTML = '<p class="set-hint">Sync is not configured in this build.</p>';
    } };
    return;
  }

  const supa = window.supabase.createClient(CFG.url, CFG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  /* —— state ———————————————————————————————————— */
  let user = null;              // supabase user object
  let meta = {};                // mediaId -> { h: contentHash, t: updated_at } (last known cloud state)
  let applying = false;         // true while writing remote changes into `library`
  let pushTimer = null;
  let pullTimer = null;
  let channel = null;
  let busy = false;
  let online = true;            // false after a failed push/pull until the next success
  let renderTimer = null;

  const K = (s) => `hikariSync.${s}.${user?.id || 'anon'}`;
  const loadMeta = () => { try { meta = JSON.parse(localStorage.getItem(K('meta'))) || {}; } catch { meta = {}; } };
  const saveMeta = () => { try { localStorage.setItem(K('meta'), JSON.stringify(meta)); } catch {} };
  const lastSyncAt = () => Number(localStorage.getItem(K('last')) || 0);
  const stampSync = () => { localStorage.setItem(K('last'), String(Date.now())); syncPill(); };

  /* `K()` is keyed on the signed-in user, so once the session dies there is
     no way to look up how long this machine has been adrift. Remember the
     account separately for exactly that. */
  const ACCT = 'hikariSync.lastAccount';
  const lastSyncFor = (uid) => Number(localStorage.getItem(`hikariSync.last.${uid || 'anon'}`) || 0);
  /* Machines that synced before this key existed still have their per-account
     `hikariSync.last.<uid>` entries, so recover the account from those rather
     than treating an upgraded install as one that never signed in — otherwise
     the warning below stays invisible on exactly the machines that need it. */
  function lastAccount() {
    const known = localStorage.getItem(ACCT);
    if (known) return known;
    let best = '', bestT = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      const m = k.match(/^hikariSync\.last\.([0-9a-f-]{36})$/);
      if (!m) continue;
      const t = Number(localStorage.getItem(k) || 0);
      if (t > bestT) { bestT = t; best = m[1]; }
    }
    if (best) localStorage.setItem(ACCT, best);
    return best;
  }

  /* —— tombstones ————————————————————————————————
     A row missing from the cloud used to mean "deleted, remove it locally",
     and a record missing from `library` used to mean "deleted, remove it
     from the cloud". Both are wrong: they are equally consistent with a
     stale reader or a partial load, and one such device silently deleted 41
     shows from the account. Absence is now never authoritative — only an
     explicit tombstone is. They live in the settings row (already shared and
     merged by both apps) so no schema change is needed. */
  const TOMB_CAP = 800;
  /* 3.0.2-3.0.4 tombstoned folded members, which are not deletions at all.
     Those are now poison: they tell every device to drop shows that were
     only consolidated. Discard the whole set once, locally and in the cloud,
     rather than trying to tell good tombstones from bad ones. */
  const TOMB_V = '2';
  let tombPurge = false;
  let tombs = {};               // mediaId -> deletion timestamp (ms)
  const loadTombs = () => {
    if (localStorage.getItem('hikariSync.tombV') !== TOMB_V) {
      tombs = {}; tombPurge = true;
      try { localStorage.removeItem(K('tomb')); } catch {}
      return;
    }
    try { tombs = JSON.parse(localStorage.getItem(K('tomb'))) || {}; } catch { tombs = {}; }
  };
  const saveTombs = () => {
    const ids = Object.keys(tombs).sort((a, b) => tombs[b] - tombs[a]).slice(0, TOMB_CAP);
    tombs = Object.fromEntries(ids.map((id) => [id, tombs[id]]));
    try { localStorage.setItem(K('tomb'), JSON.stringify(tombs)); } catch {}
  };
  function markDeleted(ids) {
    const now = Date.now();
    for (const id of [].concat(ids)) if (Number.isFinite(Number(id))) tombs[Number(id)] = now;
    saveTombs();
    schedulePush();
  }

  /* —— hashing / record shaping ————————————————— */
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + s.length;
  }
  /* jsonb does not preserve key order, so hashes must be order-independent —
     otherwise every realtime echo of our own push looks like a foreign change */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) =>
      v[k] === undefined ? '' : JSON.stringify(k) + ':' + stableStringify(v[k]))
      .filter(Boolean).join(',') + '}';
  }
  /* what goes to the cloud: everything except device-local file paths */
  function cloudRecord(r) {
    const { local, ...rest } = r;
    return rest;
  }
  const recHash = (r) => hash(stableStringify(cloudRecord(r)));

  /* settings that sync (media folder paths are per-device) */
  function cloudSettings() {
    const { mediaRoots, ...rest } = appSettings || {};
    return rest;
  }

  /* —— merge: remote row -> local library ————————— */
  function unionWatched(a = {}, b = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])].sort((x, y) => x - y);
    }
    return out;
  }
  /* returns true if the local library actually changed */
  /* consolidateLibrary() folds duplicate seasons into their group root and
     keeps the member as root.peek[id]. It is still in the library, just not
     as its own record — so it must not be re-added as one, or every pull
     would restore it and the next consolidate would fold it out again. */
  const isPeeked = (id) => library.some((r) => r.peek && r.peek[id]);

  function applyRemoteRecord(mediaId, remote, updatedAt) {
    if (isPeeked(mediaId)) { meta[mediaId] = { h: recHash(remote), t: updatedAt }; return false; }
    const idx = library.findIndex((r) => r.id === mediaId);
    const incoming = { ...remote };
    if (idx >= 0) {
      const cur = library[idx];
      if (recHash(cur) === recHash(incoming)) {
        meta[mediaId] = { h: recHash(cur), t: updatedAt };
        return false;
      }
      incoming.watched = unionWatched(cur.watched, incoming.watched);
      if (cur.local) incoming.local = cur.local;                     // device-local files stay
      incoming.playPos = { ...(incoming.playPos || {}), ...(cur.playPos || {}) };
      library[idx] = incoming;
    } else {
      library.push(incoming);
    }
    meta[mediaId] = { h: recHash(incoming), t: updatedAt };
    queueLiteEnrich(incoming);
    return true;
  }

  /* —— finish mobile adds ———————————————————————
     Phone adds are AniList-lite (epv 0, no franchise map). This machine
     owns the full pipeline, so the moment a lite record arrives — realtime
     or pull — enrich it here and push the finished version back. */
  const liteQueue = new Set();
  let liteRunning = false;
  const isLite = (r) => r && ((r.epv || 0) < 1 || !('franchise' in r));
  function queueLiteEnrich(rec) {
    if (!isLite(rec)) return;
    liteQueue.add(rec.id);
    clearTimeout(queueLiteEnrich._t);
    queueLiteEnrich._t = setTimeout(runLiteEnrich, 3000);
  }
  async function runLiteEnrich() {
    if (liteRunning || !user) return;
    liteRunning = true;
    try {
      for (const id of [...liteQueue]) {
        liteQueue.delete(id);
        const rec = library.find((r) => r.id === id);
        if (!isLite(rec)) continue;                  // finished meanwhile
        try {
          const fresh = await refreshRoot(rec);      // full pipeline + carry + persist(→push)
          toast(`${fresh.title} — seasons & episodes filled in`);
          const active = document.querySelector('.screen.active')?.id;
          if (active === 'screen-shelf') renderShelf();
          else if (active === 'screen-detail' && detailId === id) renderDetail();
          updateChrome();
        } catch (e) {
          console.warn('[sync] lite enrich failed for', id, e.message || e);
        }
      }
    } finally {
      liteRunning = false;
      if (liteQueue.size) setTimeout(runLiteEnrich, 5000);
    }
  }
  function scanLiteRecords() {
    for (const r of library) queueLiteEnrich(r);
  }
  function applyRemoteDelete(mediaId) {
    const idx = library.findIndex((r) => r.id === mediaId);
    delete meta[mediaId];
    if (idx < 0) return false;
    library.splice(idx, 1);
    return true;
  }
  function afterApply(changed) {
    if (!changed) { saveMeta(); return; }
    applying = true;
    try { persist(); } finally { applying = false; }
    saveMeta();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      const active = document.querySelector('.screen.active')?.id;
      if (active === 'screen-shelf') renderShelf();
      else if (active === 'screen-detail' && detailId != null &&
               library.some((r) => r.id === detailId)) renderDetail();
      else if (active === 'screen-detail' && detailId != null &&
               !library.some((r) => r.id === detailId)) location.hash = '', renderShelf();
      updateChrome();
    }, 350);
  }

  /* —— push ———————————————————————————————————— */
  function schedulePush() {
    if (!user || applying) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushChanges().catch(() => {}), 4000);
    syncPill('pending');
  }

  async function pushChanges() {
    if (!user || busy) return;
    busy = true; syncPill('busy');
    try {
      const now = new Date().toISOString();
      const seen = new Set();
      const ups = [];
      for (const r of library) {
        const id = Number(r.id);
        if (!Number.isFinite(id)) continue;
        seen.add(id);
        const h = recHash(r);
        if (meta[id]?.h === h) continue;
        ups.push({ user_id: user.id, media_id: id, record: cloudRecord(r), updated_at: now, _h: h });
      }
      /* Only tombstoned ids may be deleted from the cloud. Anything else we
         hold a sync ledger entry for but no record is this device being out
         of date — forget the ledger entry so the next pull brings it back. */
      const orphans = Object.keys(meta).map(Number)
        .filter((id) => !seen.has(id) && !isPeeked(id));
      const gone = orphans.filter((id) => tombs[id]);
      const stale = orphans.filter((id) => !tombs[id]);
      if (stale.length) {
        console.warn(`[sync] ${stale.length} record(s) missing locally but never deleted — re-pulling instead of deleting remotely`);
        for (const id of stale) delete meta[id];
        saveMeta();
        setTimeout(() => pullChanges().catch(() => {}), 1500);
      }

      /* chunk by payload size — episode lists make some records heavy */
      let chunk = [], size = 0;
      const chunks = [];
      for (const u of ups) {
        const s = JSON.stringify(u.record).length;
        if (chunk.length && (size + s > 700_000 || chunk.length >= 20)) { chunks.push(chunk); chunk = []; size = 0; }
        chunk.push(u); size += s;
      }
      if (chunk.length) chunks.push(chunk);

      for (const c of chunks) {
        const { error } = await supa.from('library')
          .upsert(c.map(({ _h, ...row }) => row), { onConflict: 'user_id,media_id' });
        if (error) throw error;
        for (const u of c) meta[u.media_id] = { h: u._h, t: now };
        saveMeta();
      }
      if (gone.length) {
        const { error } = await supa.from('library').delete()
          .eq('user_id', user.id).in('media_id', gone);
        if (error) throw error;
        for (const id of gone) delete meta[id];
        saveMeta();
      }

      /* Settings (minus device paths) — only when their hash moved.

         Re-read and MERGE first: the phone can set API keys too, and blindly
         upserting this app's copy would wipe a key added there minutes ago.
         Remote wins for anything we don't currently hold a value for. */
      const sh = hash(stableStringify({ ...cloudSettings(), tombstones: tombs }));
      if (localStorage.getItem(K('setH')) !== sh) {
        const { data: cur } = await supa.from('settings')
          .select('data').eq('user_id', user.id).maybeSingle();
        const mine = cloudSettings();
        const merged = { ...(cur?.data || {}), ...mine };
        /* tombstones are a union, never a replacement — the other device's
           deletions must survive ours */
        const bothTombs = tombPurge ? {} : { ...(cur?.data?.tombstones || {}) };
        for (const [id, t] of Object.entries(tombs)) {
          if (!bothTombs[id] || bothTombs[id] < t) bothTombs[id] = t;
        }
        merged.tombstones = bothTombs;
        Object.assign(tombs, bothTombs); saveTombs();
        if (tombPurge) {
          tombPurge = false;
          localStorage.setItem('hikariSync.tombV', TOMB_V);
          console.info('[sync] cleared tombstones written by 3.0.2-3.0.4');
        }
        for (const k of ['tmdbKey', 'fanartKey', 'traceKey']) {
          if (!mine[k] && cur?.data?.[k]) merged[k] = cur.data[k];   // don't delete theirs
        }
        const { error } = await supa.from('settings')
          .upsert({ user_id: user.id, data: merged, updated_at: now });
        if (error) throw error;
        localStorage.setItem(K('setH'), sh);
      }

      online = true;
      if (ups.length || gone.length) stampSync(); else syncPill();
    } catch (e) {
      online = false; syncPill();
      console.warn('[sync] push failed:', e.message || e);
    } finally { busy = false; }
  }

  /* —— pull ———————————————————————————————————— */
  async function pullChanges({ full = false } = {}) {
    if (!user || busy) return 0;
    busy = true; syncPill('busy');
    let applied = 0;
    try {
      const { data: manifest, error } = await supa.from('library')
        .select('media_id,updated_at').eq('user_id', user.id);
      if (error) throw error;

      const remoteIds = new Set();
      const want = [];
      for (const row of manifest || []) {
        remoteIds.add(row.media_id);
        if (full || !meta[row.media_id] || meta[row.media_id].t !== row.updated_at) want.push(row.media_id);
      }
      for (let i = 0; i < want.length; i += 25) {
        const { data: rows, error: e2 } = await supa.from('library')
          .select('media_id,record,updated_at')
          .eq('user_id', user.id).in('media_id', want.slice(i, i + 25));
        if (e2) throw e2;
        for (const row of rows || []) {
          if (applyRemoteRecord(row.media_id, row.record, row.updated_at)) applied++;
        }
      }
      /* settings — read before reconciling deletions, because the tombstone
         list rides along in this row */
      const { data: srow } = await supa.from('settings')
        .select('data').eq('user_id', user.id).maybeSingle();
      if (srow?.data) {
        const { tombstones, ...remoteSettings } = srow.data;
        if (!tombPurge) {
          for (const [id, t] of Object.entries(tombstones || {})) {
            if (!tombs[id] || tombs[id] < t) tombs[id] = t;
          }
          saveTombs();
        }
        const merged = { ...appSettings, ...remoteSettings, mediaRoots: appSettings.mediaRoots };
        if (JSON.stringify(merged) !== JSON.stringify(appSettings)) {
          appSettings = merged;
          window.hikari.saveSettings(appSettings).catch(() => {});
        }
        localStorage.setItem(K('setH'), hash(stableStringify({ ...cloudSettings(), tombstones: tombs })));
      }

      /* A row we hold that the cloud does not is a deletion ONLY if somebody
         tombstoned it. Otherwise the cloud is the one missing data — most
         likely because an out-of-date device pushed a delete — so put it
         back rather than destroying our copy. */
      const missing = library.filter((r) => Number.isFinite(Number(r.id))
        && !remoteIds.has(Number(r.id)) && !isPeeked(Number(r.id)));
      const deleted = missing.filter((r) => tombs[r.id]);
      const orphaned = missing.filter((r) => !tombs[r.id]);
      for (const r of deleted) if (applyRemoteDelete(Number(r.id))) applied++;
      for (const id of Object.keys(meta).map(Number)) {
        if (!remoteIds.has(id) && tombs[id]) { delete meta[id]; }
      }
      if (orphaned.length) {
        console.warn(`[sync] ${orphaned.length} local record(s) absent from the cloud and not deleted — re-uploading`);
        for (const r of orphaned) delete meta[r.id];   // clear the hash so the push re-sends them
        saveMeta();
        schedulePush();
      }

      online = true;
    } catch (e) {
      online = false;
      console.warn('[sync] pull failed:', e.message || e);
    } finally {
      busy = false;
      afterApply(applied > 0);
      syncPill();
    }
    return applied;
  }

  async function fullSync(silent = false) {
    if (!user) return;
    const applied = await pullChanges();
    await pushChanges();
    stampSync();
    fillTab();
    if (!silent) toast(applied ? `Synced — ${applied} update${applied === 1 ? '' : 's'} applied` : 'Synced — up to date');
  }

  /* —— realtime ————————————————————————————————— */
  function subscribe() {
    unsubscribe();
    channel = supa.channel('library-live')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'library', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (busy) return;                          // our own batch is in flight
          let changed = false;
          if (payload.eventType === 'DELETE') {
            const id = payload.old?.media_id;
            if (id != null && meta[id]) changed = applyRemoteDelete(Number(id));
          } else {
            const row = payload.new;
            if (!row) return;
            if (meta[row.media_id]?.h === recHash(row.record)) {      // our own echo
              meta[row.media_id].t = row.updated_at; saveMeta();
              return;
            }
            changed = applyRemoteRecord(row.media_id, row.record, row.updated_at);
          }
          if (changed) { afterApply(true); stampSync(); }
        })
      .subscribe();
  }
  function unsubscribe() {
    if (channel) { supa.removeChannel(channel); channel = null; }
  }

  /* —— statusbar pill ———————————————————————————— */
  function syncPill(state) {
    const pill = document.getElementById('sb-sync');
    const txt = document.getElementById('sb-sync-txt');
    if (!pill) return;
    /* A dead session used to hide this pill outright, so the app looked
       exactly like a healthy signed-out one while quietly not syncing —
       an expired token went unnoticed for a day and a half that way, and
       36 hours of additions never reached the account. If this machine has
       ever synced, say so loudly instead of going quiet. */
    if (!user) {
      const t = lastSyncFor(lastAccount());
      if (!t) { pill.hidden = true; return; }        // never synced: nothing to warn about
      pill.hidden = false;
      pill.classList.add('warn');
      const hrs = Math.floor((Date.now() - t) / 3600000);
      txt.textContent = hrs >= 24 ? `NOT SYNCING — ${Math.floor(hrs / 24)}d BEHIND`
        : hrs >= 1 ? `NOT SYNCING — ${hrs}h BEHIND` : 'NOT SYNCING';
      pill.title = 'Signed out of your account — open Settings to sign back in';
      sessionBanner();
      return;
    }
    sessionBanner();
    pill.hidden = false;
    pill.classList.toggle('warn', !online);
    if (state === 'busy') txt.textContent = 'SYNCING…';
    else if (state === 'pending') txt.textContent = 'SYNC ·';
    else if (!online) txt.textContent = 'SYNC OFFLINE';
    else {
      const t = lastSyncAt();
      txt.textContent = t ? `SYNCED ${new Date(t).toTimeString().slice(0, 5)}` : 'SYNCED';
    }
  }

  /* —— signed-out banner ————————————————————————
     Unlike the phone, this app does not gate on sign-in: the library lives
     on disk and working offline is legitimate. That makes a DEAD session
     indistinguishable from a deliberate one, which is how 36 hours of
     additions quietly failed to reach the account. So warn only in the case
     that is actually a fault — a machine that has synced before and now
     cannot — and keep it dismissible, because offline is still allowed. */
  let bannerOff = false;
  function sessionBanner() {
    const stale = !user && !!lastSyncFor(lastAccount());
    let el = document.getElementById('sync-banner');
    if (!stale || bannerOff) { el?.remove(); return; }
    if (el) return;
    const when = new Date(lastSyncFor(lastAccount()));
    const hrs = Math.floor((Date.now() - when.getTime()) / 3600000);
    const ago = hrs >= 24 ? `${Math.floor(hrs / 24)} day${hrs >= 48 ? 's' : ''}`
      : hrs >= 1 ? `${hrs} hour${hrs > 1 ? 's' : ''}` : 'a few minutes';
    el = document.createElement('div');
    el.id = 'sync-banner';
    el.innerHTML = `<span class="sb-i">!</span>
      <span class="sb-m"><b>Not syncing.</b> You're signed out of your account —
      nothing has reached your other devices for ${esc(ago)}
      (last sync ${esc(when.toLocaleString())}).</span>
      <button class="sb-go" data-action="sync-banner-signin">Sign in</button>
      <button class="sb-x" data-action="sync-banner-hide" aria-label="Dismiss">&times;</button>`;
    document.body.appendChild(el);
  }

  /* —— settings tab ————————————————————————————— */
  function fillTab() {
    const so = document.getElementById('syncSignedOut');
    const si = document.getElementById('syncSignedIn');
    if (!so || !si) return;
    so.hidden = !!user;
    si.hidden = !user;
    if (!user) return;
    document.getElementById('syncWho').textContent = user.email || user.id;
    const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`;
    const t = lastSyncAt();
    document.getElementById('syncStats').innerHTML = [
      kv('Status', online ? 'Connected' : 'Offline — will retry'),
      kv('Live updates', channel ? 'On' : 'Off'),
      kv('Records tracked', Object.keys(meta).length),
      kv('Last synced', t ? new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'never')
    ].join('');
  }

  async function doAuth(kind) {
    const email = document.getElementById('syncEmail').value.trim();
    const pass = document.getElementById('syncPass').value;
    if (!email || !pass) return toast('Enter an email and password', 'err');
    if (kind === 'up' && pass.length < 8) return toast('Password needs 8+ characters', 'err');
    try {
      if (kind === 'up') {
        const { data, error } = await supa.auth.signUp({ email, password: pass });
        if (error) throw error;
        if (!data.session) await supa.auth.signInWithPassword({ email, password: pass })
          .then(({ error: e }) => { if (e) throw e; });
        toast('Account created — first sync starting');
      } else {
        const { error } = await supa.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        toast('Signed in — syncing');
      }
      document.getElementById('syncPass').value = '';
    } catch (e) {
      toast(String(e.message || e).replace('AuthApiError: ', ''), 'err');
    }
  }

  /* —— lifecycle ———————————————————————————————— */
  function start() {
    loadMeta();
    loadTombs();
    subscribe();
    syncPill('busy');
    fillTab();
    setTimeout(() => fullSync(true).then(scanLiteRecords), 2500);   // let boot settle first
    clearInterval(pullTimer);
    pullTimer = setInterval(() => { pullChanges(); }, 5 * 60 * 1000);
  }
  function stop() {
    unsubscribe();
    clearInterval(pullTimer);
    clearTimeout(pushTimer);
    user = null; meta = {}; tombs = {};
    syncPill(); fillTab();
  }

  supa.auth.onAuthStateChange((_ev, session) => {
    const next = session?.user || null;
    if (next?.id === user?.id) { user = next; return; }
    user = next;
    if (user) { localStorage.setItem(ACCT, user.id); start(); } else stop();
  });

  /* Recover an expired session rather than sitting silently signed out.
     autoRefreshToken only refreshes a session the client is already
     holding; if the token expired while the app was closed, nothing
     retries it and every push/pull no-ops forever. */
  (async () => {
    const { data } = await supa.auth.getSession().catch(() => ({ data: null }));
    if (data?.session) return;                       // healthy, or genuinely signed out
    /* onAuthStateChange returns early when the session is null and `user` is
       already null — the common no-session boot — so nothing else paints the
       signed-out state. Do it here. */
    syncPill();
    if (!lastAccount()) return;                      // never signed in on this machine
    try {
      const { error } = await supa.auth.refreshSession();
      if (error) throw error;
      console.info('[sync] expired session refreshed');
    } catch (e) {
      console.warn('[sync] session could not be refreshed:', e.message || e);
      syncPill();
      const behind = Date.now() - lastSyncFor(lastAccount());
      if (behind > 6 * 3600 * 1000) {
        toast('Signed out of your account — nothing has synced since ' +
          new Date(lastSyncFor(lastAccount())).toLocaleString() +
          '. Sign in from Settings to catch up.', 'err');
      }
    }
  })();

  /* hook persist(): any library mutation schedules a push */
  const _persist = persist;
  persist = function () { _persist(); if (!applying) schedulePush(); };

  /* hook settings saves from the modal */
  if (typeof saveSettingsModal === 'function') {
    const _ssm = saveSettingsModal;
    saveSettingsModal = async function () { await _ssm(); schedulePush(); };
  }

  /* buttons (own listener — keeps app.js's action switch untouched) */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'sync-banner-hide':
        bannerOff = true;                 // this run only — a restart warns again
        document.getElementById('sync-banner')?.remove();
        break;
      case 'sync-banner-signin':
        document.getElementById('sync-banner')?.remove();
        openSettings();
        document.querySelector('.set-tab[data-tab="sync"]')?.click();
        document.getElementById('syncEmail')?.focus();
        break;
      case 'sync-signin': doAuth('in'); break;
      case 'sync-signup': doAuth('up'); break;
      case 'sync-signout':
        supa.auth.signOut().catch(() => {});
        toast('Signed out — sync off');
        break;
      case 'sync-now': fullSync(); break;
      case 'sync-pill':
        settingsTab = 'sync';
        openSettings();
        break;
    }
  });

  window.syncUI = { fill: fillTab, push: () => pushChanges(), pull: () => pullChanges(), deleted: markDeleted, state: () => ({ user: user?.email, online, meta: Object.keys(meta).length }) };
})();
