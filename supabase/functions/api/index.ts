// @ts-nocheck
// Serveur de Ma Bibliothèque (Supabase Edge Function)
// - lookup  : fiche d'un livre par ISBN (Google Books + BnF + Open Library, avec mémoire partagée)
// - cover   : recherche de couverture
// - volumes : infos de plusieurs tomes d'une série (pour « ajouter les tomes précédents »)
// - register / sync : sauvegarde et synchronisation de la bibliothèque
// - releases : sorties prévues (calculées à la demande et chaque nuit)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const GKEY = Deno.env.get("GOOGLE_BOOKS_KEY") || "";
const CACHE_V = 3; // à augmenter quand la façon de lire les catalogues change
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
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

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
    series: ps.series, volume: ps.volume,
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
async function imgSize(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image")) return 0;
    return (await r.arrayBuffer()).byteLength;
  } catch { return 0; }
}
const okImage = async (u: string) => !!u && (await imgSize(u)) > 2500;
const placeholder: Record<string, number> = {};
async function realImage(kind: string, url: string, fakeUrl: string) {
  const size = await imgSize(url);
  if (size < 2500) return false;
  if (!(kind in placeholder)) placeholder[kind] = await imgSize(fakeUrl);
  return Math.abs(size - placeholder[kind]) > 64;
}
async function findCover(isbn: string, ark?: string) {
  if (!isbn) return "";
  const i10 = isbn13to10(isbn);
  if (i10) {
    const u = "https://images-na.ssl-images-amazon.com/images/P/" + i10 + ".01.LZZZZZZZ.jpg";
    if ((await imgSize(u)) > 1000) return u;
  }
  let a = ark;
  if (!a) { try { a = (await bnfSearch('bib.isbn all "' + isbn + '"', 1))[0]?.ark; } catch { /* rien */ } }
  if (a) {
    const u = "https://catalogue.bnf.fr/couverture?&appName=NE&idArk=" + a + "&couverture=1";
    if (await realImage("bnf", u, "https://catalogue.bnf.fr/couverture?&appName=NE&idArk=ark:/12148/cb00000000x&couverture=1")) return u;
  }
  const ol = "https://covers.openlibrary.org/b/isbn/" + isbn + "-L.jpg?default=false";
  if ((await imgSize(ol)) > 1000) return ol;
  const g = "https://books.google.com/books/content?vid=ISBN" + isbn + "&printsec=frontcover&img=1&zoom=1";
  if (await realImage("google", g, "https://books.google.com/books/content?vid=ISBN9780000000002&printsec=frontcover&img=1&zoom=1")) return g;
  return "";
}

// ---------- Recherche d'un livre ----------
async function lookup(isbn: string) {
  const sources: [string, (i: string) => Promise<Book | null>][] = [
    ["Google Books", srcGoogle], ["BnF", srcBnf], ["Open Library", srcOpenLibrary],
  ];
  // Dès qu'une source a trouvé, on laisse 1,5 s aux autres pour compléter, pas plus
  const results: any[] = sources.map(([name]) => ({ name, r: null, msg: "trop lent" }));
  let gotHit: () => void = () => {};
  const hit = new Promise<void>((res) => (gotHit = res));
  const all = Promise.all(sources.map(async ([name, fn], i) => {
    try {
      const r = await withRetry(() => fn(isbn), name === "Google Books" ? 2 : 3);
      results[i] = { name, r, msg: r ? "trouvé" : "inconnu" };
      if (r) gotHit();
    } catch (e) { results[i] = { name, r: null, msg: String((e as Error)?.message || e) }; }
  }));
  await Promise.race([all, hit]);
  await Promise.race([all, sleep(1500)]);
  const report = results.map((x) => x.name + " : " + x.msg);
  const found = results.map((x) => x.r).filter(Boolean) as Book[];
  if (!found.length) return { book: null, report, networkError: results.some((x) => !/inconnu|trouvé/.test(x.msg)) };
  const pick = (k: keyof Book) => { for (const f of found) if (f[k]) return f[k]; return k === "volume" || k === "pages" ? null : ""; };
  const bnf = results[1].r;
  const b: Book = {
    isbn, title: pick("title") as string, authors: pick("authors") as string, publisher: pick("publisher") as string,
    publishedDate: pick("publishedDate") as string, pages: pick("pages") as number | null,
    description: pick("description") as string, cover: pick("cover") as string, ark: bnf?.ark || "",
    series: bnf?.series || (pick("series") as string), volume: bnf?.volume || (pick("volume") as number | null),
  };
  if (bnf?.series && bnf.volume) b.title = bnf.title;
  if (bnf?.description && !b.description) b.description = bnf.description;
  // couverture : celle signalée par la BnF est fiable et immédiate, sinon on cherche ailleurs
  if (bnf?.cover && (await okImage(bnf.cover))) b.cover = bnf.cover;
  else { const better = await findCover(isbn, b.ark); if (better) b.cover = better; else if (b.cover && !(await okImage(b.cover))) b.cover = ""; }
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
      const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent("intitle:" + JSON.stringify(series)) + "&maxResults=40&startIndex=" + start + "&printType=books")), 2);
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
      if (best && best.isbn && !best.cover) best.cover = await findCover(best.isbn, best.ark);
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
async function placeDesLibraires(query: string) {
  const html = await getPage("https://www.placedeslibraires.fr/listeliv.php?base=allbooks&mots_recherche=" + encodeURIComponent(query), 25000);
  const out: any[] = [];
  for (const block of html.split('<h2 class="livre_titre">').slice(1)) {
    const isbn = (block.match(/\/livre\/(\d{13})-/) || [])[1] || "";
    const title = strip((block.match(/<a [^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
    const publisher = strip((block.match(/itemprop="publisher">([\s\S]*?)</) || [])[1] || "");
    const date = frDate(strip((block.match(/class="MiseEnLigne">([\s\S]*?)</) || [])[1] || ""));
    if (!isbn || !title) continue;
    const ps = parseSeries(title);
    out.push({ isbn, title, publisher, date, series: ps.series, volume: ps.volume, src: "Place des Libraires",
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
  const run = (srcName: string, fn: () => Promise<any[]>) => tasks.push((async () => {
    const rk = srcName === "Google Books" ? "google" : srcName === "Decitre" ? "decitre" : "pdl";
    report[rk] = report[rk] || { ok: 0, err: 0, last: "" };
    try { for (const r of await fn()) keep(r); report[rk].ok++; }
    catch (e) { report[rk].err++; report[rk].last = String((e as Error)?.message || e); }
  })());
  // Place des Libraires : les numéros l'un après l'autre (le site n'aime pas les demandes simultanées)
  run("Place des Libraires", async () => {
    const all: any[] = [];
    for (const v of next) { all.push(...await withRetry(() => placeDesLibraires(name + " " + v), 3)); await sleep(400); }
    return all;
  });
  for (const v of next) {
    run("Google Books", async () => {
      const q = "intitle:" + JSON.stringify(name) + " " + v;
      const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent(q) + "&maxResults=20&printType=books&langRestrict=fr")), 2);
      return (d.items || []).map((it: any) => { const b = fromGoogle(it); return { ...b, date: b.publishedDate, src: "Google Books" }; });
    });
  }
  // Decitre : une recherche sur le nom de la série suffit (elle liste les livres à paraître)
  run("Decitre", () => decitre(name));
  // Google : les nouveautés les plus récentes de la série
  run("Google Books", async () => {
    const d = await withRetry(() => getJSON(gUrl("q=" + encodeURIComponent("intitle:" + JSON.stringify(name)) + "&orderBy=newest&maxResults=40&printType=books&langRestrict=fr")), 2);
    return (d.items || []).map((it: any) => { const b = fromGoogle(it); return { ...b, date: b.publishedDate, src: "Google Books" }; });
  });
  await Promise.all(tasks);
  const list = [...byVol.values()];
  for (const r of list) { r.out = false; r.id = "srv-" + key.replace(/ /g, "-") + "-" + r.volume; }
  await Promise.all(list.filter((r) => r.cover).map(async (r) => { if (!(await okImage(r.cover))) r.cover = ""; }));
  await Promise.all(list.filter((r) => !r.cover && r.isbn).slice(0, 6).map(async (r) => { r.cover = await findCover(r.isbn); }));
  return list;
}
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
  const report = { google: { ok: 0, err: 0, last: "" }, bnf: { ok: 0, err: 0, last: "" }, pdl: { ok: 0, err: 0, last: "" }, decitre: { ok: 0, err: 0, last: "" } };
  const series = [...groups.values()];
  const releases: any[] = [];
  const work = series.slice();
  const worker = async () => {
    while (work.length) { const s = work.shift()!; releases.push(...await releasesForSeries(s.name, s.books, report)); }
  };
  await Promise.all([worker(), worker()]); // 2 séries à la fois
  const row = { library_id: libraryId, releases, report, checked_at: new Date().toISOString() };
  await db.from("library_releases").upsert(row);
  return row;
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
    if (action === "cover") return json({ cover: await findCover(String(body.isbn || ""), body.ark) });
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
      const stale = !cur?.checked_at || Date.now() - new Date(cur.checked_at).getTime() > 20 * 3600e3;
      if (body.refresh || stale) return json(await computeReleases(body.id));
      return json(cur);
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
