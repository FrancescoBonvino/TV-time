/* TV Time 2.0 - interfaccia e API. Tutte le API usate sono gratuite e senza chiave:
   TVmaze (serie TV), AniList (anime), Cinemeta (film), GitHub Gist (sincronizzazione account, opzionale). */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\(Source:[^)]*\)/gi, '').trim();
  const HOUR = 3600000, DAY = 86400000;

  /* ---------- Archivio locale ---------- */
  const LS = 'tvt2.data', LC = 'tvt2.cache', LT = 'tvt2.sync', LTH = 'tvt2.theme';
  const mem = {};
  function rd(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return mem[k] !== undefined ? mem[k] : d; } }
  function wr(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio esaurito o storage bloccato */ } }
  let S = rd(LS, { v: 1, items: {} });
  let cache = rd(LC, {});
  let sync = rd(LT, { token: '', gist: '', user: '', last: 0 });
  const metaCache = {}; // key -> metadati normalizzati (risultati di ricerca, scoperta, dettaglio)

  const KIND = { tv: 'Serie TV', anime: 'Anime', movie: 'Film' };
  const LISTS = { watching: 'Sto guardando', watchlist: 'Da vedere', completed: 'Completati', dropped: 'Abbandonati' };
  const REACTIONS = ['❤️', '😂', '😮', '😢', '😡'];

  const items = () => Object.values(S.items).filter((i) => !i.deleted);
  const getItem = (key) => (S.items[key] && !S.items[key].deleted ? S.items[key] : null);
  let saveTimer = 0;
  function persist() {
    wr(LS, S);
    if (sync.gist) { clearTimeout(saveTimer); saveTimer = setTimeout(() => syncNow(true).catch(() => {}), 4000); }
  }
  function saveCache() {
    // tiene in cache solo i titoli seguiti, per non riempire lo spazio
    Object.keys(cache).forEach((k) => { if (!getItem(k) && Date.now() - cache[k].t > HOUR) delete cache[k]; });
    wr(LC, cache);
  }

  /* ---------- API ---------- */
  async function J(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const https = (u) => (u ? String(u).replace(/^http:/, 'https:') : '');

  // Serie TV: TVmaze
  const TV = {
    norm(s) {
      const m = {
        kind: 'tv', id: s.id, key: 'tv:' + s.id, title: s.name, poster: https(s.image && s.image.medium), banner: https(s.image && s.image.original),
        year: (s.premiered || '').slice(0, 4), genres: s.genres || [], runtime: s.averageRuntime || s.runtime || 42, total: null,
        status: s.status || '', summary: strip(s.summary), score: s.rating && s.rating.average ? String(s.rating.average) : null,
        network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '', lang: s.language || '',
      };
      metaCache[m.key] = m; return m;
    },
    search: (q) => J('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q)).then((a) => a.map((x) => TV.norm(x.show))),
    show: (id) => J('https://api.tvmaze.com/shows/' + id),
    eps: (id) => J('https://api.tvmaze.com/shows/' + id + '/episodes'),
    async onAir() {
      const d = new Date().toISOString().slice(0, 10);
      const a = await J('https://api.tvmaze.com/schedule?country=US&date=' + d);
      const seen = new Map();
      a.forEach((e) => { if (e.show && e.show.image && e.show.type === 'Scripted' && !seen.has(e.show.id)) seen.set(e.show.id, e.show); });
      return [...seen.values()].sort((x, y) => (y.weight || 0) - (x.weight || 0)).slice(0, 14).map(TV.norm);
    },
  };

  // Anime: AniList (GraphQL)
  const gql = (query, variables) => J('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) }).then((r) => r.data);
  const A_LIST = 'id title{romaji english} format status episodes duration seasonYear averageScore genres coverImage{large} nextAiringEpisode{episode airingAt}';
  const A_FULL = A_LIST + ' bannerImage description studios(isMain:true){nodes{name}} streamingEpisodes{title} relations{edges{relationType node{id type format title{romaji english} coverImage{large}}}}';
  const ANI = {
    norm(m) {
      const st = { FINISHED: 'Ended', CANCELLED: 'Ended', RELEASING: 'Running', HIATUS: 'Running', NOT_YET_RELEASED: 'Upcoming' }[m.status] || '';
      const x = {
        kind: 'anime', id: m.id, key: 'anime:' + m.id, title: m.title.english || m.title.romaji, alt: m.title.romaji, poster: https(m.coverImage && m.coverImage.large),
        banner: https(m.bannerImage), year: m.seasonYear || '', genres: m.genres || [], runtime: m.duration || 24, total: m.format === 'MOVIE' ? 1 : (m.episodes || null),
        status: st, summary: strip(m.description), score: m.averageScore ? (m.averageScore / 10).toFixed(1) : null, format: m.format,
        network: m.studios && m.studios.nodes && m.studios.nodes[0] ? m.studios.nodes[0].name : '', raw: m,
      };
      metaCache[x.key] = x; return x;
    },
    search: (q) => gql('query($q:String){Page(perPage:10){media(search:$q,type:ANIME,sort:SEARCH_MATCH){' + A_LIST + '}}}', { q }).then((d) => d.Page.media.map(ANI.norm)),
    one: (id) => gql('query($id:Int){Media(id:$id,type:ANIME){' + A_FULL + '}}', { id: +id }).then((d) => d.Media),
    many: (ids) => gql('query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){' + A_FULL + '}}}', { ids: ids.map(Number) }).then((d) => d.Page.media),
    trending: () => gql('query{Page(perPage:14){media(type:ANIME,status:RELEASING,sort:TRENDING_DESC,isAdult:false){' + A_LIST + '}}}').then((d) => d.Page.media.map(ANI.norm)),
  };

  // Film: Cinemeta
  const CINE = {
    poster: (id) => 'https://images.metahub.space/poster/small/' + id + '/img',
    norm(m) {
      const rt = parseInt(m.runtime, 10);
      const x = {
        kind: 'movie', id: m.id || m.imdb_id, key: 'movie:' + (m.id || m.imdb_id), title: m.name, poster: m.poster || CINE.poster(m.id || m.imdb_id),
        banner: m.background || ('https://images.metahub.space/background/medium/' + (m.id || m.imdb_id) + '/img'),
        year: String(m.year || m.releaseInfo || '').slice(0, 4), genres: m.genres || m.genre || [], runtime: isNaN(rt) ? 110 : rt, total: 1, status: '',
        summary: m.description || '', score: m.imdbRating || null, network: Array.isArray(m.director) ? m.director.join(', ') : '',
      };
      metaCache[x.key] = x; return x;
    },
    search: (q) => J('https://v3-cinemeta.strem.io/catalog/movie/top/search=' + encodeURIComponent(q) + '.json').then((r) => (r.metas || []).filter((m) => m.type === 'movie').slice(0, 10).map(CINE.norm)),
    meta: (id) => J('https://v3-cinemeta.strem.io/meta/movie/' + id + '.json').then((r) => r.meta),
    popular: () => J('https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json').then((r) => (r.metas || []).filter((m) => m.type === 'movie').slice(0, 14).map(CINE.norm)),
  };

  /* ---------- Episodi in cache ---------- */
  function cacheFromAni(m) {
    const nx = m.nextAiringEpisode;
    const total = m.format === 'MOVIE' ? 1 : m.episodes;
    const airedN = nx ? nx.episode - 1 : (m.status === 'NOT_YET_RELEASED' ? 0 : (total || 0));
    const last = total || (nx ? nx.episode : airedN);
    const titles = {};
    (m.streamingEpisodes || []).forEach((e) => { const r = /^Episode\s+(\d+)\s*[-–:]\s*(.+)$/i.exec(e.title || ''); if (r) titles[+r[1]] = r[2]; });
    const eps = [];
    for (let i = 1; i <= last; i++) {
      let ts = null;
      if (i <= airedN) ts = 0; else if (nx) ts = nx.airingAt * 1000 + (i - nx.episode) * 7 * DAY;
      eps.push([String(i), 1, i, titles[i] || (m.format === 'MOVIE' ? 'Film' : 'Episodio ' + i), ts, m.duration || null]);
    }
    return { t: Date.now(), status: { FINISHED: 'Ended', CANCELLED: 'Ended', RELEASING: 'Running', HIATUS: 'Running', NOT_YET_RELEASED: 'Upcoming' }[m.status] || '', eps };
  }
  const isFresh = (c) => c && Date.now() - c.t < (c.status === 'Ended' ? 7 * DAY : 3 * HOUR);

  async function ensure(it, force) {
    const c = cache[it.key];
    if (it.kind === 'movie') return null;
    if (isFresh(c) && !force) return c;
    try {
      if (it.kind === 'tv') {
        const [eps, show] = await Promise.all([TV.eps(it.id), TV.show(it.id)]);
        cache[it.key] = {
          t: Date.now(), status: show.status || '',
          eps: eps.filter((e) => e.number != null).map((e) => [String(e.id), e.season, e.number, e.name || '', e.airstamp ? Date.parse(e.airstamp) : (e.airdate ? Date.parse(e.airdate) : null), e.runtime || null]),
        };
      } else {
        const m = await ANI.one(it.id);
        ANI.norm(m);
        cache[it.key] = cacheFromAni(m);
      }
      saveCache();
      return cache[it.key];
    } catch (e) { return c || null; }
  }

  let refreshing = false;
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      const act = items().filter((i) => i.kind !== 'movie' && (i.list === 'watching' || i.list === 'watchlist') && !isFresh(cache[i.key]));
      const anime = act.filter((i) => i.kind === 'anime');
      for (let n = 0; n < anime.length; n += 40) {
        const chunk = anime.slice(n, n + 40);
        try { (await ANI.many(chunk.map((i) => i.id))).forEach((m) => { ANI.norm(m); cache['anime:' + m.id] = cacheFromAni(m); }); } catch (e) { /* offline */ }
      }
      for (const it of act.filter((i) => i.kind === 'tv')) { await ensure(it, true); }
      saveCache();
    } finally { refreshing = false; }
    const r = curRoute();
    if (['home', 'calendar', 'library'].includes(r.tab)) render();
  }

  /* ---------- Azioni sui titoli ---------- */
  function track(meta, list) {
    const old = S.items[meta.key];
    const it = Object.assign({ w: {}, added: Date.now() }, old || {}, {
      key: meta.key, kind: meta.kind, id: meta.id, title: meta.title, poster: meta.poster, banner: meta.banner || '', year: meta.year,
      genres: meta.genres || [], runtime: meta.runtime, total: meta.total, summary: (meta.summary || '').slice(0, 500), list: list || (old && old.list) || 'watchlist', deleted: false, u: Date.now(),
    });
    S.items[meta.key] = it; persist(); return it;
  }
  function untrack(key) { const it = S.items[key]; if (!it) return; it.deleted = true; it.u = Date.now(); persist(); }
  function setList(it, list) { it.list = list; it.u = Date.now(); persist(); }

  function afterWatch(it) {
    const c = cache[it.key];
    if (it.kind === 'movie') { it.list = Core.isWatched(it, 'movie') ? 'completed' : 'watchlist'; return; }
    if (Core.isFinished(it, c)) it.list = 'completed';
    else if (it.list === 'watchlist' || it.list === 'completed' || it.list === 'dropped') it.list = Core.watchedCount(it) ? 'watching' : 'watchlist';
  }

  function toggleEp(key, ek, forceOn) {
    let it = getItem(key);
    const wasNew = !it;
    if (!it) it = track(metaCache[key], 'watching');
    const on = forceOn != null ? forceOn : !Core.isWatched(it, ek);
    Core.setWatched(it, ek, on);
    afterWatch(it); persist();
    return { it, on, wasNew };
  }

  function markSeason(key, season, on) {
    const it = getItem(key) || track(metaCache[key], 'watching');
    const c = cache[key]; if (!c) return;
    const ended = c.status === 'Ended';
    c.eps.filter((e) => e[1] === season && (!on || Core.aired(e, ended))).forEach((e) => Core.setWatched(it, e[0], on));
    afterWatch(it); persist();
  }
  function markPrevious(key, ek) {
    const it = getItem(key); const c = cache[key]; if (!it || !c) return;
    const idx = c.eps.findIndex((e) => e[0] === ek);
    c.eps.slice(0, idx).forEach((e) => { if (!Core.isWatched(it, e[0])) Core.setWatched(it, e[0], true); });
    afterWatch(it); persist();
  }

  /* ---------- Utilita' di vista ---------- */
  const epLabel = (it, e) => (it.kind === 'tv' ? 'S' + pad(e[1]) + 'E' + pad(e[2]) : 'Ep. ' + e[2]);
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  function dayLabel(ts) {
    const k = dayKey(ts), t = Date.now();
    if (k === dayKey(t)) return 'Oggi';
    if (k === dayKey(t + DAY)) return 'Domani';
    return new Date(ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const IC = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  };
  const img = (src) => (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '');
  const lastTouch = (it) => it.u || it.added || 0;

  function posterCard(m, extra) {
    const it = getItem(m.key);
    const prog = it && it.kind !== 'movie' ? Core.progress(it, cache[it.key]) : 0;
    return '<a class="poster" href="#/item/' + esc(m.key) + '"><div class="img">' + img(m.poster) +
      (it ? '<span class="tag badge new">' + (it.list === 'completed' ? 'Fatto' : it.list === 'watching' ? 'Guardo' : it.list === 'dropped' ? 'Stop' : 'Lista') + '</span>' : '') +
      (it && it.fav ? '<span class="fav">★</span>' : '') +
      (prog > 0 ? '<div class="bar"><i style="width:' + Math.round(prog * 100) + '%"></i></div>' : '') + '</div>' +
      '<div class="n">' + esc(m.title) + '</div><div class="y">' + esc(m.year || '') + (extra || '') + '</div></a>';
  }

  /* ---------- Router ---------- */
  function curRoute() {
    const h = location.hash || '#/home';
    const p = h.split('/');
    return { tab: p[1] || 'home', arg: decodeURIComponent(p.slice(2).join('/')) };
  }
  const view = $('#view');
  let renderToken = 0;
  function render() {
    const r = curRoute(); const tok = ++renderToken;
    document.querySelectorAll('#nav a').forEach((a) => { const on = a.dataset.tab === (r.tab === 'item' ? lastTab : r.tab); a.toggleAttribute('aria-current', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const keep = view.scrollTop;
    if (r.tab === 'item') { renderDetail(r.arg, tok); return; }
    lastTab = r.tab;
    const fn = { home: vHome, calendar: vCalendar, search: vSearch, library: vLibrary, profile: vProfile }[r.tab] || vHome;
    fn();
    if (r.tab === prevTab) view.scrollTop = keep; else view.scrollTop = 0;
    prevTab = r.tab;
  }
  let lastTab = 'home', prevTab = '';
  window.addEventListener('hashchange', () => { const t = document.getElementById('toast'); if (t) t.hidden = true; render(); });

  /* ---------- Home ---------- */
  function vHome() {
    const now = Date.now();
    const act = items().filter((i) => i.kind !== 'movie' && i.list === 'watching');
    const rows = act.map((it) => ({ it, c: cache[it.key], next: Core.nextUnwatched(it, cache[it.key], now) }))
      .sort((a, b) => lastTouch(b.it) - lastTouch(a.it));
    const toWatch = rows.filter((r) => r.next);
    const waiting = rows.filter((r) => r.c && !r.next);
    const toStart = items().filter((i) => i.kind !== 'movie' && i.list === 'watchlist');
    const movies = items().filter((i) => i.kind === 'movie' && i.list === 'watchlist');
    const soon = upcomingList(['watching', 'watchlist']).slice(0, 4);

    let h = '<div class="page-head"><div><h1>Ciao!</h1><div class="sub">' + esc(new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })) + '</div></div></div>';

    if (!items().length) {
      h += '<div class="empty"><h3>La tua lista è vuota</h3>Cerca una serie, un anime o un film e segna cosa hai già visto.<br><a class="btn primary" href="#/search">Cerca un titolo</a></div>';
      view.innerHTML = h; return;
    }

    h += '<section class="section"><header><h2>Continua a guardare</h2><span class="more">' + toWatch.length + ' da vedere</span></header>';
    if (toWatch.length) {
      h += '<div class="rows">' + toWatch.map(({ it, c, next }) => {
        const left = Core.remaining(it, c, now);
        return '<div class="row link"><a class="go" href="#/item/' + esc(it.key) + '" aria-label="' + esc(it.title) + '"></a><div class="thumb">' + img(it.poster) + '</div><div class="txt"><div class="t">' + esc(it.title) +
          '</div><div class="s"><b>' + esc(epLabel(it, next)) + '</b> · ' + esc(next[3] || '') + '</div><div class="s">' + (left > 1 ? left + ' episodi da vedere' : 'Ultimo uscito') + ' · ' + esc(KIND[it.kind]) + '</div>' +
          '<div class="bar"><i style="width:' + Math.round(Core.progress(it, c) * 100) + '%"></i></div></div>' +
          '<button class="check" data-act="ep" data-key="' + esc(it.key) + '" data-ep="' + esc(next[0]) + '" aria-pressed="false" aria-label="Segna come visto">' + IC.check + '</button></div>';
      }).join('') + '</div>';
    } else if (act.length && !act.every((i) => cache[i.key])) {
      h += '<div class="rows"><div class="skel" style="height:78px"></div><div class="skel" style="height:78px"></div></div>';
    } else {
      h += '<div class="empty"><h3>Sei in pari</h3>' + (waiting.length ? 'Hai visto tutto quello che è uscito. Controlla il calendario per le prossime puntate.' : 'Segna come “Sto guardando” un titolo per vederlo qui.') + '</div>';
    }
    h += '</section>';

    if (soon.length) {
      h += '<section class="section"><header><h2>In arrivo</h2><a class="more" href="#/calendar">Calendario</a></header><div class="rows">' + soon.map(upRow).join('') + '</div></section>';
    }
    if (toStart.length) {
      h += '<section class="section"><header><h2>Da iniziare</h2></header><div class="hscroll">' + toStart.map((i) => posterCard(i, '')).join('') + '</div></section>';
    }
    if (movies.length) {
      h += '<section class="section"><header><h2>Film da vedere</h2></header><div class="hscroll">' + movies.map((i) => posterCard(i, '')).join('') + '</div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- Calendario ---------- */
  let calFilter = 'all';
  function upcomingList(lists) {
    const out = [];
    const now = Date.now();
    items().forEach((it) => {
      if (it.kind === 'movie' || !lists.includes(it.list)) return;
      Core.upcoming(it, cache[it.key], now, 45).forEach((e) => out.push({ it, e, ts: e[4] }));
    });
    return out.sort((a, b) => a.ts - b.ts);
  }
  function upRow(x) {
    return '<div class="row link"><a class="go" href="#/item/' + esc(x.it.key) + '" aria-label="' + esc(x.it.title) + '"></a><div class="time">' + (x.ts % DAY === 0 ? '' : esc(fmtTime(x.ts))) + '</div><div class="thumb">' + img(x.it.poster) + '</div><div class="txt"><div class="t">' + esc(x.it.title) +
      '</div><div class="s"><b>' + esc(epLabel(x.it, x.e)) + '</b>' + (x.e[3] ? ' · ' + esc(x.e[3]) : '') + '</div><div class="s">' + esc(dayLabel(x.ts)) + ' · ' + esc(KIND[x.it.kind]) + '</div></div></div>';
  }
  function vCalendar() {
    let list = upcomingList(['watching', 'watchlist']);
    if (calFilter !== 'all') list = list.filter((x) => x.it.kind === calFilter);
    let h = '<div class="page-head"><div><h1>Calendario</h1><div class="sub">Prossime puntate dei titoli che segui</div></div></div>' +
      '<div class="chips">' + [['all', 'Tutto'], ['tv', 'Serie TV'], ['anime', 'Anime']].map((c) => '<button class="chip" data-act="chip" data-group="cal" data-val="' + c[0] + '" aria-pressed="' + (calFilter === c[0]) + '">' + c[1] + '</button>').join('') + '</div>';
    if (!list.length) {
      const any = items().some((i) => i.kind !== 'movie');
      h += '<div class="empty" style="margin-top:14px"><h3>' + (any ? 'Nessuna uscita nei prossimi 45 giorni' : 'Calendario vuoto') + '</h3>' + (any ? 'Le serie finite o già uscite per intero non compaiono qui.' : 'Aggiungi serie e anime in corso per vedere quando escono le nuove puntate.') + '<br><a class="btn primary" href="#/search">Cerca un titolo</a></div>';
    } else {
      const groups = new Map();
      list.forEach((x) => { const k = dayKey(x.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
      groups.forEach((arr) => {
        h += '<div class="day' + (dayKey(arr[0].ts) === dayKey(Date.now()) ? ' today' : '') + '"><h3>' + esc(dayLabel(arr[0].ts)) + '</h3><div class="rows">' + arr.map(upRow).join('') + '</div></div>';
      });
    }
    view.innerHTML = h;
  }

  /* ---------- Cerca / Scopri ---------- */
  let sq = '', sFilter = 'all', sTimer = 0, sSeq = 0;
  const disc = {};
  function vSearch() {
    view.innerHTML = '<div class="searchbar"><input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Cerca serie, anime o film" value="' + esc(sq) + '"></div>' +
      '<div class="chips">' + [['all', 'Tutto'], ['tv', 'Serie TV'], ['anime', 'Anime'], ['movie', 'Film']].map((c) => '<button class="chip" data-act="chip" data-group="search" data-val="' + c[0] + '" aria-pressed="' + (sFilter === c[0]) + '">' + c[1] + '</button>').join('') + '</div>' +
      '<div id="results"></div>';
    $('#q').addEventListener('input', (e) => { sq = e.target.value; clearTimeout(sTimer); sTimer = setTimeout(runSearch, 380); });
    runSearch();
  }
  function quickBtn(m) {
    const it = getItem(m.key);
    return '<button class="check add" data-act="quick" data-key="' + esc(m.key) + '" aria-pressed="' + !!it + '" aria-label="' + (it ? 'Rimuovi dalla lista' : 'Aggiungi alla lista') + '">' + (it ? IC.check : IC.plus) + '</button>';
  }
  function resRow(m) {
    return '<div class="row link"><a class="go" href="#/item/' + esc(m.key) + '" aria-label="' + esc(m.title) + '"></a><div class="thumb">' + img(m.poster) + '</div><div class="txt"><div class="t">' + esc(m.title) + '</div><div class="s">' +
      esc([m.year, KIND[m.kind], m.score ? '★ ' + m.score : ''].filter(Boolean).join(' · ')) + '</div><div class="s">' + esc((m.genres || []).slice(0, 3).join(', ')) + '</div></div>' + quickBtn(m) + '</div>';
  }
  async function runSearch() {
    const box = $('#results'); if (!box) return;
    const seq = ++sSeq;
    const q = sq.trim();
    if (q.length < 2) { renderDiscover(box); return; }
    box.innerHTML = '<div class="rows"><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div><div class="skel" style="height:84px"></div></div>';
    const want = (k) => sFilter === 'all' || sFilter === k;
    const jobs = [['tv', want('tv') && TV.search(q)], ['anime', want('anime') && ANI.search(q)], ['movie', want('movie') && CINE.search(q)]];
    const res = await Promise.all(jobs.map(async (j) => { if (!j[1]) return [j[0], []]; try { return [j[0], await j[1]]; } catch (e) { return [j[0], null]; } }));
    if (seq !== sSeq || !$('#results')) return;
    let h = '';
    res.forEach(([k, arr]) => {
      if (arr === null) h += '<section class="section"><header><h2>' + KIND[k] + '</h2></header><div class="empty">Servizio non raggiungibile. Riprova tra poco.</div></section>';
      else if (arr.length) h += '<section class="section"><header><h2>' + KIND[k] + '</h2></header><div class="rows">' + arr.slice(0, sFilter === 'all' ? 6 : 10).map(resRow).join('') + '</div></section>';
    });
    box.innerHTML = h || '<div class="empty" style="margin-top:14px"><h3>Nessun risultato</h3>Prova con il titolo originale o con meno parole.</div>';
  }
  async function renderDiscover(box) {
    const rowsDef = [['anime', 'Anime in corso, di tendenza', ANI.trending], ['tv', 'Serie in onda oggi', TV.onAir], ['movie', 'Film popolari', CINE.popular]]
      .filter((r) => sFilter === 'all' || sFilter === r[0]);
    box.innerHTML = rowsDef.map((r) => '<section class="section" id="disc-' + r[0] + '"><header><h2>' + r[1] + '</h2></header><div class="hscroll">' + (disc[r[0]] ? disc[r[0]].map((m) => posterCard(m, '')).join('') : '<div class="skel" style="width:110px;height:200px;flex:none"></div>'.repeat(3)) + '</div></section>').join('');
    for (const r of rowsDef) {
      if (disc[r[0]]) continue;
      r[2]().then((arr) => { disc[r[0]] = arr; const el = $('#disc-' + r[0] + ' .hscroll'); if (el && !sq.trim()) el.innerHTML = arr.map((m) => posterCard(m, '')).join(''); })
        .catch(() => { const el = $('#disc-' + r[0]); if (el) el.remove(); });
    }
  }

  /* ---------- Libreria ---------- */
  let libKind = 'tv', libList = 'all';
  function vLibrary() {
    let list = items().filter((i) => i.kind === libKind);
    const counts = {}; list.forEach((i) => { counts[i.list] = (counts[i.list] || 0) + 1; });
    const fav = list.filter((i) => i.fav).length;
    if (libList === 'fav') list = list.filter((i) => i.fav); else if (libList !== 'all') list = list.filter((i) => i.list === libList);
    list.sort((a, b) => lastTouch(b) - lastTouch(a));
    const lists = libKind === 'movie' ? [['all', 'Tutti'], ['watchlist', 'Da vedere'], ['completed', 'Visti'], ['fav', 'Preferiti']] : [['all', 'Tutti'], ['watching', 'Guardo'], ['watchlist', 'Da vedere'], ['completed', 'Completati'], ['dropped', 'Abbandonati'], ['fav', 'Preferiti']];
    let h = '<div class="page-head"><div><h1>Libreria</h1><div class="sub">' + items().length + ' titoli nel tuo account</div></div></div>' +
      '<div class="seg" role="group" aria-label="Tipo">' + Object.keys(KIND).map((k) => '<button data-act="chip" data-group="libKind" data-val="' + k + '" aria-pressed="' + (libKind === k) + '">' + KIND[k] + '</button>').join('') + '</div>' +
      '<div class="chips" style="margin-top:10px">' + lists.map((l) => '<button class="chip" data-act="chip" data-group="libList" data-val="' + l[0] + '" aria-pressed="' + (libList === l[0]) + '">' + l[1] + (l[0] === 'fav' ? ' ' + fav : counts[l[0]] ? ' ' + counts[l[0]] : '') + '</button>').join('') + '</div>';
    h += list.length ? '<div class="grid" style="margin-top:12px">' + list.map((i) => posterCard(i, '')).join('') + '</div>' :
      '<div class="empty" style="margin-top:14px"><h3>Niente qui</h3>Nessun titolo in questa sezione.<br><a class="btn primary" href="#/search">Cerca un titolo</a></div>';
    view.innerHTML = h;
  }

  /* ---------- Dettaglio ---------- */
  let openReact = '', openSeasons = {};
  async function renderDetail(key, tok) {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    let meta = getItem(key) || metaCache[key];
    if (!meta) {
      view.innerHTML = '<div class="hero skel" style="min-height:200px"></div><div class="skel" style="height:120px;margin-top:14px"></div>';
      try {
        if (kind === 'tv') meta = TV.norm(await TV.show(id));
        else if (kind === 'anime') meta = ANI.norm(await ANI.one(id));
        else meta = CINE.norm(await CINE.meta(id));
      } catch (e) { view.innerHTML = '<div class="page-head"><h1>Titolo non trovato</h1></div><div class="empty">Non riesco a caricare questo titolo. <a href="#/search">Torna alla ricerca</a></div>'; return; }
      if (tok !== renderToken) return;
    } else if (!meta.summary && !getItem(key)) {
      // i risultati di ricerca non hanno trama completa: completa in background
      try {
        if (kind === 'movie') meta = CINE.norm(await CINE.meta(id)); else if (kind === 'anime') meta = ANI.norm(await ANI.one(id)); else meta = TV.norm(await TV.show(id));
      } catch (e) { /* si usa quello che c'e' */ }
      if (tok !== renderToken) return;
    }
    const tracked = getItem(key);
    // un titolo salvato ha meno dettagli: unisci i metadati freschi
    const full = metaCache[key] || meta;
    const it = tracked || Object.assign({ w: {}, list: '' }, meta);
    const c = it.kind === 'movie' ? null : cache[key];
    paintDetail(it, full, c, !!tracked);
    if (it.kind !== 'movie' && !isFresh(c)) {
      const fresh = await ensure(it, true);
      if (tok === renderToken && fresh) paintDetail(getItem(key) || it, metaCache[key] || full, fresh, !!getItem(key));
    }
  }

  function paintDetail(it, m, c, tracked) {
    const keep = view.scrollTop;
    const now = Date.now();
    const relK = m.raw && m.raw.relations ? m.raw.relations.edges.filter((e) => ['SEQUEL', 'PREQUEL'].includes(e.relationType) && e.node.type === 'ANIME') : [];
    let h = '<div class="hero" style="' + ((m.banner || m.poster) ? 'background-image:url(' + esc(m.banner || m.poster) + ')' : '') + '"><a class="back" href="#/' + lastTab + '" aria-label="Indietro">' + IC.back + '</a></div>' +
      '<div class="dhead"><div class="cover">' + img(m.poster) + '</div><div style="min-width:0"><h1>' + esc(m.title) + '</h1><div class="meta">' +
      esc([KIND[it.kind], m.year, m.status === 'Ended' ? 'Conclusa' : m.status === 'Running' ? 'In corso' : m.status === 'Upcoming' ? 'In arrivo' : '', m.score ? '★ ' + m.score : ''].filter(Boolean).join(' · ')) + '</div></div></div>';

    // stato nella lista
    if (it.kind === 'movie') {
      const seen = Core.isWatched(it, 'movie');
      h += '<div class="actions"><button class="btn ' + (seen ? '' : 'primary') + '" style="flex:1" data-act="movie" data-key="' + esc(it.key) + '">' + (seen ? '✓ Visto il ' + esc(fmtDate(it.w.movie.t)) : 'Segna come visto') + '</button>' +
        (tracked ? '' : '<button class="btn" data-act="track" data-key="' + esc(it.key) + '" data-list="watchlist">Da vedere</button>') + '</div>';
      if (seen) h += reactionBar(it, 'movie');
    } else {
      h += '<div class="actions"><div class="seg" role="group" aria-label="Stato">' + Object.keys(LISTS).map((l) => '<button data-act="list" data-key="' + esc(it.key) + '" data-list="' + l + '" aria-pressed="' + (it.list === l) + '">' + LISTS[l] + '</button>').join('') + '</div></div>';
    }
    if (tracked) {
      h += '<div class="actions" style="align-items:center;justify-content:space-between"><div class="stars" role="group" aria-label="Voto">' + [1, 2, 3, 4, 5].map((n) => '<button class="' + (it.rating >= n ? 'on' : '') + '" data-act="rate" data-key="' + esc(it.key) + '" data-n="' + n + '" aria-label="' + n + ' stelle">★</button>').join('') + '</div>' +
        '<button class="btn sm" data-act="fav" data-key="' + esc(it.key) + '">' + (it.fav ? '★ Preferito' : '☆ Preferito') + '</button></div>';
    } else if (it.kind !== 'movie') {
      h += '<div class="actions"><button class="btn primary" style="flex:1" data-act="track" data-key="' + esc(it.key) + '" data-list="watching">Inizia a seguire</button><button class="btn" data-act="track" data-key="' + esc(it.key) + '" data-list="watchlist">Da vedere</button></div>';
    }

    if (m.summary) h += '<p class="syn clamp" data-act="syn">' + esc(m.summary) + '</p>';
    const kv = [['Titolo originale', m.alt && m.alt !== m.title ? m.alt : ''], [it.kind === 'anime' ? 'Studio' : it.kind === 'movie' ? 'Regia' : 'Rete', m.network], ['Generi', (m.genres || []).join(', ')],
      ['Durata', it.runtime ? it.runtime + ' min' : ''], ['Episodi', c && c.eps.length ? String(c.eps.length) : '']].filter((x) => x[1]);
    if (kv.length) h += '<dl class="kv">' + kv.map((x) => '<dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl>';

    if (relK.length) {
      h += '<section class="section"><header><h2>Stagioni collegate</h2></header><div class="hscroll">' + relK.map((e) => '<a class="poster" href="#/item/anime:' + e.node.id + '"><div class="img">' + img(https(e.node.coverImage && e.node.coverImage.large)) + '</div><div class="n">' + esc(e.node.title.english || e.node.title.romaji) + '</div><div class="y">' + (e.relationType === 'SEQUEL' ? 'Seguito' : 'Precedente') + '</div></a>').join('') + '</div></section>';
    }

    // episodi
    if (it.kind !== 'movie') {
      h += '<section class="section"><header><h2>Episodi</h2>' + (c ? '<span class="more">' + c.eps.filter((e) => Core.isWatched(it, e[0])).length + '/' + c.eps.length + ' visti</span>' : '') + '</header>';
      if (!c) h += '<div class="skel" style="height:140px"></div>';
      else if (!c.eps.length) h += '<div class="empty">Nessun episodio disponibile per ora.</div>';
      else {
        const ended = c.status === 'Ended';
        const bySeason = new Map();
        c.eps.forEach((e) => { if (!bySeason.has(e[1])) bySeason.set(e[1], []); bySeason.get(e[1]).push(e); });
        const seasons = [...bySeason.keys()];
        const nextEp = Core.nextUnwatched(it, c, now);
        const curSeason = nextEp ? nextEp[1] : seasons[seasons.length - 1];
        seasons.forEach((s) => {
          const eps = bySeason.get(s);
          const seen = eps.filter((e) => Core.isWatched(it, e[0])).length;
          const aired = eps.filter((e) => Core.aired(e, ended, now));
          const allSeen = aired.length > 0 && aired.every((e) => Core.isWatched(it, e[0]));
          const isOpen = openSeasons[it.key + ':' + s] != null ? openSeasons[it.key + ':' + s] : s === curSeason;
          h += '<details class="season" data-skey="' + esc(it.key + ':' + s) + '"' + (isOpen ? ' open' : '') + '><summary style="list-style:none"><header><h3>' + (it.kind === 'tv' ? 'Stagione ' + s : 'Episodi') + ' <span class="pg">' + seen + '/' + eps.length + '</span></h3>' +
            '<button class="btn sm" data-act="season" data-key="' + esc(it.key) + '" data-season="' + s + '" data-on="' + (!allSeen) + '">' + (allSeen ? 'Annulla tutti' : 'Segna visti') + '</button></header></summary>';
          eps.forEach((e) => {
            const seenE = Core.isWatched(it, e[0]);
            const out = Core.aired(e, ended, now);
            const rec = (it.w || {})[e[0]];
            h += '<div class="ep' + (out ? '' : ' future') + '"><span class="num">' + (it.kind === 'tv' ? pad(e[2]) : e[2]) + '</span><div class="body"><div class="t">' + esc(e[3] || 'Episodio ' + e[2]) + '</div><div class="s">' +
              (e[4] ? (out ? fmtDate(e[4] || now) : 'Esce ' + fmtDate(e[4]) + (e[4] % DAY ? ' alle ' + fmtTime(e[4]) : '')) : (out ? '' : 'Data da annunciare')) + '</div></div>' +
              (seenE ? '<button class="react" data-act="react" data-key="' + esc(it.key) + '" data-ep="' + esc(e[0]) + '" aria-label="Reazione">' + (rec && rec.r ? rec.r : '☺') + '</button>' : '') +
              '<button class="check" data-act="ep" data-key="' + esc(it.key) + '" data-ep="' + esc(e[0]) + '" aria-pressed="' + seenE + '" aria-label="' + (seenE ? 'Segna come non visto' : 'Segna come visto') + '"' + (out ? '' : ' disabled style="opacity:.35"') + '>' + IC.check + '</button></div>';
            if (openReact === it.key + '|' + e[0]) h += reactionBar(it, e[0]);
          });
          h += '</details>';
        });
      }
      h += '</section>';
    }

    if (tracked) {
      h += '<section class="section"><header><h2>Note personali</h2></header><textarea class="note" id="note" data-key="' + esc(it.key) + '" placeholder="Cosa ne pensi?">' + esc(it.note || '') + '</textarea>' +
        '<div class="actions" style="margin-top:16px"><button class="btn danger sm" data-act="remove" data-key="' + esc(it.key) + '">Rimuovi dalla libreria</button></div></section>';
    }
    view.innerHTML = h;
    view.scrollTop = keep;
    const note = $('#note');
    if (note) note.addEventListener('change', () => { const x = getItem(note.dataset.key); if (x) { x.note = note.value; x.u = Date.now(); persist(); } });
  }
  function reactionBar(it, ek) {
    const rec = (it.w || {})[ek];
    return '<div class="reactions">' + REACTIONS.map((r) => '<button class="' + (rec && rec.r === r ? 'on' : '') + '" data-act="pick" data-key="' + esc(it.key) + '" data-ep="' + esc(ek) + '" data-r="' + r + '">' + r + '</button>').join('') + '</div>';
  }

  /* ---------- Profilo ---------- */
  function vProfile() {
    const st = Core.stats(S.items);
    const t = Core.splitTime(st.minutes);
    const months = []; const d = new Date(); d.setDate(1);
    for (let i = 5; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push({ k: x.getFullYear() + '-' + pad(x.getMonth() + 1), l: x.toLocaleDateString('it-IT', { month: 'short' }) }); }
    const maxM = Math.max(1, ...months.map((m) => st.months[m.k] || 0));
    const genres = Object.entries(st.genres).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxG = Math.max(1, ...genres.map((g) => g[1]));
    const theme = rd(LTH, 'auto');
    const hrs = (m) => (m < 60 ? m + ' min' : Math.round(m / 60) + ' h');

    let h = '<div class="page-head"><div><h1>Profilo</h1><div class="sub">' + (sync.user ? '@' + esc(sync.user) : 'Dati salvati su questo dispositivo') + '</div></div></div>' +
      '<div class="timecard"><div class="lbl">Tempo passato a guardare</div><div class="big"><div>' + t.months + '<small>mesi</small></div><div>' + t.days + '<small>giorni</small></div><div>' + t.hours + '<small>ore</small></div></div></div>' +
      '<div class="tiles"><div class="tile"><b>' + st.episodes + '</b><span>episodi visti</span></div><div class="tile"><b>' + st.movies + '</b><span>film visti</span></div><div class="tile"><b>' + st.streak + '</b><span>giorni di fila</span></div></div>' +
      '<section class="section"><header><h2>Ultimi 6 mesi</h2></header><div class="card"><div class="months">' + months.map((m) => { const v = st.months[m.k] || 0; return '<div title="' + hrs(v) + '"><i style="height:' + Math.round((v / maxM) * 80) + 'px"></i><span>' + esc(m.l) + '</span></div>'; }).join('') + '</div></div></section>' +
      '<section class="section"><header><h2>Per tipo</h2></header><div class="card"><div class="hbars">' + Object.keys(KIND).map((k) => '<div><span>' + KIND[k] + '</span><span><i style="width:' + Math.round((st.byKind[k] / Math.max(1, st.minutes)) * 100) + '%"></i></span><em>' + hrs(st.byKind[k]) + '</em></div>').join('') + '</div></div></section>';
    if (genres.length) h += '<section class="section"><header><h2>Generi preferiti</h2></header><div class="card"><div class="hbars">' + genres.map((g) => '<div><span>' + esc(g[0]) + '</span><span><i style="width:' + Math.round((g[1] / maxG) * 100) + '%"></i></span><em>' + hrs(g[1]) + '</em></div>').join('') + '</div></div></section>';

    // account e sincronizzazione
    h += '<section class="section"><header><h2>Account e sincronizzazione</h2></header><div class="card">' +
      (sync.gist ? '<div><span class="status-dot on"></span><b>Collegato come @' + esc(sync.user) + '</b></div><p>' + (sync.last ? 'Ultima sincronizzazione: ' + esc(new Date(sync.last).toLocaleString('it-IT')) : 'Mai sincronizzato') + '. I dati stanno in un Gist privato del tuo account GitHub e si uniscono tra i tuoi dispositivi.</p>' +
        '<div class="actions"><button class="btn primary sm" data-act="syncnow">Sincronizza ora</button><button class="btn danger sm" data-act="disconnect">Scollega</button></div>'
        : '<div><span class="status-dot"></span><b>Non collegato</b></div><p>Per avere gli stessi dati su telefono e computer, collega il tuo account GitHub. Crea un token con il solo permesso “gist” su github.com/settings/tokens e incollalo qui. Resta salvato solo su questo dispositivo.</p>' +
        '<div class="field"><label for="tok">Token GitHub</label><input id="tok" type="password" autocomplete="off" placeholder="ghp_… o github_pat_…"></div><div class="actions"><button class="btn primary sm" data-act="connect">Collega account</button></div>') +
      '<p id="syncmsg" role="status"></p></div></section>';

    h += '<section class="section"><header><h2>Dati e aspetto</h2></header><div class="card"><div class="actions" style="margin-top:0"><button class="btn sm" data-act="export">Esporta copia (JSON)</button><label class="btn sm" for="imp">Importa copia</label><input id="imp" type="file" accept="application/json,.json" hidden></div>' +
      '<div class="seg" style="margin-top:12px" role="group" aria-label="Tema">' + [['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map((x) => '<button data-act="theme" data-val="' + x[0] + '" aria-pressed="' + (theme === x[0]) + '">' + x[1] + '</button>').join('') + '</div></div></section>' +
      '<p class="sub" style="margin:22px 0 0;text-align:center">Dati da TVmaze, AniList e Cinemeta (IMDb). TV Time 2.0 non è affiliata a nessuno di questi servizi.</p>';
    view.innerHTML = h;
    const imp = $('#imp');
    if (imp) imp.addEventListener('change', () => {
      const f = imp.files[0]; if (!f) return;
      f.text().then((t) => { const d = JSON.parse(t); if (!d || !d.items) throw new Error('formato'); S = Core.merge(S, d); wr(LS, S); persist(); toast('Copia importata: ' + items().length + ' titoli'); vProfile(); }).catch(() => toast('File non valido'));
    });
  }

  /* ---------- Sincronizzazione account (GitHub Gist) ---------- */
  async function gh(path, opt) {
    opt = opt || {};
    const r = await fetch('https://api.github.com' + path, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + sync.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, opt.headers || {}) }));
    if (!r.ok) throw new Error('GitHub ' + r.status);
    return r.json();
  }
  async function connect(token) {
    sync.token = token.trim();
    const u = await gh('/user');
    sync.user = u.login;
    const list = await gh('/gists?per_page=100');
    let g = list.find((x) => x.files && x.files['tvtime2.json']);
    if (!g) g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'TV Time 2.0 - i miei dati', public: false, files: { 'tvtime2.json': { content: JSON.stringify({ v: 1, items: {} }) } } }) });
    sync.gist = g.id; wr(LT, sync);
    await syncNow();
  }
  async function syncNow(silent) {
    if (!sync.gist) return;
    const g = await gh('/gists/' + sync.gist);
    const f = g.files && g.files['tvtime2.json'];
    let remote = { v: 1, items: {} };
    if (f) { const txt = f.truncated ? await (await fetch(f.raw_url)).text() : f.content; try { remote = JSON.parse(txt || '{}'); } catch (e) { /* file vuoto */ } }
    S = Core.merge(S, remote); wr(LS, S);
    await gh('/gists/' + sync.gist, { method: 'PATCH', body: JSON.stringify({ files: { 'tvtime2.json': { content: JSON.stringify(S) } } }) });
    sync.last = Date.now(); wr(LT, sync);
    if (!silent) render();
  }

  /* ---------- Toast ---------- */
  let toastTimer = 0;
  function toast(msg, label, fn) {
    const t = $('#toast'); t.hidden = false;
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (label ? '<button id="tbtn">' + esc(label) + '</button>' : '');
    if (label) $('#tbtn').onclick = () => { t.hidden = true; fn(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, label ? 6000 : 2600);
  }

  /* ---------- Eventi ---------- */
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.dataset && d.dataset.skey) openSeasons[d.dataset.skey] = d.open; }, true);
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, key = el.dataset.key;
    if (el.disabled) return;
    if (el.closest('summary') && act !== 'season') return;
    if (act === 'season') { ev.preventDefault(); ev.stopPropagation(); }
    switch (act) {
      case 'ep': {
        const ek = el.dataset.ep;
        const before = getItem(key);
        const had = before ? Object.assign({}, before.w[ek]) : null;
        const { it, on } = toggleEp(key, ek);
        const c = cache[key];
        const idx = c ? c.eps.findIndex((e) => e[0] === ek) : -1;
        const missing = on && c && idx > 0 && c.eps.slice(0, idx).some((e) => Core.aired(e, c.status === 'Ended') && !Core.isWatched(it, e[0]));
        if (missing) toast('Segnato come visto', 'Anche i precedenti', () => { markPrevious(key, ek); render(); });
        else if (on) toast('Segnato come visto', 'Annulla', () => { if (had && had.t) { it.w[ek] = had; } else { Core.setWatched(it, ek, false); } afterWatch(it); persist(); render(); });
        render(); break;
      }
      case 'movie': {
        let it = getItem(key) || track(metaCache[key], 'watchlist');
        Core.setWatched(it, 'movie', !Core.isWatched(it, 'movie')); afterWatch(it); persist();
        if (Core.isWatched(it, 'movie')) openReact = key + '|movie'; render(); break;
      }
      case 'track': track(metaCache[key], el.dataset.list); render(); toast('Aggiunto alla libreria'); break;
      case 'quick': {
        if (getItem(key)) { untrack(key); toast('Rimosso dalla libreria'); } else { track(metaCache[key], 'watchlist'); toast('Aggiunto a “Da vedere”'); }
        const box = el.closest('.row'); if (box) { const m = metaCache[key]; el.outerHTML = quickBtn(m); } break;
      }
      case 'list': { const it = getItem(key) || track(metaCache[key], el.dataset.list); setList(it, el.dataset.list); render(); break; }
      case 'fav': { const it = getItem(key); it.fav = !it.fav; it.u = Date.now(); persist(); render(); break; }
      case 'rate': { const it = getItem(key); const n = +el.dataset.n; it.rating = it.rating === n ? 0 : n; it.u = Date.now(); persist(); render(); break; }
      case 'season': markSeason(key, +el.dataset.season, el.dataset.on === 'true'); render(); break;
      case 'react': { const k = key + '|' + el.dataset.ep; openReact = openReact === k ? '' : k; render(); break; }
      case 'pick': { const it = getItem(key); Core.setReaction(it, el.dataset.ep, el.dataset.r); persist(); openReact = ''; render(); break; }
      case 'remove': untrack(key); toast('Rimosso dalla libreria'); location.hash = '#/library'; break;
      case 'syn': el.classList.toggle('clamp'); break;
      case 'chip': {
        const g = el.dataset.group, v = el.dataset.val;
        if (g === 'cal') calFilter = v; else if (g === 'libKind') { libKind = v; libList = 'all'; } else if (g === 'libList') libList = v; else if (g === 'search') sFilter = v;
        render(); break;
      }
      case 'connect': {
        const tok = $('#tok').value.trim(); const msg = $('#syncmsg');
        if (!tok) { msg.textContent = 'Incolla prima il token.'; break; }
        msg.textContent = 'Collegamento in corso…'; el.disabled = true;
        try { await connect(tok); toast('Account collegato'); } catch (e) { sync.token = ''; sync.gist = ''; msg.textContent = 'Non riesco a collegarmi. Controlla che il token abbia il permesso “gist”.'; el.disabled = false; }
        break;
      }
      case 'syncnow': { const msg = $('#syncmsg'); msg.textContent = 'Sincronizzazione…'; try { await syncNow(); toast('Sincronizzato'); } catch (e) { msg.textContent = 'Sincronizzazione non riuscita. Riprova.'; } break; }
      case 'disconnect': sync = { token: '', gist: '', user: '', last: 0 }; wr(LT, sync); render(); toast('Account scollegato'); break;
      case 'export': {
        const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tv-time-2-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove(); break;
      }
      case 'theme': { wr(LTH, el.dataset.val); applyTheme(); vProfile(); break; }
      default: break;
    }
  });

  function applyTheme() {
    const t = rd(LTH, 'auto'); const r = document.documentElement;
    if (t === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0f0f12';
  }

  // locandina mancante: toglie l'immagine rotta e lascia il segnaposto grigio
  document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.remove(); }, true);

  /* ---------- Avvio ---------- */
  applyTheme();
  render();
  refreshAll();
  if (sync.gist) syncNow(true).then(() => render()).catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__tvt = { get S() { return S; }, get cache() { return cache; }, Core };
})();
