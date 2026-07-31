/* ————————————————————————————————————————————————————————————————
   HIKARI BROWSE — the catalogue, narrowed by what you pick.

   Discover is recommendation-driven: it reads your shelf and suggests
   things like it. This is query-driven and independent of the shelf — you
   state the constraints, AniList answers. Different job, so a different
   surface rather than another mode of Discover.

   Genres and tags are one control here even though AniList keeps two
   separate vocabularies (19 genres, 425 tags in 24 categories), because
   nobody thinks "Comedy is a genre but Female Harem is a tag" — and the
   obvious example, harem, is three tags and no genre at all.

   Selections are ANDed. Verified against the live API: genre_in and tag_in
   are both AND, and they AND with each other, so narrowing needs no
   client-side filtering.

   Loads after app.js and shares its globals, the same way sync.js does.
   ———————————————————————————————————————————————————————————————— */
(() => {
  const SORTS = [
    ['POPULARITY_DESC', 'Most popular'],
    ['SCORE_DESC', 'Highest rated'],
    ['TRENDING_DESC', 'Trending now'],
    ['START_DATE_DESC', 'Newest first'],
    ['FAVOURITES_DESC', 'Most favourited']
  ];
  const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
  const THIS_YEAR = new Date().getFullYear();
  /* Results per load. AniList caps a request at 50, so anything above that
     is chained rather than asked for in one go. */
  const perLoad = () => Number(appSettings.browsePerLoad) || 50;

  const st = {
    genres: [], tags: [], formats: [], season: '', year: '', status: '',
    minScore: 0, adult: false, dubOnly: false, sort: 'POPULARITY_DESC',
    results: [], page: 0, hasNext: true, loading: false, error: null,
    vocab: null, tagQuery: '', openCats: new Set(), seq: 0, booted: false
  };

  const activeCount = () => st.genres.length + st.tags.length + st.formats.length
    + (st.season ? 1 : 0) + (st.year ? 1 : 0) + (st.status ? 1 : 0)
    + (st.minScore ? 1 : 0) + (st.adult ? 1 : 0) + (st.dubOnly ? 1 : 0);

  /* —— data ——————————————————————————————————————
     Debounced, because a rapid multi-select would otherwise spend the
     30/min AniList budget in a few seconds. `seq` drops the answer to a
     query the user has already moved on from. */
  let timer = null;
  function refetch(delay = 400) {
    clearTimeout(timer);
    st.results = []; st.page = 0; st.hasNext = true; st.error = null;
    render({ rail: true, reset: true });
    timer = setTimeout(load, delay);
  }

  const hasEnglishDub = (m) =>
    (m.characters?.edges || []).some((e) => e.voiceActors?.length);

  /* AniList has no dub filter — an English dub is only knowable by asking
     whether any character has an English voice actor, so "dubbed" can only
     be applied to rows already fetched. That makes pages uneven: a page of
     30 might yield 8. Keep pulling until the page is worth showing, bounded
     so a filter with almost no matches cannot run away with the request
     budget. */
  const MIN_YIELD = 12;
  const MAX_CHAIN = 4;

  async function load() {
    if (st.loading || !st.hasNext) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null;
    render();
    try {
      let added = 0;
      const want = perLoad();
      const size = Math.min(want, 50);
      const hops = Math.max(Math.ceil(want / size), st.dubOnly ? MAX_CHAIN : 1);
      for (let hop = 0; hop < hops && st.hasNext; hop++) {
        const r = await browseAnime({
          genres: st.genres, tags: st.tags, formats: st.formats,
          season: st.season || null, year: st.year || null,
          status: st.status || null, minScore: st.minScore || null,
          adult: st.adult, sort: [st.sort]
        }, st.page + 1, size);
        if (seq !== st.seq) return;                  // a newer filter won
        st.page = r.page;
        st.hasNext = r.hasNext;
        const seen = new Set(st.results.map((m) => m.id));
        const fresh = r.media
          .filter((m) => !seen.has(m.id))
          .filter((m) => !st.dubOnly || hasEnglishDub(m));
        st.results.push(...fresh);
        added += fresh.length;
        if (added >= (st.dubOnly ? Math.min(want, MIN_YIELD) : want)) break;
      }
    } catch (e) {
      if (seq === st.seq) st.error = e.message || String(e);
    } finally {
      if (seq === st.seq) { st.loading = false; render(); }
    }
  }

  async function loadVocab() {
    if (st.vocab) return;
    try { st.vocab = await fetchFilterVocab(); }
    catch { st.vocab = { genres: [], tags: [], categories: [] }; }
    render({ rail: true });
  }

  /* —— markup ————————————————————————————————————— */
  const chip = (kind, value, on, label) =>
    `<button class="bf-chip ${on ? 'on' : ''}" data-action="browse-toggle"
      data-kind="${kind}" data-value="${esc(value)}">${esc(label || value)}</button>`;

  function filtersHTML() {
    const v = st.vocab;
    if (!v) return '<div class="bf-load"><i></i>Loading filters…</div>';
    const q = st.tagQuery.trim().toLowerCase();
    const cats = v.categories
      .map(([cat, tags]) => [cat, tags.filter((t) =>
        (st.adult || !t.isAdult) && (!q || t.name.toLowerCase().includes(q)))])
      .filter(([, tags]) => tags.length);
    const n = activeCount();

    return `
    <div class="bf-head">
      <b>Filters</b>
      ${n ? `<button class="bf-clear" data-action="browse-clear">Clear ${n}</button>` : ''}
    </div>

    <div class="bf-sec">
      <h4>Sort</h4>
      <select class="bf-sel" data-action="browse-set" data-field="sort">
        ${SORTS.map(([k, l]) => `<option value="${k}"${st.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>

    <div class="bf-sec">
      <h4>Genre</h4>
      <div class="bf-chips">${v.genres.map((g) => chip('genre', g, st.genres.includes(g))).join('')}</div>
    </div>

    <div class="bf-sec">
      <h4>Format</h4>
      <div class="bf-chips">${FORMATS.map((f) => chip('format', f, st.formats.includes(f), fmtFormat(f) || f)).join('')}</div>
    </div>

    <div class="bf-sec bf-two">
      <label><span>Season</span>
        <select class="bf-sel" data-action="browse-set" data-field="season">
          <option value="">Any</option>
          ${['WINTER', 'SPRING', 'SUMMER', 'FALL'].map((s) =>
      `<option value="${s}"${st.season === s ? ' selected' : ''}>${s[0] + s.slice(1).toLowerCase()}</option>`).join('')}
        </select>
      </label>
      <label><span>Year</span>
        <select class="bf-sel" data-action="browse-set" data-field="year">
          <option value="">Any</option>
          ${Array.from({ length: 48 }, (_, i) => THIS_YEAR + 1 - i).map((y) =>
      `<option value="${y}"${String(st.year) === String(y) ? ' selected' : ''}>${y}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="bf-sec bf-two">
      <label><span>Status</span>
        <select class="bf-sel" data-action="browse-set" data-field="status">
          <option value="">Any</option>
          ${[['RELEASING', 'Airing'], ['FINISHED', 'Finished'], ['NOT_YET_RELEASED', 'Upcoming']].map(([k, l]) =>
      `<option value="${k}"${st.status === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </label>
      <label><span>Min score</span>
        <select class="bf-sel" data-action="browse-set" data-field="minScore">
          <option value="0">Any</option>
          ${[60, 70, 75, 80, 85, 90].map((s) =>
      `<option value="${s}"${Number(st.minScore) === s ? ' selected' : ''}>${s}%+</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="bf-sec">
      <h4>Tags <span class="bf-hint">${v.tags.length} in ${v.categories.length} groups</span></h4>
      <input class="bf-search" type="search" placeholder="Find a tag…" value="${esc(st.tagQuery)}"
             data-action="browse-tagq" spellcheck="false">
      ${st.tags.length ? `<div class="bf-chips picked">${st.tags.map((t) => chip('tag', t, true)).join('')}</div>` : ''}
      <div class="bf-cats">
        ${cats.map(([cat, tags]) => {
      const open = st.openCats.has(cat) || !!q;
      return `
        <div class="bf-cat${open ? ' open' : ''}">
          <button class="bf-cat-h" data-action="browse-cat" data-cat="${esc(cat)}">
            <span>${esc(cat)}</span><i>${tags.length}</i>
          </button>
          ${open ? `<div class="bf-chips">${tags.map((t) =>
        chip('tag', t.name, st.tags.includes(t.name))).join('')}</div>` : ''}
        </div>`;
    }).join('')}
      </div>
    </div>

    <div class="bf-sec">
      <label class="bf-check">
        <input type="checkbox" data-action="browse-dub"${st.dubOnly ? ' checked' : ''}>
        <span>English dub only<small>Checked against each result — AniList cannot filter on it</small></span>
      </label>
    </div>

    <div class="bf-sec">
      <label class="bf-check">
        <input type="checkbox" data-action="browse-adult"${st.adult ? ' checked' : ''}>
        <span>Include adult titles<small>AniList hides these by default</small></span>
      </label>
    </div>`;
  }

  function cardHTML(m) {
    const owner = library.find((x) => x.id === m.id)
      || library.find((x) => franchiseIds(x).has(m.id));
    const title = m.title.english || m.title.romaji || m.title.native || '?';
    const meta = [fmtFormat(m.format), m.seasonYear, m.episodes ? `${m.episodes} EP` : null]
      .filter(Boolean).join(' · ');
    return `
    <button class="bcard${owner ? ' owned' : ''}" data-action="browse-open" data-id="${m.id}"
            data-owner="${owner ? owner.id : ''}" style="--show:${esc(m.coverImage?.color || '#E4A15D')}">
      <span class="bc-cover">
        <img src="${esc(m.coverImage?.large || '')}" alt="" loading="lazy" decoding="async">
        ${m.averageScore ? `<span class="bc-score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : ''}
        ${owner ? '<span class="bc-owned">ON SHELF</span>' : ''}
      </span>
      <span class="bc-t">${esc(title)}</span>
      <span class="bc-m">${esc(meta)}</span>
    </button>`;
  }

  /* —— rendering ————————————————————————————————
     Split three ways on purpose. The first cut rebuilt the whole page on
     every event, which meant page 2 destroyed and recreated all 30 cards
     already on screen — every one of them re-ran its entry animation, which
     is the flicker — and every keystroke in the tag search rebuilt the rail,
     losing its scroll position and collapsing the groups you had open. */

  let drawn = 0;                     // how many results are already in the DOM

  function shell() {
    const host = document.getElementById('browseHost');
    if (!host) return null;
    if (!host.querySelector('.browse-main')) {
      host.innerHTML = `
        <aside class="browse-rail"></aside>
        <div class="browse-main">
          <div class="browse-bar"><span class="bb-count"></span></div>
          <div class="browse-note"></div>
          <div class="browse-grid"></div>
          <div class="browse-sentinel"></div>
          <div class="browse-foot"></div>
        </div>`;
      /* leaving Browse destroys this markup (the shelf screen is reused by
         every view), so the append cursor has to go back to zero or the
         grid returns empty on the way back in */
      drawn = 0;
      renderRail();
      observeSentinel();
    }
    return host;
  }

  /* the rail only changes when a filter or the vocabulary does */
  function renderRail() {
    const rail = document.querySelector('.browse-rail');
    if (!rail) return;
    const keepScroll = rail.scrollTop;
    const active = document.activeElement;
    const hadTagFocus = active?.dataset?.action === 'browse-tagq';
    const caret = hadTagFocus ? active.selectionStart : null;

    rail.innerHTML = filtersHTML();

    rail.scrollTop = keepScroll;                 // do not throw them back to the top
    if (hadTagFocus) {
      const again = rail.querySelector('[data-action="browse-tagq"]');
      if (again) { again.focus(); again.setSelectionRange(caret, caret); }
    }
  }

  function renderChrome() {
    const count = document.querySelector('.bb-count');
    const note = document.querySelector('.browse-note');
    const foot = document.querySelector('.browse-foot');
    if (!count) return;
    const shown = st.results.length;
    count.textContent = shown
      ? `${shown} shown${st.hasNext ? '' : ' — that’s all'}${st.dubOnly ? ' · dubbed only' : ''}`
      : st.loading ? 'Searching…' : 'Nothing yet';
    note.innerHTML = st.error
      ? `<div class="browse-empty"><b>Couldn’t reach AniList</b><p>${esc(st.error)}</p>
         <button class="btn-primary" data-action="browse-retry">Try again</button></div>`
      : (!st.loading && !shown)
        ? `<div class="browse-empty"><b>Nothing matches</b>
           <p>Every selection narrows the results — try removing one.</p></div>`
        : '';
    foot.innerHTML = st.loading
      ? `<div class="browse-grid more">${Array.from({ length: 8 }, () =>
        '<div class="bcard skel"><span class="bc-cover"></span><span class="bc-t"></span></div>').join('')}</div>`
      : (!st.hasNext && shown) ? '<p class="browse-end">That’s everything.</p>' : '';
  }

  /* append only — existing cards are never touched, so they never re-animate */
  function renderGrid(reset = false) {
    const grid = document.querySelector('.browse-grid');
    if (!grid) return;
    if (reset) { grid.innerHTML = ''; drawn = 0; }
    if (drawn >= st.results.length) return;
    const frag = document.createElement('template');
    frag.innerHTML = st.results.slice(drawn).map(cardHTML).join('');
    grid.append(...frag.content.childNodes);
    drawn = st.results.length;
  }

  function render({ rail = false, reset = false } = {}) {
    if (!shell()) return;
    if (rail) renderRail();
    renderGrid(reset);
    renderChrome();
  }

  /* An IntersectionObserver on a sentinel below the grid, rather than a
     scroll listener doing arithmetic on scrollHeight. The listener fired
     against whichever element happened to be scrolling and raced its own
     re-render, so it either never triggered or triggered repeatedly. */
  let io = null;
  function observeSentinel() {
    const el = document.querySelector('.browse-sentinel');
    if (!el) return;
    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (currentView !== 'browse') return;
      load();
    }, { rootMargin: '900px 0px' });
    io.observe(el);
  }

  /* —— interaction ———————————————————————————————— */
  function toggle(kind, value) {
    const list = kind === 'genre' ? st.genres : kind === 'tag' ? st.tags : st.formats;
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1); else list.push(value);
    refetch();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'browse-toggle': toggle(el.dataset.kind, el.dataset.value); break;
      case 'browse-cat': {
        const c = el.dataset.cat;
        if (st.openCats.has(c)) st.openCats.delete(c); else st.openCats.add(c);
        render({ rail: true });
        break;
      }
      case 'browse-clear':
        Object.assign(st, { genres: [], tags: [], formats: [], season: '', year: '',
          status: '', minScore: 0, adult: false, dubOnly: false });
        refetch(0);
        break;
      case 'browse-retry': st.hasNext = true; load(); break;
      case 'browse-open': {
        const owner = el.dataset.owner;
        if (owner) goDetail(Number(owner));
        else goPreview(Number(el.dataset.id));
        break;
      }
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'browse-set') {
      st[el.dataset.field] = el.value;
      refetch(0);
    } else if (el.dataset.action === 'browse-dub') {
      st.dubOnly = el.checked;
      refetch(0);
    } else if (el.dataset.action === 'browse-adult') {
      st.adult = el.checked;
      refetch(0);
    }
  });

  /* the tag search only filters chips already in memory — no request */
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-action="browse-tagq"]');
    if (!el) return;
    st.tagQuery = el.value;
    render({ rail: true });    // renderRail keeps focus, caret and scroll
  });

  /* —— entry point ———————————————————————————————— */
  window.hikariBrowse = {
    open() {
      loadVocab();
      if (!st.booted) { st.booted = true; refetch(0); }
      else render();
    },
    render,
    state: () => st
  };
})();
