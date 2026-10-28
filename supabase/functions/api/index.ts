// @ts-nocheck
// Serveur de Ma Bibliothèque (Supabase Edge Function)
// - lookup  : fiche d'un livre par ISBN (BnF, Leslibraires, Place des Libraires, Google Books, Open Library, Decitre, avec mémoire partagée)
// - cover   : recherche de couverture
// - volumes : infos de plusieurs tomes d'une série (pour « ajouter les tomes précédents »)
// - register / sync : sauvegarde et synchronisation de la bibliothèque
// - releases : sorties prévues (calculées en arrière-plan, à l'ouverture de l'appli et chaque nuit)
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const GKEY = Deno.env.get("GOOGLE_BOOKS_KEY") || "";
const CACHE_V = 9; // à augmenter quand la façon de lire les catalogues change
const clean = (b: any) => { if (!b) return b; const { _m, ...rest } = b; return rest; };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Outils ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(700 * (i + 1) * (i + 1)); }
  }
  throw last;
}
async function getText(url: string, timeout = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "MaBibliotheque/1.0" } });
  if (!r.ok) throw new Error("erreur " + r.status);
  return await r.text();
}
const getJSON = async (url: string, t?: number) => JSON.parse(await getText(url, t));
const gUrl = (q: string) => "https://www.googleapis.com/books/v1/volumes?" + q + "&country=FR" + (GKEY ? "&key=" + GKEY : "");

function isbn13to10(i: string) {
  if (!/^978\d{10}$/.test(i)) return "";
  const core = i.slice(3, 12);
  let sum = 0;
  for (let k = 0; k < 9; k++) sum += +core[k] * (10 - k);
  const c = (11 - (sum % 11)) % 11;
  return core + (c === 10 ? "X" : c);
}
function isbn10to13(i: string) {
  const core = "978" + i.slice(0, 9);
  let sum = 0;
  for (let k = 0; k < 12; k++) sum += +core[k] * (k % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

function parseSeries(title: string, subtitle?: string) {
  const full = [title, subtitle].filter(Boolean).join(" - ");
  const clean = (s: string) => s.replace(/[\s,.:\-–—(]+$/, "").trim();
  let m = full.match(/^(.*?)[\s,.:\-–—(]*\b(?:tome|tomes|t\.|t|vol\.?|volume|volumes|n°|no\.?|num[ée]ro|#)\s*(\d{1,4})\b/i);
  if (m && m[1].trim().length > 1) return { series: clean(m[1]), volume: +m[2] };
  m = full.match(/^(.*?)[\s,.:\-–—#]+(\d{1,3})\s*$/);
  if (m && m[1].trim().length > 1) return { series: clean(m[1]), volume: +m[2] };
  return { series: "", volume: null as number | null };
}

// Light novels : même nom que le manga, donc on les range dans une série à part « Nom (roman) »
const LN_SUFFIX = " (roman)";
const LN_RE = /\s*\(roman\)\s*$/i;
const baseName = (s: string) => String(s || "").replace(LN_RE, "");
const ASIAN = ["jpn", "kor", "chi", "zho"];
const isMangaPub = (p: string) => { const t = " " + norm(p) + " "; return MANGA_PUB.some((x) => t.includes(" " + x + " ")); };

type Book = {
  isbn: string; title: string; authors: string; publisher: string; publishedDate: string;
  pages: number | null; description: string; cover: string; series: string; volume: number | null; ark?: string;
};

// ---------- Google Books ----------
function fromGoogle(v: any, isbn = ""): Book {
  const i = v.volumeInfo || {};
  const ids = i.industryIdentifiers || [];
  const i13 = (ids.find((x: any) => x.type === "ISBN_13") || {}).identifier;
  const img = i.imageLinks || {};
  const ps = parseSeries(i.title, i.subtitle);
  return {
    isbn: i13 || isbn, title: [i.title, i.subtitle].filter(Boolean).join(" – "),
    authors: (i.authors || []).join(", "), publisher: i.publisher || "", publishedDate: i.publishedDate || "",
    pages: i.pageCount || null, description: String(i.description || "").replace(/<[^>]+>/g, ""),
    cover: String(img.thumbnail || img.smallThumbnail || "").replace(/^http:/, "https:").replace("&edge=curl", ""),
    series: ps.series, volume: ps.volume, subjects: i.categories || [],
  };
}
async function srcGoogle(isbn: string) {
  const g = await getJSON(gUrl("q=isbn:" + isbn));
  if (g.items?.length) return fromGoogle(g.items[0], isbn);
  const g2 = await getJSON(gUrl("q=" + isbn + "&maxResults=3"));
  const it = (g2.items || []).find((v: any) =>
    (v.volumeInfo.industryIdentifiers || []).some((x: any) => x.identifier.replace(/-/g, "") === isbn || x.identifier === isbn13to10(isbn))
  );
  return it ? fromGoogle(it, isbn) : null;
}

// ---------- BnF : format UNIMARC (champs structurés : série, tome, titre, auteurs…) ----------
const xmlDecode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&').trim();
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
  // Type de livre : la BnF dit si c'est du texte seul ou du texte + images, et classe les BD à part (805)
  const contents = marcFields(rec, '181').flatMap((f) => f.c || []);
  const cls = marcFields(rec, '686').map((f) => sub(f, 'a')).find(Boolean) || '';
  const origLang = marcFields(rec, '101').flatMap((f) => f.c || [])[0] || '';
  const drawn = /dessin|sc[ée]nario/i.test(sub(t200, 'f') + ' ' + sub(t200, 'g'));
  const bookKind = cls === '805' || drawn ? 'manga' : /^80[0-46-9]$/.test(cls) ? 'roman'
    : contents.includes('sti') ? 'manga' : contents.includes('txt') ? 'roman' : '';
  const pubName = sub(marcFields(rec, '214')[0] || marcFields(rec, '210')[0], 'c');
  const light = bookKind === 'roman' && (/light ?novel/i.test(main + ' ' + subt) || (isMangaPub(pubName) && ASIAN.includes(origLang)));
  if (light && series && !LN_RE.test(series)) {
    const old = series; series = series + LN_SUFFIX;
    if (title.startsWith(old)) title = series + title.slice(old.length);
  }
  const authors = marcFields(rec, '700').concat(marcFields(rec, '701'))
    .map((f) => (sub(f, 'b') + ' ' + sub(f, 'a')).trim()).filter(Boolean);
  const pubF = marcFields(rec, '214')[0] || marcFields(rec, '210')[0];
  const year = (sub(pubF, 'd').match(/\d{4}/) || [])[0] || '';
  const isbn = (sub(marcFields(rec, '073')[0], 'a') || sub(marcFields(rec, '010')[0], 'a')).replace(/[^0-9X]/gi, '');
  const pages = +((sub(marcFields(rec, '215')[0], 'a').match(/(\d+)\s*p\./) || [])[1] || 0) || null;
  const hasCover = marcFields(rec, '856').some((f) => /couverture/i.test(sub(f, 'b')));
  const subjects = marcFields(rec, '608').concat(marcFields(rec, '606')).map((f) => sub(f, 'a')).filter(Boolean);
  const price = parseFloat((sub(marcFields(rec, '010')[0], 'd').match(/\d+(?:[.,]\d+)?/) || ['0'])[0].replace(',', '.')) || 0;
  const size = (sub(marcFields(rec, '215')[0], 'd').match(/\d+/) || [''])[0];
  return {
    isbn: /^97[89]\d{10}$/.test(isbn) ? isbn : '', title, authors: [...new Set(authors)].join(', '),
    publisher: sub(pubF, 'c'), publishedDate: year, pages, description: sub(marcFields(rec, '330')[0], 'a'),
    cover: hasCover && ark ? 'https://catalogue.bnf.fr/couverture?&appName=NE&idArk=' + ark + '&couverture=1' : '',
    series, volume, ark, subjects, collection: colls.join(', '), kind: bookKind, light, origLang, price: price || null,
    // « texte seul » (181) sans classement BD/roman : indice faible (la BnF le met aussi sur des mangas)
    kindWeak: !(cls === '805' || drawn || /^80[0-46-9]$/.test(cls)),
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
  const base = 'bib.title all "' + baseName(series).replace(/"/g, '') + '" and bib.title all "' + v + '"';
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

async function bnfSearch(cql: string, max = 5): Promise<Book[]> {
  const xml = await getText(
    "https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=" + encodeURIComponent(cql) +
      "&recordSchema=unimarcxchange&maximumRecords=" + max, 12000,
  );
  return parseBnfResponse(xml);
}
async function srcBnf(isbn: string) {
  const r = await bnfSearch('bib.isbn all "' + isbn + '"', 3);
  return r[0] ? { ...r[0], isbn } : null;
}

// ---------- Open Library ----------
async function srcOpenLibrary(isbn: string): Promise<Book | null> {
  const o = await getJSON("https://openlibrary.org/api/books?bibkeys=ISBN:" + isbn + "&format=json&jscmd=data");
  const d = o["ISBN:" + isbn];
  if (!d) return null;
  const ps = parseSeries(d.title, d.subtitle);
  return {
    isbn, title: [d.title, d.subtitle].filter(Boolean).join(" – "),
    authors: (d.authors || []).map((a: any) => a.name).join(", "),
    publisher: (d.publishers || []).map((p: any) => p.name).join(", "),
    publishedDate: d.publish_date || "", pages: d.number_of_pages || null, description: "",
    cover: d.cover ? String(d.cover.medium || d.cover.large || "").replace(/^http:/, "https:") : "",
    series: ps.series, volume: ps.volume,
  };
}

// ---------- Couvertures ----------
// Télécharge une image : taille, largeur et empreinte (pour reconnaître les images « pas de couverture »)
async function imgInfo(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": UA["User-Agent"] } });
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image")) return { size: 0, w: 0, hash: "" };
    const b = new Uint8Array(await r.arrayBuffer());
    let w = 0;
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
        if (m >= 0xc0 && m <= 0xc3) { w = (b[i + 7] << 8) | b[i + 8]; break; }
        i += 2 + len;
      }
    } else if (b[0] === 0x47) w = b[6] | (b[7] << 8);
    else if (b[0] === 0x89) w = (b[18] << 8) | b[19];
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", b))].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
    return { size: b.length, w, hash };
  } catch { return { size: 0, w: 0, hash: "" }; }
}
const imgSize = async (url: string) => (await imgInfo(url)).size;
// Images « pas de couverture » déjà repérées (Google en a plusieurs versions)
const FAKE = new Set(["ba8cd5043eed", "f3426f39acd1"]);
const fakeProbe: Record<string, Promise<void>> = {};
const FAKE_URL: Record<string, string> = {
  google: "https://books.google.com/books/content?vid=ISBN9780000000002&printsec=frontcover&img=1&zoom=1",
  bnf: "https://catalogue.bnf.fr/couverture?&appName=NE&idArk=ark:/12148/cb00000000x&couverture=1",
  decitre: "https://products-images.di-static.com/image/x/9780000000002-475x500-1.jpg",
  epagine: "https://images.epagine.fr/002/9780000000002_1_m.jpg",
};
const kindOf = (u: string) => /books\.google|googleusercontent/.test(u) ? "google" : /bnf\.fr/.test(u) ? "bnf" : /di-static/.test(u) ? "decitre" : /epagine/.test(u) ? "epagine" : "";
// Vraie couverture : une image assez grande, qui n'est pas l'image de remplacement du site
async function okImage(u: string) {
  if (!u) return false;
  const kind = kindOf(u);
  if (kind && !fakeProbe[kind]) fakeProbe[kind] = imgInfo(FAKE_URL[kind]).then((f) => { if (f.hash) FAKE.add(f.hash.slice(0, 12)); });
  const [info] = await Promise.all([imgInfo(u), kind ? fakeProbe[kind] : null]);
  if (info.size < 2500 || (info.w && info.w < 60)) return false;
  return !FAKE.has(info.hash.slice(0, 12));
}

// Amazon : image directe pour les ISBN en 978, sinon recherche sur amazon.fr (marche aussi pour les 979)
const AMZ_STOP = new Set(["tome", "tomes", "vol", "volume", "les", "des", "une", "the", "edition", "manga", "roman"]);
function amazonMatch(hint: any, title: string) {
  const t = " " + norm(title) + " ";
  const words = norm(hint.series || hint.title || "").split(" ").filter((w) => w.length > 2 && !AMZ_STOP.has(w));
  if (!words.length) return false;
  const found = words.filter((w) => t.includes(" " + w + " ")).length;
  if (found / words.length < 0.7) return false;
  const vol = hint.volume || parseSeries(hint.title || "").volume;
  return !vol || new RegExp(" (t|tome|vol|volume|n)? ?0*" + vol + " ").test(t);
}
async function amazonCandidates(isbn: string) {
  const html = await withRetry(() => hostLimited("amazon", () => getPage("https://www.amazon.fr/s?k=" + isbn + "&i=stripbooks", 12000), 800), 2);
  const out: { asin: string; img: string; title: string }[] = [];
  const parts = html.split(/<div[^>]*data-component-type="s-search-result"/).slice(1, 5);
  const heads = [...html.matchAll(/<div[^>]*data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"|<div[^>]*data-component-type="s-search-result"[^>]*data-asin="([A-Z0-9]{10})"/g)];
  parts.forEach((p, i) => {
    const img = (p.match(/class="s-image"[^>]*src="([^"]+)"/) || p.match(/src="([^"]+)"[^>]*class="s-image"/) || [])[1] || "";
    const title = xmlDecode((p.match(/<h2[^>]*aria-label="([^"]+)"/) || [])[1] || strip((p.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || ""));
    const h = heads[i];
    if (img) out.push({ asin: (h && (h[1] || h[2])) || "", img: img.replace(/\._[^/]*_\.(jpg|jpeg|png)$/i, "._SL600_.$1"), title });
  });
  return out;
}
async function amazonPick(isbn: string, hint: any, cands?: Promise<any[]>) {
  const i10 = isbn13to10(isbn);
  if (i10) {
    const u = "https://images-na.ssl-images-amazon.com/images/P/" + i10 + ".01.LZZZZZZZ.jpg";
    if ((await imgSize(u)) > 1000) return u;
  }
  let list: any[] = [];
  try { list = await (cands || amazonCandidates(isbn)); } catch { return ""; }
  const c = list.find((x) => (i10 && x.asin === i10) || amazonMatch(hint || {}, x.title));
  return c && (await imgSize(c.img)) > 2500 ? c.img : "";
}

async function findCover(isbn: string, ark?: string, hint?: any) {
  if (!isbn) return "";
  if (!hint || !(hint.title || hint.series)) {
    const { data: c } = await db.from("book_cache").select("data").eq("isbn", isbn).maybeSingle();
    if (c?.data) hint = { title: c.data.title, series: c.data.series, volume: c.data.volume };
  }
  // 1) Amazon
  const amz = await amazonPick(isbn, hint).catch(() => "");
  if (amz) return amz;
  // 2) Decitre (image par ISBN, bonne qualité)
  const dec = "https://products-images.di-static.com/image/x/" + isbn + "-475x500-1.jpg";
  if (await okImage(dec)) return dec;
  // 3) Leslibraires
  try { const ll = await srcLeslibraires(isbn); if (ll?.cover && (await okImage(ll.cover))) return ll.cover; } catch { /* suivant */ }
  // 4) BnF
  let a = ark;
  if (!a) { try { a = (await bnfSearch('bib.isbn all "' + isbn + '"', 1))[0]?.ark; } catch { /* rien */ } }
  if (a) {
    const u = "https://catalogue.bnf.fr/couverture?&appName=NE&idArk=" + a + "&couverture=1";
    if (await okImage(u)) return u;
  }
  // 5) Open Library, Google
  const ol = "https://covers.openlibrary.org/b/isbn/" + isbn + "-L.jpg?default=false";
  if (await okImage(ol)) return ol;
  const g = "https://books.google.com/books/content?vid=ISBN" + isbn + "&printsec=frontcover&img=1&zoom=1";
  if (await okImage(g)) return g;
  return "";
}

// ---------- Sites de libraires, par ISBN ----------
// Certains sites refusent les demandes trop rapprochées : une file d'attente par site
const hostQueue: Record<string, Promise<unknown>> = {};
function hostLimited<T>(host: string, fn: () => Promise<T>, gap = 700): Promise<T> {
  const prev = hostQueue[host] || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  hostQueue[host] = run.catch(() => {}).then(() => sleep(gap));
  return run;
}
const pageRetry = (host: string, url: string, timeout = 15000) =>
  withRetry(() => hostLimited(host, () => getPage(url, timeout)), 3);

// Leslibraires.fr : fiche complète (série + numéro, date exacte, rayon Manga/Littérature, grande couverture)
async function srcLeslibraires(isbn: string) {
  const html = await pageRetry("leslibraires", "https://www.leslibraires.fr/recherche/?q=" + isbn);
  if (!html.includes('itemprop="gtin13" content="' + isbn + '"')) return null;
  const g = (re: RegExp) => (html.match(re) || [])[1] || "";
  const row = (label: string) => g(new RegExp('<th scope="row">' + label + '</th>\\s*<td[^>]*>([\\s\\S]*?)</td>'));
  const crumbs = [...html.matchAll(/"@type": "ListItem", "position": \d+, "name": "([^"]+)"/g)].map((m) => xmlDecode(m[1]));
  const rayons = [...new Set(crumbs.filter((c) => !/^(accueil|livres|occasion)$/i.test(c)))].slice(0, -1);
  const serieCell = row("Série");
  const series = strip((serieCell.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
  const volume = +((serieCell.match(/\((\d{1,4})\)/) || [])[1] || 0) || null;
  const h1 = strip(g(/<h1 class="product-details__title"[^>]*>([\s\S]*?)<\/h1>/));
  // sous-titre : ce qui suit « - » s'il ne répète pas le nom de la série
  let part = (h1.split(" - ").slice(1).join(" - ") || "").trim();
  if (part && series && norm(part).includes(norm(series))) part = "";
  // les noms en lien (« Prénom Nom ») d'abord, puis les autres
  const h2s = [...html.matchAll(/<h2 class="product-details__author"[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1]);
  const names = h2s.flatMap((h) => [...h.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((a) => strip(a[1])))
    .concat(h2s.map((h) => strip(h).replace(/^(dessins?|sc[ée]nario|texte|traduction|traduit|illustrations?|adaptation|couleurs?)\s+(de|par)\s+/i, "")));
  const seen = new Set<string>(); const authors: string[] = [];
  for (const n of names) { const k = norm(n).split(" ").sort().join(" "); if (n && !seen.has(k)) { seen.add(k); authors.push(n); } }
  let cover = g(/<img[^>]*itemprop="image"[^>]*src="([^"]+)"/);
  if (cover.startsWith("//")) cover = "https:" + cover;
  const collection = strip(row("Collection"));
  const lo = norm(strip(row("Langue d'origine")));
  const origLang = /coreen/.test(lo) ? "kor" : /japonais/.test(lo) ? "jpn" : /chinois/.test(lo) ? "chi" : "";
  return {
    origLang,
    isbn, series, volume,
    title: series && volume ? series + " – Tome " + volume + (part ? " – " + part : "") : h1,
    authors: authors.join(", "), publisher: strip(row("Éditeur")),
    publishedDate: g(/itemprop="datePublished" datetime="(\d{4}-\d{2}-\d{2})"/),
    pages: +g(/itemprop="numberOfPages">(\d+)/) || null,
    description: strip(g(/<p itemprop="description">([\s\S]*?)<\/p>/)),
    cover: cover.replace("/s:800:800/", "/s:600:600/"), collection, subjects: rayons.concat(collection ? [collection] : []),
    preorder: /schema\.org\/PreOrder/.test(html), src: "Leslibraires",
    price: parseFloat((html.match(/itemprop="price"\s+content="([\d.,]+)"/) || html.match(/content="([\d.,]+)"\s+itemprop="price"/) || [])[1]?.replace(",", ".") || "") || null,
  };
}
// Place des Libraires : une seule demande à la fois, espacées ; si le site dit « trop de demandes », on attend
async function pdlSearch(query: string) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await hostLimited("pdl", () => placeDesLibraires(query), 1500); }
    catch (e) { last = e; await sleep(/429/.test(String((e as Error)?.message)) ? 6000 * (i + 1) : 1500); }
  }
  throw last;
}
async function srcPdl(isbn: string) {
  const list = await pdlSearch(isbn);
  const r = list.find((x: any) => x.isbn === isbn);
  if (!r) return null;
  return { ...r, publishedDate: r.date };
}
// Decitre (secours) : la page du livre contient un bloc de données
async function srcDecitre(isbn: string) {
  const html = await pageRetry("decitre", "https://www.decitre.fr/rechercher/result?q=" + isbn, 20000);
  const path = (html.match(new RegExp('"path":"(/livres/[^"]+-' + isbn + '\\.html)"')) || [])[1];
  if (!path) return null;
  const page = await pageRetry("decitre", "https://www.decitre.fr" + path, 20000);
  const ld = [...page.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .flat().find((x: any) => x && (x["@type"] === "Book" || x["@type"] === "Product"));
  if (!ld) return null;
  const title = xmlDecode(String(ld.name || ""));
  const ps = parseSeries(title);
  const auth = [].concat(ld.author || []).map((a: any) => typeof a === "string" ? a : a?.name).filter(Boolean).join(", ");
  return { isbn, title, authors: auth, publisher: (ld.publisher && (ld.publisher.name || ld.publisher)) || "",
    publishedDate: String(ld.datePublished || "").slice(0, 10), pages: +ld.numberOfPages || null, description: strip(String(ld.description || "")),
    cover: "https://products-images.di-static.com/image/x/" + isbn + "-475x500-1.jpg", series: ps.series, volume: ps.volume, subjects: [], src: "Decitre" };
}

// ---------- Catégorie : roman ou manga (les BD et comics vont avec les mangas) ----------
const MANGA_PUB = ["pika", "kana", "ki oon", "kioon", "kurokawa", "tonkam", "kaze", "doki doki", "akata", "soleil manga", "crunchyroll",
  "noeve", "mangetsu", "meian", "glenat manga", "panini manga", "black box", "ototo", "taifu", "nobi nobi", "kbooks", "sakka", "naban",
  "isan manga", "omake", "lezard noir", "imho", "vega", "dupuis manga", "kotoji", "hikari", "komikku", "mana books", "h2t", "shiba",
  "bamboo manga", "michel lafon manga", "nazca", "delcourt tonkam", "ankama", "casterman sakka", "fleurus manga", "rue de sevres manga",
  "ofelbe", "lanovel"];
function categorize(parts: any[]): string {
  const txt = " " + norm(parts.flat().filter(Boolean).join(" ")) + " ";
  if (/ (mangas?|shonen|shounen|seinen|shojo|shoujo|josei|kodomo|webtoons?|manhwa|manhua|bandes? dessinees?|bd|comics?|graphic novels?|comic books?) /.test(txt)) return "manga";
  if (MANGA_PUB.some((p) => txt.includes(" " + p + " "))) return "manga";
  return "roman";
}

// ---------- Recherche d'un livre ----------
async function lookup(isbn: string) {
  // la recherche Amazon (pour la couverture) part tout de suite, en même temps que les catalogues
  const amzCands = isbn13to10(isbn) ? undefined : amazonCandidates(isbn).catch(() => []);
  const sources: [string, (i: string) => Promise<any>][] = [
    ["BnF", srcBnf], ["Leslibraires", srcLeslibraires], ["Place des Libraires", srcPdl], ["Google Books", srcGoogle], ["Open Library", srcOpenLibrary],
  ];
  const results: any[] = sources.map(([name]) => ({ name, r: null, msg: "trop lent" }));
  let gotMain: () => void = () => {};
  const main = new Promise<void>((res) => (gotMain = res));
  let gotAny: () => void = () => {};
  const any = new Promise<void>((res) => (gotAny = res));
  const all = Promise.all(sources.map(async ([name, fn], i) => {
    try {
      const r = await withRetry(() => fn(isbn), name === "Google Books" ? 2 : 1);
      results[i] = { name, r, msg: r ? "trouvé" : "inconnu" };
      if (r) { gotAny(); if (name === "BnF" || name === "Leslibraires") gotMain(); }
    } catch (e) { results[i] = { name, r: null, msg: String((e as Error)?.message || e) }; }
  }));
  // On répond dès qu'une source principale a trouvé (+1,2 s pour compléter), ou 3 s après une autre source
  await Promise.race([all, main, any.then(() => sleep(3000))]);
  await Promise.race([all, sleep(1200)]);
  let found = results.map((x) => x.r).filter(Boolean);
  // Rien trouvé : on essaie Decitre en secours
  if (!found.length) {
    try { const d = await srcDecitre(isbn); if (d) { results.push({ name: "Decitre", r: d, msg: "trouvé" }); found = [d]; } }
    catch (e) { results.push({ name: "Decitre", r: null, msg: String((e as Error)?.message || e) }); }
  }
  const report = results.map((x) => x.name + " : " + x.msg);
  if (!found.length) return { book: null, report, networkError: results.some((x) => !/inconnu|trouvé/.test(x.msg)) };
  const R = (n: string) => results.find((x) => x.name === n)?.r || null;
  const bnf = R("BnF"), ll = R("Leslibraires"), pdl = R("Place des Libraires"), gg = R("Google Books");
  const first = (...vals: any[]) => vals.find((v) => v !== undefined && v !== null && v !== "") ?? "";
  const pickAll = (k: string) => first(...found.map((f: any) => f[k]));
  const series = first(bnf?.series && bnf?.volume ? bnf.series : "", ll?.series, pickAll("series"));
  let volume = first(bnf?.series && bnf?.volume ? bnf.volume : "", ll?.volume, ...found.filter((f: any) => f.series && norm(f.series) === norm(series)).map((f: any) => f.volume)) || null;
  // numéro de tome caché dans un titre (« The Ones - tome 1 … »)
  if (series && !volume) for (const f of found) { const ps = parseSeries(f.title || ""); if (ps.volume && norm(ps.series).includes(norm(series))) { volume = ps.volume; break; } }
  // dates : uniquement au format AAAA, AAAA-MM ou AAAA-MM-JJ, la plus précise d'abord (libraires en priorité)
  const isoDate = (d: string) => { const m = String(d || "").match(/^(\d{4})(-\d{2})?(-\d{2})?/); if (m) return m[0]; const y = String(d || "").match(/\b(1[89]\d{2}|20\d{2})\b/); return y ? y[1] : ""; };
  const dates = [ll, pdl, bnf, gg, ...found].filter(Boolean).map((f: any) => isoDate(f.publishedDate || f.date)).filter(Boolean)
    .sort((x: string, y: string) => y.length - x.length);
  let title = first(bnf?.series && bnf?.volume ? bnf.title : "", ll?.volume ? ll.title : "", ll?.title, pickAll("title"));
  if (series && volume && !/tome/i.test(title)) title = series + " – Tome " + volume;
  else if (series && volume && norm(title).startsWith(norm(series) + " " + norm(series))) title = series + " – Tome " + volume;
  const b: any = {
    isbn, title,
    authors: first(bnf?.authors, ll?.authors, pickAll("authors")),
    publisher: first(ll?.publisher, bnf?.publisher, pdl?.publisher, pickAll("publisher")),
    publishedDate: dates[0] || "",
    pages: first(ll?.pages, gg?.pages, pickAll("pages")) || null,
    description: first(ll?.description, bnf?.description, gg?.description, pdl?.description, pickAll("description")),
    series, volume, ark: bnf?.ark || "", collection: first(ll?.collection, pdl?.collection, bnf?.collection),
    price: first(ll?.price, pdl?.price, bnf?.price) || null,
  };
  // Type de livre, du plus sûr au moins sûr : la notice BnF, le mot « roman » / « light novel » dans un titre, puis rayon et éditeur
  // (les rayons des libraires sont parfois faux : Leslibraires range le roman Solo Leveling en BD)
  const titlesTxt = " " + norm(found.map((f: any) => f.title).join(" ")) + " ";
  const saysNovel = / (light novel|novel|roman) /.test(titlesTxt);
  // un « roman » de la BnF déduit du seul champ 181, chez un éditeur de mangas, sans le mot roman : c'est un manga
  const pubTxt = first(ll?.publisher, bnf?.publisher, pdl?.publisher, pickAll("publisher"));
  const weakRoman = bnf?.kind === "roman" && bnf?.kindWeak && isMangaPub(pubTxt) && !saysNovel && !/ light novel /.test(" " + norm(b.collection) + " ");
  const kind = (weakRoman ? "" : bnf?.kind) || (saysNovel ? "roman" : "");
  b.category = kind || categorize([found.map((f: any) => [f.subjects, f.collection]), b.publisher, b.collection]);
  const origLang = bnf?.origLang || ll?.origLang || "";
  const light = b.category === "roman" && (bnf?.light || / light novel /.test(titlesTxt + norm(b.collection) + " ") ||
    (isMangaPub(b.publisher) && (saysNovel || ASIAN.includes(origLang))));
  if (!light && LN_RE.test(b.series || "")) { // la BnF avait cru à un light novel
    b.series = baseName(b.series);
    if (b.volume) b.title = b.series + " – Tome " + b.volume;
  }
  if (light && b.series && !LN_RE.test(b.series)) {
    b.series = baseName(b.series) + LN_SUFFIX;
    if (b.volume) b.title = b.series + " – Tome " + b.volume;
  }
  b.format = light ? "Light novel" : b.category === "roman" ? "Roman"
    : origLang === "kor" ? "Manhwa" : (ASIAN.includes(origLang) || isMangaPub(b.publisher)) ? "Manga"
    : / comics? /.test(" " + norm(JSON.stringify(found.map((f: any) => f.subjects || []))) + " ") ? "Comics" : "BD";
  // couverture : Amazon d'abord, puis Leslibraires, Decitre, BnF et les autres (chaque image est vérifiée)
  b.cover = await amazonPick(isbn, { title: b.title, series: b.series, volume: b.volume }, amzCands).catch(() => "");
  if (!b.cover) {
    const cands = [ll?.cover, "https://products-images.di-static.com/image/x/" + isbn + "-475x500-1.jpg", bnf?.cover, pdl?.cover, gg?.cover, pickAll("cover")].filter(Boolean);
    for (const c of [...new Set(cands)]) { if (await okImage(c)) { b.cover = c; break; } }
  }
  if (!b.cover) b.cover = await findCover(isbn, b.ark, b);
  return { book: b, report, networkError: false };
}

async function cachedLookup(raw: string) {
  let isbn = String(raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (isbn.length === 10) isbn = isbn10to13(isbn);
  if (isbn.length !== 13) return { book: null, report: ["ISBN invalide"] };
  const { data: c } = await db.from("book_cache").select("*").eq("isbn", isbn).maybeSingle();
  const age = c ? Date.now() - new Date(c.updated_at).getTime() : Infinity;
  if (c && ((c.found && c.data?.v === CACHE_V && age < 60 * 864e5) || (!c.found && age < 2 * 864e5))) {
    return { book: c.data, report: ["mémoire du serveur"], cached: true };
  }
  const res = await lookup(isbn);
  if (res.book) res.book = { ...clean(res.book), v: CACHE_V };
  if (res.book || !res.networkError) {
    await db.from("book_cache").upsert({ isbn, data: res.book, found: !!res.book, updated_at: new Date().toISOString() });
  }
  return res;
}

// ---------- Tomes d'une série (sans ISBN) ----------
async function googleSeriesIndex(series: string) {
  const map = new Map<number, Book>();
  for (const start of [0, 40]) {
    try {
      const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent("intitle:" + JSON.stringify(baseName(series)) + (LN_RE.test(series) ? " roman" : "")) + "&maxResults=40&startIndex=" + start + "&printType=books")), 2);
      for (const it of d.items || []) {
        const b = fromGoogle(it);
        if (b.volume && norm(b.series) === norm(series) && b.isbn && !map.has(b.volume)) map.set(b.volume, b);
      }
      if (!d.items || d.items.length < 40) break;
    } catch { break; }
  }
  return map;
}
async function volumes(series: string, vols: number[], publisher: string, refIsbn: string) {
  const key = norm(series);
  let ref: any = null;
  if (refIsbn) { try { ref = await srcBnf(refIsbn); } catch { /* sans référence */ } }
  if (!ref) ref = { publisher };
  const gIndex = await googleSeriesIndex(series);
  const out: Record<number, Book | null> = {};
  const work = vols.slice(0, 200);
  const worker = async () => {
    while (work.length) {
      const v = work.shift()!;
      let best: any = null;
      try {
        const recs = await withRetry(() => bnfVolumeSearch(series, v, ref.publisher || publisher), 2);
        best = pickVolume(recs, v, key, ref);
      } catch { /* Google ensuite */ }
      if (!best && gIndex.has(v)) best = gIndex.get(v)!;
      if (best && best.cover && !(await okImage(best.cover))) best.cover = "";
      if (best && best.isbn && !best.cover) best.cover = await findCover(best.isbn, best.ark, best);
      out[v] = clean(best);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ---------- Libraires (dates à venir) ----------
const UA = { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36", "Accept-Language": "fr-FR,fr;q=0.9" };
async function getPage(url: string, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: UA });
  if (!r.ok) throw new Error("erreur " + r.status);
  return await r.text();
}
const MOIS: Record<string, string> = { janvier: "01", fevrier: "02", mars: "03", avril: "04", mai: "05", juin: "06", juillet: "07", aout: "08", septembre: "09", octobre: "10", novembre: "11", decembre: "12" };
function frDate(s: string) {
  const m = norm(s).match(/(\d{1,2}) ([a-z]+) (\d{4})/);
  if (m && MOIS[m[2]]) return m[3] + "-" + MOIS[m[2]] + "-" + m[1].padStart(2, "0");
  const m2 = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m2 ? m2[3] + "-" + m2[2] + "-" + m2[1] : "";
}
const strip = (h: string) => xmlDecode(String(h).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ")).trim();
const frenchIsbn = (i: string) => /^(9782|97910)/.test(i || "");

// Place des Libraires : la recherche affiche titre, éditeur, date de parution et ISBN
async function placeDesLibraires(query: string, extra = "") {
  const html = await getPage("https://www.placedeslibraires.fr/listeliv.php?base=" + (extra ? "paper" : "allbooks") + "&mots_recherche=" + encodeURIComponent(query) + extra, 25000);
  const out: any[] = [];
  for (const block of html.split('<h2 class="livre_titre">').slice(1)) {
    const isbn = (block.match(/\/livre\/(\d{13})-/) || [])[1] || "";
    const title = strip((block.match(/<a [^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
    const publisher = strip((block.match(/itemprop="publisher">([\s\S]*?)</) || [])[1] || "");
    const date = frDate(strip((block.match(/class="MiseEnLigne">([\s\S]*?)</) || [])[1] || ""));
    const collection = strip((block.match(/class="collection[^"]*">\s*<span>([\s\S]*?)<\/span>/) || [])[1] || "");
    const authors = strip((block.match(/class="livre_auteur"[^>]*title="([^"]*)"/) || [])[1] || "");
    const description = strip((block.match(/class="livre_resume[^"]*">([\s\S]*?)<\/p>/) || [])[1] || "");
    const price = parseFloat(((block.match(/(\d{1,3}[.,]\d{2})\s*(?:&nbsp;)?\s*(?:&euro;|€)/) || [])[1] || "").replace(",", ".")) || null;
    if (!isbn || !title) continue;
    const ps = parseSeries(title);
    out.push({ isbn, title, publisher, date, series: ps.series, volume: ps.volume, src: "Place des Libraires",
      collection, authors, description, subjects: [collection], price,
      cover: "https://images.epagine.fr/" + isbn.slice(-3) + "/" + isbn + "_1_m.jpg" });
  }
  return out;
}
// Decitre : la recherche signale les livres « à paraître », la page du livre donne la date
async function decitre(query: string) {
  const html = await getPage("https://www.decitre.fr/rechercher/result?q=" + encodeURIComponent(query), 20000);
  const out: any[] = [];
  const seen = new Set();
  const re = /"title":"([^"]+)"[^{}]{0,400}?|"path":"(\/livres\/[^"]+-(\d{13})\.html)"[\s\S]{0,600}?"tags":\[([^\]]*)\],"title":"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!m[2] || seen.has(m[3])) continue;
    seen.add(m[3]);
    if (!/is_upcoming/.test(m[4])) continue; // seulement les livres à paraître
    const title = xmlDecode(m[5].replace(/\\u0027/g, "'"));
    const ps = parseSeries(title);
    out.push({ isbn: m[3], title, path: m[2], series: ps.series, volume: ps.volume, src: "Decitre", date: "", publisher: "" });
  }
  for (const r of out.slice(0, 4)) {
    try {
      const page = await getPage("https://www.decitre.fr" + r.path, 20000);
      r.date = (page.match(/"datePublished":"(\d{4}-\d{2}-\d{2})"/) || [])[1] || "";
      r.cover = "https://products-images.di-static.com/image/x/" + r.isbn + "-475x500-1.jpg";
    } catch { /* sans date */ }
  }
  return out.filter((r) => r.date);
}

// ---------- Sorties prévues ----------
const dateKey = (d: string) => {
  if (!d) return "9999-99-99";
  const p = String(d).split("-");
  return [p[0] || "9999", (p[1] || "12").padStart(2, "0"), (p[2] || "28").padStart(2, "0")].join("-");
};
async function releasesForSeries(name: string, books: any[], report: any) {
  const key = norm(name);
  const today = new Date().toISOString().slice(0, 10);
  const vols = books.map((b) => b.volume).filter(Boolean);
  const maxOwned = vols.length ? Math.max(...vols) : 0;
  const ownedIsbn = new Set(books.map((b) => b.isbn));
  const last = books.filter((b) => b.volume === maxOwned).find((b) => b.isbn) || books.find((b) => b.volume === maxOwned) || books[0];
  const myPub = pubWord(last?.publisher || "");
  const byVol = new Map<number, any>();
  // une sortie retenue : la bonne série, un tome qu'on n'a pas, une date dans le futur
  const keep = (r: any) => {
    if (!r || !r.series || norm(r.series) !== key || !r.volume || !r.date) return;
    if (vols.includes(r.volume) || ownedIsbn.has(r.isbn) || r.volume <= maxOwned) return;
    if (dateKey(r.date) < today) return;
    if (r.isbn && !frenchIsbn(r.isbn)) return; // édition étrangère (ex. version japonaise)
    if (myPub && r.publisher && pubWord(r.publisher) !== myPub) return; // autre éditeur = autre édition
    const prev = byVol.get(r.volume);
    const prec = (d: string) => String(d || "").split("-").length;
    const special = (t: string) => /collector|coffret|edition speciale|edition limitee|limited|integrale|pack /.test(norm(t));
    if (!LN_RE.test(name) && / duo | roman t(ome)? ?\d/.test(" " + norm(r.title) + " ")) return; // lot « manga + roman » : pas un vrai tome
    const better = !prev || (special(prev.title) && !special(r.title)) || (special(prev.title) === special(r.title) && prec(r.date) > prec(prev.date));
    if (better) byVol.set(r.volume, { ...(prev || {}), ...r, cover: r.cover || prev?.cover || "", sources: [...new Set([...(prev?.sources || []), r.src])] });
    else if (!special(r.title)) prev.sources = [...new Set([...(prev.sources || []), r.src])];
  };
  // 1) Dernier tome déjà paru (BnF) : les prochains numéros sont juste après
  let latest = maxOwned;
  if (maxOwned) {
    let ref: any = null;
    if (last?.isbn) { try { ref = await srcBnf(last.isbn); } catch { /* sans référence */ } }
    if (!ref) ref = { publisher: last?.publisher || "" };
    let misses = 0;
    for (let v = maxOwned + 1; v <= maxOwned + 40 && misses < 2; v++) {
      try {
        const recs = await withRetry(() => bnfVolumeSearch(name, v, ref.publisher), 2);
        if (pickVolume(recs, v, key, ref)) { latest = v; misses = 0; } else misses++;
        report.bnf.ok++;
      } catch (e) { report.bnf.err++; report.bnf.last = String((e as Error)?.message || e); misses++; }
    }
  }
  // 2) Les 3 numéros suivants, demandés à plusieurs sites en même temps
  const next = latest ? [latest + 1, latest + 2, latest + 3] : [];
  const tasks: Promise<void>[] = [];
  let pdlFailed = true, googleFailed = true, pdlPartial = false;
  const run = (srcName: string, fn: () => Promise<any[]>) => tasks.push((async () => {
    const rk = srcName === "Google Books" ? "google" : srcName === "Decitre" ? "decitre" : "pdl";
    report[rk] = report[rk] || { ok: 0, err: 0, last: "" };
    try {
      for (const r of await fn()) keep(r);
      report[rk].ok++;
      if (rk === "pdl") pdlFailed = false;
      if (rk === "google") googleFailed = false;
    }
    catch (e) { report[rk].err++; report[rk].last = String((e as Error)?.message || e); }
  })());
  // Place des Libraires : les numéros l'un après l'autre (le site n'aime pas les demandes simultanées)
  // pour un light novel « Nom (roman) », on cherche « Nom roman »
  const qName = name.replace(LN_RE, " roman");
  run("Place des Libraires", async () => {
    const all: any[] = [];
    let ok = 0;
    for (const v of next) { try { all.push(...await pdlSearch(qName + " " + v)); ok++; } catch (e) { pdlPartial = true; if (!ok && v === next[next.length - 1]) throw e; } }
    return all;
  });
  for (const v of next) {
    run("Google Books", async () => {
      const q = "intitle:" + JSON.stringify(baseName(name)) + (LN_RE.test(name) ? " roman" : "") + " " + v;
      const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent(q) + "&maxResults=20&printType=books&langRestrict=fr")), 3);
      return (d.items || []).map((it: any) => { const b = fromGoogle(it); return { ...b, date: b.publishedDate, src: "Google Books" }; });
    });
  }
  // Decitre : une recherche sur le nom de la série suffit (elle liste les livres à paraître)
  run("Decitre", () => decitre(qName));
  // Google : les nouveautés les plus récentes de la série
  run("Google Books", async () => {
    const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent("intitle:" + JSON.stringify(baseName(name)) + (LN_RE.test(name) ? " roman" : "")) + "&orderBy=newest&maxResults=40&printType=books&langRestrict=fr")), 2);
    return (d.items || []).map((it: any) => { const b = fromGoogle(it); return { ...b, date: b.publishedDate, src: "Google Books" }; });
  });
  await Promise.all(tasks);
  const list: any = [...byVol.values()];
  // Leslibraires : confirme la date exacte et donne une belle couverture
  for (const r of list.filter((x) => x.isbn).slice(0, 4)) {
    try {
      const ll = await srcLeslibraires(r.isbn);
      if (ll) {
        if (ll.publishedDate) r.date = ll.publishedDate;
        if (ll.cover) r.cover = ll.cover;
        r.sources = [...new Set([...(r.sources || []), "Leslibraires"])];
      }
    } catch { /* on garde ce qu'on a */ }
  }
  for (const r of list) { r.out = false; r.id = "srv-" + key.replace(/ /g, "-") + "-" + r.volume; }
  report.ll = report.ll || { ok: 0, err: 0, last: "" }; report.ll.ok++;
  await Promise.all(list.filter((r) => r.cover && !/leslibraires/.test(r.cover)).map(async (r) => { if (!(await okImage(r.cover))) r.cover = ""; }));
  await Promise.all(list.filter((r) => !r.cover && r.isbn).slice(0, 6).map(async (r) => { r.cover = await findCover(r.isbn, "", r); }));
  return { list, failed: pdlFailed || pdlPartial };
}
const SERIES_TTL = 6 * 3600e3; // une série est revérifiée au plus toutes les 6 heures
async function computeReleases(libraryId: string) {
  const { data: rows } = await db.from("library_books").select("data").eq("library_id", libraryId).eq("deleted", false);
  const books = (rows || []).map((r) => r.data).filter(Boolean);
  const groups = new Map<string, { name: string; books: any[] }>();
  for (const b of books) {
    if (!b.series) continue;
    const k = norm(b.series);
    if (!groups.has(k)) groups.set(k, { name: b.series, books: [] });
    groups.get(k)!.books.push(b);
  }
  const report: any = { google: { ok: 0, err: 0, last: "" }, bnf: { ok: 0, err: 0, last: "" }, pdl: { ok: 0, err: 0, last: "" }, decitre: { ok: 0, err: 0, last: "" }, ll: { ok: 0, err: 0, last: "" } };
  const series = [...groups.values()];
  const releases: any[] = [];
  const { data: prevRow } = await db.from("library_releases").select("releases").eq("library_id", libraryId).maybeSingle();
  const prev: any[] = prevRow?.releases || [];
  const today = new Date().toISOString().slice(0, 10);
  const started = Date.now();
  let lastSave = 0;
  const saveProgress = async (done: boolean) => {
    await db.from("library_releases").upsert({ library_id: libraryId, releases, report,
      checked_at: new Date().toISOString(), running_since: done ? null : new Date(started).toISOString() });
  };
  const work = series.slice();
  const worker = async () => {
    while (work.length) {
      const s = work.shift()!;
      const vols = s.books.map((b) => b.volume).filter(Boolean);
      const maxOwned = vols.length ? Math.max(...vols) : 0;
      const last = s.books.find((b) => b.volume === maxOwned) || s.books[0];
      const key = norm(s.name) + "|" + pubWord(last?.publisher || "") + "|" + maxOwned;
      const { data: cached } = await db.from("series_cache").select("data, checked_at").eq("key", key).maybeSingle();
      let list: any[];
      if (cached && Date.now() - new Date(cached.checked_at).getTime() < SERIES_TTL) list = cached.data || [];
      else {
        const res = await releasesForSeries(s.name, s.books, report);
        list = res.list;
        if (res.failed) {
          // sites indisponibles : on garde ce qu'on savait déjà, et on réessaiera dans 30 minutes
          const old = (cached?.data || []).concat(prev.filter((r) => norm(r.series) === norm(s.name)));
          const seen = new Set(list.map((r) => r.volume));
          for (const r of old) if (!seen.has(r.volume) && dateKey(r.date) >= today) { seen.add(r.volume); list.push(r); }
          await db.from("series_cache").upsert({ key, data: list, checked_at: new Date(Date.now() - SERIES_TTL + 30 * 60e3).toISOString() });
        } else {
          await db.from("series_cache").upsert({ key, data: list, checked_at: new Date().toISOString() });
        }
      }
      const ownedIsbn = new Set(s.books.map((b) => b.isbn));
      releases.push(...list.filter((r) => !ownedIsbn.has(r.isbn) && !vols.includes(r.volume)));
      if (Date.now() - lastSave > 4000) { lastSave = Date.now(); await saveProgress(false); }
    }
  };
  await Promise.all([worker(), worker()]); // 2 séries à la fois
  await saveProgress(true);
  return { library_id: libraryId, releases, report, checked_at: new Date().toISOString() };
}

// ---------- Infos d'une série : tomes parus en France, parution d'origine (Wikipédia) ----------
const WIKI = "https://fr.wikipedia.org/w/api.php?format=json&";
const wikiGet = (q: string) => withRetry(() => hostLimited("wiki", async () => {
  const r = await fetch(WIKI + q, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "MaBibliotheque/1.0 (application de bibliothèque personnelle)" } });
  if (!r.ok) throw new Error("erreur " + r.status);
  return await r.json();
}, 300), 2);
async function wikiSeries(name: string, light: boolean, manga: boolean) {
  const base = baseName(name);
  const nb = norm(base);
  // plusieurs formulations : le type du livre n'est pas toujours connu
  const queries = [...new Set([base + (light ? " light novel" : manga ? " manga" : " roman"), base + " manga", base])];
  let title = "";
  for (const q of queries) {
    const s = await wikiGet("action=query&list=search&srlimit=6&srsearch=" + encodeURIComponent(q));
    const hits: string[] = (s.query?.search || []).map((h: any) => h.title);
    title = hits.find((t) => norm(t.replace(/\(.*\)/, "")) === nb) || hits.find((t) => norm(t).startsWith(nb + " ") && /\(/.test(t)) || "";
    if (title) break;
  }
  if (!title) return null;
  const p = await wikiGet("action=parse&prop=wikitext&section=0&redirects=1&page=" + encodeURIComponent(title));
  const t: string = p.parse?.wikitext?.["*"] || "";
  const field = (b: string, k: string) => ((b.match(new RegExp("\\n\\s*\\|\\s*" + k + "\\s*=([^\\n]*)")) || [])[1] || "").trim();
  const clean = (v: string) => v.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/<[^>]+>/g, "").replace(/'{2,}/g, "").trim();
  const books = t.split(/\{\{Infobox Animation et bande dessinée asiatiques\/Livre/i).slice(1).map((b) => {
    b = "\n" + b.split(/\n\}\}/)[0];
    const last = field(b, "dernier_volume");
    return { format: norm(field(b, "format")), origin: clean(field(b, "origine")), count: +((field(b, "nb_volumes").match(/\d+/) || [0])[0]) || null,
      finished: /\d{4}/.test(last) };
  });
  const pick = books.find((x) => light ? x.format.includes("roman") : x.format === "bd") || (light ? null : books[0]);
  if (pick) return { title, origin: pick.origin, count: pick.count, finished: pick.finished };
  // roman « classique » : Infobox Livre (années de parution d'origine « 2004 – 2023 »)
  const d = (t.match(/\|\s*dateparution_orig\s*=([^\n]*)/) || t.match(/\|\s*dateparution\s*=([^\n]*)/) || [])[1] || "";
  const years = d.match(/\b(?:1[89]|20)\d{2}\b/g) || [];
  if (!years.length) return null;
  return { title, origin: clean((t.match(/\|\s*pays\s*=([^\n]*)/) || [])[1] || "").replace(/\{\{|\}\}/g, ""), count: null, finished: years.length > 1 };
}
// Dernier tome paru en France (BnF), en partant du dernier tome possédé
async function frLatest(name: string, books: any[]) {
  const vols = books.map((b) => b.volume).filter(Boolean);
  const maxOwned = vols.length ? Math.max(...vols) : 0;
  if (!maxOwned) return 0;
  const key = norm(name);
  const last = books.filter((b) => b.volume === maxOwned).find((b) => b.isbn) || books[0];
  let ref: any = null;
  if (last?.isbn) { try { ref = await srcBnf(last.isbn); } catch { /* sans référence */ } }
  if (!ref) ref = { publisher: last?.publisher || "" };
  let latest = maxOwned, misses = 0;
  for (let v = maxOwned + 1; v <= maxOwned + 60 && misses < 2; v++) {
    try {
      const recs = await withRetry(() => bnfVolumeSearch(name, v, ref.publisher), 2);
      if (pickVolume(recs, v, key, ref)) { latest = v; misses = 0; } else misses++;
    } catch { misses++; }
  }
  return latest;
}
const INFO_TTL = 7 * 864e5;
async function seriesInfo(name: string, books: any[]) {
  const vols = books.map((b) => b.volume).filter(Boolean);
  const maxOwned = vols.length ? Math.max(...vols) : 0;
  const first = books[0] || {};
  const key = "info|" + norm(name) + "|" + pubWord(first.publisher || "") + "|" + maxOwned;
  const { data: c } = await db.from("series_cache").select("data, checked_at").eq("key", key).maybeSingle();
  if (c && Date.now() - new Date(c.checked_at).getTime() < INFO_TTL) return c.data;
  const light = LN_RE.test(name) || books.some((b) => b.format === "Light novel");
  const manga = !light && books.some((b) => b.category === "manga" || /manga|manhwa|bd|comics/i.test(b.format || ""));
  const [fr, wiki] = await Promise.all([frLatest(name, books).catch(() => maxOwned), wikiSeries(name, light, manga).catch(() => null)]);
  const sameCountry = wiki && /^france$|belgique/i.test(norm(wiki.origin || ""));
  const frCount = Math.max(fr || 0, maxOwned, sameCountry && wiki?.count ? wiki.count : 0);
  const done = !!wiki?.finished && (!wiki.count || frCount >= wiki.count);
  const info = { fr: frCount, origin: wiki?.origin || "", originCount: wiki?.count || null, originFinished: wiki ? !!wiki.finished : null,
    status: wiki ? (done ? "Terminée" : "En cours") : "", wiki: wiki?.title || "" };
  await db.from("series_cache").upsert({ key, data: info, checked_at: new Date().toISOString() });
  return info;
}

// ---------- Recherche par titre (ajout sans code-barres) ----------
// « solo » -> Solo Leveling (regroupé en série, tous les tomes trouvés), puis les autres livres dont le titre contient « solo »
const SEARCH_TTL = 864e5;
async function searchBooks(raw: string) {
  const q = norm(raw).slice(0, 60);
  const words = q.split(" ").filter(Boolean);
  if (!words.length || q.length < 2) return { series: [], books: [] };
  const key = "search|" + q;
  const { data: c } = await db.from("series_cache").select("data, checked_at").eq("key", key).maybeSingle();
  if (c && Date.now() - new Date(c.checked_at).getTime() < SEARCH_TTL) return c.data;
  // chaque mot tapé doit être le début d'un mot du titre (« sol » trouve « Solo », pas « Consolation »)
  const matches = (t: string) => { const n = " " + norm(t) + " "; return words.every((w) => n.includes(" " + w)); };
  const found: any[] = [];
  const add = (r: any, src: string, rank: number) => {
    if (!r || !r.isbn || !/^97[89]\d{10}$/.test(r.isbn) || !r.title) return;
    if (!matches(r.title) && !matches(r.series || "")) return;
    found.push({ isbn: r.isbn, title: r.title, authors: r.authors || "", publisher: r.publisher || "", date: r.date || r.publishedDate || "",
      cover: r.cover || "", series: r.series || "", volume: r.volume || null, src, rank });
  };
  const tasks: Promise<void>[] = [];
  // Place des Libraires (livres papier, classés par popularité) : 2 pages
  tasks.push((async () => {
    for (const page of [1, 2]) {
      try {
        const r = await hostLimited("pdl", () => placeDesLibraires(raw, "&page=" + page), 1200);
        r.forEach((x, i) => add(x, "pdl", (page - 1) * 30 + i));
        if (r.length < 20) break; // pas de page suivante
      } catch { break; }
    }
  })());
  // Google Books
  tasks.push((async () => {
    try {
      const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent("intitle:" + raw) + "&maxResults=40&printType=books&langRestrict=fr"), 9000), 2);
      (d.items || []).forEach((it: any, i: number) => { const b = fromGoogle(it); add(b, "google", 20 + i); });
    } catch { /* sans Google */ }
  })());
  // Mémoire du serveur (livres déjà scannés par quelqu'un) : marche aussi avec un début de mot
  tasks.push((async () => {
    try {
      const { data } = await db.from("book_cache").select("isbn, data").eq("found", true).ilike("data->>title", "%" + words[0].replace(/[%_]/g, "") + "%").limit(80);
      (data || []).forEach((r: any, i: number) => add({ ...r.data, isbn: r.isbn }, "cache", 10 + i));
    } catch { /* rien */ }
  })());
  await Promise.all(tasks);
  // éditions françaises seulement, si on en a
  const fr = found.filter((r) => frenchIsbn(r.isbn));
  const list = fr.length ? fr : found;
  const byIsbn = new Map<string, any>();
  for (const r of list.sort((a, b) => a.rank - b.rank)) {
    const prev = byIsbn.get(r.isbn);
    if (!prev) byIsbn.set(r.isbn, r);
    else {
      for (const k of ["series", "volume", "publisher", "authors", "date"]) if (!prev[k] && r[k]) prev[k] = r[k];
      if (r.src === "cache" && r.cover) prev.cover = r.cover; // couverture déjà vérifiée
      else if (!prev.cover && r.cover) prev.cover = r.cover;
    }
  }
  // regroupement par série et éditeur (deux éditions = deux séries)
  const groups = new Map<string, any>();
  const books: any[] = [];
  for (const r of byIsbn.values()) {
    if (!r.series || !r.volume) { books.push(r); continue; }
    const pw = pubWord(r.publisher);
    const k = norm(r.series) + "|" + pw;
    // un livre sans éditeur rejoint la série du même nom déjà vue
    const g = groups.get(k) || (!pw ? [...groups.values()].find((x) => x.key === norm(r.series)) : null);
    if (g) { if (!g.vols.some((v: any) => v.volume === r.volume)) g.vols.push(r); g.rank = Math.min(g.rank, r.rank); if (!g.publisher) g.publisher = r.publisher; }
    else groups.set(k, { key: norm(r.series), name: r.series, publisher: r.publisher, rank: r.rank, vols: [r] });
  }
  const series = [...groups.values()].map((g) => {
    g.vols.sort((a: any, b: any) => a.volume - b.volume);
    const v1 = g.vols.find((v: any) => v.cover) || g.vols[0];
    return { name: g.name, publisher: g.publisher, authors: v1.authors, cover: v1.cover, count: g.vols.length, maxVol: g.vols[g.vols.length - 1].volume, rank: g.rank,
      vols: g.vols.map((v: any) => ({ isbn: v.isbn, volume: v.volume, title: v.title, cover: v.cover, date: v.date })) };
  });
  // une « série » d'un seul tome isolé reste dans les livres
  const real = series.filter((s) => s.count > 1 || s.maxVol > 1);
  for (const s of series) if (!real.includes(s)) books.push({ ...s.vols[0], publisher: s.publisher, authors: s.authors, series: s.name, volume: s.vols[0].volume });
  const starts = (t: string) => norm(t).startsWith(q) ? 0 : 1;
  real.sort((a, b) => starts(a.name) - starts(b.name) || b.count - a.count || a.rank - b.rank);
  books.sort((a, b) => starts(a.title) - starts(b.title) || a.rank - b.rank);
  const out = { series: real.slice(0, 12), books: books.slice(0, 30).map(({ rank, src, ...r }) => r) };
  out.series.forEach((s: any) => delete s.rank);
  if (found.length) await db.from("series_cache").upsert({ key, data: out, checked_at: new Date().toISOString() });
  return out;
}

// ---------- Bibliothèques (sans compte : un identifiant + un code secret) ----------
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function auth(id: string, secret: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !secret) return false;
  const { data } = await db.from("libraries").select("secret_hash").eq("id", id).maybeSingle();
  if (!data || data.secret_hash !== (await sha(secret))) return false;
  await db.from("libraries").update({ last_seen: new Date().toISOString() }).eq("id", id);
  return true;
}

async function sync(id: string, changes: any[]) {
  if (Array.isArray(changes) && changes.length) {
    const ids = changes.map((c) => String(c.book_id));
    const existing = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await db.from("library_books").select("book_id, updated_at").eq("library_id", id).in("book_id", ids.slice(i, i + 200));
      for (const r of data || []) existing.set(r.book_id, Number(r.updated_at));
    }
    const rows = changes
      .filter((c) => c && c.book_id && Number(c.updated_at) > (existing.get(String(c.book_id)) ?? -1))
      .map((c) => ({ library_id: id, book_id: String(c.book_id), data: c.deleted ? null : c.data, deleted: !!c.deleted, updated_at: Number(c.updated_at) }));
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await db.from("library_books").upsert(rows.slice(i, i + 300));
      if (error) throw new Error(error.message);
    }
  }
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("library_books").select("book_id, data, deleted, updated_at").eq("library_id", id).range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ---------- Point d'entrée ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || new URL(req.url).searchParams.get("action");

    if (action === "ping") return json({ ok: true });
    if (action === "lookup") return json(await cachedLookup(body.isbn));
    if (action === "lookupMany") {
      const isbns = (body.isbns || []).slice(0, 8);
      const out: Record<string, any> = {};
      const work = isbns.slice();
      const worker = async () => { while (work.length) { const i = work.shift(); try { out[i] = (await cachedLookup(i)).book; } catch { out[i] = null; } } };
      await Promise.all([worker(), worker(), worker()]);
      return json({ books: out });
    }
    if (action === "cover") {
      const isbn = String(body.isbn || "").replace(/[^0-9X]/gi, "");
      const cover = await findCover(isbn, body.ark, { title: body.title, series: body.series, volume: body.volume });
      if (cover) {
        const { data: c } = await db.from("book_cache").select("data").eq("isbn", isbn).maybeSingle();
        if (c?.data) await db.from("book_cache").update({ data: { ...c.data, cover } }).eq("isbn", isbn);
      }
      return json({ cover });
    }
    if (action === "search") return json(await searchBooks(String(body.q || "")));
    if (action === "seriesInfo") return json({ info: await seriesInfo(String(body.series || ""), Array.isArray(body.books) ? body.books.slice(0, 300) : []) });
    if (action === "volumes") return json({ volumes: await volumes(String(body.series || ""), (body.volumes || []).map(Number).filter((n: number) => n > 0), String(body.publisher || ""), String(body.refIsbn || "")) });

    if (action === "register") {
      const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data, error } = await db.from("libraries").insert({ secret_hash: await sha(secret) }).select("id").single();
      if (error) throw new Error(error.message);
      return json({ id: data.id, secret });
    }
    if (action === "sync") {
      if (!(await auth(body.id, body.secret))) return json({ error: "code de bibliothèque invalide" }, 401);
      return json({ books: await sync(body.id, body.changes || []) });
    }
    if (action === "releases") {
      if (!(await auth(body.id, body.secret))) return json({ error: "code de bibliothèque invalide" }, 401);
      const { data: cur } = await db.from("library_releases").select("*").eq("library_id", body.id).maybeSingle();
      const stale = !cur?.checked_at || Date.now() - new Date(cur.checked_at).getTime() > 6 * 3600e3;
      const running = cur?.running_since && Date.now() - new Date(cur.running_since).getTime() < 4 * 60e3;
      let refreshing = !!running;
      if ((body.refresh || stale) && !running) {
        refreshing = true;
        await db.from("library_releases").upsert({ library_id: body.id, releases: cur?.releases || [], report: cur?.report || null,
          checked_at: cur?.checked_at || null, running_since: new Date().toISOString() });
        const task = computeReleases(body.id).catch(async () => {
          await db.from("library_releases").update({ running_since: null }).eq("library_id", body.id);
        });
        // @ts-ignore EdgeRuntime existe sur Supabase
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(task); else await task;
      }
      return json({ ...(cur || { releases: [] }), refreshing });
    }
    if (action === "cron") {
      const { data: cfg } = await db.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
      if (!cfg || req.headers.get("x-cron-key") !== cfg.value) return json({ error: "interdit" }, 403);
      if (body.id) { await computeReleases(body.id); return json({ updated: 1 }); }
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      const { data: libs } = await db.from("libraries").select("id").gte("last_seen", since);
      let n = 0;
      for (const l of libs || []) { try { await computeReleases(l.id); n++; } catch { /* suivante */ } }
      return json({ updated: n });
    }
    return json({ error: "action inconnue" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
