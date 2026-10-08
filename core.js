/* TV Time 2.0 - logica pura (nessun accesso al DOM), testabile in Node */
(function (root) {
  'use strict';
  const Core = {};
  const DAY = 86400000;

  Core.keyOf = (kind, id) => kind + ':' + id;

  // Un episodio visto: w[epKey] = { t: timestamp (0 = non visto), r: reazione, u: ultimo aggiornamento }
  Core.isWatched = (it, ek) => !!(it.w && it.w[ek] && it.w[ek].t > 0);

  Core.setWatched = function (it, ek, on, now) {
    now = now || Date.now();
    it.w = it.w || {};
    const prev = it.w[ek] || {};
    it.w[ek] = { t: on ? now : 0, r: prev.r || null, u: now };
    it.u = now;
  };

  Core.setReaction = function (it, ek, r, now) {
    now = now || Date.now();
    it.w = it.w || {};
    const prev = it.w[ek] || { t: 0 };
    it.w[ek] = { t: prev.t, r: prev.r === r ? null : r, u: now };
    it.u = now;
  };

  Core.watchedCount = (it) => Object.values(it.w || {}).filter((x) => x.t > 0).length;

  // Episodio di cache: [chiave, stagione, numero, titolo, timestampUscita(ms), durata]
  // ts === 0  -> gia' uscito (orario sconosciuto); ts === null -> data sconosciuta
  Core.aired = function (ep, ended, now) {
    now = now || Date.now();
    const ts = ep[4];
    if (ts === 0) return true;
    if (ts == null) return !!ended;
    return ts <= now;
  };

  Core.nextUnwatched = function (it, cached, now) {
    if (!cached) return null;
    const ended = cached.status === 'Ended';
    for (const ep of cached.eps) {
      if (Core.aired(ep, ended, now) && !Core.isWatched(it, ep[0])) return ep;
    }
    return null;
  };

  Core.remaining = function (it, cached, now) {
    if (!cached) return 0;
    const ended = cached.status === 'Ended';
    return cached.eps.filter((ep) => Core.aired(ep, ended, now) && !Core.isWatched(it, ep[0])).length;
  };

  Core.progress = function (it, cached) {
    if (it.kind === 'movie') return Core.isWatched(it, 'movie') ? 1 : 0;
    const total = (cached && cached.eps.length) || it.total || 0;
    if (!total) return 0;
    const seen = cached ? cached.eps.filter((e) => Core.isWatched(it, e[0])).length : Core.watchedCount(it);
    return Math.min(1, seen / total);
  };

  Core.isFinished = function (it, cached) {
    if (!cached || cached.status !== 'Ended' || !cached.eps.length) return false;
    return cached.eps.every((e) => Core.isWatched(it, e[0]));
  };

  // Prossime uscite di un titolo seguito
  Core.upcoming = function (it, cached, now, horizonDays) {
    if (!cached) return [];
    now = now || Date.now();
    const lim = now + (horizonDays || 30) * DAY;
    return cached.eps.filter((e) => e[4] && e[4] > now && e[4] <= lim);
  };

  // Unione di due stati (per la sincronizzazione): vince l'ultima modifica, episodio per episodio
  Core.merge = function (a, b) {
    const out = { v: 1, items: {} };
    const A = (a && a.items) || {};
    const B = (b && b.items) || {};
    const keys = new Set(Object.keys(A).concat(Object.keys(B)));
    keys.forEach((k) => {
      const x = A[k], y = B[k];
      if (!x || !y) { out.items[k] = x || y; return; }
      const newer = (x.u || 0) >= (y.u || 0) ? x : y;
      const older = newer === x ? y : x;
      const m = Object.assign({}, older, newer);
      const w = {};
      const ek = new Set(Object.keys(x.w || {}).concat(Object.keys(y.w || {})));
      ek.forEach((e) => {
        const p = (x.w || {})[e], q = (y.w || {})[e];
        w[e] = !p ? q : !q ? p : ((p.u || 0) >= (q.u || 0) ? p : q);
      });
      m.w = w;
      out.items[k] = m;
    });
    return out;
  };

  // Statistiche del profilo
  Core.stats = function (items, now) {
    now = now || Date.now();
    const list = Object.values(items).filter((i) => !i.deleted);
    const s = { episodes: 0, movies: 0, minutes: 0, shows: 0, anime: 0, byKind: { tv: 0, anime: 0, movie: 0 }, genres: {}, months: {}, streak: 0 };
    const days = new Set();
    list.forEach((it) => {
      if (it.kind === 'tv') s.shows++;
      if (it.kind === 'anime') s.anime++;
      Object.keys(it.w || {}).forEach((ek) => {
        const rec = it.w[ek];
        if (!(rec.t > 0)) return;
        const mins = it.runtime || (it.kind === 'anime' ? 24 : it.kind === 'movie' ? 110 : 42);
        s.minutes += mins;
        s.byKind[it.kind] += mins;
        if (it.kind === 'movie') s.movies++; else s.episodes++;
        const d = new Date(rec.t);
        const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        s.months[mk] = (s.months[mk] || 0) + mins;
        days.add(d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate());
        (it.genres || []).forEach((g) => { s.genres[g] = (s.genres[g] || 0) + mins; });
      });
    });
    // serie di giorni consecutivi fino a oggi (o ieri)
    let cur = new Date(now);
    const key = (d) => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    if (!days.has(key(cur))) cur = new Date(now - DAY);
    while (days.has(key(cur))) { s.streak++; cur = new Date(cur.getTime() - DAY); }
    return s;
  };

  // minuti -> { mesi, giorni, ore } come nel "tempo trascorso" di TV Time
  Core.splitTime = function (minutes) {
    const h = Math.floor(minutes / 60);
    const months = Math.floor(h / (24 * 30));
    const days = Math.floor((h - months * 24 * 30) / 24);
    const hours = h - months * 24 * 30 - days * 24;
    return { months, days, hours };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);
