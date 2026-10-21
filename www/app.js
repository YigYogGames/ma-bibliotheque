/* Ma Bibliothèque — logique de l'application (sans framework, pour rester simple) */
(function () {
  'use strict';

  // ---------- Stockage ----------
  const KEY = 'mabiblio.v1';
  const defaultState = () => ({
    books: [],
    releases: [],          // sorties trouvées ou ajoutées à la main
    dismissed: [],         // sorties masquées par l'utilisateur (clé série|tome)
    settings: { theme: 'bois', layout: 'shelf', sort: 'added' },
    lastCheck: null,
  });
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { return defaultState(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast("Impossible d'enregistrer"); }
  }

  // ---------- Outils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // Dates partielles de Google Books : "2026", "2026-11", "2026-11-14"
  function dateKey(d) {
    if (!d) return '9999-99-99';
    const p = String(d).split('-');
    return [p[0] || '9999', (p[1] || '12').padStart(2, '0'), (p[2] || '28').padStart(2, '0')].join('-');
  }
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function fmtDate(d) {
    if (!d) return 'Date inconnue';
    const p = String(d).split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return MONTHS[+p[1] - 1] + ' ' + p[0];
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }

  // Détection « Série + numéro de tome » à partir du titre
  function parseSeries(title, subtitle) {
    const full = [title, subtitle].filter(Boolean).join(' - ');
    let m = full.match(/^(.*?)[\s,.:\-–—(]*\b(?:tome|tomes|t\.|t|vol\.?|volume|volumes|n°|no\.?|num[ée]ro|#)\s*(\d{1,4})\b/i);
    if (m && m[1].trim().length > 1) return { series: clean(m[1]), volume: +m[2] };
    m = full.match(/^(.*?)[\s,.:\-–—#]+(\d{1,3})\s*$/);
    if (m && m[1].trim().length > 1) return { series: clean(m[1]), volume: +m[2] };
    return { series: '', volume: null };
    function clean(s) { return s.replace(/[\s,.:\-–—(]+$/, '').trim(); }
  }

  // ---------- Recherche d'un livre par ISBN ----------
  function cleanIsbn(s) { return String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase(); }
  function isbn10to13(i) {
    const core = '978' + i.slice(0, 9);
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += (+core[k]) * (k % 2 ? 3 : 1);
    return core + ((10 - (sum % 10)) % 10);
  }
  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function httpsify(u) { return u ? u.replace(/^http:/, 'https:').replace('&edge=curl', '') : ''; }

  function fromGoogle(v, isbn) {
    const i = v.volumeInfo || {};
    const ids = i.industryIdentifiers || [];
    const i13 = (ids.find((x) => x.type === 'ISBN_13') || {}).identifier;
    const img = i.imageLinks || {};
    const ps = parseSeries(i.title, i.subtitle);
    return {
      isbn: i13 || isbn || '',
      title: [i.title, i.subtitle].filter(Boolean).join(' – '),
      authors: (i.authors || []).join(', '),
      publisher: i.publisher || '',
      publishedDate: i.publishedDate || '',
      pages: i.pageCount || null,
      description: (i.description || '').replace(/<[^>]+>/g, ''),
      cover: httpsify(img.thumbnail || img.smallThumbnail || ''),
      series: ps.series, volume: ps.volume,
    };
  }

  async function lookupIsbn(raw) {
    let isbn = cleanIsbn(raw);
    if (isbn.length === 10) isbn = isbn10to13(isbn);
    // 1) Google Books
    try {
      const g = await getJSON('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn);
      if (g.items && g.items.length) {
        const b = fromGoogle(g.items[0], isbn);
        if (!b.cover) b.cover = 'https://covers.openlibrary.org/b/isbn/' + isbn + '-M.jpg?default=false';
        return b;
      }
    } catch (e) { /* on essaie la suite */ }
    // 2) Open Library
    try {
      const o = await getJSON('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data');
      const d = o['ISBN:' + isbn];
      if (d) {
        const ps = parseSeries(d.title, d.subtitle);
        return {
          isbn, title: [d.title, d.subtitle].filter(Boolean).join(' – '),
          authors: (d.authors || []).map((a) => a.name).join(', '),
          publisher: (d.publishers || []).map((p) => p.name).join(', '),
          publishedDate: d.publish_date || '', pages: d.number_of_pages || null,
          description: '', cover: d.cover ? httpsify(d.cover.medium || d.cover.large || '') : '',
          series: ps.series, volume: ps.volume,
        };
      }
    } catch (e) { /* rien */ }
    return null;
  }

  // ---------- Couvertures ----------
  function hashColor(s) {
    let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 30) % 360} 50% 24%))`;
  }
  function coverHTML(b) {
    const fake = `<div class="fake-cover" style="background:${hashColor(b.series || b.title)}"><div class="fc-title">${esc(b.title || 'Sans titre')}</div><div class="fc-author">${esc(b.authors || '')}</div></div>`;
    if (!b.cover) return fake;
    return `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(fake)}">`;
  }

  // ---------- Navigation ----------
  const TITLES = { library: 'Ma bibliothèque', series: 'Mes séries', releases: 'Sorties prévues', settings: 'Réglages' };
  let currentView = 'library';
  function show(view) {
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('#viewTitle').textContent = TITLES[view];
    window.scrollTo(0, 0);
    render();
  }

  // ---------- Rendu ----------
  function render() {
    renderSub();
    if (currentView === 'library') renderLibrary();
    if (currentView === 'series') renderSeries();
    if (currentView === 'releases') renderReleases();
    if (currentView === 'settings') renderSettings();
    renderBadge();
  }
  function renderSub() {
    const n = state.books.length;
    const s = seriesList().length;
    const sub = {
      library: n ? `${n} livre${n > 1 ? 's' : ''}` : '',
      series: s ? `${s} série${s > 1 ? 's' : ''}` : '',
      releases: 'Les prochains tomes de tes séries',
      settings: '',
    }[currentView];
    $('#viewSub').textContent = sub || '';
  }

  function sortedBooks() {
    const q = norm($('#searchInput').value);
    let list = state.books.filter((b) => !q || norm([b.title, b.authors, b.series, b.publisher, b.isbn].join(' ')).includes(q));
    const by = state.settings.sort;
    const cmp = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' });
    list.sort((a, b) => {
      if (by === 'title') return cmp(a.title, b.title);
      if (by === 'author') return cmp(a.authors || '~', b.authors || '~') || cmp(a.title, b.title);
      if (by === 'series') return cmp(a.series || a.title, b.series || b.title) || (a.volume || 0) - (b.volume || 0);
      if (by === 'date') return dateKey(b.publishedDate).localeCompare(dateKey(a.publishedDate));
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    return list;
  }

  function renderLibrary() {
    const el = $('#libraryContent');
    $('#sortSelect').value = state.settings.sort;
    $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.settings.layout));
    if (!state.books.length) {
      el.innerHTML = `<div class="empty"><div class="big">📖</div><h2>Ta bibliothèque est vide</h2>
        <p>Appuie sur le gros bouton au centre en bas pour scanner le code-barres au dos d'un livre.</p></div>`;
      return;
    }
    const list = sortedBooks();
    if (!list.length) { el.innerHTML = `<div class="empty"><p>Aucun livre ne correspond à ta recherche.</p></div>`; return; }

    if (state.settings.layout === 'list') {
      el.innerHTML = '<div class="list">' + list.map((b) => `
        <div class="list-item" data-id="${b.id}">
          <div class="thumb">${coverHTML(b)}</div>
          <div class="li-main"><div class="li-title">${esc(b.title)}</div>
          <div class="li-sub">${esc([b.authors, b.series && (b.series + (b.volume ? ' · T' + b.volume : ''))].filter(Boolean).join(' — '))}</div></div>
        </div>`).join('') + '</div>';
    } else {
      const cols = Math.max(3, Math.floor((Math.min(window.innerWidth, 900) - 40) / 112));
      let html = '<div class="shelf">';
      for (let i = 0; i < list.length; i += cols) {
        html += `<div class="shelf-row" style="--cols:${cols}">` + list.slice(i, i + cols).map((b) =>
          `<div class="book" data-id="${b.id}">${coverHTML(b)}${b.volume ? `<span class="vol-tag">${b.volume}</span>` : ''}</div>`).join('') +
          '</div><div class="shelf-plank"></div>';
      }
      el.innerHTML = html + '</div>';
    }
  }

  function seriesList() {
    const map = new Map();
    for (const b of state.books) {
      if (!b.series) continue;
      const k = norm(b.series);
      if (!map.has(k)) map.set(k, { key: k, name: b.series, books: [] });
      map.get(k).books.push(b);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  function renderSeries() {
    const el = $('#seriesContent');
    const list = seriesList();
    if (!list.length) {
      el.innerHTML = `<div class="empty"><div class="big">🗂️</div><h2>Aucune série pour l'instant</h2>
        <p>Quand tu ajoutes un livre qui fait partie d'une série (ex. « One Piece – Tome 12 »), il apparaît ici automatiquement. Tu peux aussi corriger la série d'un livre en le touchant.</p></div>`;
      return;
    }
    el.innerHTML = list.map((s) => {
      const vols = [...new Set(s.books.map((b) => b.volume).filter((v) => v))].sort((a, b) => a - b);
      const max = vols.length ? vols[vols.length - 1] : 0;
      const missing = [];
      for (let v = 1; v < max; v++) if (!vols.includes(v)) missing.push(v);
      const nextRel = state.releases.filter((r) => norm(r.series) === s.key && r.date && dateKey(r.date) >= todayKey())
        .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))[0];
      let strip = '';
      if (max && max <= 120) {
        for (let v = 1; v <= max; v++) strip += `<span class="vol ${vols.includes(v) ? 'own' : 'miss'}">${v}</span>`;
        strip += `<span class="vol next">${max + 1}?</span>`;
      } else if (vols.length) {
        strip = vols.map((v) => `<span class="vol own">${v}</span>`).join('');
      }
      const noVol = s.books.filter((b) => !b.volume).length;
      return `<div class="series-card">
        <div class="series-head"><div class="series-name">${esc(s.name)}</div><div class="muted small">${s.books.length} livre${s.books.length > 1 ? 's' : ''}</div></div>
        ${strip ? `<div class="vol-strip">${strip}</div>` : ''}
        <div class="muted small" style="margin-top:8px">
          ${missing.length ? `Il te manque : ${missing.length > 12 ? missing.length + ' tomes' : 'T' + missing.join(', T')}.` : (max ? 'Tu as tous les tomes jusqu’au ' + max + '.' : '')}
          ${noVol ? ` ${noVol} sans numéro de tome.` : ''}
          ${nextRel ? `<br>📅 Prochain : <b>${nextRel.volume ? 'T' + nextRel.volume : esc(nextRel.title)}</b> le ${fmtDate(nextRel.date)}` : ''}
        </div></div>`;
    }).join('');
  }

  function visibleReleases() {
    const dismissed = new Set(state.dismissed);
    return state.releases.filter((r) => !dismissed.has(relKey(r)) && !ownsVolume(r.series, r.volume, r.isbn));
  }
  function relKey(r) { return norm(r.series) + '|' + (r.volume || norm(r.title)); }
  function ownsVolume(series, volume, isbn) {
    return state.books.some((b) => (isbn && b.isbn === isbn) || (volume && b.volume === volume && norm(b.series) === norm(series)));
  }

  function renderReleases() {
    const el = $('#releasesContent');
    $('#lastCheck').textContent = state.lastCheck ? 'Dernière recherche : ' + new Date(state.lastCheck).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    if (!seriesList().length) {
      el.innerHTML = `<div class="empty"><div class="big">📅</div><h2>Pas encore de série</h2><p>Ajoute des livres qui font partie d'une série, puis reviens ici : je chercherai les prochains tomes et leurs dates de sortie.</p></div>`;
      return;
    }
    const all = visibleReleases();
    const today = todayKey();
    const upcoming = all.filter((r) => dateKey(r.date) >= today && r.date).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    const past = all.filter((r) => r.date && dateKey(r.date) < today).sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
    const nodate = all.filter((r) => !r.date);
    if (!all.length) {
      el.innerHTML = `<div class="empty"><p>${state.lastCheck ? 'Aucune nouvelle sortie trouvée pour tes séries. Tu peux en ajouter une à la main si tu connais la date.' : 'Appuie sur « Chercher les nouveautés » pour trouver les prochains tomes de tes séries.'}</p></div>`;
      return;
    }
    const row = (r, isPast) => {
      const p = String(r.date || '').split('-');
      const d = p[2] ? +p[2] : (p[1] ? '' : '');
      const m = p[1] ? MONTHS[+p[1] - 1] : '';
      return `<div class="rel" data-rel="${r.id}">
        <div class="rel-date ${isPast ? 'past' : ''}"><div class="d">${d || (p[0] ? '' : '?')}</div><div class="m">${m}${p[0] ? '<br>' + p[0] : ''}</div></div>
        ${r.cover ? `<div class="thumb"><img src="${esc(r.cover)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>` : ''}
        <div class="li-main"><div class="li-title">${esc(r.series)}${r.volume ? ' — Tome ' + r.volume : ''}</div>
          <div class="li-sub">${esc(r.title || '')}${r.manual ? (r.title ? ' · ' : '') + 'ajouté à la main' : ''}</div></div>
        <button class="rel-x" data-dismiss="${r.id}" aria-label="Masquer">✕</button>
      </div>`;
    };
    el.innerHTML =
      (upcoming.length ? `<div class="rel-group-title">À venir</div>` + upcoming.map((r) => row(r, false)).join('') : '') +
      (past.length ? `<div class="rel-group-title">Déjà parus — pas encore dans ta bibliothèque</div>` + past.map((r) => row(r, true)).join('') : '') +
      (nodate.length ? `<div class="rel-group-title">Date inconnue</div>` + nodate.map((r) => row(r, true)).join('') : '');
  }

  function renderBadge() {
    const today = todayKey();
    const n = visibleReleases().filter((r) => r.date && dateKey(r.date) >= today).length;
    const b = $('#releaseBadge');
    b.hidden = !n; b.textContent = n;
  }

  function renderSettings() {
    $$('.theme-chip').forEach((c) => c.classList.toggle('active', c.dataset.themePick === state.settings.theme));
  }

  function applyTheme() {
    document.body.dataset.theme = state.settings.theme;
    const bg = getComputedStyle(document.body).getPropertyValue('--bg2').trim();
    $('meta[name="theme-color"]').setAttribute('content', bg || '#1f1712');
  }

  // ---------- Feuille modale ----------
  function openSheet(html) {
    $('#sheetBody').innerHTML = html;
    $('#sheetBackdrop').hidden = false;
  }
  function closeSheet() { $('#sheetBackdrop').hidden = true; $('#sheetBody').innerHTML = ''; }

  function bookForm(b, { isNew }) {
    return `<h2>${isNew ? 'Ajouter ce livre ?' : 'Modifier le livre'}</h2>
      ${isNew && b.cover ? `<div class="detail-top" style="margin-bottom:12px"><div class="detail-cover">${coverHTML(b)}</div><div class="detail-meta"><div class="kv">ISBN <b>${esc(b.isbn)}</b></div><div class="kv">${esc(b.publisher || '')}</div><div class="kv">${b.publishedDate ? 'Paru : ' + fmtDate(b.publishedDate) : ''}</div></div></div>` : ''}
      <form class="form" id="bookForm" autocomplete="off">
        <label>Titre<input type="text" name="title" value="${esc(b.title)}" required></label>
        <label>Auteur(s)<input type="text" name="authors" value="${esc(b.authors)}"></label>
        <div class="two">
          <label>Série<input type="text" name="series" value="${esc(b.series)}" list="seriesNames" placeholder="ex. One Piece"></label>
          <label>Tome n°<input type="number" name="volume" min="0" inputmode="numeric" value="${b.volume ?? ''}"></label>
        </div>
        <datalist id="seriesNames">${seriesList().map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>
        <div class="two">
          <label>Éditeur<input type="text" name="publisher" value="${esc(b.publisher)}"></label>
          <label>Parution<input type="text" name="publishedDate" value="${esc(b.publishedDate)}" placeholder="AAAA-MM-JJ"></label>
        </div>
        <label>ISBN<input type="text" name="isbn" inputmode="numeric" value="${esc(b.isbn)}"></label>
        <div class="sheet-actions">
          <button class="btn primary block" type="submit">${isNew ? '＋ Ajouter à ma bibliothèque' : 'Enregistrer'}</button>
          ${isNew ? '<button class="btn block" type="button" data-act="scan-again">Annuler et scanner un autre</button>' : ''}
          <button class="btn ghost block" type="button" data-act="close">Annuler</button>
        </div>
      </form>`;
  }

  function wireBookForm(b, isNew) {
    $('#bookForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const upd = {
        title: f.get('title').trim(), authors: f.get('authors').trim(), series: f.get('series').trim(),
        volume: f.get('volume') ? +f.get('volume') : null, publisher: f.get('publisher').trim(),
        publishedDate: f.get('publishedDate').trim(), isbn: cleanIsbn(f.get('isbn')),
      };
      if (!upd.title) return toast('Il faut au moins un titre');
      if (isNew) {
        state.books.push(Object.assign({}, b, upd, { id: uid(), addedAt: Date.now() }));
        save(); closeSheet(); render();
        afterAdd(upd);
      } else {
        Object.assign(b, upd); save(); closeSheet(); render(); toast('Modifications enregistrées');
      }
    });
  }

  function afterAdd(b) {
    openSheet(`<h2>✅ Ajouté !</h2><p class="muted">« ${esc(b.title)} » est maintenant dans ta bibliothèque.</p>
      <div class="sheet-actions"><button class="btn primary block" data-act="scan-again">Scanner un autre livre</button>
      <button class="btn ghost block" data-act="close">Terminé</button></div>`);
  }

  function openBook(id) {
    const b = state.books.find((x) => x.id === id);
    if (!b) return;
    openSheet(`<div class="detail-top"><div class="detail-cover">${coverHTML(b)}</div>
      <div class="detail-meta"><h2>${esc(b.title)}</h2>
        <div class="kv">${esc(b.authors || 'Auteur inconnu')}</div>
        ${b.series ? `<div class="kv">Série : <b>${esc(b.series)}</b>${b.volume ? ' · Tome <b>' + b.volume + '</b>' : ''}</div>` : ''}
        ${b.publisher ? `<div class="kv">${esc(b.publisher)}</div>` : ''}
        ${b.publishedDate ? `<div class="kv">Paru : ${fmtDate(b.publishedDate)}</div>` : ''}
        ${b.pages ? `<div class="kv">${b.pages} pages</div>` : ''}
        ${b.isbn ? `<div class="kv">ISBN ${esc(b.isbn)}</div>` : ''}
      </div></div>
      ${b.description ? `<div class="desc">${esc(b.description)}</div>` : ''}
      <div class="sheet-actions">
        <button class="btn block" data-act="edit" data-id="${b.id}">✏️ Modifier</button>
        <button class="btn danger block" data-act="delete" data-id="${b.id}">🗑️ Retirer de ma bibliothèque</button>
        <button class="btn ghost block" data-act="close">Fermer</button>
      </div>`);
  }

  // ---------- Scan ----------
  async function startScan() {
    const BS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if (!isNative() || !BS) { askIsbn('Le scanner fonctionne dans l’application sur téléphone. Ici, tape l’ISBN (le numéro sous le code-barres) :'); return; }
    try {
      const avail = await BS.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: true }));
      if (!avail.available) {
        openSheet(`<h2>Préparation du scanner…</h2><p class="muted">Première utilisation : ton téléphone télécharge le module de scan (quelques secondes, il faut Internet).</p><div class="spinner"></div>`);
        await installScannerModule(BS);
        closeSheet();
      }
      const res = await BS.scan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'] });
      const code = res && res.barcodes && res.barcodes[0] && (res.barcodes[0].rawValue || res.barcodes[0].displayValue);
      if (code) handleCode(code);
    } catch (e) {
      const msg = String(e && (e.message || e)).toLowerCase();
      if (msg.includes('cancel')) return;
      askIsbn('Le scanner n’a pas pu démarrer. Tu peux taper l’ISBN (le numéro sous le code-barres) :');
    }
  }

  function installScannerModule(BS) {
    return new Promise(async (resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const h = await BS.addListener('googleBarcodeScannerModuleInstallProgress', (ev) => {
          if (ev.state === 4 || ev.state === 5 || ev.state === 3) { h && h.remove && h.remove(); finish(); }
        });
        await BS.installGoogleBarcodeScannerModule();
      } catch (e) { finish(); }
      setTimeout(finish, 45000);
    });
  }

  function askIsbn(intro) {
    openSheet(`<h2>Saisir un ISBN</h2><p class="muted small">${esc(intro || 'Tape le numéro à 13 chiffres sous le code-barres (commence souvent par 978).')}</p>
      <form class="form" id="isbnForm"><input type="text" name="isbn" inputmode="numeric" placeholder="978…" autofocus>
      <div class="sheet-actions"><button class="btn primary block" type="submit">Rechercher</button>
      <button class="btn ghost block" type="button" data-act="close">Annuler</button></div></form>`);
    $('#isbnForm').addEventListener('submit', (e) => { e.preventDefault(); handleCode(new FormData(e.target).get('isbn')); });
    setTimeout(() => { const i = $('#isbnForm input'); i && i.focus(); }, 150);
  }

  async function handleCode(code) {
    const isbn = cleanIsbn(code);
    if (isbn.length !== 13 && isbn.length !== 10) { toast('Ce code ne ressemble pas à un ISBN'); return; }
    const n13 = isbn.length === 10 ? isbn10to13(isbn) : isbn;
    const dup = state.books.find((b) => b.isbn === n13);
    if (dup) {
      openSheet(`<h2>Déjà dans ta bibliothèque 👍</h2><p class="muted">« ${esc(dup.title)} »</p>
        <div class="sheet-actions"><button class="btn primary block" data-act="scan-again">Scanner un autre livre</button>
        <button class="btn block" data-act="open" data-id="${dup.id}">Voir le livre</button>
        <button class="btn ghost block" data-act="close">Fermer</button></div>`);
      return;
    }
    openSheet(`<h2>Recherche du livre…</h2><p class="muted small">ISBN ${esc(n13)}</p><div class="spinner"></div>`);
    const found = await lookupIsbn(n13);
    const b = found || { isbn: n13, title: '', authors: '', publisher: '', publishedDate: '', cover: '', series: '', volume: null };
    // Si une série existante ressemble, on reprend son nom exact
    if (b.series) {
      const ex = seriesList().find((s) => s.key === norm(b.series));
      if (ex) b.series = ex.name;
    }
    openSheet((found ? '' : `<p class="muted small">Je n’ai pas trouvé ce livre automatiquement. Remplis les infos toi-même :</p>`) + bookForm(b, { isNew: true }));
    wireBookForm(b, true);
  }

  // ---------- Recherche des sorties ----------
  async function checkReleases() {
    const series = seriesList();
    if (!series.length) { toast('Ajoute d’abord des livres d’une série'); return; }
    const btn = $('#checkReleasesBtn');
    btn.disabled = true;
    const keepManual = state.releases.filter((r) => r.manual);
    const found = [];
    let i = 0, errors = 0;
    for (const s of series) {
      i++;
      btn.textContent = `Recherche… ${i}/${series.length}`;
      const vols = s.books.map((b) => b.volume).filter(Boolean);
      const maxOwned = vols.length ? Math.max(...vols) : 0;
      const ownedIsbn = new Set(s.books.map((b) => b.isbn));
      try {
        const q = 'intitle:' + JSON.stringify(s.name);
        const url = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&orderBy=newest&maxResults=40&printType=books';
        const data = await getJSON(url);
        const byVol = new Map();
        for (const it of data.items || []) {
          const b = fromGoogle(it);
          if (!b.series || norm(b.series) !== s.key || !b.volume) continue;
          if (b.volume <= maxOwned && vols.includes(b.volume)) continue;
          if (ownedIsbn.has(b.isbn)) continue;
          if (b.volume < maxOwned) continue; // les trous sont déjà visibles dans « Séries »
          const prev = byVol.get(b.volume);
          // on garde l'édition la plus récente et datée
          if (!prev || dateKey(b.publishedDate) > dateKey(prev.date)) {
            byVol.set(b.volume, { id: uid(), series: s.name, volume: b.volume, title: b.title, date: b.publishedDate, isbn: b.isbn, cover: b.cover });
          }
        }
        found.push(...byVol.values());
      } catch (e) { errors++; }
      await new Promise((r) => setTimeout(r, 350)); // on reste poli avec le service
    }
    state.releases = keepManual.concat(found.filter((f) => !keepManual.some((m) => relKey(m) === relKey(f))));
    state.lastCheck = Date.now();
    save();
    btn.disabled = false; btn.textContent = '↻ Chercher les nouveautés';
    render();
    const up = visibleReleases().filter((r) => r.date && dateKey(r.date) >= todayKey()).length;
    if (errors === series.length) toast('Pas de connexion Internet ?');
    else toast(up ? `${up} sortie${up > 1 ? 's' : ''} à venir trouvée${up > 1 ? 's' : ''} 🎉` : 'Recherche terminée');
  }

  function addReleaseManually() {
    const names = seriesList();
    openSheet(`<h2>Ajouter une sortie</h2><p class="muted small">Tu connais la date d'un prochain tome ? Note-la ici.</p>
      <form class="form" id="relForm">
        <label>Série<input type="text" name="series" list="relSeries" required></label>
        <datalist id="relSeries">${names.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>
        <div class="two"><label>Date de sortie<input type="date" name="date" required></label>
        <label>Tome n°<input type="number" name="volume" min="0" inputmode="numeric"></label></div>
        <label>Titre (facultatif)<input type="text" name="title"></label>
        <div class="sheet-actions"><button class="btn primary block" type="submit">Ajouter</button>
        <button class="btn ghost block" type="button" data-act="close">Annuler</button></div>
      </form>`);
    $('#relForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      state.releases.push({ id: uid(), manual: true, series: f.get('series').trim(), date: f.get('date'), volume: f.get('volume') ? +f.get('volume') : null, title: f.get('title').trim(), cover: '' });
      save(); closeSheet(); render(); toast('Sortie ajoutée');
    });
  }

  // ---------- Sauvegarde ----------
  async function exportData() {
    const json = JSON.stringify({ app: 'ma-bibliotheque', version: 1, exportedAt: new Date().toISOString(), books: state.books, releases: state.releases.filter((r) => r.manual) }, null, 2);
    const name = 'ma-bibliotheque-' + todayKey() + '.json';
    // Dans l'application : on écrit le fichier puis on ouvre le menu « Partager » (Drive, mail, WhatsApp…)
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (isNative() && P && P.Filesystem && P.Share) {
      try {
        const w = await P.Filesystem.writeFile({ path: name, data: json, directory: 'CACHE', encoding: 'utf8' });
        await P.Share.share({ title: 'Sauvegarde Ma Bibliothèque', files: [w.uri], dialogTitle: 'Enregistrer la sauvegarde' });
        return;
      } catch (e) {
        if (String(e && e.message).toLowerCase().includes('cancel')) return;
      }
    }
    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([json], name, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Sauvegarde Ma Bibliothèque' }); return; }
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    // Solution de secours : copier le texte
    try { await navigator.clipboard.writeText(json); toast('Sauvegarde copiée (colle-la dans une note ou un mail)'); } catch (e) { toast('Sauvegarde créée'); }
  }
  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.books)) throw new Error();
        const known = new Set(state.books.map((b) => b.isbn || b.id));
        let added = 0;
        for (const b of d.books) { if (!known.has(b.isbn || b.id)) { state.books.push(Object.assign({ id: uid(), addedAt: Date.now() }, b)); added++; } }
        for (const rel of d.releases || []) if (!state.releases.some((x) => relKey(x) === relKey(rel))) state.releases.push(rel);
        save(); render(); toast(`${added} livre${added > 1 ? 's' : ''} importé${added > 1 ? 's' : ''}`);
      } catch (e) { toast('Ce fichier n’est pas une sauvegarde valide'); }
    };
    r.readAsText(file);
  }

  // ---------- Événements ----------
  function wire() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
    $('#scanBtn').addEventListener('click', startScan);
    $('#searchInput').addEventListener('input', renderLibrary);
    $('#sortSelect').addEventListener('change', (e) => { state.settings.sort = e.target.value; save(); renderLibrary(); });
    $$('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.settings.layout = b.dataset.layout; save(); renderLibrary(); }));
    $$('.theme-chip').forEach((c) => c.addEventListener('click', () => { state.settings.theme = c.dataset.themePick; save(); applyTheme(); renderSettings(); }));
    $('#checkReleasesBtn').addEventListener('click', checkReleases);
    $('#addReleaseBtn').addEventListener('click', addReleaseManually);
    $('#manualIsbnBtn').addEventListener('click', () => askIsbn());
    $('#manualBookBtn').addEventListener('click', () => {
      const b = { isbn: '', title: '', authors: '', publisher: '', publishedDate: '', cover: '', series: '', volume: null };
      openSheet(bookForm(b, { isNew: true })); wireBookForm(b, true);
    });
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

    $('#libraryContent').addEventListener('click', (e) => { const it = e.target.closest('[data-id]'); if (it) openBook(it.dataset.id); });
    $('#releasesContent').addEventListener('click', (e) => {
      const x = e.target.closest('[data-dismiss]');
      if (!x) return;
      const r = state.releases.find((r) => r.id === x.dataset.dismiss);
      if (!r) return;
      if (r.manual) state.releases = state.releases.filter((z) => z !== r); else state.dismissed.push(relKey(r));
      save(); render(); toast('Sortie masquée');
    });

    $('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });
    $('#sheet').addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'close') closeSheet();
      if (act === 'scan-again') { closeSheet(); startScan(); }
      if (act === 'open') openBook(a.dataset.id);
      if (act === 'edit') { const b = state.books.find((x) => x.id === a.dataset.id); openSheet(bookForm(b, { isNew: false })); wireBookForm(b, false); }
      if (act === 'delete') {
        if (a.dataset.confirm) {
          state.books = state.books.filter((x) => x.id !== a.dataset.id); save(); closeSheet(); render(); toast('Livre retiré');
        } else { a.dataset.confirm = '1'; a.textContent = 'Appuie encore pour confirmer'; }
      }
    });

    // Bouton « retour » d'Android : ferme la fenêtre ouverte, sinon revient aux livres
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && App.addListener) {
      App.addListener('backButton', () => {
        if (!$('#sheetBackdrop').hidden) closeSheet();
        else if (currentView !== 'library') show('library');
        else App.exitApp && App.exitApp();
      });
    }
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => currentView === 'library' && renderLibrary(), 150); });
  }

  // ---------- Démarrage ----------
  applyTheme();
  wire();
  render();

  // Recherche automatique des sorties une fois par semaine
  if (seriesList().length && (!state.lastCheck || Date.now() - state.lastCheck > 7 * 864e5)) {
    setTimeout(() => checkReleases().catch(() => {}), 2500);
  }

  // Pour les tests
  window.__biblio = { parseSeries, state: () => state };
})();
