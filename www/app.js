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
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast("Impossible d'enregistrer"); }
  }
  function save() {
    saveLocal();
    if (typeof scheduleSync === 'function') scheduleSync();
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
  // Requête HTTP : on passe par le module natif quand on est dans l'application (pas de souci de CORS)
  async function httpGet(url, timeoutMs = 10000) {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), timeoutMs));
    if (isNative() && H && H.get) {
      const r = await Promise.race([H.get({ url, headers: { Accept: 'application/json, text/xml, */*', 'User-Agent': 'MaBibliotheque/0.2 (Android)' }, responseType: 'text', connectTimeout: timeoutMs, readTimeout: timeoutMs }), timeout]);
      if (r.status < 200 || r.status >= 300) throw new Error('erreur ' + r.status);
      return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    }
    const r = await Promise.race([fetch(url), timeout]);
    if (!r.ok) throw new Error('erreur ' + r.status);
    return r.text();
  }
  async function getJSON(url, t) { return JSON.parse(await httpGet(url, t)); }
  function httpsify(u) { return u ? u.replace(/^http:/, 'https:').replace('&edge=curl', '') : ''; }
  function isbn13to10(i) {
    if (!/^978\d{10}$/.test(i)) return '';
    const core = i.slice(3, 12);
    let sum = 0;
    for (let k = 0; k < 9; k++) sum += (+core[k]) * (10 - k);
    const c = (11 - (sum % 11)) % 11;
    return core + (c === 10 ? 'X' : c);
  }

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Réessaie automatiquement quand un service ne répond pas (souvent : « trop de demandes »)
  async function withRetry(fn, tries = 3, onRetry) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (i < tries - 1) { onRetry && onRetry(i + 2); await sleep(900 * (i + 1) * (i + 1)); }
      }
    }
    throw last;
  }

  // --- Source 1 : Google Books (country=FR évite le refus « localisation inconnue »)
  async function srcGoogle(isbn) {
    const g = await getJSON('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn + '&country=FR', 8000);
    if (g.items && g.items.length) return fromGoogle(g.items[0], isbn);
    // recherche plein texte : attrape les fiches mal indexées
    const g2 = await getJSON('https://www.googleapis.com/books/v1/volumes?q=' + isbn + '&country=FR&maxResults=3', 8000);
    const it = (g2.items || []).find((v) => (v.volumeInfo.industryIdentifiers || []).some((x) => x.identifier.replace(/-/g, '') === isbn || x.identifier === isbn13to10(isbn)));
    return it ? fromGoogle(it, isbn) : null;
  }

  // --- Source 2 : catalogue de la Bibliothèque nationale de France (tous les livres publiés en France)
  // ---------- BnF : format UNIMARC (champs structurés : série, tome, titre, auteurs…) ----------
  const xmlDecode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
  function marcFields(rec, tag) {
    const out = [];
    const re = new RegExp('<mxc:datafield tag="' + tag + '"[^>]*>([\\s\\S]*?)</mxc:datafield>', 'g');
    let m;
    while ((m = re.exec(rec))) {
      const f = {};
      const sre = /<mxc:subfield code="(.)">([\s\S]*?)<\/mxc:subfield>/g;
      let s;
      while ((s = sre.exec(m[1]))) (f[s[1]] = f[s[1]] || []).push(xmlDecode(s[2]));
      out.push(f);
    }
    return out;
  }
  const sub = (f, c) => (f && f[c] && f[c][0]) || '';
  const volNum = (v) => { const m = String(v || '').match(/(\d{1,4})/); return m ? +m[1] : null; };
  function parseUnimarc(rec) {
    const ark = ((rec.match(/<srw:recordIdentifier>([^<]+)<\/srw:recordIdentifier>/) || [])[1] || '').trim();
    const t200 = marcFields(rec, '200')[0];
    if (!t200) return null;
    const kind = sub(t200, 'b');
    if (kind && !/texte/i.test(kind)) return null; // DVD, musique… : on ignore
    const main = sub(t200, 'a').replace(/\s+/g, ' ');
    let series = '', volume = null;
    const s461 = marcFields(rec, '461').find((f) => sub(f, 't') && volNum(sub(f, 'v')));
    // 225 = collection de l'éditeur (« Folio junior ; 100ème ») OU vraie série (« One piece ; tome 1 »)
    const isSeries225 = (f) => sub(f, 'a') && volNum(sub(f, 'v')) &&
      (/tome|vol|t\.|livre|partie|cycle|épisode|episode|n°/i.test(sub(f, 'v')) || norm(main).includes(norm(sub(f, 'a'))));
    const s225 = marcFields(rec, '225').find(isSeries225);
    const colls = marcFields(rec, '225').filter((f) => !isSeries225(f)).map((f) => norm(sub(f, 'a'))).filter(Boolean)
      .concat(marcFields(rec, '410').map((f) => norm(sub(f, 't'))).filter(Boolean));
    if (s461) { series = sub(s461, 't'); volume = volNum(sub(s461, 'v')); }
    else if (s225) { series = sub(s225, 'a'); volume = volNum(sub(s225, 'v')); }
    else if (volNum(sub(t200, 'h'))) { series = main; volume = volNum(sub(t200, 'h')); }
    const part = sub(t200, 'i') || (series && norm(main) !== norm(series) ? main : '');
    const subt = sub(t200, 'e');
    let title;
    if (series && volume) title = series + ' – Tome ' + volume + (part ? ' – ' + part : '');
    else {
      title = main + (subt ? ' : ' + subt : '');
      const ps = parseSeries(main, sub(t200, 'h'));
      if (ps.series) { series = ps.series; volume = ps.volume; }
    }
    const authors = marcFields(rec, '700').concat(marcFields(rec, '701'))
      .map((f) => (sub(f, 'b') + ' ' + sub(f, 'a')).trim()).filter(Boolean);
    const pubF = marcFields(rec, '214')[0] || marcFields(rec, '210')[0];
    const year = (sub(pubF, 'd').match(/\d{4}/) || [])[0] || '';
    const isbn = (sub(marcFields(rec, '073')[0], 'a') || sub(marcFields(rec, '010')[0], 'a')).replace(/[^0-9X]/gi, '');
    const pages = +((sub(marcFields(rec, '215')[0], 'a').match(/(\d+)\s*p\./) || [])[1] || 0) || null;
    const hasCover = marcFields(rec, '856').some((f) => /couverture/i.test(sub(f, 'b')));
    const price = parseFloat((sub(marcFields(rec, '010')[0], 'd').match(/\d+(?:[.,]\d+)?/) || ['0'])[0].replace(',', '.')) || 0;
    const size = (sub(marcFields(rec, '215')[0], 'd').match(/\d+/) || [''])[0];
    return {
      isbn: /^97[89]\d{10}$/.test(isbn) ? isbn : '', title, authors: [...new Set(authors)].join(', '),
      publisher: sub(pubF, 'c'), publishedDate: year, pages, description: sub(marcFields(rec, '330')[0], 'a'),
      cover: hasCover && ark ? 'https://catalogue.bnf.fr/couverture?&appName=NE&idArk=' + ark + '&couverture=1' : '',
      series, volume, ark,
      // indices pour reconnaître la même édition (format, prix, collection) et écarter les produits dérivés
      _m: { main: norm(main), sub: norm(subt), colls, price, size },
    };
  }

  // Mot principal du nom de l'éditeur (« Éditions Delcourt » -> « delcourt »)
  function pubWord(p) {
    const stop = ['editions', 'edition', 'ed', 'les', 'groupe', 'la', 'le', 'de', 'des', 'et'];
    return norm(p).split(' ').filter((w) => w.length > 2 && !stop.includes(w))[0] || '';
  }
  // Recherche BnF d'un tome précis : d'abord chez le même éditeur, sinon partout
  async function bnfVolumeSearch(series, v, publisher) {
    const base = 'bib.title all "' + String(series).replace(/"/g, '') + '" and bib.title all "' + v + '"';
    const pw = pubWord(publisher);
    let recs = pw ? await bnfSearch(base + ' and bib.publisher all "' + pw + '"', 50) : [];
    if (!recs.some((r) => r.volume === v && norm(r.series) === norm(series))) recs = recs.concat(await bnfSearch(base, 50));
    return recs;
  }

  // Parmi plusieurs notices « Série, tome N », choisit celle qui ressemble le plus au tome de référence
  function pickVolume(recs, v, key, ref) {
    const R = (ref && ref._m) || null;
    const scored = recs.filter((r) => r.volume === v && norm(r.series) === key).map((r) => {
      const m = r._m || {};
      let sc = 0;
      if (r.isbn) sc += 1;
      if (ref && ref.publisher && r.publisher) sc += pubWord(r.publisher) === pubWord(ref.publisher) ? 3 : -4;
      // produit dérivé : « One piece » + sous-titre (« color walk », « quiz book »…)
      if (m.main === key && m.sub && !(R && R.main === key && R.sub)) return null;
      if (R) {
        if (R.size && m.size) sc += R.size === m.size ? 3 : -3;
        if (R.price && m.price) sc += Math.abs(m.price - R.price) / R.price < 0.35 ? 2 : -2;
        if (R.colls.length && m.colls.some((c) => R.colls.includes(c))) sc += 2;
        if ((R.main === key) === (m.main === key)) sc += 1; // même façon de titrer les tomes
      }
      return { r, sc };
    }).filter(Boolean).sort((a, b) => b.sc - a.sc);
    if (!scored.length) return null;
    return scored[0].sc >= (R ? 3 : 1) ? scored[0].r : null;
  }
  function parseBnfResponse(xml) {
    if (!/searchRetrieveResponse/.test(xml)) throw new Error('réponse illisible');
    return (xml.match(/<srw:record>[\s\S]*?<\/srw:record>/g) || []).map(parseUnimarc).filter(Boolean);
  }

  async function bnfSearch(cql, max = 5) {
    const xml = await httpGet('https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=' + encodeURIComponent(cql) + '&recordSchema=unimarcxchange&maximumRecords=' + max, 12000);
    return parseBnfResponse(xml);
  }
  async function srcBnf(isbn) {
    const r = await bnfSearch('bib.isbn all "' + isbn + '"', 3);
    return r[0] ? Object.assign(r[0], { isbn }) : null;
  }

  // --- Source 3 : Open Library
  async function srcOpenLibrary(isbn) {
    const o = await getJSON('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data', 9000);
    const d = o['ISBN:' + isbn];
    if (!d) return null;
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

  // ---------- Serveur en ligne ----------
  const API = 'https://zfniddtlcgnmvserapql.supabase.co/functions/v1/api';
  async function api(action, payload = {}, timeoutMs = 25000) {
    const body = Object.assign({ action }, payload);
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('serveur trop lent')), timeoutMs));
    let status, data;
    if (isNative() && H && H.post) {
      const r = await Promise.race([H.post({ url: API, headers: { 'Content-Type': 'application/json' }, data: body, connectTimeout: timeoutMs, readTimeout: timeoutMs }), timeout]);
      status = r.status; data = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : r.data;
    } else {
      const r = await Promise.race([fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), timeout]);
      status = r.status; data = await r.json();
    }
    if (status < 200 || status >= 300) { const e = new Error((data && data.error) || 'erreur ' + status); e.status = status; throw e; }
    return data;
  }
  const stripV = (b) => { if (b) { delete b.v; } return b; };

  let lastLookupReport = [];
  async function lookupIsbn(raw, onStatus) {
    let isbn = cleanIsbn(raw);
    if (isbn.length === 10) isbn = isbn10to13(isbn);
    try {
      const r = await api('lookup', { isbn }, 30000);
      lastLookupReport = (r.report || []).concat(['serveur : OK']);
      if (r.book) return stripV(r.book);
      if (!r.networkError) return null; // les catalogues ne connaissent pas ce livre
    } catch (e) {
      onStatus && onStatus('Serveur indisponible, recherche directe…');
    }
    return lookupIsbnLocal(isbn, onStatus);
  }
  async function lookupIsbnLocal(raw, onStatus) {
    let isbn = cleanIsbn(raw);
    if (isbn.length === 10) isbn = isbn10to13(isbn);
    const sources = [['Google Books', srcGoogle, 3], ['BnF', srcBnf, 3], ['Open Library', srcOpenLibrary, 2]];
    const results = sources.map(([name]) => ({ name, r: null, msg: 'trop lent' }));
    let gotHit;
    const hit = new Promise((res) => (gotHit = res));
    const all = Promise.all(sources.map(async ([name, fn, tries], i) => {
      try {
        const r = await withRetry(() => fn(isbn), tries, (n) => onStatus && onStatus(name + ' ne répond pas, essai n°' + n + '…'));
        results[i] = { name, r, msg: r ? 'trouvé' : 'inconnu' };
        if (r) gotHit();
      } catch (e) { results[i] = { name, r: null, msg: String((e && e.message) || e) }; }
    }));
    // Dès qu'une source a trouvé, on laisse 2 secondes aux autres pour compléter, pas plus
    await Promise.race([all, hit]);
    await Promise.race([all, sleep(2000)]);
    lastLookupReport = results.map((x) => x.name + ' : ' + x.msg);
    const found = results.map((x) => x.r).filter(Boolean);
    if (!found.length) return null;
    // On fusionne : la première source qui a l'info gagne
    const pick = (k) => { for (const f of found) if (f[k]) return f[k]; return k === 'volume' || k === 'pages' ? null : ''; };
    const bnf = results[1].r;
    const b = {
      isbn,
      title: pick('title'), authors: pick('authors'), publisher: pick('publisher'),
      publishedDate: pick('publishedDate'), pages: pick('pages'), description: pick('description'),
      cover: pick('cover'), ark: (bnf && bnf.ark) || '',
      // la BnF découpe très bien « Série. N° » : on la préfère pour la série
      series: (bnf && bnf.series) || pick('series'), volume: (bnf && bnf.volume) || pick('volume'),
    };
    if (bnf && bnf.series && bnf.volume) b.title = bnf.title;
    if (bnf && bnf.description && !b.description) b.description = bnf.description;
    return b;
  }

  // Couverture cherchée en arrière-plan : l'écran s'affiche tout de suite, l'image arrive ensuite
  async function findCoverAny(isbn, ark) {
    try { const r = await api('cover', { isbn, ark }, 30000); if (r.cover) return r.cover; } catch (e) { /* recherche directe */ }
    return findCover(isbn, ark);
  }
  function coverLater(b) {
    if (!b.isbn || b.coverPhoto || b.cover) return;
    findCoverAny(b.isbn, b.ark).then((u) => {
      if (!u) return;
      b.cover = u; b.coverTriedAt = Date.now();
      const pv = $('#previewCover'); if (pv) pv.innerHTML = coverHTML(b);
      if (state.books.includes(b)) { save(); if (!scanner.active) render(); }
    }).catch(() => {});
  }

  // ---------- Recherche de couverture (plusieurs sources) ----------
  function imageOk(url) {
    return new Promise((res) => {
      const im = new Image();
      const t = setTimeout(() => res(false), 8000);
      im.onload = () => { clearTimeout(t); res(im.naturalWidth > 20 && im.naturalHeight > 20); };
      im.onerror = () => { clearTimeout(t); res(false); };
      im.src = url;
    });
  }
  // Certains services renvoient une image « pas de couverture » au lieu d'une erreur :
  // on télécharge l'image en natif et on la compare à cette image-type.
  async function nativeSize(url) {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (!isNative() || !H) return -1;
    try {
      const r = await H.get({ url, responseType: 'blob', connectTimeout: 8000, readTimeout: 8000 });
      if (r.status !== 200 || typeof r.data !== 'string') return 0;
      return r.data.length;
    } catch (e) { return 0; }
  }
  const placeholderSizes = {};
  async function realImage(kind, url, fakeUrl) {
    const size = await nativeSize(url);
    if (size === -1) return false;          // hors application : on ne peut pas vérifier
    if (size < 2500) return false;           // trop petit = vide
    if (!(kind in placeholderSizes)) placeholderSizes[kind] = await nativeSize(fakeUrl);
    return Math.abs(size - placeholderSizes[kind]) > 64 && imageOk(url);
  }
  async function findCover(isbn, ark) {
    if (!isbn) return '';
    const i10 = isbn13to10(isbn);
    // 1) Amazon (très complet pour les livres français en 978)
    if (i10) {
      for (const u of ['https://images-na.ssl-images-amazon.com/images/P/' + i10 + '.01.LZZZZZZZ.jpg', 'https://m.media-amazon.com/images/P/' + i10 + '.01._SCLZZZZZZZ_.jpg']) {
        if (await imageOk(u)) return u;
      }
    }
    // 2) BnF (couvertures fournies par les éditeurs, y compris les ISBN en 979)
    let a = ark;
    if (!a) { try { const r = await bnfSearch('bib.isbn all "' + isbn + '"', 1); a = r[0] && r[0].ark; } catch (e) { /* rien */ } }
    if (a) {
      const u = 'https://catalogue.bnf.fr/couverture?&appName=NE&idArk=' + a + '&couverture=1';
      if (await realImage('bnf', u, 'https://catalogue.bnf.fr/couverture?&appName=NE&idArk=ark:/12148/cb00000000x&couverture=1')) return u;
    }
    // 3) Open Library
    const ol = 'https://covers.openlibrary.org/b/isbn/' + isbn + '-L.jpg?default=false';
    if (await imageOk(ol)) return ol;
    // 4) Google Books (image directe par ISBN)
    const g = 'https://books.google.com/books/content?vid=ISBN' + isbn + '&printsec=frontcover&img=1&zoom=1';
    if (await realImage('google', g, 'https://books.google.com/books/content?vid=ISBN9780000000002&printsec=frontcover&img=1&zoom=1')) return g;
    return '';
  }

  // Photo de couverture prise par l'utilisateur : réduite pour ne pas prendre trop de place
  function photoToCover(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onerror = rej;
      fr.onload = () => {
        const im = new Image();
        im.onerror = rej;
        im.onload = () => {
          const h = 420, w = Math.round(im.width * (h / im.height));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          res(c.toDataURL('image/jpeg', 0.72));
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // Au démarrage : on retente de trouver les couvertures manquantes (tous les 3 jours par livre)
  async function repairCovers() {
    const todo = state.books.filter((b) => !b.cover && b.isbn && (!b.coverTriedAt || Date.now() - b.coverTriedAt > 3 * 864e5));
    let fixed = 0;
    for (const b of todo.slice(0, 15)) {
      const u = await findCoverAny(b.isbn, b.ark).catch(() => '');
      b.coverTriedAt = Date.now();
      if (u) { b.cover = u; fixed++; }
      save();
    }
    if (fixed) { render(); toast(fixed + ' couverture' + (fixed > 1 ? 's' : '') + ' retrouvée' + (fixed > 1 ? 's' : '')); }
  }

  // ---------- Couvertures ----------
  function hashColor(s) {
    let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 30) % 360} 50% 24%))`;
  }
  function coverHTML(b) {
    const fake = `<div class="fake-cover" style="background:${hashColor(b.series || b.title)}"><div class="fc-title">${esc(b.title || 'Sans titre')}</div><div class="fc-author">${esc(b.authors || '')}</div></div>`;
    if (!b.cover) return fake;
    return `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="window.__badCover(this)" data-id="${esc(b.id || '')}" data-fb="${esc(fake)}">`;
  }

  // Image de couverture qui ne s'affiche pas : on met la couverture de secours et on cherche une autre source
  const badCoverTried = new Set();
  window.__badCover = (img) => {
    const id = img.dataset.id;
    img.outerHTML = img.dataset.fb;
    if (!id || badCoverTried.has(id)) return;
    badCoverTried.add(id);
    const b = state.books.find((x) => x.id === id);
    if (!b || b.coverPhoto || !b.isbn) return;
    const bad = b.cover;
    findCoverAny(b.isbn, b.ark).then((u) => {
      if (u && u !== bad) b.cover = u; else { b.cover = ''; b.coverTriedAt = Date.now(); }
      save(); if (!scanner.active) render();
    }).catch(() => {});
  };

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
    if (view === 'releases') autoLoadReleases();
  }
  // En ouvrant « Sorties » : si la liste n'a pas été chargée depuis 6 h (ou jamais), on la demande au serveur
  let releasesLoading = false;
  function autoLoadReleases() {
    if (releasesLoading || !seriesList().length) return;
    const fresh = state.releasesFromServer && Date.now() - (state.lastCheck || 0) < 6 * 3600e3 && state.lastCheckSeries === seriesKeySig();
    if (fresh) return;
    releasesLoading = true;
    $('#lastCheck').textContent = 'Recherche des sorties de tes séries sur le serveur…';
    loadServerReleases(false).then(() => { state.lastCheckSeries = seriesKeySig(); saveLocal(); })
      .catch(() => { $('#lastCheck').textContent = 'Serveur indisponible : appuie sur « Chercher les nouveautés »'; })
      .finally(() => { releasesLoading = false; if (currentView === 'releases') renderReleases(); });
  }
  // Signature des séries possédées (avec le dernier tome) : si elle change, on recalcule les sorties
  function seriesKeySig() {
    return seriesList().map((s) => s.key + ':' + Math.max(0, ...s.books.map((b) => b.volume || 0))).join('|');
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
    const rp = state.lastReport;
    const srcTxt = (name, x) => !x ? '' : (x.ok ? name + ' OK' : (x.err ? name + ' indisponible' + (x.last ? ' (' + x.last + ')' : '') : ''));
    const rpTxt = rp ? ' · ' + [srcTxt('BnF', rp.bnf), srcTxt('Google Books', rp.google)].filter(Boolean).join(' · ') : '';
    const auto = state.releasesFromServer ? ' · mise à jour automatique chaque nuit' : '';
    $('#lastCheck').textContent = state.lastCheck ? 'Dernière recherche : ' + new Date(state.lastCheck).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) + auto + rpTxt : '';
    if (!seriesList().length) {
      el.innerHTML = `<div class="empty"><div class="big">📅</div><h2>Pas encore de série</h2><p>Ajoute des livres qui font partie d'une série, puis reviens ici : je chercherai les prochains tomes et leurs dates de sortie.</p></div>`;
      return;
    }
    const all = visibleReleases();
    const today = todayKey();
    const upcoming = all.filter((r) => isUpcoming(r)).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    const past = all.filter((r) => r.date && !isUpcoming(r)).sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
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
    const n = visibleReleases().filter((r) => isUpcoming(r)).length;
    const b = $('#releaseBadge');
    b.hidden = !n; b.textContent = n;
  }

  function renderSettings() {
    renderSyncStatus();
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
    return `<h2>${isNew ? 'Ajouter un livre' : 'Compléter le livre'}</h2>
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
        addBook(Object.assign({}, b, upd));
      } else {
        Object.assign(b, upd); delete b.incomplete; save(); closeSheet(); render(); toast('Livre complété');
      }
    });
  }

  // Zone d'informations en lecture seule
  function bookCard(b) {
    const row = (k, v) => v ? `<div class="info-row"><span class="info-k">${k}</span><span class="info-v">${v}</span></div>` : '';
    return `<div class="detail-top"><div class="detail-cover" id="previewCover">${coverHTML(b)}</div>
      <div class="detail-meta"><h2>${esc(b.title || 'Titre inconnu')}</h2><div class="kv">${esc(b.authors || 'Auteur inconnu')}</div></div></div>
      <div class="info-box">
        ${row('Série', esc(b.series))}
        ${row('Tome', b.volume ? 'n° ' + b.volume : '')}
        ${row('Éditeur', esc(b.publisher))}
        ${row('Parution', b.publishedDate ? fmtDate(b.publishedDate) : '')}
        ${row('Pages', b.pages ? b.pages : '')}
        ${row('ISBN', esc(b.isbn))}
        ${row('Ajouté le', b.addedAt ? new Date(b.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '')}
      </div>
      ${b.description ? `<div class="desc">${esc(b.description)}</div>` : ''}`;
  }

  function confirmAdd(b) {
    openSheet(`${bookCard(b)}
      <div class="sheet-actions">
        <button class="btn primary block" id="doAdd">＋ Ajouter à ma bibliothèque</button>
        <button class="btn block" data-act="scan-again">Ce n’est pas le bon livre, rescanner</button>
        <button class="btn ghost block" data-act="close">Annuler</button>
      </div>`);
    $('#doAdd').onclick = () => addBook(b);
  }

  function addBook(b) {
    Object.assign(b, { id: uid(), addedAt: Date.now() });
    delete b.incomplete;
    state.books.push(b);
    save(); render();
    const missing = missingBefore(b);
    if (missing.length) askFillPrevious(b, missing);
    else afterAdd(b);
  }

  function afterAdd(b) {
    openSheet(`<h2>✅ Ajouté !</h2><p class="muted">« ${esc(b.title)} » est maintenant dans ta bibliothèque.</p>
      ${!b.cover ? '<p class="muted small">La couverture est en cours de recherche. Si elle n’arrive pas, tu peux la prendre en photo.</p>' : ''}
      <div class="sheet-actions"><button class="btn primary block" data-act="scan-again">Scanner un autre livre</button>
      ${!b.cover ? '<button class="btn block" id="addCoverNow">📷 Ajouter la couverture</button>' : ''}
      <button class="btn ghost block" data-act="close">Terminé</button></div>`);
    const c = $('#addCoverNow'); if (c) c.onclick = () => coverMenu(b, () => afterAdd(b));
  }

  // ---------- Ajouter les tomes précédents d'une série ----------
  function missingBefore(b) {
    if (!b.series || !b.volume || b.volume < 2) return [];
    const k = norm(b.series);
    const owned = new Set(state.books.filter((x) => norm(x.series) === k).map((x) => x.volume));
    const miss = [];
    for (let v = 1; v < b.volume; v++) if (!owned.has(v)) miss.push(v);
    return miss;
  }
  function volRange(list) {
    // [1,2,3,5,6] -> "1 à 3, 5 et 6"
    const parts = []; let a = list[0], p = list[0];
    for (const v of list.slice(1).concat([null])) {
      if (v === p + 1) { p = v; continue; }
      parts.push(a === p ? '' + a : (p === a + 1 ? a + ', ' + p : a + ' à ' + p)); a = p = v;
    }
    return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' et ' + parts[parts.length - 1] : parts[0];
  }
  function askFillPrevious(b, missing) {
    const all = missing.length === b.volume - 1;
    openSheet(`<h2>✅ Tome ${b.volume} ajouté !</h2>
      <p>Veux-tu aussi ajouter ${all ? 'tous les tomes précédents' : 'les tomes qui te manquent avant celui-ci'} de <b>${esc(b.series)}</b> ?</p>
      <p class="muted small">${missing.length === 1 ? 'Tome' : 'Tomes'} ${volRange(missing)} (${missing.length} livre${missing.length > 1 ? 's' : ''}).</p>
      <div class="sheet-actions">
        <button class="btn primary block" id="fillYes">Oui, ajouter ${all ? 'les tomes 1 à ' + (b.volume - 1) : 'les ' + missing.length + ' tomes manquants'}</button>
        <button class="btn block" id="fillNo">Non, juste le tome ${b.volume}</button>
      </div>`);
    $('#fillYes').onclick = () => fillPrevious(b, missing);
    $('#fillNo').onclick = () => afterAdd(b);
  }

  // Cherche les infos d'un tome précis d'une série (BnF puis Google), sans ISBN
  const bnfRefCache = new WeakMap(); // notice BnF du tome de référence (sans l'enregistrer dans le livre)
  async function findVolume(series, v, ref, gIndex) {
    try {
      if (ref.isbn && !bnfRefCache.has(ref)) bnfRefCache.set(ref, (await srcBnf(ref.isbn).catch(() => null)) || { publisher: ref.publisher });
      const recs = await withRetry(() => bnfVolumeSearch(series, v, ref.publisher || ''), 2);
      const best = pickVolume(recs, v, norm(series), bnfRefCache.get(ref) || ref);
      if (best) { delete best._m; return best; }
    } catch (e) { /* on essaie Google */ }
    if (gIndex && gIndex.has(v)) return gIndex.get(v);
    return null;
  }
  async function googleSeriesIndex(series) {
    const map = new Map();
    for (const start of [0, 40]) {
      try {
        const q = 'intitle:' + JSON.stringify(series);
        const d = await withRetry(() => getJSON('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=40&startIndex=' + start + '&printType=books&country=FR', 9000), 2);
        for (const it of d.items || []) {
          const b = fromGoogle(it);
          if (b.volume && norm(b.series) === norm(series) && b.isbn && !map.has(b.volume)) map.set(b.volume, b);
        }
        if (!d.items || d.items.length < 40) break;
      } catch (e) { break; }
    }
    return map;
  }

  async function fillPrevious(ref, missing) {
    let done = 0, withInfo = 0, cancelled = false;
    openSheet(`<h2>Ajout des tomes précédents…</h2><p class="muted small" id="fillStatus">Recherche des informations de chaque tome</p>
      <div class="progress"><div class="progress-bar" id="fillBar"></div></div>
      <div class="sheet-actions"><button class="btn ghost block" id="fillStop">Arrêter</button></div>`);
    $('#fillStop').onclick = () => { cancelled = true; };
    const added = [];
    let gIndex = null, serverOk = true;
    const addVolume = (v, info) => {
      // un livre ajouté entre-temps avec le même ISBN ? on évite les doublons
      if (info && info.isbn && state.books.some((x) => x.isbn === info.isbn)) {
        const ex = state.books.find((x) => x.isbn === info.isbn);
        if (ex.volume === v && norm(ex.series) === norm(ref.series)) { done++; return; }
        info.isbn = ''; // fiche douteuse : on garde le tome mais sans cet ISBN
      }
      const nb = {
        id: uid(), addedAt: Date.now() - (ref.volume - v), // garde l'ordre des tomes dans « Ajout récent »
        isbn: (info && info.isbn) || '', ark: (info && info.ark) || '',
        title: (info && info.title) || (ref.series + ' – Tome ' + v),
        authors: (info && info.authors) || ref.authors || '', publisher: (info && info.publisher) || ref.publisher || '',
        publishedDate: (info && info.publishedDate) || '', pages: (info && info.pages) || null,
        description: (info && info.description) || '', cover: (info && info.cover) || '',
        series: ref.series, volume: v,
      };
      if (info) withInfo++;
      state.books.push(nb); added.push(nb);
      done++;
      const st = $('#fillStatus'); if (st) st.textContent = `Tome ${v} ajouté — ${done}/${missing.length}`;
      const bar = $('#fillBar'); if (bar) bar.style.width = Math.round((done / missing.length) * 100) + '%';
    };
    // Le serveur cherche les tomes par paquets de 12 (bien plus rapide) ; sinon, recherche directe tome par tome
    for (let i = 0; i < missing.length && !cancelled; i += 12) {
      const chunk = missing.slice(i, i + 12);
      const st0 = $('#fillStatus'); if (st0) st0.textContent = `Recherche des tomes ${chunk[0]} à ${chunk[chunk.length - 1]}… (${done}/${missing.length})`;
      let infos = null;
      if (serverOk) {
        try { infos = (await api('volumes', { series: ref.series, volumes: chunk, publisher: ref.publisher || '', refIsbn: ref.isbn || '' }, 140000)).volumes || {}; }
        catch (e) { serverOk = false; }
      }
      if (cancelled) break;
      if (!infos) {
        if (!gIndex) gIndex = await googleSeriesIndex(ref.series);
        infos = {};
        await Promise.all(chunk.map(async (v) => { infos[v] = await findVolume(ref.series, v, ref, gIndex).catch(() => null); }));
      }
      for (const v of chunk) { if (!cancelled) addVolume(v, stripV(infos[v]) || null); }
      save();
    }
    save(); render();
    // Couvertures : l'une après l'autre, en arrière-plan
    (async () => { for (const nb of added) { if (!nb.cover && nb.isbn) { const u = await findCoverAny(nb.isbn, nb.ark).catch(() => ''); nb.coverTriedAt = Date.now(); if (u) { nb.cover = u; save(); render(); } } } })();
    openSheet(`<h2>✅ ${added.length} tome${added.length > 1 ? 's' : ''} ajouté${added.length > 1 ? 's' : ''}</h2>
      <p class="muted">${esc(ref.series)} : tu as maintenant les tomes 1 à ${ref.volume}${cancelled ? ' (ajout arrêté en cours de route)' : ''}.</p>
      ${withInfo < added.length ? `<p class="muted small">${added.length - withInfo} tome${added.length - withInfo > 1 ? 's' : ''} sans fiche détaillée trouvée : ils sont ajoutés avec le nom de la série et leur numéro.</p>` : ''}
      <p class="muted small">Les couvertures arrivent petit à petit.</p>
      <div class="sheet-actions"><button class="btn primary block" data-act="scan-again">Scanner un autre livre</button>
      <button class="btn ghost block" data-act="close">Terminé</button></div>`);
  }

  function openBook(id) {
    const b = state.books.find((x) => x.id === id);
    if (!b) return;
    openSheet(`${bookCard(b)}
      <div class="sheet-actions">
        <button class="btn block" data-act="cover" data-id="${b.id}">🖼️ ${b.cover ? 'Changer la couverture' : 'Ajouter une couverture'}</button>
        ${b.incomplete ? `<button class="btn block" id="relookup">🔎 Relancer la recherche</button>
          <button class="btn block" data-act="edit" data-id="${b.id}">✏️ Compléter à la main</button>` : ''}
        <button class="btn danger block" data-act="delete" data-id="${b.id}">🗑️ Retirer de ma bibliothèque</button>
        <button class="btn ghost block" data-act="close">Fermer</button>
      </div>`);
    const rl = $('#relookup');
    if (rl) rl.onclick = async () => {
      rl.textContent = 'Recherche…'; rl.disabled = true;
      const f = b.isbn ? await lookupIsbn(b.isbn) : null;
      if (f && f.title) {
        Object.assign(b, f); delete b.incomplete; save(); render(); coverLater(b); openBook(b.id); toast('Livre trouvé 🎉');
      } else { toast('Toujours introuvable'); rl.textContent = '🔎 Relancer la recherche'; rl.disabled = false; }
    };
  }

  // ---------- Scan ----------
  const scanner = { active: false, burst: false, torch: false, handle: null, lastCode: '', lastAt: 0, queue: [], busy: false, items: [] };
  try { scanner.burst = localStorage.getItem('mabiblio.burst') === '1'; } catch (e) { /* rien */ }
  const getBS = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;

  // Scanner maison : la caméra s'affiche directement dans l'application (rapide, sans fenêtre Google)
  async function startScan() {
    const BS = getBS();
    if (!isNative() || !BS) { askIsbn('Le scanner fonctionne dans l’application sur téléphone. Ici, tape l’ISBN (le numéro sous le code-barres) :'); return; }
    if (scanner.active) return;
    closeSheet();
    scanner.lastCode = ''; scanner.items = []; scanner.queue = [];
    try {
      let perm = await BS.checkPermissions();
      if (perm.camera !== 'granted') perm = await BS.requestPermissions();
      if (perm.camera !== 'granted') {
        toast('Autorise l’appareil photo pour scanner (Paramètres du téléphone → Applis)', 4000);
        return googleScan();
      }
      showScanOverlay();
      scanner.handle = await BS.addListener('barcodesScanned', (ev) => onLiveCode(ev && ev.barcodes));
      await BS.startScan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'], lensFacing: 'BACK' });
      scanner.active = true;
      try { const t = await BS.isTorchAvailable(); scanner.torchAvail = !!t.available; $('#scTorch').hidden = !t.available; } catch (e) { /* rien */ }
    } catch (e) {
      await stopScan();
      googleScan(); // si la caméra intégrée échoue, on garde l'ancien scanner en secours
    }
  }

  async function stopScan() {
    const BS = getBS();
    scanner.active = false;
    try { scanner.handle && scanner.handle.remove && (await scanner.handle.remove()); } catch (e) { /* rien */ }
    scanner.handle = null;
    try { BS && (await BS.stopScan()); } catch (e) { /* rien */ }
    if (scanner.torch) { scanner.torch = false; }
    document.documentElement.classList.remove('scanning');
    const o = $('#scanOverlay'); if (o) o.remove();
  }

  function showScanOverlay() {
    document.documentElement.classList.add('scanning');
    const o = document.createElement('div');
    o.id = 'scanOverlay';
    o.innerHTML = `
      <div class="sc-top">
        <button class="sc-btn" id="scClose" aria-label="Fermer">✕</button>
        <div class="sc-mode">
          <button class="sc-chip ${scanner.burst ? '' : 'on'}" data-burst="0">Un livre</button>
          <button class="sc-chip ${scanner.burst ? 'on' : ''}" data-burst="1">Rafale</button>
        </div>
        <button class="sc-btn ${scanner.torch ? 'on' : ''}" id="scTorch" aria-label="Lampe" ${scanner.torchAvail ? '' : 'hidden'}>🔦</button>
      </div>
      <div class="sc-frame"><span class="sc-laser"></span></div>
      <div class="sc-hint" id="scHint">${scanner.burst ? 'Mode rafale : scanne tes livres les uns après les autres' : 'Vise le code-barres au dos du livre'}</div>
      <div class="sc-list" id="scList"></div>
      <div class="sc-bottom"><button class="sc-wide" id="scManual">Taper l’ISBN</button>${scanner.burst ? '<button class="sc-wide primary" id="scDone">Terminé</button>' : ''}</div>`;
    document.body.appendChild(o);
    renderScanList();
    $('#scClose').onclick = () => finishScan();
    $('#scManual').onclick = async () => { await finishScan(); askIsbn(); };
    if ($('#scDone')) $('#scDone').onclick = () => finishScan();
    $('#scTorch').onclick = async () => { try { await getBS().toggleTorch(); scanner.torch = !scanner.torch; $('#scTorch').classList.toggle('on', scanner.torch); } catch (e) { /* rien */ } };
    $$('.sc-chip', o).forEach((c) => c.onclick = () => {
      scanner.burst = c.dataset.burst === '1';
      try { localStorage.setItem('mabiblio.burst', scanner.burst ? '1' : '0'); } catch (e) { /* rien */ }
      const keep = scanner.active; o.remove(); showScanOverlay(); scanner.active = keep;
    });
  }

  async function finishScan() {
    await stopScan();
    const added = scanner.items.filter((i) => i.state === 'ok').length;
    const todo = scanner.items.filter((i) => i.state === 'todo').length;
    if (scanner.items.length) toast(`${added} livre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}` + (todo ? ` · ${todo} à compléter` : ''), 3500);
    scanner.items = []; scanner.queue = [];
    render();
  }

  function beep() {
    try { navigator.vibrate && navigator.vibrate(60); } catch (e) { /* rien */ }
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const ctx = beep.ctx || (beep.ctx = new A());
      const os = ctx.createOscillator(), g = ctx.createGain();
      os.frequency.value = 1150; g.gain.value = 0.08;
      os.connect(g); g.connect(ctx.destination); os.start(); os.stop(ctx.currentTime + 0.09);
    } catch (e) { /* rien */ }
  }

  function onLiveCode(barcodes) {
    if (!scanner.active || !barcodes || !barcodes.length) return;
    for (const bc of barcodes) {
      const code = cleanIsbn(bc.rawValue || bc.displayValue);
      if (!/^97[89]\d{10}$/.test(code)) {
        if (code.length >= 8) { const h = $('#scHint'); if (h) h.textContent = 'Ce code n’est pas celui d’un livre (cherche celui qui commence par 978 ou 979)'; }
        continue;
      }
      if (!eanValid(code)) continue; // lecture imparfaite : on attend l'image suivante
      const now = Date.now();
      if (code === scanner.lastCode && now - scanner.lastAt < 4000) return; // même livre encore devant la caméra
      scanner.lastCode = code; scanner.lastAt = now;
      beep();
      const fr = $('.sc-frame'); if (fr) { fr.classList.add('hit'); setTimeout(() => fr.classList.remove('hit'), 400); }
      if (!scanner.burst) { stopScan().then(() => handleCode(code)); return; }
      queueBurst(code);
      return;
    }
  }

  // ---- Mode rafale : chaque livre est cherché puis ajouté automatiquement
  function queueBurst(isbn) {
    if (state.books.some((b) => b.isbn === isbn) || scanner.items.some((i) => i.isbn === isbn)) {
      scanner.items.unshift({ isbn, state: 'dup', title: (state.books.find((b) => b.isbn === isbn) || {}).title || 'Déjà scanné' });
      renderScanList(); return;
    }
    const it = { isbn, state: 'wait', title: 'Recherche…' };
    scanner.items.unshift(it); scanner.queue.push(it);
    renderScanList(); runQueue();
  }
  async function runQueue() {
    if (scanner.busy) return;
    scanner.busy = true;
    while (scanner.queue.length) {
      const it = scanner.queue.shift();
      let b = null;
      try { b = await lookupIsbn(it.isbn); } catch (e) { b = null; }
      if (b && b.title) {
        if (b.series) { const ex = seriesList().find((s) => s.key === norm(b.series)); if (ex) b.series = ex.name; }
        state.books.push(Object.assign(b, { id: uid(), addedAt: Date.now() }));
        it.state = 'ok'; it.title = b.title; it.cover = b.cover;
        coverLater(b);
      } else {
        state.books.push({ id: uid(), addedAt: Date.now(), isbn: it.isbn, title: 'À compléter (ISBN ' + it.isbn + ')', authors: '', series: '', volume: null, cover: '', incomplete: true });
        it.state = 'todo'; it.title = 'Introuvable — ajouté « à compléter »';
      }
      save(); renderScanList();
    }
    scanner.busy = false;
    if (!scanner.active) render();
  }
  function renderScanList() {
    const el = $('#scList'); if (!el) return;
    const icon = { wait: '⏳', ok: '✅', todo: '✏️', dup: '↩️' };
    el.innerHTML = scanner.items.slice(0, 6).map((i) => `<div class="sc-item ${i.state}"><span>${icon[i.state]}</span><span class="sc-t">${esc(i.title)}</span></div>`).join('');
  }

  // Ancien scanner (fenêtre Google) : gardé en secours
  async function googleScan() {
    const BS = getBS();
    try {
      const avail = await BS.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: true }));
      if (!avail.available) {
        openSheet(`<h2>Préparation du scanner…</h2><p class="muted">Première utilisation : ton téléphone télécharge le module de scan (quelques secondes, il faut Internet).</p><div class="spinner"></div>`);
        await installScannerModule(BS);
        closeSheet();
      }
      const res = await BS.scan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'] });
      const code = res && res.barcodes && res.barcodes[0] && (res.barcodes[0].rawValue || res.barcodes[0].displayValue);
      if (code) handleCode(code, true);
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

  // Contrôle du code EAN-13 : évite les lectures erronées du scanner
  function eanValid(c) {
    if (!/^\d{13}$/.test(c)) return true;
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += (+c[k]) * (k % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === +c[12];
  }

  async function handleCode(code, fromScan) {
    const isbn = cleanIsbn(code);
    if (isbn.length !== 13 && isbn.length !== 10) { toast('Ce code ne ressemble pas à un ISBN'); return; }
    if (!eanValid(isbn)) {
      if (fromScan) { toast('Code mal lu, on recommence…'); setTimeout(startScan, 600); }
      else toast('Ce numéro contient une erreur, vérifie-le');
      return;
    }
    const n13 = isbn.length === 10 ? isbn10to13(isbn) : isbn;
    const dup = state.books.find((b) => b.isbn === n13);
    if (dup) {
      openSheet(`<h2>Déjà dans ta bibliothèque 👍</h2><p class="muted">« ${esc(dup.title)} »</p>
        <div class="sheet-actions"><button class="btn primary block" data-act="scan-again">Scanner un autre livre</button>
        <button class="btn block" data-act="open" data-id="${dup.id}">Voir le livre</button>
        <button class="btn ghost block" data-act="close">Fermer</button></div>`);
      return;
    }
    openSheet(`<h2>Recherche du livre…</h2><p class="muted small">ISBN ${esc(n13)}</p><div class="spinner"></div><p class="muted small" id="lookupStatus" style="text-align:center"></p>`);
    const status = (t) => { const el = $('#lookupStatus'); if (el) el.textContent = t; };
    let found = await lookupIsbn(n13, status);
    // Dernière chance : tout a échoué à cause du réseau → on patiente et on recommence une fois
    if (!found && lastLookupReport.some((l) => !/inconnu|trouvé/.test(l))) {
      status('Connexion difficile, dernier essai…');
      await sleep(2500);
      found = await lookupIsbn(n13, status);
    }
    const b = found || { isbn: n13, title: '', authors: '', publisher: '', publishedDate: '', cover: '', series: '', volume: null };
    // Si une série existante ressemble, on reprend son nom exact
    if (b.series) {
      const ex = seriesList().find((s) => s.key === norm(b.series));
      if (ex) b.series = ex.name;
    }
    const notFound = `<p class="muted small">Je n’ai pas trouvé ce livre automatiquement.</p>
      <button class="btn block" type="button" id="retryLookup" style="margin-bottom:10px">↻ Réessayer la recherche</button>
      <p class="muted small" style="font-size:11px;opacity:.8">${esc(lastLookupReport.join(' · '))}</p><p class="muted small">Ou remplis les infos toi-même :</p>`;
    if (found) { confirmAdd(b); coverLater(b); return; }
    openSheet(notFound + bookForm(b, { isNew: true }));
    wireBookForm(b, true);
    const rb = $('#retryLookup'); if (rb) rb.addEventListener('click', () => handleCode(n13));
  }

  // ---------- Choix de la couverture ----------
  function coverMenu(b, onDone) {
    openSheet(`<h2>Couverture</h2><div style="display:flex;justify-content:center;margin-bottom:12px"><div class="detail-cover">${coverHTML(b)}</div></div>
      <div class="sheet-actions">
        <button class="btn primary block" id="cvPhoto">📷 Prendre en photo / choisir une image</button>
        ${b.isbn ? '<button class="btn block" id="cvSearch">🔎 Chercher automatiquement</button>' : ''}
        ${b.cover ? '<button class="btn danger block" id="cvRemove">Retirer la couverture</button>' : ''}
        <button class="btn ghost block" id="cvBack">Retour</button>
      </div><input type="file" id="cvFile" accept="image/*" hidden>`);
    $('#cvBack').onclick = onDone;
    $('#cvPhoto').onclick = () => $('#cvFile').click();
    $('#cvFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { b.cover = await photoToCover(f); b.coverPhoto = true; save(); render(); toast('Couverture enregistrée'); onDone(); }
      catch (err) { toast('Impossible de lire cette image'); }
    };
    if ($('#cvSearch')) $('#cvSearch').onclick = async () => {
      $('#cvSearch').textContent = 'Recherche…'; $('#cvSearch').disabled = true;
      const u = await findCoverAny(b.isbn, b.ark).catch(() => '');
      if (u) { b.cover = u; b.coverPhoto = false; save(); render(); toast('Couverture trouvée 🎉'); onDone(); }
      else { toast('Aucune couverture trouvée, essaie une photo'); $('#cvSearch').textContent = '🔎 Chercher automatiquement'; $('#cvSearch').disabled = false; }
    };
    if ($('#cvRemove')) $('#cvRemove').onclick = () => { b.cover = ''; save(); render(); onDone(); };
  }

  // ---------- Synchronisation en ligne (sauvegarde automatique) ----------
  function hashStr(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + '.' + str.length.toString(36); }
  const bookHash = (b) => { const { updatedAt, ...rest } = b; return hashStr(JSON.stringify(rest)); };
  let syncTimer = null, syncing = false, syncAgain = false;
  function scheduleSync(ms = 2500) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow().catch(() => {}), ms); }
  async function ensureLibrary() {
    if (!state.sync) state.sync = {};
    if (state.sync.id) return;
    const r = await api('register', {}, 20000);
    state.sync = { id: r.id, secret: r.secret, snap: {} };
    saveLocal();
  }
  async function syncNow() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      await ensureLibrary();
      const snap = state.sync.snap || {};
      const now = Date.now();
      const local = new Map(state.books.map((b) => [b.id, b]));
      const changes = [];
      for (const b of state.books) {
        if (snap[b.id] !== bookHash(b)) { b.updatedAt = now; changes.push({ book_id: b.id, updated_at: now, data: b }); }
      }
      for (const id of Object.keys(snap)) if (!local.has(id)) changes.push({ book_id: id, deleted: true, updated_at: now });
      const r = await api('sync', { id: state.sync.id, secret: state.sync.secret, changes }, 60000);
      let changed = false;
      for (const row of r.books || []) {
        const loc = local.get(row.book_id);
        if (row.deleted) {
          if (loc && (loc.updatedAt || 0) <= row.updated_at) { state.books = state.books.filter((x) => x !== loc); changed = true; }
          continue;
        }
        if (!row.data) continue;
        if (!loc) { state.books.push(Object.assign({}, row.data, { id: row.book_id, updatedAt: row.updated_at })); changed = true; }
        else if (row.updated_at > (loc.updatedAt || 0)) {
          for (const k of Object.keys(loc)) delete loc[k];
          Object.assign(loc, row.data, { id: row.book_id, updatedAt: row.updated_at }); changed = true;
        }
      }
      const newSnap = {};
      for (const b of state.books) newSnap[b.id] = bookHash(b);
      state.sync.snap = newSnap; state.sync.last = Date.now(); state.sync.error = '';
      saveLocal();
      if (changed && !scanner.active) render();
    } catch (e) {
      if (!state.sync) state.sync = {};
      state.sync.error = e.status === 401 ? 'code de bibliothèque refusé' : 'hors ligne';
      saveLocal();
    } finally {
      syncing = false;
      renderSyncStatus();
      if (syncAgain) { syncAgain = false; scheduleSync(500); }
    }
  }
  function libraryCode() { return state.sync && state.sync.id ? state.sync.id + '.' + state.sync.secret : ''; }
  function renderSyncStatus() {
    const el = $('#syncStatus'); if (!el) return;
    const sy = state.sync || {};
    if (sy.last && !sy.error) el.innerHTML = '✅ Ta bibliothèque est sauvegardée en ligne — dernière synchro : ' + new Date(sy.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    else if (sy.error) el.innerHTML = '⚠️ Pas de synchro pour l’instant (' + esc(sy.error) + '). Tes livres restent sur le téléphone et seront envoyés dès que possible.';
    else el.textContent = 'Connexion au serveur…';
  }
  function showLibraryCode() {
    const code = libraryCode();
    if (!code) { toast('Synchro pas encore faite, réessaie dans un instant'); syncNow(); return; }
    openSheet(`<h2>Code de ma bibliothèque</h2>
      <p class="muted small">Ce code permet de retrouver ta bibliothèque sur un autre téléphone (ou sur iPhone plus tard). Garde-le pour toi : quiconque l’a peut voir et modifier ta bibliothèque.</p>
      <div class="code-box" id="codeBox">${esc(code)}</div>
      <div class="sheet-actions">
        <button class="btn primary block" id="copyCode">Copier le code</button>
        <button class="btn block" id="shareCode">Partager / l’envoyer</button>
        <button class="btn ghost block" data-act="close">Fermer</button>
      </div>`);
    $('#copyCode').onclick = async () => { try { await navigator.clipboard.writeText(code); toast('Code copié'); } catch (e) { toast('Sélectionne le code et copie-le'); } };
    $('#shareCode').onclick = async () => {
      const P = window.Capacitor && window.Capacitor.Plugins;
      try {
        if (isNative() && P && P.Share) await P.Share.share({ title: 'Code Ma Bibliothèque', text: code });
        else if (navigator.share) await navigator.share({ text: code });
        else { await navigator.clipboard.writeText(code); toast('Code copié'); }
      } catch (e) { /* annulé */ }
    };
  }
  function useOtherCode() {
    openSheet(`<h2>Utiliser une autre bibliothèque</h2>
      <p class="muted small">Colle le code d’une bibliothèque existante (par exemple celle de ton ancien téléphone). Les livres de ce téléphone y seront ajoutés, rien n’est perdu.</p>
      <form class="form" id="codeForm"><input type="text" name="code" placeholder="xxxxxxxx-xxxx-….xxxxxxxx" autocomplete="off">
      <div class="sheet-actions"><button class="btn primary block" type="submit">Relier cette bibliothèque</button>
      <button class="btn ghost block" type="button" data-act="close">Annuler</button></div></form>`);
    $('#codeForm').onsubmit = async (e) => {
      e.preventDefault();
      const code = String(new FormData(e.target).get('code') || '').trim();
      const m = code.match(/^([0-9a-f-]{36})\.([0-9a-f]{20,})$/i);
      if (!m) return toast('Ce code n’a pas le bon format');
      const before = state.sync;
      state.sync = { id: m[1].toLowerCase(), secret: m[2].toLowerCase(), snap: {} };
      saveLocal(); closeSheet(); toast('Connexion à la bibliothèque…');
      await syncNow();
      if (state.sync.error) { toast('Code refusé, rien n’a changé', 3500); state.sync = before; saveLocal(); renderSyncStatus(); return; }
      toast('Bibliothèque reliée 🎉'); render(); loadServerReleases(false).catch(() => {});
    };
  }

  // ---------- Sorties calculées par le serveur (chaque nuit, ou à la demande) ----------
  async function loadServerReleases(refresh) {
    await syncNow();
    if (!state.sync || !state.sync.id || state.sync.error) throw new Error('serveur indisponible');
    if (state.lastCheckSeries && state.lastCheckSeries !== seriesKeySig()) refresh = true;
    const r = await api('releases', { id: state.sync.id, secret: state.sync.secret, refresh: !!refresh }, 150000);
    state.lastCheckSeries = seriesKeySig();
    if (!r) return;
    const manual = state.releases.filter((x) => x.manual);
    state.releases = manual.concat((r.releases || []).filter((f) => !manual.some((m) => relKey(m) === relKey(f))));
    state.lastCheck = r.checked_at ? new Date(r.checked_at).getTime() : Date.now();
    state.lastReport = r.report || null;
    state.releasesFromServer = true;
    saveLocal();
    if (!scanner.active) render();
  }

  // ---------- Recherche des sorties ----------
  // Une série : on cherche les tomes suivants dans Google Books (dates à venir) et à la BnF (déjà parus)
  async function releasesForSeries(s, report) {
    const vols = s.books.map((b) => b.volume).filter(Boolean);
    const maxOwned = vols.length ? Math.max(...vols) : 0;
    const ownedIsbn = new Set(s.books.map((b) => b.isbn));
    const byVol = new Map();
    const keep = (r) => {
      if (!r._s || norm(r._s) !== s.key || !r.volume) return;
      delete r._s;
      if (vols.includes(r.volume) || ownedIsbn.has(r.isbn) || r.volume < maxOwned) return;
      const prev = byVol.get(r.volume);
      // priorité à la date la plus précise (jour > mois > année)
      const prec = (d) => String(d || '').split('-').length;
      if (!prev || prec(r.date) > prec(prev.date) || (prec(r.date) === prec(prev.date) && dateKey(r.date) > dateKey(prev.date))) {
        byVol.set(r.volume, Object.assign({ id: uid() }, prev || {}, r, { cover: r.cover || (prev && prev.cover) || '' }));
      }
    };
    // Google Books
    try {
      const q = 'intitle:' + JSON.stringify(s.name);
      const data = await withRetry(() => getJSON('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&orderBy=newest&maxResults=40&printType=books&country=FR', 9000), 3);
      for (const it of data.items || []) {
        const b = fromGoogle(it);
        keep({ series: s.name, volume: b.volume, title: b.title, date: b.publishedDate, isbn: b.isbn, cover: b.cover, _s: b.series });
      }
      report.google.ok++;
    } catch (e) { report.google.err++; report.google.last = String(e.message || e); }
    // BnF : on demande directement les 2 tomes suivants
    if (maxOwned) {
      for (const v of [maxOwned + 1, maxOwned + 2]) {
        try {
          const recs = await withRetry(() => bnfSearch('bib.title all "' + s.name.replace(/"/g, '') + '" and bib.title all "' + v + '"', 10), 2);
          for (const r of recs) if (r.volume === v) keep({ series: s.name, volume: r.volume, title: r.title, date: r.publishedDate, isbn: r.isbn, cover: r.cover || '', out: true, _s: r.series });
          report.bnf.ok++;
        } catch (e) { report.bnf.err++; report.bnf.last = String(e.message || e); }
        await sleep(250);
      }
    }
    return [...byVol.values()];
  }

  async function checkReleases() {
    if (!seriesList().length) { toast('Ajoute d’abord des livres d’une série'); return; }
    const btn = $('#checkReleasesBtn');
    btn.disabled = true; btn.textContent = 'Recherche en cours…';
    try {
      await loadServerReleases(true);
      btn.disabled = false; btn.textContent = '↻ Chercher les nouveautés';
      const n = visibleReleases().length;
      toast(n ? `${n} tome${n > 1 ? 's' : ''} trouvé${n > 1 ? 's' : ''} pour tes séries 🎉` : 'Rien de nouveau pour l’instant');
      return;
    } catch (e) { /* serveur indisponible : recherche directe depuis le téléphone */ }
    return checkReleasesLocal();
  }
  async function checkReleasesLocal() {
    const series = seriesList();
    const btn = $('#checkReleasesBtn');
    btn.disabled = true;
    state.releasesFromServer = false;
    const keepManual = state.releases.filter((r) => r.manual);
    const found = [];
    const report = { google: { ok: 0, err: 0, last: '' }, bnf: { ok: 0, err: 0, last: '' } };
    let i = 0;
    for (const s of series) {
      i++;
      btn.textContent = `Recherche… ${i}/${series.length}`;
      found.push(...await releasesForSeries(s, report));
      await sleep(700); // on reste poli avec les services
    }
    // Une sortie trouvée seulement à la BnF est déjà parue (la BnF enregistre les livres à leur sortie)
    for (const r of found) r.out = !!(r.out && (!r.date || r.date.length === 4));
    state.releases = keepManual.concat(found.filter((f) => !keepManual.some((m) => relKey(m) === relKey(f))));
    state.lastCheck = Date.now();
    state.lastReport = report;
    save();
    btn.disabled = false; btn.textContent = '↻ Chercher les nouveautés';
    render();
    const up = visibleReleases().filter((r) => isUpcoming(r)).length;
    const allFailed = report.google.ok === 0 && report.bnf.ok === 0;
    if (allFailed) toast('Les catalogues ne répondent pas, réessaie dans quelques minutes', 4000);
    else toast(up ? `${up} sortie${up > 1 ? 's' : ''} à venir trouvée${up > 1 ? 's' : ''} 🎉` : 'Recherche terminée : rien de nouveau pour l’instant');
  }
  function isUpcoming(r) { return r.date && !r.out && dateKey(r.date) >= todayKey(); }

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
    $('#syncNowBtn').addEventListener('click', async () => { toast('Synchronisation…'); await syncNow(); toast(state.sync && !state.sync.error ? 'Synchronisé ✅' : 'Pas de connexion au serveur'); });
    $('#showCodeBtn').addEventListener('click', showLibraryCode);
    $('#useCodeBtn').addEventListener('click', useOtherCode);
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
      if (act === 'cover') { const b = state.books.find((x) => x.id === a.dataset.id); coverMenu(b, () => openBook(b.id)); }
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
      App.addListener('resume', () => {
        syncNow().then(() => { if (seriesList().length && Date.now() - (state.lastCheck || 0) > 6 * 3600e3) return loadServerReleases(false); }).catch(() => {});
      });
      App.addListener('backButton', () => {
        if (scanner.active || $('#scanOverlay')) finishScan();
        else if (!$('#sheetBackdrop').hidden) closeSheet();
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

  // Couvertures manquantes
  setTimeout(() => repairCovers().catch(() => {}), 1500);

  // Synchro en ligne, puis sorties (calculées par le serveur chaque nuit)
  setTimeout(() => {
    syncNow().then(() => { if (seriesList().length) return loadServerReleases(false); }).catch(() => {});
  }, 800);

  // Pour les tests
  window.__biblio = { parseSeries, state: () => state };
})();
