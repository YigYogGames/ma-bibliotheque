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
  const MONTHS_LONG = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
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
  // Le serveur cherche d'abord sur Amazon (le titre sert à vérifier que c'est le bon livre), puis chez les libraires
  async function findCoverAny(isbn, ark, b) {
    const info = b ? { title: b.title || '', series: b.series || '', volume: b.volume || null } : {};
    try { const r = await api('cover', Object.assign({ isbn, ark }, info), 30000); return r.cover || ''; } catch (e) { /* serveur injoignable : recherche directe */ }
    return findCover(isbn, ark);
  }
  // Une seule fois : on remplace les couvertures qui ne viennent pas d'Amazon (fausses images Google, images BnF très lourdes)
  const isAmazon = (u) => /media-amazon\.com|images-amazon\.com/.test(u || '');
  async function upgradeCovers() {
    const todo = state.books.filter((b) => b.isbn && !b.coverPhoto && (b.coverV || 0) < 2 && !isAmazon(b.cover));
    let changed = 0;
    for (const b of todo) {
      let u;
      try { u = (await api('cover', { isbn: b.isbn, ark: b.ark, title: b.title || '', series: b.series || '', volume: b.volume || null }, 30000)).cover || ''; }
      catch (e) { return; } // pas de réseau : on réessaiera au prochain lancement
      b.coverV = 2;
      if (u && u !== b.cover) { b.cover = u; changed++; }
      save();
      if (changed && changed % 5 === 0) scheduleRender();
      await new Promise((r) => setTimeout(r, 400));
    }
    if (changed) { scheduleRender(); toast(changed + ' couverture' + (changed > 1 ? 's' : '') + ' améliorée' + (changed > 1 ? 's' : '')); }
  }
  function coverLater(b) {
    if (!b.isbn || b.coverPhoto || b.cover) return;
    findCoverAny(b.isbn, b.ark, b).then((u) => {
      if (!u) return;
      b.cover = u; b.coverTriedAt = Date.now();
      const pv = $('#previewCover'); if (pv) pv.innerHTML = coverHTML(b);
      const bd = $('.book-card'); if (bd && !$('.bc-backdrop', bd)) bd.insertAdjacentHTML('afterbegin', `<div class="bc-backdrop" aria-hidden="true"><img src="${esc(u)}" alt=""></div>`);
      if (state.books.includes(b)) { save(); scheduleRender(); }
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
    // (Google n'est plus utilisé ici : il renvoie souvent une image « pas de couverture » qu'on ne peut pas reconnaître)
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
      const u = await findCoverAny(b.isbn, b.ark, b).catch(() => '');
      b.coverTriedAt = Date.now();
      if (u) { b.cover = u; fixed++; }
      save();
    }
    if (fixed) { scheduleRender(); toast(fixed + ' couverture' + (fixed > 1 ? 's' : '') + ' retrouvée' + (fixed > 1 ? 's' : '')); }
  }

  // ---------- Couvertures ----------
  function hashColor(s) {
    let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 30) % 360} 50% 24%))`;
  }
  function coverHTML(b) {
    const fake = `<div class="fake-cover" style="background:${hashColor(b.series || b.title)}"><div class="fc-title">${esc(b.title || 'Sans titre')}</div><div class="fc-author">${esc(b.authors || '')}</div></div>`;
    if (!b.cover) return fake;
    return `<img src="${esc(b.cover)}" alt="" loading="lazy" decoding="async" onerror="window.__badCover(this)" data-id="${esc(b.id || '')}" data-fb="${esc(fake)}">`;
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
    findCoverAny(b.isbn, b.ark, b).then((u) => {
      if (u && u !== bad) b.cover = u; else { b.cover = ''; b.coverTriedAt = Date.now(); }
      save(); scheduleRender();
    }).catch(() => {});
  };

  // ---------- Étagères (thèmes) ----------
  const THEMES = [
    { id: 'bois', name: 'Bois', desc: 'Lampe chaude et bois sombre', preview: 'radial-gradient(120% 70% at 50% 0%, #4a3523, #221912 60%, #1a130e)', ink: '#f3e6d3' },
    { id: 'neon', name: 'Néon', desc: 'Synthwave sous la pluie', preview: 'linear-gradient(#07040f 40%, #3b0b55), radial-gradient(circle at 50% 70%, #ff4fa3 0 22%, transparent 23%)', ink: '#ffe6fb' },
    { id: 'japon', name: 'Japon', desc: 'Washi, sakura et vagues', preview: 'radial-gradient(circle at 78% 30%, #d9473d 0 18%, transparent 19%), linear-gradient(#fbf5e9, #e9dcc2)', ink: '#2a211b' },
    { id: 'grimoire', name: 'Grimoire', desc: 'Bougies, runes et poussière d’or', preview: 'radial-gradient(70% 50% at 50% 10%, rgba(159,123,255,.45), transparent 70%), linear-gradient(#120f24, #0a0813)', ink: '#f1e6c8' },
    { id: 'lofi', name: 'Lo-fi', desc: 'Pluie sur la vitre, la nuit', preview: 'radial-gradient(circle at 30% 40%, rgba(255,143,177,.5) 0 10%, transparent 11%), radial-gradient(circle at 70% 55%, rgba(143,208,255,.45) 0 12%, transparent 13%), linear-gradient(#1b1d3a, #3a2b52)', ink: '#f3eefe' },
    { id: 'ocean', name: 'Océan', desc: 'Rayons, bulles et méduses', preview: 'linear-gradient(170deg, rgba(160,240,255,.35) 0 12%, transparent 13% 30%, rgba(160,240,255,.25) 31% 36%, transparent 37%), linear-gradient(#0e4d70, #04192e 70%, #020b16)', ink: '#e8fbff' },
  ].map((t) => Object.assign({ deco: [], hang: [], top: '', books: [] }, t));
  // anciens décors -> le plus proche des nouveaux
  const OLD_THEME = { 'dark-fantasy': 'grimoire', medieval: 'grimoire', halloween: 'grimoire', nuit: 'lofi', japon: 'japon', cosy: 'bois', papier: 'bois', pastel: 'bois', manga: 'bois' };
  const themeOf = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
  function themeCardsHTML() {
    return '<div class="theme-grid">' + THEMES.map((t) => `<button class="theme-card ${t.id === curTheme() ? 'active' : ''}" data-pick-theme="${t.id}" style="background:${t.preview};color:${t.ink}">
      <span class="tc-name" data-theme="${t.id}">${esc(t.name)}</span><span class="tc-desc">${esc(t.desc)}</span></button>`).join('') + '</div>';
  }

  // ---------- Décors animés (calque fixe derrière l'appli) ----------
  function seeded(seed) { let x = seed; return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }
  const SCENES = {
    bois: () => '<div class="sc-lamp"></div><div class="sc-dust"></div>',
    neon(r) {
      let rain = '';
      for (let i = 0; i < 28; i++) rain += `<i class="nx-drop" style="left:${(r() * 100).toFixed(1)}%;height:${40 + r() * 70 | 0}px;animation-duration:${(.55 + r() * .5).toFixed(2)}s;animation-delay:-${(r() * 1.5).toFixed(2)}s;opacity:${(.15 + r() * .3).toFixed(2)}"></i>`;
      return `<div class="nx-sky"></div><div class="nx-sun"></div><div class="nx-city"></div><div class="nx-floor"><div class="nx-grid"></div></div><div class="nx-scan"></div><div class="nx-rain">${rain}</div>`;
    },
    japon(r) {
      let petals = '';
      const cols = ['#f7b6c8', '#f9c9d6', '#f4a3bb', '#fbd5df'];
      for (let i = 0; i < 14; i++) petals += `<svg class="jp-petal" style="left:${(r() * 100 - 5).toFixed(1)}%;width:${10 + r() * 8 | 0}px;animation-duration:${(7 + r() * 6).toFixed(1)}s,${(2.5 + r() * 2).toFixed(1)}s;animation-delay:-${(r() * 12).toFixed(1)}s,-${(r() * 4).toFixed(1)}s" viewBox="0 0 20 20"><path d="M10 1C6 5 4 9 6 14c1 3 3 5 4 5s3-2 4-5c2-5 0-9-4-13z" fill="${cols[i % 4]}"/></svg>`;
      return `<div class="jp-washi"></div><div class="jp-sun"></div>
        <svg class="jp-mount" viewBox="0 0 390 220" preserveAspectRatio="none"><path d="M0 160 L60 90 L95 120 L150 40 L210 125 L250 95 L300 140 L340 100 L390 150 L390 220 L0 220Z" fill="#2b3a55" opacity=".14"/><path d="M0 185 L80 130 L130 165 L190 110 L250 170 L320 135 L390 175 L390 220 L0 220Z" fill="#2b3a55" opacity=".22"/><path d="M150 40 L165 58 L158 56 L150 64 L142 56 L135 58Z" fill="#fff" opacity=".8"/></svg>
        <svg class="jp-branch" viewBox="0 0 200 120"><path d="M0 30 C50 35 90 50 140 90 M60 40 C75 25 90 20 110 18 M100 62 C110 78 118 90 120 108" stroke="#4a2f22" stroke-width="3" fill="none" stroke-linecap="round"/><g fill="#f4a3bb"><circle cx="110" cy="18" r="6"/><circle cx="122" cy="20" r="5"/><circle cx="140" cy="90" r="7"/><circle cx="150" cy="84" r="5"/><circle cx="120" cy="108" r="6"/><circle cx="78" cy="30" r="5"/><circle cx="38" cy="33" r="4"/></g></svg>
        <div class="jp-hanko">本棚</div><div class="jp-waves"></div><div class="jp-petals">${petals}</div>`;
    },
    grimoire(r) {
      let stars = '', motes = '';
      for (let i = 0; i < 36; i++) stars += `<i class="gr-star" style="left:${(r() * 100).toFixed(1)}%;top:${(r() * 45).toFixed(1)}%;animation-delay:-${(r() * 4).toFixed(1)}s;animation-duration:${(2 + r() * 3).toFixed(1)}s"></i>`;
      for (let i = 0; i < 24; i++) { const z = (2 + r() * 3).toFixed(1); motes += `<i class="gr-mote" style="left:${(r() * 100).toFixed(1)}%;width:${z}px;height:${z}px;animation-duration:${(7 + r() * 7).toFixed(1)}s;animation-delay:-${(r() * 14).toFixed(1)}s"></i>`; }
      const candle = (side) => `<div class="gr-candle ${side}"><i class="gr-flame"></i><b></b></div>`;
      return `<div class="gr-sky"></div>${stars}<svg class="gr-runes" viewBox="0 0 300 300"><circle cx="150" cy="150" r="140" stroke="#d9b45a" fill="none" opacity=".5"/><circle cx="150" cy="150" r="118" stroke="#d9b45a" stroke-dasharray="2 8" fill="none" opacity=".6"/><circle cx="150" cy="150" r="96" stroke="#9f7bff" fill="none" opacity=".4"/><path d="M150 12 L270 220 L30 220Z M150 288 L30 80 L270 80Z" stroke="#d9b45a" fill="none" opacity=".35"/><path id="grc" d="M150 21 a129 129 0 1 1 -0.1 0" fill="none"/><text font-family="serif" font-size="14" fill="#d9b45a" opacity=".7"><textPath href="#grc">ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ ᚷ ᚹ ᚺ ᚾ ᛁ ᛃ ᛇ ᛈ ᛉ ᛊ ᛏ ᛒ ᛖ ᛗ ᛚ ᛜ ᛞ ᛟ ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ ᚷ</textPath></text></svg>${candle('l')}${candle('r')}<div class="gr-motes">${motes}</div><div class="gr-floor"></div>`;
    },
    lofi(r) {
      let bokeh = '', drops = '';
      const cols = ['#ff8fb1', '#ffd27a', '#8fd0ff', '#b59bff', '#ff9f6e'];
      for (let i = 0; i < 14; i++) { const z = 18 + r() * 42 | 0; bokeh += `<i class="lf-bokeh" style="left:${(r() * 100 - 5).toFixed(1)}%;top:${(10 + r() * 50).toFixed(1)}%;width:${z}px;height:${z}px;background:${cols[i % 5]};animation-duration:${(3 + r() * 4).toFixed(1)}s;animation-delay:-${(r() * 6).toFixed(1)}s"></i>`; }
      for (let i = 0; i < 24; i++) { const z = 3 + r() * 5; drops += `<i class="lf-drop" style="left:${(r() * 100).toFixed(1)}%;top:${(r() * 90 - 10).toFixed(1)}%;width:${z.toFixed(1)}px;height:${(z * 1.3).toFixed(1)}px;animation-duration:${(5 + r() * 7).toFixed(1)}s;animation-delay:-${(r() * 12).toFixed(1)}s"></i>`; }
      return `<div class="lf-sky"></div><div class="lf-bokehs">${bokeh}</div><div class="lf-streak"></div><div class="lf-drops">${drops}</div><div class="lf-sill"></div>
        <svg class="lf-cat" viewBox="0 0 70 62"><path d="M8 60 C6 40 14 28 26 26 L24 12 L32 22 C36 21 40 21 44 22 L52 12 L50 27 C58 32 60 44 58 60Z" fill="#0f0d1e"/><path class="lf-tail" d="M58 56 C70 52 72 40 64 34" stroke="#0f0d1e" stroke-width="6" fill="none" stroke-linecap="round"/><circle class="lf-eye" cx="32" cy="34" r="2.2" fill="#ffd27a"/><circle class="lf-eye" cx="44" cy="34" r="2.2" fill="#ffd27a"/></svg><div class="lf-grain"></div>`;
    },
    ocean(r) {
      let bubbles = '', rays = '';
      for (let i = 0; i < 22; i++) { const z = (4 + r() * 12).toFixed(1); bubbles += `<i class="oc-bub" style="left:${(r() * 100).toFixed(1)}%;width:${z}px;height:${z}px;animation-duration:${(6 + r() * 8).toFixed(1)}s,${(1.6 + r() * 2).toFixed(1)}s;animation-delay:-${(r() * 14).toFixed(1)}s,-${(r() * 3).toFixed(1)}s"></i>`; }
      for (let i = 0; i < 6; i++) rays += `<i class="oc-ray" style="left:${(i * 18 - 6 + r() * 6).toFixed(1)}%;width:${(24 + r() * 40) | 0}px;animation-delay:-${(r() * 8).toFixed(1)}s;animation-duration:${(6 + r() * 5).toFixed(1)}s"></i>`;
      const jelly = (cls, c) => `<svg class="oc-jelly ${cls}" viewBox="0 0 60 110"><path class="oc-bell" d="M6 34 C6 14 18 4 30 4 C42 4 54 14 54 34 C46 30 40 36 30 32 C20 36 14 30 6 34Z" fill="${c}" opacity=".75"/><g class="oc-tent" stroke="${c}" stroke-width="2" fill="none" opacity=".55" stroke-linecap="round"><path d="M14 34 C10 52 18 66 12 86"/><path d="M24 34 C22 56 30 74 24 104"/><path d="M36 34 C38 56 30 74 36 100"/><path d="M46 34 C50 52 42 66 48 84"/></g></svg>`;
      return `<div class="oc-sea"></div><div class="oc-caustic"></div><div class="oc-rays">${rays}</div>${jelly('j1', '#ff9ed2')}${jelly('j2', '#9fe7ff')}
        <svg class="oc-kelp l" viewBox="0 0 80 260"><path d="M20 260 C10 210 34 170 22 120 C12 80 30 40 24 0" stroke="#1f7a5c" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M48 260 C58 220 36 190 50 150 C60 120 44 90 52 60" stroke="#2b9470" stroke-width="7" fill="none" stroke-linecap="round"/></svg>
        <svg class="oc-kelp r" viewBox="0 0 80 260"><path d="M40 260 C30 210 54 170 42 120 C32 80 50 50 44 10" stroke="#2b9470" stroke-width="8" fill="none" stroke-linecap="round"/></svg>
        <div class="oc-sand"></div><div class="oc-bubs">${bubbles}</div>`;
    },
  };
  let sceneFor = '';
  function renderScene() {
    const id = curTheme();
    if (id === sceneFor) return;
    sceneFor = id;
    const el = $('#scene'); if (!el) return;
    const make = SCENES[id] || SCENES.bois;
    el.innerHTML = make(seeded(id.length * 7919 + 13));
    el.dataset.theme = id;
  }
  // animation d'entrée des étagères (au démarrage, en changeant de thème, de bibliothèque ou de disposition)
  function animateShelves() {
    const el = $('#libraryContent'); if (!el) return;
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    clearTimeout(animateShelves.t); animateShelves.t = setTimeout(() => el.classList.remove('enter'), 1600);
  }
  function curTheme() { const t = state.settings.themes || {}; const id = t[curCat()] || state.settings.theme || 'bois'; return THEMES.some((x) => x.id === id) ? id : (OLD_THEME[id] || 'bois'); }
  let lastTap = { x: innerWidth / 2, y: innerHeight / 2 };
  document.addEventListener('pointerdown', (e) => { lastTap = { x: e.clientX, y: e.clientY }; }, true);
  function pickTheme(id) {
    if (id === curTheme()) return;
    const go = () => { state.settings.themes = Object.assign({}, state.settings.themes, { [curCat()]: id }); save(); applyTheme(); render(); animateShelves(); };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduce) return go();
    document.documentElement.style.setProperty('--vt-x', lastTap.x + 'px');
    document.documentElement.style.setProperty('--vt-y', lastTap.y + 'px');
    document.startViewTransition(go);
  }
  function openShelfPicker() {
    openSheet(`<h2>Étagère des ${CATS[curCat()].label.toLowerCase()}</h2>${themeCardsHTML()}<div class="sheet-actions"><button class="btn ghost block" data-act="close">Fermer</button></div>`);
    $$('[data-pick-theme]', $('#sheetBody')).forEach((c) => c.onclick = () => { closeSheet(); pickTheme(c.dataset.pickTheme); });
  }

  // ---------- Bibliothèques Romans / Mangas ----------
  const CATS = { roman: { label: 'Romans', one: 'roman', icon: '📖' }, manga: { label: 'Mangas', one: 'manga', icon: '🎌' } };
  const MANGA_PUB = ['pika', 'kana', 'ki oon', 'kioon', 'kurokawa', 'tonkam', 'kaze', 'doki doki', 'akata', 'soleil manga', 'crunchyroll',
    'noeve', 'mangetsu', 'meian', 'glenat manga', 'panini manga', 'black box', 'ototo', 'taifu', 'nobi nobi', 'kbooks', 'sakka', 'naban',
    'isan manga', 'omake', 'lezard noir', 'imho', 'vega', 'dupuis manga', 'kotoji', 'hikari', 'komikku', 'mana books', 'h2t', 'shiba',
    'bamboo manga', 'michel lafon manga', 'nazca', 'delcourt tonkam', 'ankama', 'fleurus manga'];
  function guessCategory(parts) {
    const txt = ' ' + norm(parts.filter(Boolean).join(' ')) + ' ';
    if (/ (mangas?|shonen|shounen|seinen|shojo|shoujo|josei|kodomo|webtoons?|manhwa|manhua|bandes? dessinees?|bd|comics?) /.test(txt)) return 'manga';
    if (MANGA_PUB.some((p) => txt.includes(' ' + p + ' '))) return 'manga';
    return '';
  }
  // Catégorie d'un livre : la sienne, sinon celle de sa série, sinon une supposition
  let seriesCatCache = null;
  function seriesCats() {
    if (seriesCatCache) return seriesCatCache;
    const m = {};
    for (const b of state.books) if (b.series && b.category) m[norm(b.series)] = m[norm(b.series)] || b.category;
    return (seriesCatCache = m);
  }
  function catOf(b) {
    if (b.category) return b.category;
    const sc = b.series && seriesCats()[norm(b.series)];
    return sc || guessCategory([b.collection, b.publisher, b.title]) || 'roman';
  }
  function curCat() {
    if (state.settings.cat) return state.settings.cat;
    const hasManga = state.books.some((b) => catOf(b) === 'manga'), hasRoman = state.books.some((b) => catOf(b) === 'roman');
    return hasManga && !hasRoman ? 'manga' : 'roman';
  }
  const catBooks = (cat = curCat()) => state.books.filter((b) => catOf(b) === cat);
  function setCat(cat) {
    if (cat === curCat() && state.settings.cat) return;
    state.settings.cat = cat; saveLocal(); applyTheme(); libSig = ''; window.scrollTo(0, 0); render(); animateShelves();
  }
  function renderCatSwitch() {
    const el = $('#catSwitch'); if (!el) return;
    el.hidden = currentView === 'settings' || currentView === 'stats';
    const c = curCat();
    const counts = { roman: 0, manga: 0 };
    for (const b of state.books) counts[catOf(b)]++;
    el.innerHTML = Object.entries(CATS).map(([k, v]) => `<button class="cat-btn ${k === c ? 'on' : ''}" data-cat="${k}">${v.label}<span class="cat-n">${counts[k]}</span></button>`).join('');
  }
  function moveBooks(books, cat) {
    for (const b of books) { b.category = cat; b.catManual = true; }
    seriesCatCache = null; save(); render();
  }

  const LN_RE = /\s*\(roman\)\s*$/i;
  // Livres déjà dans la bibliothèque : on demande leur catégorie au serveur (en arrière-plan)
  let classifying = false;
  async function classifyLibrary() {
    if (classifying) return;
    classifying = true;
    try {
      // livres sans catégorie, ou sans type (manga, roman, light novel…) : détection faite par le serveur
      const recheck = (b) => !b.recat13 && !b.catManual && b.category === 'roman' && b.format !== 'Light novel' && !LN_RE.test(b.series || '') && guessCategory([b.publisher]) === 'manga';
      const todo = state.books.filter((b) => b.isbn && ((!b.category && !b.catTriedAt) || (!b.format && !b.fmtTriedAt) || (b.price == null && !b.priceTriedAt) || recheck(b)));
      for (let i = 0; i < todo.length; i += 6) {
        const chunk = todo.slice(i, i + 6);
        let res = {};
        try { res = (await api('lookupMany', { isbns: chunk.map((b) => b.isbn) }, 90000)).books || {}; } catch (e) { break; }
        for (const b of chunk) {
          const f = res[b.isbn];
          b.catTriedAt = b.fmtTriedAt = b.priceTriedAt = Date.now();
          if (f) b.recat13 = 1;
          if (f && f.format && (!b.format || recheck(b))) b.format = f.format;
          if (f && f.price && !b.price) b.price = f.price;
          // un light novel rangé avec le manga du même nom : on le met dans sa propre série « Nom (roman) »
          if (f && f.series && LN_RE.test(f.series) && b.series && !LN_RE.test(b.series) && norm(f.series.replace(LN_RE, '')) === norm(b.series)) {
            b.series = f.series; if (f.title) b.title = f.title;
          }
          if (f && f.category && !b.catManual) b.category = f.category;
          if (f && !b.cover && f.cover) b.cover = f.cover;
          if (f && !b.publishedDate && f.publishedDate) b.publishedDate = f.publishedDate;
        }
        seriesCatCache = null; save(); scheduleRender();
      }
    } finally { classifying = false; }
  }

  // ---------- Navigation ----------
  const TITLES = { library: 'Ma bibliothèque', series: 'Mes séries', releases: 'Sorties prévues', settings: 'Réglages' };
  let currentView = 'library';
  function show(view) {
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    window.scrollTo(0, 0);
    render();
  }
  function viewTitle() {
    const c = CATS[curCat()];
    return { library: 'Ma bibliothèque', series: 'Mes séries', stats: 'Statistiques', releases: 'Sorties prévues', settings: 'Réglages' }[currentView];
  }
  // Signature des séries possédées (avec le dernier tome) : si elle change, on recalcule les sorties
  function seriesKeySig() {
    return seriesList().map((s) => s.key + ':' + Math.max(0, ...s.books.map((b) => b.volume || 0))).join('|');
  }

  // ---------- Rendu ----------
  // Plusieurs mises à jour rapprochées = un seul dessin de l'écran
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; if (!scanner.active) render(); });
  }
  function render() {
    seriesCatCache = null;
    $('#viewTitle').textContent = viewTitle();
    renderCatSwitch();
    renderSub();
    if (currentView === 'library') renderLibrary();
    if (currentView === 'series') renderSeries();
    if (currentView === 'stats') renderStats();
    if (currentView === 'releases') renderReleases();
    if (currentView === 'settings') renderSettings();
    renderBadge();
  }
  function renderSub() {
    const n = catBooks().length;
    const s = seriesInCat().length;
    const sub = {
      library: n ? `${n} ${CATS[curCat()].label.toLowerCase()}` : '',
      stats: 'Ta bibliothèque en chiffres',
      series: s ? `${s} série${s > 1 ? 's' : ''}` : '',
      releases: state.releasesRefreshing ? 'Recherche des nouveautés…' : 'Les prochains tomes de tes séries',
      settings: '',
    }[currentView];
    $('#viewSub').textContent = sub || '';
  }

  function sortedBooks() {
    const q = norm($('#searchInput').value);
    let list = catBooks().filter((b) => !q || norm([b.title, b.authors, b.series, b.publisher, b.isbn].join(' ')).includes(q));
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

  // ---------- Dispositions des étagères ----------
  const LAYOUTS = [
    { id: 'shelf', name: 'Classique', desc: 'Tous les livres à la suite, dans l’ordre de tri choisi.' },
    { id: 'series', name: 'Une série par étagère', desc: 'Chaque étagère = une série. Glisse de gauche à droite pour voir les tomes.' },
    { id: 'group', name: 'Séries regroupées', desc: 'Une seule couverture par série. Touche-la pour déplier tous ses tomes.' },
    { id: 'list', name: 'Liste', desc: 'Une ligne par livre, avec le titre et l’auteur.' },
  ];
  const SORTS = [
    { id: 'added', name: 'Ajout récent' },
    { id: 'series', name: 'Série puis tome' },
    { id: 'title', name: 'Titre (A→Z)' },
    { id: 'author', name: 'Auteur (A→Z)' },
    { id: 'date', name: 'Date de parution' },
  ];
  const LAYOUT_ICON = {
    shelf: '<i class="li-row"><b></b><b></b><b></b><b></b><b></b></i><i class="li-plank"></i><i class="li-row"><b></b><b></b><b></b><b></b><b></b></i><i class="li-plank"></i>',
    series: '<i class="li-row li-scroll"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></i><i class="li-plank"></i><i class="li-row li-scroll alt"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></i><i class="li-plank"></i>',
    group: '<i class="li-row li-piles"><b></b><b></b><b></b></i><i class="li-plank"></i>',
    list: '<i class="li-line"></i><i class="li-line"></i><i class="li-line"></i><i class="li-line"></i>',
  };
  function optionCards(items, current, attr, icons) {
    return items.map((o) => `<button class="opt-card ${o.id === current ? 'on' : ''}" ${attr}="${o.id}">
        ${icons ? `<span class="opt-icon" aria-hidden="true">${icons[o.id]}</span>` : ''}
        <span class="opt-main"><span class="opt-name">${o.name}</span>${o.desc ? `<span class="opt-desc">${o.desc}</span>` : ''}</span>
        <span class="opt-radio" aria-hidden="true"></span></button>`).join('');
  }
  function openLayoutMenu() {
    openSheet(`<h2>Disposition des étagères</h2><p class="muted small">Choisis comment tes livres sont rangés.</p>
      <div class="opt-list">${optionCards(LAYOUTS, state.settings.layout, 'data-layout', LAYOUT_ICON)}</div>
      <div class="sheet-actions"><button class="btn block" id="decorBtn">🎨 Changer de décor</button>
      <button class="btn ghost block" data-act="close">Fermer</button></div>`);
    $$('[data-layout]', $('#sheetBody')).forEach((b) => b.onclick = () => {
      state.settings.layout = b.dataset.layout; openPile = null; save(); closeSheet(); libSig = ''; renderLibrary(); animateShelves();
      window.scrollTo({ top: 0 });
    });
    $('#decorBtn').onclick = openShelfPicker;
  }
  function openSortMenu() {
    openSheet(`<h2>Trier les livres</h2>
      <div class="opt-list">${optionCards(SORTS, state.settings.sort, 'data-sort')}</div>
      <div class="sheet-actions"><button class="btn ghost block" data-act="close">Fermer</button></div>`);
    $$('[data-sort]', $('#sheetBody')).forEach((b) => b.onclick = () => {
      state.settings.sort = b.dataset.sort; save(); closeSheet(); renderLibrary();
    });
  }
  // Regroupe les livres (déjà triés) par série, dans l'ordre où chaque série apparaît ; tomes du plus petit au plus grand
  function groupBySeries(list) {
    const groups = [], idx = new Map(), loose = [];
    for (const b of list) {
      if (!b.series) { loose.push(b); continue; }
      const k = norm(b.series);
      if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ key: k, name: b.series, books: [] }); }
      groups[idx.get(k)].books.push(b);
    }
    for (const g of groups) g.books.sort((a, b) => (a.volume || 0) - (b.volume || 0));
    return { groups, loose };
  }
  const bookHTML = (b) => `<div class="book" data-id="${b.id}">${coverHTML(b)}${b.volume ? `<span class="vol-tag">${b.volume}</span>` : ''}</div>`;
  function plankHTML(row) {
    const T = themeOf(curTheme());
    const hang = T.hang.length ? `<span class="hang ${row % 2 ? 'r' : 'l'}">${T.hang[row % T.hang.length]}</span>` : '';
    return `<div class="shelf-plank">${hang}${T.lights ? '<span class="lights"></span>' : ''}</div>`;
  }
  function shelfCols() { return Math.max(3, Math.floor((Math.min(window.innerWidth, 900) - 40) / 112)); }

  // Mode « une série par étagère » : une carte arrondie par série, couverture floutée en fond, tomes qui défilent
  function seriesProgress(name, books) {
    const info = (state.seriesInfo || {})[norm(name)];
    const owned = new Set(books.map((b) => b.volume).filter(Boolean)).size;
    if (!info || !info.fr) return null;
    const total = Math.max(info.fr, owned);
    return { owned, total, pct: Math.min(100, Math.round(owned / total * 100)), status: info.status, info };
  }
  function seriesShelvesHTML(list) {
    const { groups, loose } = groupBySeries(list);
    const cards = groups.map((g) => {
      const n = g.books.length;
      const pr = seriesProgress(g.name, g.books);
      const bg = (g.books.find((b) => b.cover && !b.coverPhoto) || g.books.find((b) => b.cover) || {}).cover;
      return `<section class="s-card">
        ${bg ? `<img class="s-bg" src="${esc(bg)}" alt="" aria-hidden="true">` : ''}
        <div class="s-top"><div class="s-names"><b>${esc(g.name)}</b><span>${n} tome${n > 1 ? 's' : ''}</span></div>
          <button class="s-open" data-series-open="${esc(g.key)}" aria-label="Voir la série ${esc(g.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></div>
        <div class="series-scroll">${g.books.map(bookHTML).join('')}</div>
        ${pr ? `<div class="s-prog"><div class="s-prog-row"><span>${pr.owned} sur ${pr.total} parus en France</span>${pr.status ? `<span class="s-pill ${pr.status === 'Terminée' ? 'done' : ''}">${pr.status}</span>` : ''}</div>
          <div class="s-bar ${pr.status === 'Terminée' ? 'done' : ''}"><i style="width:${pr.pct}%"></i></div></div>` : ''}
      </section>`;
    });
    if (loose.length) cards.push(`<section class="s-card"><div class="s-top"><div class="s-names"><b>Autres livres</b><span>${loose.length} livre${loose.length > 1 ? 's' : ''}</span></div></div>
      <div class="series-scroll">${loose.map(bookHTML).join('')}</div></section>`);
    return '<div class="s-cards">' + cards.join('') + '</div>';
  }

  // Infos des séries (tomes parus en France, parution d'origine, statut) : demandées au serveur en arrière-plan
  let infoVer = 0, infoLoading = false;
  async function loadSeriesInfo(force) {
    if (infoLoading) return;
    infoLoading = true;
    try {
      state.seriesInfo = state.seriesInfo || {};
      for (const s of seriesList()) {
        const maxOwned = Math.max(0, ...s.books.map((b) => b.volume || 0));
        const cur = state.seriesInfo[s.key];
        if (!force && cur && cur.maxOwned === maxOwned && Date.now() - (cur.at || 0) < 3 * 864e5) continue;
        try {
          const r = await api('seriesInfo', { series: s.name, books: s.books.map((b) => ({ isbn: b.isbn, volume: b.volume, publisher: b.publisher, category: b.category, format: b.format })) }, 120000);
          if (r && r.info) { state.seriesInfo[s.key] = Object.assign({}, r.info, { maxOwned, at: Date.now() }); infoVer++; save(); scheduleRender(); }
        } catch (e) { break; } // serveur injoignable : on réessaiera plus tard
      }
    } finally { infoLoading = false; }
  }

  // Page d'une série : progression de ta collection, parution en France et dans le pays d'origine, tomes manquants
  function openSeries(key) {
    const s = seriesList().find((x) => x.key === key);
    if (!s) return;
    const books = s.books.slice().sort((a, b) => (a.volume || 0) - (b.volume || 0));
    const info = (state.seriesInfo || {})[key] || null;
    const ownedVols = new Set(books.map((b) => b.volume).filter(Boolean));
    const maxOwned = Math.max(0, ...ownedVols);
    const fr = Math.max(info && info.fr || 0, maxOwned);
    const covers = books.filter((b) => b.cover).slice(0, 3);
    const first = books[0];
    const ref = books.filter((b) => b.volume === maxOwned)[0] || first;
    const missing = []; for (let v = 1; v <= Math.min(fr, 300); v++) if (!ownedVols.has(v)) missing.push(v);
    const origin = info && info.origin ? info.origin.charAt(0).toUpperCase() + info.origin.slice(1) : '';
    const originFr = /france|belgique/i.test(origin);
    const inOrigin = origin ? (/^[aeiouyé]/i.test(origin) ? 'en ' : /^(japon|royaume|canada|portugal)/i.test(origin) ? 'au ' : /unis$/i.test(origin) ? 'aux ' : 'en ') + origin.replace(/^Japon$/i, 'Japon') : '';
    const bar = (title, value, pct, color, note) => `<div class="sd-bar"><div class="sd-bar-row"><b>${title}</b><span>${value}</span></div>
      <div class="s-bar ${color}"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>${note ? `<p>${note}</p>` : ''}</div>`;
    let bars = bar('Ma collection', `${ownedVols.size} sur ${fr} tome${fr > 1 ? 's' : ''}`, fr ? ownedVols.size / fr * 100 : 0, '',
      missing.length ? (missing.length === 1 ? `Il te manque le tome ${missing[0]}.` : `Il te manque ${missing.length} tomes (${volRange(missing)}).`) : 'Tu as tous les tomes parus en France.');
    if (info && info.originCount && !originFr) {
      const behind = info.originCount - fr;
      bars += bar('Parution en France', behind < 0 ? `${fr} tomes` : `${fr} sur ${info.originCount} tomes`, fr / info.originCount * 100, 'fr',
        behind > 0 ? `La France a ${behind} tome${behind > 1 ? 's' : ''} de retard sur l’édition d’origine.` : behind < 0 ? `L’édition française compte plus de tomes que l’originale (${info.originCount}) : les chapitres y sont répartis autrement.` : 'La France est à jour.');
      bars += bar('Parution ' + inOrigin, `${info.originCount} tomes`, 100, info.originFinished ? 'done' : 'origin',
        info.originFinished ? 'Série terminée ' + inOrigin + '.' : 'Série toujours en cours ' + inOrigin + '.');
    } else if (info && info.originFinished != null) {
      bars += bar('Parution' + (inOrigin ? ' ' + inOrigin : ''), `${fr} tome${fr > 1 ? 's' : ''}`, 100, info.originFinished ? 'done' : 'origin',
        info.originFinished ? 'Série terminée.' : 'Série toujours en cours.');
    }
    const nextRel = state.releases.filter((r) => norm(r.series) === key && r.date && dateKey(r.date) >= todayKey())
      .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))[0];
    const days = nextRel ? Math.round((new Date(dateKey(nextRel.date)) - new Date(todayKey())) / 864e5) : 0;
    const grid = [];
    const top = Math.min(Math.max(fr, maxOwned), 300);
    for (let v = 1; v <= top; v++) {
      const b = books.find((x) => x.volume === v);
      grid.push(b ? bookHTML(b) : `<div class="sd-miss" aria-label="Tome ${v} manquant">${v}</div>`);
    }
    for (const b of books.filter((x) => !x.volume)) grid.push(bookHTML(b));
    const status = info && info.status;
    openSheet(`<div class="book-card sd">
        ${covers[0] ? `<div class="bc-backdrop" aria-hidden="true"><img src="${esc(covers[0].cover)}" alt=""></div>` : ''}
        <div class="sd-head">
          <div class="sd-fan">${covers.slice(1, 3).map((b, i) => `<img class="f${i + 1}" src="${esc(b.cover)}" alt="">`).join('')}${covers[0] ? `<img class="f0" src="${esc(covers[0].cover)}" alt="">` : ''}</div>
          <h2 class="bc-title">${esc(s.name)}</h2>
          <div class="bc-authors">${esc([first.authors, first.publisher].filter(Boolean).join(' · '))}</div>
          <div class="bc-chips">${first.format ? `<span>${esc(first.format)}</span>` : ''}${status ? `<span class="${status === 'Terminée' ? 'st-done' : 'st-on'}">${status}</span>` : ''}</div>
        </div>
        <div class="sd-bars">${info ? bars : '<p class="muted small">Recherche de la parution de la série…</p>'}</div>
        ${nextRel ? `<div class="sd-next"><div class="sd-miss small">${nextRel.volume ? 'T' + nextRel.volume : '?'}</div><div><span>PROCHAINE SORTIE</span><b>${nextRel.volume ? 'Tome ' + nextRel.volume + ' · ' : ''}${fmtDate(nextRel.date)}</b><small>${days <= 0 ? 'aujourd’hui' : days === 1 ? 'demain' : 'dans ' + days + ' jours'}</small></div></div>` : ''}
        <div class="sd-vols-head"><h3>Les tomes</h3><span>${ownedVols.size} possédé${ownedVols.size > 1 ? 's' : ''}${missing.length ? ' · ' + missing.length + ' manquant' + (missing.length > 1 ? 's' : '') : ''}</span></div>
        <div class="sd-grid" id="sdGrid">${grid.join('')}</div>
      </div>
      <div class="sheet-actions">
        ${missing.length ? `<button class="btn primary block" id="sdFill">Ajouter ${missing.length === 1 ? 'le tome manquant' : 'les ' + missing.length + ' tomes manquants'}</button>` : ''}
        <button class="btn ghost block" data-act="close">Fermer</button>
      </div>`);
    $('#sdGrid').onclick = (e) => { const it = e.target.closest('.book[data-id]'); if (it) openBook(it.dataset.id); };
    if ($('#sdFill')) $('#sdFill').onclick = () => fillPrevious(ref, missing);
    if (!info) loadSeriesInfo().then(() => { if ($('.book-card.sd') && (state.seriesInfo || {})[key]) openSeries(key); });
  }

  // ---------- Statistiques ----------
  function renderStats() {
    const el = $('#statsContent');
    const books = state.books;
    if (!books.length) { el.innerHTML = `<div class="empty"><h2>Pas encore de statistiques</h2><p>Scanne tes premiers livres pour voir les chiffres de ta bibliothèque.</p></div>`; return; }
    const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
    const byCat = { roman: [], manga: [] };
    for (const b of books) byCat[catOf(b)].push(b);
    const pages = (l) => l.reduce((t, b) => t + (+b.pages || 0), 0);
    const totalPages = pages(books);
    const minutes = pages(byCat.manga) * 0.4 + pages(byCat.roman) * 1.3;
    // valeur : prix neuf actuel ; sans prix connu, on prend la moyenne des livres du même type
    const known = (l) => l.filter((b) => +b.price > 0);
    const avg = (l, d) => { const k = known(l); return k.length ? k.reduce((t, b) => t + +b.price, 0) / k.length : d; };
    const avgCat = { manga: avg(byCat.manga, 7.5), roman: avg(byCat.roman, 9) };
    const value = books.reduce((t, b) => t + (+b.price > 0 ? +b.price : avgCat[catOf(b)]), 0);
    const estimated = books.filter((b) => !(+b.price > 0)).length;
    const series = seriesList();
    let complete = 0, missingTotal = 0;
    for (const s of series) {
      const owned = new Set(s.books.map((b) => b.volume).filter(Boolean));
      const max = Math.max(0, ...owned);
      const info = (state.seriesInfo || {})[s.key];
      const total = Math.max(info && info.fr || 0, max);
      let miss = 0; for (let v = 1; v <= total; v++) if (!owned.has(v)) miss++;
      missingTotal += miss;
      if (!miss && total) complete++;
    }
    const pct = Math.round(byCat.roman.length / books.length * 100);
    // ajouts des 6 derniers mois
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const n = books.filter((b) => { const a = new Date(b.addedAt || 0); return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth(); }).length;
      months.push({ label: d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''), n, cur: i === 0 });
    }
    const maxM = Math.max(1, ...months.map((m) => m.n));
    const thick = books.filter((b) => +b.pages > 0).sort((a, b) => b.pages - a.pages)[0];
    const pubs = {};
    for (const b of books) if (b.publisher) { const k = norm(b.publisher).split(' ')[0]; (pubs[k] = pubs[k] || { name: b.publisher, n: 0 }).n++; }
    const fav = Object.values(pubs).sort((a, b) => b.n - a.n)[0];
    const hours = minutes / 60;
    el.innerHTML = `<div class="st-wrap">
      <div class="st-grid">
        <div class="st-card"><span>Livres</span><b class="st-big">${fmt(books.length)}</b><small>dans ${series.length} série${series.length > 1 ? 's' : ''}</small></div>
        <div class="st-card"><span>Pages</span><b class="st-big">${fmt(totalPages)}</b><small>≈ ${hours >= 1 ? fmt(hours) + ' h' : fmt(minutes) + ' min'} de lecture</small></div>
        <div class="st-card st-money"><div class="st-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 6.5A7 7 0 1 0 17.5 17.5"/><path d="M4 10.5h10M4 13.5h10"/></svg></div>
          <div><span>Valeur estimée de ta bibliothèque</span><b class="st-big">≈ ${fmt(Math.round(value / 5) * 5)} €</b><small>d’après les prix neufs actuels en librairie${estimated ? ` (${estimated} prix estimé${estimated > 1 ? 's' : ''})` : ''}</small></div></div>
      </div>
      <div class="st-card st-block"><h3>Romans et mangas</h3>
        <div class="st-split"><i class="r" style="width:${pct}%"></i><i class="m" style="width:${100 - pct}%"></i></div>
        <div class="st-split-legend"><span><b class="r">${byCat.roman.length}</b> roman${byCat.roman.length > 1 ? 's' : ''} · ${fmt(pages(byCat.roman))} pages</span><span><b class="m">${byCat.manga.length}</b> manga${byCat.manga.length > 1 ? 's' : ''} · ${fmt(pages(byCat.manga))} pages</span></div></div>
      <div class="st-card st-block"><h3>Mes séries</h3>
        <div class="st-three"><div><b>${series.length}</b><span>suivies</span></div><div><b class="ok">${complete}</b><span>complètes</span></div><div><b class="warn">${missingTotal}</b><span>tomes manquants</span></div></div></div>
      <div class="st-card st-block"><div class="st-head"><h3>Livres ajoutés</h3><span>6 derniers mois</span></div>
        <div class="st-months">${months.map((m) => `<div><span class="n">${m.n}</span><i class="${m.cur ? 'cur' : ''}" style="height:${Math.max(4, Math.round(m.n / maxM * 70))}px"></i><span>${m.label}</span></div>`).join('')}</div></div>
      <div class="st-grid">
        ${thick ? `<div class="st-card"><span>Le plus épais</span><b>${esc(thick.title)}</b><small>${thick.pages} pages</small></div>` : ''}
        ${fav ? `<div class="st-card"><span>Éditeur préféré</span><b>${esc(fav.name)}</b><small>${fav.n} livre${fav.n > 1 ? 's' : ''}</small></div>` : ''}
      </div>
    </div>`;
  }

  // Mode « séries regroupées » : une pile par série, qui se déplie quand on la touche
  let openPile = null;
  function groupedShelvesHTML(list) {
    const { groups, loose } = groupBySeries(list);
    const T = themeOf(curTheme());
    const cols = shelfCols();
    const units = [];
    const seen = new Set();
    for (const b of list) { // garde l'ordre du tri : une série prend la place de son premier tome
      if (!b.series) { units.push({ book: b }); continue; }
      const k = norm(b.series);
      if (seen.has(k)) continue;
      seen.add(k);
      const g = groups.find((x) => x.key === k);
      units.push(g.books.length > 1 ? { group: g } : { book: g.books[0] });
    }
    void loose;
    let html = '<div class="shelf">' + (T.top ? `<div class="shelf-top">${T.top}</div>` : '');
    for (let i = 0, row = 0; i < units.length; i += cols, row++) {
      const chunk = units.slice(i, i + cols);
      html += `<div class="shelf-row" style="--cols:${cols}">` + chunk.map((u) => {
        if (u.book) return bookHTML(u.book);
        const g = u.group, first = g.books[0];
        return `<button class="book pile ${openPile === g.key ? 'open' : ''}" data-pile="${esc(g.key)}" aria-label="${esc(g.name)}, ${g.books.length} tomes">${coverHTML(Object.assign({}, first, { id: '', title: g.name }))}<span class="pile-count">${g.books.length} tomes</span></button>`;
      }).join('') + `</div>${plankHTML(row)}`;
      const opened = chunk.find((u) => u.group && u.group.key === openPile);
      if (opened) {
        const g = opened.group;
        html += `<div class="pile-panel"><div class="pile-head"><b>${esc(g.name)}</b><span>${g.books.length} tomes</span>
          <button class="btn small" data-regroup>Regrouper</button></div>`;
        for (let k = 0; k < g.books.length; k += cols) {
          html += `<div class="shelf-row" style="--cols:${cols}">` + g.books.slice(k, k + cols).map(bookHTML).join('') + `</div><div class="shelf-plank thin"></div>`;
        }
        html += '</div>';
      }
    }
    return html + '</div>';
  }

  let libSig = '';
  // Pendant une recherche dans la barre du haut : les livres trouvés en ligne, à ajouter, sous ceux de la bibliothèque
  let onlineQ = '', onlineTimer = null;
  function updateOnlineHint() {
    const h = $('#onlineHint'); if (!h) return;
    const q = $('#searchInput').value.trim();
    if (norm(q).length < 2) { h.hidden = true; h.innerHTML = ''; onlineQ = ''; clearTimeout(onlineTimer); return; }
    if (norm(q) === onlineQ) return; // déjà affiché (ou en cours) pour cette recherche
    onlineQ = norm(q);
    h.hidden = false;
    h.innerHTML = `<h3 class="as-h">À ajouter à ta bibliothèque</h3><div class="as-loading"><span class="mini-spin"></span>Recherche de « ${esc(q)} » chez les libraires…</div>`;
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(async () => {
      const mine = onlineQ;
      let res;
      try { res = await searchOnline(q); }
      catch (e) { if (mine === onlineQ) h.innerHTML = '<p class="as-hint">Pas de connexion : impossible de chercher en ligne pour l’instant.</p>'; return; }
      if (mine !== onlineQ) return;
      renderSearchResults(h, res, q);
    }, 600);
  }
  function renderLibrary() {
    const el = $('#libraryContent');
    if (!catBooks().length) {
      const c = CATS[curCat()];
      libSig = '';
      const q0 = $('#searchInput').value.trim();
      el.innerHTML = norm(q0).length >= 2 ? '' : `<div class="empty"><div class="big">${c.icon}</div><h2>Pas encore de ${c.label.toLowerCase()}</h2>
        <p>Appuie sur le gros bouton au centre en bas pour scanner le code-barres au dos d'un livre, ou tape un titre dans la barre de recherche en haut.</p></div>`;
      updateOnlineHint();
      return;
    }
    const list = sortedBooks();
    if (!list.length) { libSig = ''; el.innerHTML = `<p class="lib-none">« ${esc($('#searchInput').value.trim())} » n’est pas dans ta bibliothèque.</p>`; updateOnlineHint(); return; }
    updateOnlineHint();
    const layout = state.settings.layout;
    const sig = [layout, openPile, infoVer, curTheme(), window.innerWidth, list.map((b) => b.id + ':' + (b.cover || '') + ':' + b.volume + ':' + (b.title || '')).join(',')].join('|');
    if (sig === libSig && el.childElementCount) return;
    libSig = sig;

    if (layout === 'series' || layout === 'group') { el.innerHTML = layout === 'series' ? seriesShelvesHTML(list) : groupedShelvesHTML(list); return; }
    if (layout === 'list') {
      el.innerHTML = '<div class="list">' + list.map((b) => `
        <div class="list-item" data-id="${b.id}">
          <div class="thumb">${coverHTML(b)}</div>
          <div class="li-main"><div class="li-title">${esc(b.title)}</div>
          <div class="li-sub">${esc([b.authors, b.series && (b.series + (b.volume ? ' · T' + b.volume : ''))].filter(Boolean).join(' — '))}</div></div>
        </div>`).join('') + '</div>';
    } else {
      const cols = Math.max(3, Math.floor((Math.min(window.innerWidth, 900) - 40) / 112));
      const T = themeOf(curTheme());
      let html = '<div class="shelf">' + (T.top ? `<div class="shelf-top">${T.top}</div>` : '');
      let row = 0;
      for (let i = 0; i < list.length; i += cols) {
        const books = list.slice(i, i + cols);
        // objets décoratifs dans les places libres de l'étagère
        let deco = '';
        for (let k = books.length; k < cols && T.deco.length; k++) deco += `<div class="deco-item ${k % 2 ? 'small' : ''}">${T.deco[(row * 2 + k) % T.deco.length]}</div>`;
        const hang = T.hang.length ? `<span class="hang ${row % 2 ? 'r' : 'l'}">${T.hang[row % T.hang.length]}</span>` : '';
        html += `<div class="shelf-row" style="--cols:${cols}">` + books.map((b) =>
          `<div class="book" data-id="${b.id}">${coverHTML(b)}${b.volume ? `<span class="vol-tag">${b.volume}</span>` : ''}</div>`).join('') + deco +
          `</div><div class="shelf-plank">${hang}${T.lights ? '<span class="lights"></span>' : ''}</div>`;
        row++;
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

  function seriesInCat() { const c = curCat(); return seriesList().filter((s) => catOf(s.books[0]) === c); }
  function renderSeries() {
    const el = $('#seriesContent');
    const list = seriesInCat();
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
    const rpTxt = rp ? ' · Sources : ' + [srcTxt('Leslibraires', rp.ll), srcTxt('Place des Libraires', rp.pdl), srcTxt('Decitre', rp.decitre), srcTxt('Google Books', rp.google), srcTxt('BnF', rp.bnf)].filter(Boolean).join(' · ') : '';
    const auto = state.releasesFromServer ? ' · mise à jour automatique' : '';
    $('#lastCheck').textContent = state.lastCheck ? 'Dernière recherche : ' + new Date(state.lastCheck).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) + auto + rpTxt : '';
    const st = $('#relStatus');
    if (st) st.hidden = !state.releasesRefreshing;
    if (!seriesInCat().length) {
      el.innerHTML = `<div class="empty"><div class="big">📅</div><h2>Pas encore de série</h2><p>Ajoute des livres qui font partie d'une série, puis reviens ici : je chercherai les prochains tomes et leurs dates de sortie.</p></div>`;
      return;
    }
    // Seulement les tomes à venir, du plus proche au plus lointain (sans limite de durée)
    const catKeys = new Set(seriesInCat().map((x) => x.key));
    const upcoming = visibleReleases().filter((r) => isUpcoming(r) && (catKeys.has(norm(r.series)) || (r.manual && !seriesList().some((x) => x.key === norm(r.series))))).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    if (!upcoming.length) {
      el.innerHTML = `<div class="empty"><p>${state.releasesRefreshing ? 'Je cherche les prochains tomes de tes séries…' : (state.lastCheck ? 'Aucune sortie annoncée pour l’instant pour tes séries. Je revérifie à chaque ouverture de l’application et chaque nuit.' : 'Les sorties de tes séries vont apparaître ici automatiquement.')}</p></div>`;
      return;
    }
    const now = new Date(todayKey());
    const inDays = (d) => Math.round((new Date(dateKey(d)) - now) / 864e5);
    const when = (d) => { const n = inDays(d); return n <= 0 ? 'aujourd’hui' : n === 1 ? 'demain' : n < 60 ? 'dans ' + n + ' jours' : 'dans ' + Math.round(n / 30) + ' mois'; };
    const row = (r) => {
      const p = String(r.date || '').split('-');
      const d = p[2] ? +p[2] : '';
      const m = p[1] ? MONTHS[+p[1] - 1] : '';
      const src = r.manual ? 'ajouté à la main' : (r.sources && r.sources.length ? r.sources.join(', ') : '');
      return `<div class="rel" data-rel="${r.id}">
        <div class="rel-date"><div class="d">${d}</div><div class="m">${m}${p[0] ? '<br>' + p[0] : ''}</div></div>
        ${r.cover ? `<div class="thumb"><img src="${esc(r.cover)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>` : ''}
        <div class="li-main"><div class="li-title">${esc(r.series)}${r.volume ? ' — Tome ' + r.volume : ''}</div>
          <div class="li-sub">${when(r.date)}${src ? ' · ' + esc(src) : ''}</div></div>

      </div>`;
    };
    // regroupement par mois
    let html = '', cur = '';
    for (const r of upcoming) {
      const p = dateKey(r.date).split('-');
      const label = MONTHS_LONG[+p[1] - 1] + ' ' + p[0];
      if (label !== cur) { html += `<div class="rel-group-title">${label}</div>`; cur = label; }
      html += row(r);
    }
    el.innerHTML = html;
  }

  function renderBadge() {
    const today = todayKey();
    const n = visibleReleases().filter((r) => isUpcoming(r)).length;
    const b = $('#releaseBadge');
    b.hidden = !n; b.textContent = n;
  }

  function renderSettings() {
    renderSyncStatus();
    const tp = $('#themePicker');
    if (tp) { tp.innerHTML = themeCardsHTML(); $$('[data-pick-theme]', tp).forEach((c) => c.onclick = () => { pickTheme(c.dataset.pickTheme); renderSettings(); }); }
  }

  function applyTheme() {
    document.body.dataset.theme = curTheme();
    renderScene();
    const bg = getComputedStyle(document.body).getPropertyValue('--bg2').trim();
    $('meta[name="theme-color"]').setAttribute('content', bg || '#1f1712');
  }

  // ---------- Feuille modale ----------
  function openSheet(html) {
    $('#sheetBody').innerHTML = html;
    $('#sheetBackdrop').hidden = false;
    document.body.style.setProperty('--sy', scrollY + 'px');
    document.body.classList.add('sheet-open');
  }
  function closeSheet() { $('#sheetBackdrop').hidden = true; $('#sheetBody').innerHTML = ''; document.body.classList.remove('sheet-open'); }

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
        ${isNew ? catPickerHTML(detectedCat(b)) : ''}
        <div class="sheet-actions">
          <button class="btn primary block" type="submit">${isNew ? '＋ Ajouter à ma bibliothèque' : 'Enregistrer'}</button>
          ${isNew ? '<button class="btn block" type="button" data-act="scan-again">Annuler et scanner un autre</button>' : ''}
          <button class="btn ghost block" type="button" data-act="close">Annuler</button>
        </div>
      </form>`;
  }

  function wireBookForm(b, isNew) {
    const cat0 = isNew ? detectedCat(b) : null;
    let picked = cat0;
    if (isNew) wireCatPicker((c) => { picked = c; });
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
        const nb = Object.assign({}, b, upd);
        applyCat(nb, picked, picked !== cat0);
        addBook(nb);
      } else {
        Object.assign(b, upd); delete b.incomplete; save(); closeSheet(); render(); toast('Livre complété');
      }
    });
  }

  // Zone d'informations en lecture seule
  // Fiche « douce » : couverture floutée en fond, grande couverture, pastilles, petites cases d'infos, résumé repliable
  function bookCard(b) {
    const hasSeries = b.series && b.volume;
    // « Série – Tome 3 – Sous-titre » : on garde le sous-titre à part
    const part = hasSeries ? String(b.title || '').split(/\s[–-]\s*Tome\s*\d+\s*[–-]\s*/i)[1] || '' : '';
    const name = hasSeries ? b.series : (b.title || 'Titre inconnu');
    const chips = [b.format, b.pages ? b.pages + ' pages' : '', CATS[catOf(b)].label].filter(Boolean);
    const added = b.addedAt ? new Date(b.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const tile = (k, v) => v ? `<div class="bc-tile"><span>${k}</span><b>${v}</b></div>` : '';
    const tiles = [tile('Éditeur', esc(b.publisher)), tile('Parution', b.publishedDate ? fmtDate(b.publishedDate) : ''),
      tile('Dans ta bibliothèque', added ? 'depuis le ' + added : ''), tile('ISBN', esc(b.isbn))].filter(Boolean).join('');
    const long = (b.description || '').length > 220;
    return `<div class="book-card">
      ${b.cover ? `<div class="bc-backdrop" aria-hidden="true"><img src="${esc(b.cover)}" alt=""></div>` : ''}
      <div class="bc-head">
        <div class="bc-cover" id="previewCover">${coverHTML(b)}</div>
        <h2 class="bc-title">${esc(name)}</h2>
        ${hasSeries ? `<div class="bc-vol">Tome ${b.volume}${part ? ' · ' + esc(part) : ''}</div>` : ''}
        <div class="bc-authors">${esc(b.authors || 'Auteur inconnu')}</div>
        ${chips.length ? `<div class="bc-chips">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
      </div>
      ${tiles ? `<div class="bc-tiles">${tiles}</div>` : ''}
      ${b.description ? `<div class="bc-summary"><h3>Résumé</h3><p class="${long ? 'clamp' : ''}">${esc(b.description)}</p>
        ${long ? `<button class="bc-more" onclick="const p=this.previousElementSibling;p.classList.toggle('clamp');this.textContent=p.classList.contains('clamp')?'Lire la suite':'Réduire'">Lire la suite</button>` : ''}</div>` : ''}
    </div>`;
  }
  // Icônes des boutons de la fiche
  const ICON = {
    cover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9.5" cy="9" r="1.6"/><path d="m20 16-4.5-4.5L7 20"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5c3-1.5 6-1.5 9 .5 3-2 6-2 9-.5V19c-3-1.5-6-1.5-9 .5-3-2-6-2-9-.5z"/><path d="M12 6v13.5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  };

  // ---------- Choix Roman / Manga au moment de l'ajout ----------
  // proposé d'office : la bibliothèque des autres tomes de la série, sinon ce que l'appli a détecté
  function detectedCat(b) {
    if (b.catManual && b.category) return b.category;
    const same = b.series && state.books.find((x) => x.series && norm(x.series) === norm(b.series) && x.category);
    return (same && same.category) || b.category || catOf(b);
  }
  function catPickerHTML(cur) {
    return `<div class="cat-pick"><span>Ranger dans</span><div class="cat-seg" role="radiogroup">
      ${['roman', 'manga'].map((c) => `<button type="button" role="radio" aria-checked="${c === cur}" class="${c === cur ? 'on' : ''}" data-pick="${c}">${c === 'roman' ? 'Roman' : 'Manga'}</button>`).join('')}
      </div></div>`;
  }
  function wireCatPicker(onPick) {
    $$('[data-pick]', $('#sheetBody')).forEach((el) => el.onclick = () => {
      $$('[data-pick]', $('#sheetBody')).forEach((x) => { const on = x === el; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
      onPick(el.dataset.pick);
    });
  }
  // la catégorie choisie à la main l'emporte, et le type affiché suit (un manga n'est pas « Roman »)
  function applyCat(b, cat, manual = true) {
    b.category = cat; if (manual) b.catManual = true;
    if (cat === 'manga' && /^(Roman|Light novel)$/.test(b.format || '')) b.format = 'Manga';
    if (cat === 'roman' && b.format && !/^(Roman|Light novel)$/.test(b.format)) b.format = 'Roman';
  }

  function confirmAdd(b) {
    const cat = detectedCat(b);
    openSheet(`${bookCard(Object.assign({}, b, { category: cat }))}
      ${catPickerHTML(cat)}
      <div class="sheet-actions">
        <button class="btn primary block" id="doAdd">＋ Ajouter à ma bibliothèque</button>
        <button class="btn block" data-act="scan-again">Ce n’est pas le bon livre, rescanner</button>
        <button class="btn ghost block" data-act="close">Annuler</button>
      </div>`);
    let picked = cat;
    wireCatPicker((c) => { picked = c; });
    $('#doAdd').onclick = () => { applyCat(b, picked, picked !== cat); addBook(b); };
  }

  function addBook(b) {
    onlineQ = '';
    Object.assign(b, { id: uid(), addedAt: Date.now() });
    delete b.incomplete;
    const same = b.series && !b.catManual && state.books.find((x) => x.series && norm(x.series) === norm(b.series) && x.category);
    if (same) b.category = same.category;
    if (!b.category) b.category = catOf(b);
    state.books.push(b);
    seriesCatCache = null;
    if (catOf(b) !== curCat()) { setCat(catOf(b)); toast('Rangé dans tes ' + CATS[catOf(b)].label.toLowerCase()); }
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
        series: ref.series, volume: v, category: catOf(ref),
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
    (async () => { for (const nb of added) { if (!nb.cover && nb.isbn) { const u = await findCoverAny(nb.isbn, nb.ark, nb).catch(() => ''); nb.coverTriedAt = Date.now(); if (u) { nb.cover = u; save(); scheduleRender(); } } } })();
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
    const otherCat = CATS[catOf(b) === 'manga' ? 'roman' : 'manga'];
    openSheet(`${bookCard(b)}
      ${b.incomplete ? `<div class="sheet-actions"><button class="btn block" id="relookup">🔎 Relancer la recherche</button>
          <button class="btn block" data-act="edit" data-id="${b.id}">✏️ Compléter à la main</button></div>` : ''}
      <div class="bc-actions">
        <button class="bc-act" data-act="cover" data-id="${b.id}">${ICON.cover}<span>Couverture</span></button>
        <button class="bc-act" id="moveCat">${ICON.move}<span>Vers les ${otherCat.label.toLowerCase()}</span></button>
        <button class="bc-act danger" data-act="delete" data-id="${b.id}">${ICON.trash}<span>Retirer</span></button>
      </div>
      <button class="btn ghost block bc-close" data-act="close">Fermer</button>`);
    $('#moveCat').onclick = () => {
      const other = catOf(b) === 'manga' ? 'roman' : 'manga';
      const same = b.series ? state.books.filter((x) => norm(x.series) === norm(b.series)) : [b];
      moveBooks(same, other); closeSheet();
      toast(same.length > 1 ? `${same.length} tomes rangés dans les ${CATS[other].label.toLowerCase()}` : `Rangé dans les ${CATS[other].label.toLowerCase()}`);
    };
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
    // le son du « bip » doit être préparé pendant l'appui sur le bouton (obligatoire sur iPhone)
    try { const A = window.AudioContext || window.webkitAudioContext; if (A) { beep.ctx = beep.ctx || new A(); beep.ctx.resume && beep.ctx.resume(); } } catch (e) { /* rien */ }
    if (!isNative() || !BS) return startWebScan();
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

  // ---- Version web (iPhone, navigateur) : caméra du navigateur + lecteur de codes-barres
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('chargement impossible')); document.head.appendChild(s);
  });
  let webDetector = null;
  async function getWebDetector() {
    if (webDetector) return webDetector;
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    // Chrome sur Android sait lire les codes-barres tout seul
    if ('BarcodeDetector' in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        if (sup.includes('ean_13')) return (webDetector = new window.BarcodeDetector({ formats }));
      } catch (e) { /* lecteur fourni */ }
    }
    // Safari (iPhone) : lecteur fourni avec l'application (vendor/)
    if (!window.WebBarcode) await loadScript('vendor/barcode.js');
    const W = window.WebBarcode;
    if (!W || !W.BarcodeDetector) throw new Error('lecteur indisponible');
    const locateFile = (p, prefix) => (/\.wasm$/.test(p) ? new URL('vendor/' + p, location.href).href : (prefix || '') + p);
    if (W.prepareZXingModule) W.prepareZXingModule({ overrides: { locateFile }, fireImmediately: true });
    else if (W.setZXingModuleOverrides) W.setZXingModuleOverrides({ locateFile });
    return (webDetector = new W.BarcodeDetector({ formats }));
  }
  function attachWebVideo(o) {
    if (!scanner.web) return;
    const v = document.createElement('video');
    v.id = 'scVideo'; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.autoplay = true;
    v.srcObject = scanner.web.stream;
    o.prepend(v);
    scanner.web.video = v;
    v.play().catch(() => {});
  }
  async function startWebScan() {
    if (scanner.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      askIsbn('Ce navigateur ne permet pas d’utiliser la caméra. Tape l’ISBN (le numéro sous le code-barres) :'); return;
    }
    closeSheet();
    scanner.lastCode = ''; scanner.items = []; scanner.queue = [];
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      askIsbn('La caméra n’est pas autorisée. Sur iPhone : Réglages → Safari → Appareil photo → Autoriser, puis réessaie. En attendant, tape l’ISBN :');
      return;
    }
    const track = stream.getVideoTracks()[0];
    scanner.web = { stream, track, timer: null, video: null };
    try { const caps = track.getCapabilities ? track.getCapabilities() : {}; scanner.torchAvail = !!caps.torch; } catch (e) { scanner.torchAvail = false; }
    showScanOverlay();
    scanner.active = true;
    let det;
    try { det = await getWebDetector(); }
    catch (e) { await stopScan(); askIsbn('Le lecteur de codes-barres n’a pas pu se charger (vérifie ta connexion). Tape l’ISBN :'); return; }
    const loop = async () => {
      if (!scanner.active || !scanner.web) return;
      const v = scanner.web.video;
      if (v && v.readyState >= 2 && v.videoWidth) {
        try {
          const res = await det.detect(v);
          if (res && res.length) onLiveCode(res.map((r) => ({ rawValue: r.rawValue })));
        } catch (e) { /* image suivante */ }
      }
      if (scanner.web) scanner.web.timer = setTimeout(loop, 120);
    };
    loop();
  }

  async function stopScan() {
    const BS = getBS();
    scanner.active = false;
    if (scanner.web) {
      clearTimeout(scanner.web.timer);
      try { scanner.web.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* rien */ }
      scanner.web = null;
    }
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
      <div class="sc-bottom"><button class="sc-wide" id="scSearch">🔎 Chercher par titre</button><button class="sc-wide" id="scManual">Taper l’ISBN</button>${scanner.burst ? '<button class="sc-wide primary" id="scDone">Terminé</button>' : ''}</div>`;
    document.body.appendChild(o);
    attachWebVideo(o);
    renderScanList();
    $('#scClose').onclick = () => finishScan();
    $('#scManual').onclick = async () => { await finishScan(); askIsbn(); };
    $('#scSearch').onclick = async () => { await finishScan(); openAddSearch(''); };
    if ($('#scDone')) $('#scDone').onclick = () => finishScan();
    $('#scTorch').onclick = async () => {
      try {
        if (scanner.web) await scanner.web.track.applyConstraints({ advanced: [{ torch: !scanner.torch }] });
        else await getBS().toggleTorch();
        scanner.torch = !scanner.torch; $('#scTorch').classList.toggle('on', scanner.torch);
      } catch (e) { /* rien */ }
    };
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
    const lastOk = state.books.slice().sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0))[0];
    scanner.items = []; scanner.queue = [];
    if (added && lastOk && catOf(lastOk) !== curCat()) setCat(catOf(lastOk));
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

  // ---------- Recherche par titre (ajout sans code-barres) ----------
  // « Solo » -> la série Solo Leveling (tous ses tomes), puis tous les livres dont le titre contient « solo »
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const searchCache = new Map();
  let searchSeq = 0;
  async function searchOnline(q) {
    const k = norm(q);
    if (searchCache.has(k)) return searchCache.get(k);
    let res;
    try { res = await api('search', { q }, 40000); }
    catch (e) {
      // serveur indisponible : Google Books directement
      const d = await getJSON('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent('intitle:' + q) + '&maxResults=40&printType=books&langRestrict=fr&country=FR', 12000);
      const books = (d.items || []).map((it) => fromGoogle(it)).filter((b) => /^97[89]\d{10}$/.test(b.isbn || ''))
        .map((b) => ({ isbn: b.isbn, title: b.title, authors: b.authors, publisher: b.publisher, date: b.publishedDate, cover: b.cover, series: b.series, volume: b.volume }));
      res = { series: [], books };
    }
    searchCache.set(k, res);
    return res;
  }
  const ownedIsbns = () => new Set(state.books.map((b) => b.isbn).filter(Boolean));
  const year = (d) => (String(d || '').match(/\d{4}/) || [''])[0];
  function thumbHTML(r) { return `<div class="as-thumb">${coverHTML({ cover: r.cover, title: r.title || r.name, authors: r.authors, series: r.series || r.name })}</div>`; }

  // Toute recherche d'ajout passe par la barre de recherche en haut de la bibliothèque
  function openAddSearch(initial) {
    closeSheet();
    if (currentView !== 'library') show('library');
    const i = $('#searchInput');
    if (initial != null) i.value = initial;
    renderLibrary();
    window.scrollTo(0, 0);
    setTimeout(() => i.focus(), 100);
  }

  function renderSearchResults(box, res, q) {
    const own = ownedIsbns();
    const series = res.series || [];
    const books = (res.books || []).filter((b) => !own.has(b.isbn)); // ceux qu'on a déjà sont affichés au-dessus
    let html = '<h3 class="as-h">À ajouter à ta bibliothèque</h3>';
    if (!series.length && !books.length) {
      box.innerHTML = html + `<p class="as-hint">Rien trouvé en ligne pour « ${esc(q)} ». Vérifie l’orthographe, ou essaie avec le nom de l’auteur.</p>`;
      return;
    }
    if (series.length) {
      html += '<div class="as-list">' + series.map((s, i) => {
        const mine = s.vols.filter((v) => own.has(v.isbn)).length;
        return `<button class="as-row" data-as-series="${i}">${thumbHTML(s)}
          <span class="as-main"><b>${esc(s.name)}</b><span>${esc([s.publisher, s.authors].filter(Boolean).join(' · '))}</span>
          <span class="as-meta">Série · ${s.count} tome${s.count > 1 ? 's' : ''}${mine ? ` · ${mine} chez toi` : ''}</span></span>
          <span class="as-chev" aria-hidden="true">›</span></button>`;
      }).join('') + '</div>';
    }
    if (books.length) {
      html += `${series.length ? '<div class="as-gap"></div>' : ''}<div class="as-list">` + books.map((b, i) => `
        <button class="as-row" data-as-book="${i}">${thumbHTML(b)}
          <span class="as-main"><b>${esc(b.title)}</b><span>${esc([b.authors, b.publisher, year(b.date)].filter(Boolean).join(' · '))}</span></span>
          <span class="as-add" aria-label="Ajouter">＋</span></button>`).join('') + '</div>';
    }
    box.innerHTML = html;
    $$('[data-as-series]', box).forEach((el) => el.onclick = () => openSearchSeries(series[+el.dataset.asSeries], q));
    $$('[data-as-book]', box).forEach((el) => el.onclick = () => handleCode(books[+el.dataset.asBook].isbn));
  }

  // Une série trouvée : tous ses tomes, à cocher puis ajouter d'un coup
  async function openSearchSeries(s, q) {
    const own = ownedIsbns();
    const ownedVols = new Set(state.books.filter((b) => norm(b.series) === norm(s.name)).map((b) => b.volume));
    const isOwned = (v) => own.has(v.isbn) || ownedVols.has(v.volume);
    const picked = new Set();
    if (!s.cat) {
      const ownedBook = state.books.find((b) => norm(b.series) === norm(s.name) && b.category);
      s.cat = ownedBook ? ownedBook.category : LN_RE.test(s.name) ? 'roman' : (guessCategory([s.publisher, s.name]) || 'roman');
    }
    const draw = () => {
      const vols = s.vols;
      const free = vols.filter((v) => !isOwned(v));
      openSheet(`<button class="as-back" id="asBack">‹ Retour</button>
        <div class="as-shead">${thumbHTML(s)}<div><h2>${esc(s.name)}</h2>
          <p class="muted small">${esc([s.publisher, s.authors].filter(Boolean).join(' · '))}</p>
          <p class="muted small" id="asMore">${vols.length} tome${vols.length > 1 ? 's' : ''} trouvé${vols.length > 1 ? 's' : ''}${s.more ? '' : ' · recherche des autres tomes…'}</p></div></div>
        <div class="as-tools"><span>Touche les tomes à ajouter</span>${free.length ? `<button class="as-link" id="asAll">${free.every((v) => picked.has(v.isbn)) ? 'Tout décocher' : 'Tout cocher'}</button>` : ''}</div>
        <div class="as-grid">${vols.map((v) => {
          const o = isOwned(v);
          return `<button class="as-vol ${o ? 'own' : picked.has(v.isbn) ? 'on' : ''}" data-isbn="${esc(v.isbn)}" ${o ? 'disabled' : ''}>
            ${coverHTML({ cover: v.cover, title: v.title, series: s.name })}<span class="as-num">${v.volume}</span>
            ${o ? '<span class="as-tick own">✓</span>' : '<span class="as-tick"></span>'}</button>`;
        }).join('')}</div>
        ${catPickerHTML(s.cat)}
        <div class="sheet-actions"><button class="btn primary block" id="asAddSel" ${picked.size ? '' : 'disabled'}>${picked.size ? `Ajouter ${picked.size} tome${picked.size > 1 ? 's' : ''}` : 'Choisis des tomes'}</button></div>`);
      $('#asBack').onclick = () => closeSheet();
      if ($('#asAll')) $('#asAll').onclick = () => { const all = free.every((v) => picked.has(v.isbn)); free.forEach((v) => all ? picked.delete(v.isbn) : picked.add(v.isbn)); draw(); };
      $$('.as-vol:not([disabled])', $('#sheetBody')).forEach((el) => el.onclick = () => {
        const i = el.dataset.isbn; picked.has(i) ? picked.delete(i) : picked.add(i);
        el.classList.toggle('on', picked.has(i));
        const btn = $('#asAddSel'); btn.disabled = !picked.size;
        btn.textContent = picked.size ? `Ajouter ${picked.size} tome${picked.size > 1 ? 's' : ''}` : 'Choisis des tomes';
        const all = $('#asAll'); if (all) all.textContent = free.every((v) => picked.has(v.isbn)) ? 'Tout décocher' : 'Tout cocher';
      });
      wireCatPicker((c) => { s.cat = c; s.catTouched = true; });
      $('#asAddSel').onclick = () => addManyIsbns(vols.filter((v) => picked.has(v.isbn)), s);
    };
    draw();
    // les tomes qui manquent dans la première recherche : on cherche le nom exact de la série
    if (!s.more && norm(s.name) !== norm(q)) {
      try {
        const r = await searchOnline(s.name);
        const same = (r.series || []).find((x) => norm(x.name) === norm(s.name) && (!s.publisher || !x.publisher || pubWordLocal(x.publisher) === pubWordLocal(s.publisher)));
        if (same) for (const v of same.vols) if (!s.vols.some((x) => x.volume === v.volume)) s.vols.push(v);
        s.vols.sort((a, b) => a.volume - b.volume); s.count = s.vols.length;
      } catch (e) { /* on garde ce qu'on a */ }
    }
    s.more = true;
    if ($('#asBack')) draw();
  }
  const pubWordLocal = (p) => norm(p).split(' ').filter((w) => w.length > 2 && !['editions', 'edition', 'les', 'groupe'].includes(w))[0] || '';

  async function addManyIsbns(vols, s) {
    let done = 0, cancelled = false;
    const added = [];
    openSheet(`<h2>Ajout de ${vols.length} tome${vols.length > 1 ? 's' : ''}…</h2><p class="muted small" id="fillStatus">Recherche des fiches</p>
      <div class="progress"><div class="progress-bar" id="fillBar"></div></div>
      <div class="sheet-actions"><button class="btn ghost block" id="fillStop">Arrêter</button></div>`);
    $('#fillStop').onclick = () => { cancelled = true; };
    const work = vols.slice();
    const worker = async () => {
      while (work.length && !cancelled) {
        const v = work.shift();
        let b = null;
        try { b = await lookupIsbn(v.isbn); } catch (e) { /* fiche simple */ }
        if (cancelled) return;
        if (state.books.some((x) => x.isbn === v.isbn)) { done++; continue; }
        b = b || { isbn: v.isbn, title: v.title, authors: s.authors || '', publisher: s.publisher || '', publishedDate: v.date || '', cover: v.cover || '', series: s.name, volume: v.volume };
        if (!b.series) { b.series = s.name; b.volume = v.volume; }
        const ex = seriesList().find((x) => x.key === norm(b.series)); if (ex) b.series = ex.name;
        Object.assign(b, { id: uid(), addedAt: Date.now() - (1000 - (v.volume || 0)) });
        if (!b.category) b.category = catOf(b);
        state.books.push(b); added.push(b); done++;
        const st = $('#fillStatus'); if (st) st.textContent = `Tome ${v.volume} ajouté — ${done}/${vols.length}`;
        const bar = $('#fillBar'); if (bar) bar.style.width = Math.round(done / vols.length * 100) + '%';
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (added.length) {
      const fmt = (added.find((b) => b.category === s.cat && b.format) || {}).format;
      added.forEach((b) => { const was = b.category; applyCat(b, s.cat, !!s.catTouched); if (fmt && was !== s.cat) b.format = fmt; });
    }
    seriesCatCache = null; onlineQ = '';
    if (added.length && catOf(added[0]) !== curCat()) setCat(catOf(added[0]));
    save(); render();
    (async () => { for (const nb of added) { if (!nb.cover && nb.isbn) { const u = await findCoverAny(nb.isbn, nb.ark, nb).catch(() => ''); nb.coverTriedAt = Date.now(); if (u) { nb.cover = u; save(); scheduleRender(); } } } })();
    openSheet(`<h2>✅ ${added.length} tome${added.length > 1 ? 's' : ''} ajouté${added.length > 1 ? 's' : ''}</h2>
      <p class="muted">${esc(s.name)}${cancelled ? ' (ajout arrêté en cours de route)' : ''}.</p>
      <div class="sheet-actions"><button class="btn primary block" id="asAgain">Chercher un autre livre</button>
      <button class="btn ghost block" data-act="close">Terminé</button></div>`);
    $('#asAgain').onclick = () => openAddSearch('');
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
      const u = await findCoverAny(b.isbn, b.ark, b).catch(() => '');
      if (u && u === b.cover && !b.coverPhoto) { toast('Pas de meilleure couverture trouvée, essaie une photo'); $('#cvSearch').textContent = '🔎 Chercher automatiquement'; $('#cvSearch').disabled = false; }
      else if (u) { b.cover = u; b.coverPhoto = false; b.coverV = 2; save(); render(); toast('Couverture trouvée 🎉'); onDone(); }
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
      if (changed) scheduleRender();
      if (state.lastCheckSeries && state.lastCheckSeries !== seriesKeySig()) { clearTimeout(syncNow.rel); syncNow.rel = setTimeout(autoReleases, 3000); }
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
  // Le serveur répond tout de suite avec ce qu'il sait déjà, puis cherche les nouveautés en arrière-plan
  let relPoll = null, relPolls = 0;
  function applyReleases(r) {
    const manual = state.releases.filter((x) => x.manual);
    state.releases = manual.concat((r.releases || []).filter((f) => !manual.some((m) => relKey(m) === relKey(f))));
    if (r.checked_at) state.lastCheck = new Date(r.checked_at).getTime();
    state.lastReport = r.report || state.lastReport || null;
    state.releasesFromServer = true;
    state.releasesRefreshing = !!r.refreshing;
    saveLocal();
    scheduleRender();
  }
  async function loadServerReleases(refresh) {
    if (!state.sync || !state.sync.id) await syncNow();
    if (!state.sync || !state.sync.id || state.sync.error) throw new Error('serveur indisponible');
    if (state.lastCheckSeries !== seriesKeySig()) refresh = true; // une série a changé : on recalcule
    const r = await api('releases', { id: state.sync.id, secret: state.sync.secret, refresh: !!refresh }, 30000);
    state.lastCheckSeries = seriesKeySig();
    applyReleases(r);
    clearTimeout(relPoll);
    if (r.refreshing) { relPolls = 0; pollReleases(); }
  }
  function pollReleases() {
    relPoll = setTimeout(async () => {
      relPolls++;
      try {
        const r = await api('releases', { id: state.sync.id, secret: state.sync.secret, refresh: false }, 30000);
        applyReleases(r);
        if (r.refreshing && relPolls < 20) pollReleases();
        else if (!r.refreshing) { state.releasesRefreshing = false; saveLocal(); scheduleRender(); }
      } catch (e) { if (relPolls < 20) pollReleases(); }
    }, relPolls < 3 ? 8000 : 15000);
  }
  // Recherche automatique : à l'ouverture, au retour dans l'application, et quand une série change
  function autoReleases() {
    if (!seriesList().length) return;
    loadServerReleases(false).catch(() => { state.releasesRefreshing = false; scheduleRender(); });
  }

  // ---------- Recherche des sorties ----------
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
    let qt; $('#searchInput').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(renderLibrary, 120); });
    $('#catSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) setCat(b.dataset.cat); });
    $('#sortBtn').addEventListener('click', openSortMenu);
    $('#layoutBtn').addEventListener('click', openLayoutMenu);
    $('#addReleaseBtn').addEventListener('click', addReleaseManually);
    $('#manualIsbnBtn').addEventListener('click', () => askIsbn());
    $('#searchAddBtn').addEventListener('click', () => openAddSearch(''));
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

    $('#libraryContent').addEventListener('click', (e) => {
      const so = e.target.closest('[data-series-open]');
      if (so) { openSeries(so.dataset.seriesOpen); return; }
      const pile = e.target.closest('[data-pile]');
      if (pile) { openPile = openPile === pile.dataset.pile ? null : pile.dataset.pile; renderLibrary(); return; }
      if (e.target.closest('[data-regroup]')) { openPile = null; renderLibrary(); return; }
      const it = e.target.closest('.book[data-id], .list-item[data-id]');
      if (it && it.dataset.id) openBook(it.dataset.id);
    });
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
        syncNow().then(() => autoReleases()).catch(() => {});
      });
      App.addListener('backButton', () => {
        if (scanner.active || $('#scanOverlay')) finishScan();
        else if (!$('#sheetBackdrop').hidden) closeSheet();
        else if (currentView !== 'library') show('library');
        else App.exitApp && App.exitApp();
      });
    }
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { libSig = ''; if (currentView === 'library') renderLibrary(); }, 150); });
  }

  // ---------- Démarrage ----------
  applyTheme();
  wire();
  render();
  animateShelves();

  // Synchro en ligne, puis sorties (recherchées automatiquement), puis rangement Romans / Mangas
  setTimeout(() => {
    syncNow().then(() => { autoReleases(); return classifyLibrary(); }).catch(() => {}).then(() => loadSeriesInfo()).catch(() => {});
  }, 300);
  // Couvertures manquantes, sans gêner le démarrage
  setTimeout(() => repairCovers().catch(() => {}).then(() => upgradeCovers()).catch(() => {}), 4000);

  // Version web sur iPhone : explique comment la mettre sur l'écran d'accueil (une fois)
  (() => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    let seen = false; try { seen = localStorage.getItem('mabiblio.a2hs') === '1'; } catch (e) { /* rien */ }
    if (isNative() || !ios || standalone || seen) return;
    const d = document.createElement('div');
    d.className = 'a2hs';
    d.innerHTML = '<span>📲 Pour l’utiliser comme une vraie appli : touche <b>Partager</b> <span class="a2hs-ic">⬆︎</span> en bas de Safari, puis <b>« Sur l’écran d’accueil »</b>.</span><button aria-label="Fermer">✕</button>';
    d.querySelector('button').onclick = () => { d.remove(); try { localStorage.setItem('mabiblio.a2hs', '1'); } catch (e) { /* rien */ } };
    document.body.appendChild(d);
  })();

  // Pour les tests
  window.__biblio = { parseSeries, state: () => state };
})();
