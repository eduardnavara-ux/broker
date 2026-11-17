// netlify/functions/weekly-digest-background.mjs
// Týdenní puls portfolia — běží automaticky (cron) a posílá digest e-mailem přes Resend.
//
// DVOUSTUPŇOVÝ REŽIM:
//   1. Triáž  — levný model (Haiku) projde všechny tituly a témata.
//   2. Hloubka — silný model (Sonnet) rozebere jen to, co v triáži dostalo
//      vysokou důležitost. Za hloubku se platí jen tehdy, kdy se opravdu něco stalo.
//
// ENV proměnné (Netlify → Site settings → Environment variables):
//   ANTHROPIC_API_KEY  — klíč z console.anthropic.com (POZOR: musí mít kredit)
//   RESEND_API_KEY     — klíč z resend.com
//   DIGEST_TO          — tvůj e-mail (kam digest chodí)
//   DIGEST_FROM        — odesílatel, např. "PORTFOLIO <onboarding@resend.dev>"

// ── Pozice (uprav při změně portfolia) ──────────────────────────────
const POSITIONS = [
  { name: "Alibaba Group",         ticker: "BABA",  ccy: "USD" },
  { name: "AT&T",                  ticker: "T",     ccy: "USD" },
  { name: "Gevo",                  ticker: "GEVO",  ccy: "USD" },
  { name: "Oklo",                  ticker: "OKLO",  ccy: "USD" },
  { name: "Warner Bros Discovery", ticker: "WBD",   ccy: "USD" },
  { name: "Pembina Pipeline",      ticker: "PPL",   ccy: "CAD" },
  { name: "Tilray Brands",         ticker: "TLRY",  ccy: "CAD" },
  { name: "GEVORKYAN",             ticker: "GEV",   ccy: "CZK" },
  { name: "Moneta Money Bank",     ticker: "MONET", ccy: "CZK" },
  // Wirecard (mrtvý titul) a CSPX (indexový ETF) záměrně nescanujeme.
];

// ── Sledovaná témata (ne akcie — legislativa, sazby) ────────────────
const WATCHES = [
  {
    id: "penzijko",
    label: "Penzijní reforma",
    query:
      "novela zákona o doplňkovém penzijním spoření, reforma třetího pilíře, " +
      "strop poplatku 0,5 %, zrušení poplatku ze zhodnocení, projednávání ve sněmovně",
  },
  {
    id: "csob-sazby",
    label: "Sazby ČSOB",
    query:
      "ČSOB Spoření s bonusem změna úrokové sazby, bonusová sazba, " +
      "podmínky pro TOP sazbu, oznámení o výši bonusové úrokové sazby",
  },
  {
    id: "penzijko-csob",
    label: "ČSOB penzijko",
    query:
      "ČSOB Penzijní společnost účastnické fondy: změna poplatků, změna investiční strategie, " +
      "sloučení nebo transformace fondů, zveřejněné výnosy fondů, změna podmínek smlouvy či převodů",
  },
  {
    id: "penzijko-trh",
    label: "Penzijko – trh",
    query:
      "penzijní společnosti v ČR: srovnání výnosů a poplatků fondů, změny státního příspěvku, " +
      "odpočtu ze základu daně a příspěvku zaměstnavatele, DIP dlouhodobý investiční produkt, " +
      "podmínky převodu mezi penzijními společnostmi",
  },
];

// ── Kalendář spouštěčů ──────────────────────────────────────────────
// "date" = jednorázové (YYYY-MM-DD). "annual" = každoročně (MM-DD).
const TRIGGERS = [
  {
    date: "2026-09-30",
    title: "Končí garance sazby 3,8 % u ČSOB",
    note: "Ověřit novou sazbu a podmínky. Pokud klesne, přehodnotit, proč držet 3 000 Kč v Patrii.",
  },
  {
    date: "2026-11-15",
    title: "Penzijní reforma — stav ve sněmovně",
    note: "První čtení novely. Zjistit, jestli reforma postupuje, nebo uvázla.",
  },
  {
    date: "2027-01-10",
    title: "Účinnost penzijní reformy?",
    note: "Pokud platí strop 0,5 %, zvážit navýšení vkladu na 1 700 Kč (max. státní příspěvek 340 Kč).",
  },
  {
    date: "2027-03-01",
    title: "Příprava jarního přesunu penzijka",
    note: "Porovnat fondy, poplatky a podmínky převodu; ověřit u ČSOB lhůty a případné sankce i vliv na státní příspěvek. Navazuje na rozhodnutí 1. 4.",
  },
  {
    date: "2027-04-01",
    title: "ROZHODNUTÍ: penzijko nechat, nebo odbytné",
    note: "Prahová pravděpodobnost reformy byla 58,8 %. Podmínkou výhodnosti je výplata rentou na 10+ let.",
  },
  {
    date: "2027-08-01",
    title: "Ověřit nárok na výběr 1/3 vkladů bez sankce",
    note: "Nové právo do 36. narozenin (5. 9. 2027) + min. 120 měsíců spoření. Časově těsné — ověřit u ČSOB.",
  },
  {
    date: "2029-11-01",
    title: "Obnovit W-8BEN u Trading 212",
    note: "Formulář podepsaný 20. 8. 2026 platí do 31. 12. 2029.",
  },
  {
    date: "2030-01-15",
    title: "Revize Gevo",
    note: "Slíbený horizont. Sežene Project North Star financování? Dostali se na break-even?",
  },
  {
    date: "2046-01-15",
    title: "Portu překročí 5 mil. → Platinová úroveň",
    note: "Poplatek klesne na 0,24 % p.a. Ověřit, že se přeřazení skutečně promítlo.",
  },
  {
    annual: "01-10",
    title: "Roční rekalibrace",
    note: "Poměr CSPX/EXUS zpět na 80/20. Navýšit měsíční vklad o 1 000 Kč. Zkontrolovat podíl USA v portfoliu (cíl pod ~65 %).",
  },
];

const WINDOW_DAYS = 30;    // jak daleko dopředu hlásit spouštěče
const MAX_HIGHLIGHTS = 8;  // kolik zpráv nejvýš v mailu
const MAX_PER_TICKER = 2;  // kolik nejvýš na jeden titul

// ── Eskalace na silnější model ──────────────────────────────────────
const ESCALATE_MIN = 4;    // od jaké "importance" (1–5) jít do hloubky
const ESCALATE_MAX = 3;    // kolik položek nejvýš rozebrat (strop nákladů)

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL_SCAN = "claude-haiku-4-5-20251001"; // triáž — levná, hodně dotazů
const MODEL_DEEP = "claude-sonnet-5";           // hloubka — jen na materiální zprávy

// ── Spouštěče ───────────────────────────────────────────────────────
function nextAnnual(annual, today) {
  const [m, d] = annual.split("-").map(Number);
  const y = today.getUTCFullYear();
  let dt = new Date(Date.UTC(y, m - 1, d));
  if (dt < today) dt = new Date(Date.UTC(y + 1, m - 1, d));
  return dt;
}

function upcomingTriggers(todayStr) {
  const today = new Date(`${todayStr}T00:00:00Z`);
  const out = [];
  for (const t of TRIGGERS) {
    const when = t.annual ? nextAnnual(t.annual, today) : new Date(`${t.date}T00:00:00Z`);
    const days = Math.round((when - today) / 86400000);
    if (days >= 0 && days <= WINDOW_DAYS) {
      out.push({ ...t, when: when.toISOString().slice(0, 10), days });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

// ── Prompty ─────────────────────────────────────────────────────────
function buildScanPrompt(p, today) {
  return `Dnešní datum: ${today}. Připravuješ položku do STRUČNÉHO týdenního přehledu pro drobného investora.

JAZYK — dodrž bezvýhradně: celý výstup piš ČESKY a tykej. To platí i pro pole "headline" a "detail". I když jsou zdrojové články anglicky, přelož je do češtiny. Anglický titulek je chyba. Ponech anglicky jen názvy firem, tickery, zkratky (EBITDA, guidance, EPS) a měny.

Titul: ${p.name} (${p.ticker}, ${p.ccy}).

Pomocí web search projdi ZPRÁVY ZA POSLEDNÍCH 7 DNÍ a použij FILTR MATERIALITY — u každé zprávy: "mohlo by tohle pohnout cenou o víc než pár procent?" Co neprojde, zahoď.

MATERIÁLNÍ (zařaď): nové obchody / velké kontrakty / partnerství, akvizice/fúze, spin-off; výsledky a hlavně změna nebo stažení guidance; financování (nový dluh, refinancování, emise nových akcií = ředění, likvidita/runway); regulace a politika; odchod CEO nebo velký insider trade; změna či škrt dividendy; VÝRAZNÁ změna analytického cíle či up/downgrade od váženého domu.
NEMATERIÁLNÍ (zahoď): běžné PR, marketing, rutinní potvrzení ratingů, makrošum, drobné pohyby bez příčiny.

Vrať POUZE validní JSON, nic dalšího:
{"highlights":[{"ticker":"${p.ticker}","headline":"max 8 slov","detail":"1 věta kontextu","importance":4,"sentiment":"bullish","url":"https://..."}],"considerations":["krátká neutrální úvaha (ne pokyn)"]}

Pravidla:
- "importance" je celé číslo 1–5. Buď přísný a použij celou škálu: 5 = mění investiční tezi (ředění akcií, ztráta klíčového kontraktu, odchod CEO, regulační zásah do byznys modelu); 4 = výrazný dopad na ocenění; 3 = stojí za pozornost; 1–2 = spíš šum. Čtyřku a pětku dávej jen tehdy, kdy bys to sám považoval za důvod znovu si promyslet, proč titul držet.
- "sentiment" je "bullish" (dopad na cenu spíš pozitivní), "bearish" (spíš negativní), nebo "neutral" (nejednoznačný/smíšený).
- "url" je odkaz na zdrojový článek — použij POUZE skutečnou URL z výsledků hledání; pokud si nejsi jistý, pole url úplně vynech, NIKDY URL nevymýšlej.
- "considerations" jsou nanejvýš dvě krátké neutrální úvahy v celých, gramaticky správných českých větách. Žádné pomlčky uprostřed myšlenky, žádné zkratkovité poznámky, žádné pokyny k obchodu. Když tě nic pořádného nenapadá, vrať prázdné pole — je to lepší než vata.
Když nic materiálního není, vrať prázdná pole.`;
}

function buildWatchPrompt(w, today) {
  return `Dnešní datum: ${today}. Sleduješ pro drobného investora jedno téma a hlásíš POUZE konkrétní změny.

JAZYK — dodrž bezvýhradně: celý výstup piš ČESKY a tykej, včetně polí "headline" a "detail". Anglický titulek je chyba.

Téma: ${w.label}
Co hledat: ${w.query}

Pomocí web search zjisti, jestli za POSLEDNÍCH 7 DNÍ nastala KONKRÉTNÍ, OVĚŘITELNÁ ZMĚNA.

ZAŘAĎ: schválení nebo zamítnutí ve vládě či sněmovně, hlasování, posun mezi čteními, změna účinnosti, pozměňovací návrh měnící podstatu, publikace ve Sbírce zákonů; u sazeb a poplatků: skutečná změna výše, změna podmínek pro její získání, oznámení banky; u penzijních fondů: změna poplatků, strategie či sloučení fondu, nově zveřejněné výnosy nebo srovnání penzijních společností.
ZAHOĎ: komentáře, názory, analýzy, spekulace o tom, co by mohlo být, rozhovory, opakování už známého stavu, marketing.

Buď přísný. Když se za týden nic nestalo, je správná odpověď prázdné pole — to je užitečná informace, ne selhání.

Vrať POUZE validní JSON, nic dalšího:
{"items":[{"headline":"max 9 slov","detail":"1-2 věty, co se přesně stalo a co to znamená","url":"https://..."}]}
Pravidlo k "url": použij POUZE skutečnou URL z výsledků hledání; pokud si nejsi jistý, pole url úplně vynech, NIKDY URL nevymýšlej.`;
}

function buildDeepPrompt(h, pos, today) {
  const name = pos ? `${pos.name} (${pos.ticker})` : h.ticker;
  const src = h.url ? `\nZdroj z triáže: ${h.url}` : "";
  return `Dnešní datum: ${today}. Mluv česky, tykej. Píšeš pro drobného investora s dlouhým horizontem, který titul drží roky a nechce reagovat na šum.

V týdenní triáži vyskočila tato zpráva jako potenciálně zásadní:
Titul: ${name}
Zpráva: ${h.headline}
Kontext z triáže: ${h.detail}${src}

Pomocí web search si zprávu OVĚŘ a dohledej širší souvislosti — předchozí vývoj, reakci trhu, co na to říkají různé strany.

Napiš 3 až 5 vět, které odpoví na:
- Co se konkrétně stalo a jak spolehlivý je zdroj.
- Jde o jednorázovou událost, nebo o změnu dlouhodobé trajektorie firmy?
- Co by muselo dál nastat, aby to pro dlouhodobého držitele opravdu něco znamenalo — a co by naopak znamenalo, že jde o planý poplach.

Tři pravidla, na kterých záleží:
1. NEDÁVEJ pokyn k nákupu ani prodeji a nepiš "měl bys". Dodáváš kontext a pojmenováváš, co dál sledovat. Rozhodnutí zůstává na čtenáři.
2. Když se zpráva ověřením ukáže jako přifouknutá nebo už dávno započtená v ceně, NAPIŠ TO. Vyvrácení je stejně cenné jako potvrzení.
3. Nespekuluj nad rámec toho, co jsi našel. Když něco není známo, napiš to.

FORMÁT ODPOVĚDI — dodrž přesně:
Až dokončíš hledání, napiš jako úplně první znak odpovědi { a jako poslední }. Žádný úvod, žádné shrnutí před ani za, žádné bloky s uvozovkami kódu. Rozbor patří dovnitř pole "analysis".

{"analysis":"souvislý text, 3-5 vět","revised_importance":4}

"revised_importance" je celé číslo 1–5 — tvoje vlastní přehodnocení důležitosti po ověření.`;
}

// ── Volání modelu ───────────────────────────────────────────────────
async function callModel({ prompt, apiKey, model, maxTokens = 1500, maxUses = 1, allowedDomains = null }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      ...(maxUses > 0
      ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses, ...(allowedDomains ? { allowed_domains: allowedDomains } : {}) }] }
      : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  let json = null;
  if (s >= 0 && e > s) {
    try {
      json = JSON.parse(clean.slice(s, e + 1));
    } catch {
      json = null; // rozbitý JSON — volající se rozhodne, co dál
    }
  }
  return { json, text: clean };
}

async function scanTicker(p, today, apiKey) {
  let parsed;
  try {
    const { json } = await callModel({
      prompt: buildScanPrompt(p, today),
      apiKey,
      model: MODEL_SCAN,
      maxTokens: 1500,
      maxUses: 1,
    });
    if (!json) throw new Error("odpověď bez použitelného JSON");
    parsed = json;
  } catch (err) {
    throw new Error(`${p.ticker}: ${err.message}`);
  }
  // Tickery vždy sjednotíme na náš vlastní (model občas napíše jiný tvar).
  const hs = (Array.isArray(parsed.highlights) ? parsed.highlights : []).map((h) => ({
    ...h,
    ticker: p.ticker,
  }));
  return {
    highlights: hs,
    considerations: Array.isArray(parsed.considerations) ? parsed.considerations : [],
  };
}

async function scanWatch(w, today, apiKey) {
  let parsed;
  try {
    const { json } = await callModel({
      prompt: buildWatchPrompt(w, today),
      apiKey,
      model: MODEL_SCAN,
      maxTokens: 1200,
      maxUses: 1,
    });
    if (!json) throw new Error("odpověď bez použitelného JSON");
    parsed = json;
  } catch (err) {
    throw new Error(`${w.label}: ${err.message}`);
  }
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map((it) => ({
    ...it,
    label: w.label,
  }));
  return { items };
}

async function deepDive(h, today, apiKey) {
  const pos = POSITIONS.find((p) => p.ticker === h.ticker);
  const { json, text } = await callModel({
    prompt: buildDeepPrompt(h, pos, today),
    apiKey,
    model: MODEL_DEEP,
    maxTokens: 3000, // rozbor + režie web searche; 1200 bylo těsné a odpověď se sekala
    maxUses: 3,
  });

  if (json && typeof json.analysis === "string") {
    return {
      analysis: json.analysis,
      revised: Number.isInteger(json.revised_importance) ? json.revised_importance : null,
    };
  }

  // Záchrana: JSON se nepovedl, ale text rozboru máme — je to próza, tak ji použijeme.
  // Lepší mít rozbor bez přehodnocené důležitosti než přijít o něj celý.
  const salvaged = text.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  if (salvaged.length > 80) {
    console.warn(`deepDive ${h.ticker}: JSON se nepovedl, použit surový text`);
    return { analysis: salvaged.slice(0, 1200), revised: null };
  }
  throw new Error("odpověď bez použitelného obsahu");
}

// ── Skejwin (Lukáš Nádvorník) ───────────────────────────────────────
// Čteme RSS blogu (zdarma, bez API). Když feed nejde, záloha přes web search omezený na skejwin.cz.
const SKEJWIN_FEED = "https://skejwin.cz/feed/";
const SKEJWIN_DAYS = 8; // týdenní běh + malá rezerva
const MAX_SKEJWIN = 3;

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlTag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  if (!m) return "";
  return decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchSkejwinFeed() {
  const res = await fetch(SKEJWIN_FEED, { headers: { "user-agent": "Mozilla/5.0 (PortfolioPuls)" } });
  if (!res.ok) throw new Error("Skejwin feed: HTTP " + res.status);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (!items.length) throw new Error("Skejwin feed: bez položek");
  const all = items
    .map((it) => ({
      title: xmlTag(it, "title"),
      url: xmlTag(it, "link").split("?")[0], // bez utm parametrů
      date: new Date(xmlTag(it, "pubDate")),
      excerpt: (xmlTag(it, "description") || xmlTag(it, "content:encoded")).slice(0, 1200),
    }))
    .filter((p) => p.title && /^https:\/\//.test(p.url));
  const cutoff = Date.now() - SKEJWIN_DAYS * 86400000;
  return { recent: all.filter((p) => p.date.getTime() >= cutoff), latest: all[0] || null };
}

// Shrnutí vlastními slovy (levný model, bez web searche). Odkazy a data bereme z feedu, ne od modelu.
async function summarizeSkejwin(posts, apiKey) {
  const list = posts.map((p, i) => "#" + i + "\nNázev: " + p.title + "\nÚryvek: " + p.excerpt).join("\n\n");
  const prompt = [
    "JAZYK: piš česky a tykej.",
    "Níže jsou nové články blogu Lukáše Nádvorníka (SKEJWIN, nezávislé investování, penzijní reforma).",
    "Ke každému napiš 1–2 věty VLASTNÍMI SLOVY: o čem je a co z toho plyne pro drobného investora s dlouhým horizontem. Text článku nekopíruj.",
    '"relevant" je true, pokud se týká penzijka či důchodové reformy, ETF a pasivního investování nebo daní a legislativy investic.',
    'Vrať POUZE JSON: {"posts":[{"i":0,"summary":"...","relevant":true}]}',
    "",
    list,
  ].join("\n");
  const { json } = await callModel({ prompt, apiKey, model: MODEL_SCAN, maxTokens: 1200, maxUses: 0 });
  if (!json) throw new Error("Skejwin: shrnutí bez použitelného JSON");
  return new Map((Array.isArray(json.posts) ? json.posts : []).map((x) => [x.i, x]));
}

// Záloha: když RSS nejde, web search omezený na skejwin.cz.
async function skejwinViaSearch(today, apiKey) {
  const prompt = [
    "Dnešní datum: " + today + ". JAZYK: piš česky a tykej.",
    "Pomocí web search najdi NOVÉ články na blogu skejwin.cz (Lukáš Nádvorník) publikované za posledních " + SKEJWIN_DAYS + " dní.",
    'Vrať POUZE JSON: {"posts":[{"title":"...","url":"https://skejwin.cz/...","date":"YYYY-MM-DD","summary":"1–2 věty vlastními slovy","relevant":true}]}',
    '"relevant" je true, pokud se týká penzijka či důchodové reformy, ETF nebo legislativy investic. URL musí být skutečná z výsledků hledání, nic nevymýšlej. Když nic nového nevyšlo, vrať {"posts":[]}.',
  ].join("\n");
  const { json } = await callModel({ prompt, apiKey, model: MODEL_SCAN, maxTokens: 1500, maxUses: 2, allowedDomains: ["skejwin.cz"] });
  if (!json) throw new Error("Skejwin: web search bez použitelného JSON");
  return (Array.isArray(json.posts) ? json.posts : [])
    .filter((p) => p.title && typeof p.url === "string" && /^https:\/\/(www\.)?skejwin\.cz\//.test(p.url))
    .map((p) => ({
      title: p.title,
      url: p.url.split("?")[0],
      date: p.date ? new Date(p.date) : null,
      summary: p.summary || "",
      relevant: !!p.relevant,
    }));
}

// Nikdy nevyhazuje chybu — selhání Skejwinu nesmí shodit zbytek digestu.
async function scanSkejwin(today, apiKey) {
  try {
    const { recent, latest } = await fetchSkejwinFeed();
    let posts = [];
    if (recent.length) {
      const top = recent.slice(0, MAX_SKEJWIN);
      let map = new Map();
      try {
        map = await summarizeSkejwin(top, apiKey);
      } catch (err) {
        console.error("Skejwin shrnutí:", err.message); // článek ukážeme i bez shrnutí
      }
      posts = top.map((p, i) => ({
        ...p,
        summary: (map.get(i) && map.get(i).summary) || "",
        relevant: !!(map.get(i) && map.get(i).relevant),
      }));
    }
    return { status: posts.length ? "news" : "quiet", posts, latest };
  } catch (err) {
    console.error("Skejwin RSS selhalo, zkouším web search:", err.message);
    try {
      const posts = (await skejwinViaSearch(today, apiKey)).slice(0, MAX_SKEJWIN);
      return { status: posts.length ? "news" : "quiet", posts, latest: null };
    } catch (err2) {
      console.error("Skejwin:", err2.message);
      return { status: "failed", posts: [], latest: null };
    }
  }
}

function renderSkejwin(sk) {
  if (!sk) return "";
  const head =
    '<h3 style="font:11px ' + MONO + ';letter-spacing:.16em;color:#7c7b74;margin:28px 0 8px;">SKEJWIN · LUKÁŠ NÁDVORNÍK</h3>';
  const box = (inner) =>
    '<div style="background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;padding:6px 16px;">' + inner + "</div>";
  const fmt = (d) => (d && !isNaN(d) ? d.toISOString().slice(0, 10) : "");
  if (sk.status === "failed") {
    return head + box('<p style="font:13.5px ' + SANS + ';color:#a83232;">Blog se tento týden nepodařilo zkontrolovat.</p>');
  }
  if (!sk.posts.length) {
    const last = sk.latest ? " Poslední článek: " + escHtml(sk.latest.title) + " (" + fmt(sk.latest.date) + ")." : "";
    return head + box('<p style="font:14.5px/1.6 ' + SERIF + ';color:#7c7b74;">Tento týden nový článek nevyšel.' + last + "</p>");
  }
  const items = sk.posts
    .map((p, i) => {
      const badge = p.relevant
        ? '<span style="display:inline-block;background:#e4ecf7;color:#24427a;border-radius:5px;padding:2px 8px;font:600 11px ' + SANS + ';margin-left:6px;">pro tvé portfolio</span>'
        : "";
      const link = escHtml(p.url);
      return (
        '<div style="padding:12px 0;' + (i ? "border-top:1px solid #dcdad2;" : "") + '">' +
        '<div style="font:600 15.5px/1.35 ' + SANS + ';color:#191a1c;"><a href="' + link + '" style="color:#191a1c;text-decoration:underline;text-decoration-color:#b9b7ae;">' + escHtml(p.title) + "</a>" + badge + "</div>" +
        '<div style="font:12px ' + MONO + ';color:#7c7b74;margin:3px 0 4px;">' + fmt(p.date) + "</div>" +
        '<div style="font:14.5px/1.62 ' + SERIF + ';color:#40413f;">' + escHtml(p.summary) +
        ' <a href="' + link + '" style="font:12.5px ' + SANS + ';color:#24427a;text-decoration:none;white-space:nowrap;">číst dál →</a></div>' +
        "</div>"
      );
    })
    .join("");
  return head + box(items);
}

// ── Render e-mailu ──────────────────────────────────────────────────
// Fonty: v e-mailu nelze spolehlivě načíst vlastní písmo (Gmail strhává @font-face),
// takže sázíme na to, co má uživatel v systému. Georgia je na dlouhý text čitelnější
// než Arial a je prakticky všude; Consolas/SF Mono jsou hezčí než Courier New.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";
const MONO = "Consolas,'SF Mono',Menlo,'Courier New',monospace";

function safeHttps(u) {
  return typeof u === "string" && /^https:\/\//.test(u) ? u : null;
}

function renderEmail({ today, triggers, highlights, watchItems, considerations, coverage, allFailed, skejwin }) {
  const SENT = {
    bullish: { label: "▲ bullish", color: "#17734a", bg: "#e4f2ea" },
    bearish: { label: "▼ bearish", color: "#a83232", bg: "#f7e7e7" },
    neutral: { label: "◆ neutrální", color: "#7c7b74", bg: "#ececea" },
  };

  // ── Poplach: nespadlo náhodou všechno? ──
  const failBanner = allFailed
    ? `
    <div style="background:#f7e7e7;border:1px solid #d9a5a5;border-radius:12px;padding:16px 18px;margin-bottom:26px;">
      <div style="font:700 15.5px ${SANS};color:#a83232;margin-bottom:6px;">
        &#9888; Přehled se nepodařilo sestavit
      </div>
      <div style="font:14.5px/1.7 ${SERIF};color:#40413f;">
        Všechny dotazy skončily chybou, takže tenhle mail <strong>neříká, že se nic nestalo</strong> — říká,
        že se nic nepodařilo zjistit. Nejčastější příčina je vyčerpaný kredit na Anthropic API
        (console.anthropic.com &rarr; Plans &amp; Billing). Přesnou chybu najdeš v Netlify &rarr; Functions &rarr; Logs.
      </div>
    </div>`
    : "";

  // ── Spouštěče (jen když je co hlásit) ──
  const triggerBlock = triggers.length
    ? `
    <h3 style="font:11px ${MONO};letter-spacing:.16em;color:#7c7b74;margin:0 0 8px;">SPOUŠTĚČE</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;margin-bottom:26px;">
      ${triggers
        .map((t, i) => {
          const badge =
            t.days <= 7 ? { bg: "#f7e7e7", color: "#a83232" } : { bg: "#ececea", color: "#40413f" };
          const when = t.days === 0 ? "dnes" : t.days === 1 ? "zítra" : `za ${t.days} dní`;
          return `
      <tr>
        <td style="padding:14px 16px;${i ? "border-top:1px solid #dcdad2;" : ""}">
          <div style="margin-bottom:6px;">
            <span style="display:inline-block;background:${badge.bg};color:${badge.color};border-radius:5px;
                         padding:3px 9px;font:600 11px ${SANS};">${when}</span>
            <span style="font:12px ${MONO};color:#7c7b74;margin-left:8px;">${t.when}</span>
          </div>
          <div style="font:600 15.5px/1.35 ${SANS};color:#191a1c;margin:2px 0 4px;">${t.title}</div>
          <div style="font:14.5px/1.62 ${SERIF};color:#40413f;">${t.note}</div>
        </td>
      </tr>`;
        })
        .join("")}
    </table>`
    : "";

  // ── Zprávy k titulům ──
  const emptyMsg = allFailed
    ? "Žádná data — viz upozornění nahoře."
    : "Tento týden nic zásadního — žádná zpráva neprošla filtrem materiality. To je taky užitečná informace.";

  const rows = highlights.length
    ? highlights
        .map((h, i) => {
          const s = SENT[h.sentiment] || SENT.neutral;
          const safeUrl = safeHttps(h.url);
          const headline = safeUrl
            ? `<a href="${safeUrl}" style="color:#191a1c;text-decoration:underline;text-decoration-color:#b9b7ae;">${h.headline}</a>`
            : h.headline;
          const readMore = safeUrl
            ? ` <a href="${safeUrl}" style="font:12.5px ${SANS};color:#24427a;text-decoration:none;white-space:nowrap;">číst dál →</a>`
            : "";
          const deep = h.analysis
            ? `
          <div style="margin-top:10px;padding:12px 14px;background:#f2f1ec;border-left:3px solid #24427a;border-radius:0 8px 8px 0;">
            <div style="font:11px ${MONO};letter-spacing:.13em;color:#24427a;margin-bottom:5px;">HLUBŠÍ POHLED</div>
            <div style="font:14.5px/1.7 ${SERIF};color:#40413f;">${h.analysis}</div>
          </div>`
            : "";
          return `
      <tr>
        <td style="padding:14px 14px;border-top:1px solid #dcdad2;vertical-align:top;
                   font:600 13px ${MONO};color:#24427a;">${String(i + 1).padStart(2, "0")}</td>
        <td style="padding:14px 16px 14px 0;border-top:1px solid #dcdad2;">
          <div style="margin-bottom:6px;">
            <span style="display:inline-block;background:#24427a;color:#fbfaf6;border-radius:5px;
                         padding:3px 9px;font:700 12px ${MONO};letter-spacing:.07em;">${h.ticker}</span>
            <span style="display:inline-block;background:${s.bg};color:${s.color};border-radius:5px;
                         padding:3px 9px;font:600 11px ${SANS};margin-left:6px;">${s.label}</span>
          </div>
          <div style="font:600 16.5px/1.35 ${SANS};color:#191a1c;margin:2px 0 4px;">${headline}</div>
          <div style="font:15px/1.62 ${SERIF};color:#40413f;">${h.detail}${readMore}</div>
          ${deep}
        </td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="2" style="padding:16px;font:15px/1.6 ${SERIF};color:#40413f;">${emptyMsg}</td></tr>`;

  // ── Sledovaná témata ──
  const watchBlock = watchItems.length
    ? `
    <h3 style="font:11px ${MONO};letter-spacing:.16em;color:#7c7b74;margin:28px 0 8px;">SLEDOVANÉ ZMĚNY</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;">
      ${watchItems
        .map((it, i) => {
          const safeUrl = safeHttps(it.url);
          const headline = safeUrl
            ? `<a href="${safeUrl}" style="color:#191a1c;text-decoration:underline;text-decoration-color:#b9b7ae;">${it.headline}</a>`
            : it.headline;
          const readMore = safeUrl
            ? ` <a href="${safeUrl}" style="font:12.5px ${SANS};color:#24427a;text-decoration:none;white-space:nowrap;">číst dál →</a>`
            : "";
          return `
      <tr>
        <td style="padding:14px 16px;${i ? "border-top:1px solid #dcdad2;" : ""}">
          <div style="margin-bottom:6px;">
            <span style="display:inline-block;background:#5a5f52;color:#fbfaf6;border-radius:5px;
                         padding:3px 9px;font:600 11px ${SANS};letter-spacing:.04em;">${it.label}</span>
          </div>
          <div style="font:600 15.5px/1.35 ${SANS};color:#191a1c;margin:2px 0 4px;">${headline}</div>
          <div style="font:14.5px/1.62 ${SERIF};color:#40413f;">${it.detail}${readMore}</div>
        </td>
      </tr>`;
        })
        .join("")}
    </table>`
    : "";

  const cons = considerations.length
    ? `<h3 style="font:11px ${MONO};letter-spacing:.16em;color:#7c7b74;margin:28px 0 8px;">K ZVÁŽENÍ</h3>
       <ul style="margin:0;padding-left:18px;">
         ${considerations.map((c) => `<li style="font:15px/1.68 ${SERIF};color:#40413f;">${c}</li>`).join("")}
       </ul>`
    : "";

  // Přehled pokrytí — které tituly měly zprávu, které byly klidné, které selhaly.
  const withNews = coverage.filter((c) => c.status === "news").map((c) => c.ticker);
  const quiet = coverage.filter((c) => c.status === "quiet").map((c) => c.ticker);
  const failed = coverage.filter((c) => c.status === "failed").map((c) => c.ticker);
  const line = (label, arr, color) =>
    arr.length
      ? `<div style="font:13.5px/1.65 ${SANS};color:${color};margin-top:4px;">
           <strong style="font-weight:600;">${label}:</strong> ${arr.join(", ")}
         </div>`
      : "";
  const coverageBlock = `
    <h3 style="font:11px ${MONO};letter-spacing:.16em;color:#7c7b74;margin:28px 0 8px;">POKRYTÍ</h3>
    <div style="background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;padding:14px 16px;">
      ${line("Se zprávou", withNews, "#191a1c")}
      ${line("Bez zásadních zpráv", quiet, "#7c7b74")}
      ${line("Nepodařilo se prověřit", failed, "#a83232")}
    </div>`;

  return `
  <div style="max-width:640px;margin:0 auto;background:#f2f1ec;padding:28px 22px;">
    <div style="font:11px ${MONO};letter-spacing:.16em;color:#7c7b74;">PATRIA · OSOBNÍ ÚČET</div>
    <h1 style="font:700 27px ${SANS};letter-spacing:-.01em;color:#191a1c;margin:6px 0 2px;">Týdenní puls portfolia</h1>
    <div style="font:13px ${SANS};color:#7c7b74;margin-bottom:22px;">${today} · seřazeno podle dopadu</div>
    ${failBanner}
    ${triggerBlock}
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;">
      ${rows}
    </table>
    ${watchBlock}
    ${renderSkejwin(skejwin)}
    ${cons}
    ${coverageBlock}
    <p style="font:11.5px/1.6 ${SANS};color:#7c7b74;border-top:1px solid #dcdad2;margin-top:28px;padding-top:14px;">
      Přehled je informativní, sestavený z veřejných zdrojů, a nejde o investiční doporučení.
      Štítky bullish/bearish jsou odhad pravděpodobného směru dopadu, ne signál k obchodu.
      Body „k zvážení" a „hlubší pohled" jsou neutrální pozorování, ne pokyny k nákupu či prodeji.
      Spouštěče jsou vlastní poznámky k termínům, ne právní ani daňová rada — vždy ověř u zdroje.
    </p>
  </div>`;
}

// ── Hlavní běh ──────────────────────────────────────────────────────
export default async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_TO;
  const from = process.env.DIGEST_FROM;
  if (!apiKey || !resendKey || !to || !from) {
    return new Response("Chybí ENV proměnné", { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const triggers = upcomingTriggers(today);
  const allHighlights = [];
  const considerations = [];
  const watchItems = [];
  const coverage = []; // { ticker, status: "news" | "quiet" | "failed" }

  // ── 1. TRIÁŽ ── sekvenčně, s jedním retry — šetrné k rate limitům.
  for (const p of POSITIONS) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await scanTicker(p, today, apiKey);
        allHighlights.push(...r.highlights);
        considerations.push(...r.considerations);
        coverage.push({ ticker: p.ticker, status: r.highlights.length ? "news" : "quiet" });
        ok = true;
      } catch (err) {
        if (attempt === 1) {
          coverage.push({ ticker: p.ticker, status: "failed" });
          console.error(err);
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }

  for (const w of WATCHES) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await scanWatch(w, today, apiKey);
        watchItems.push(...r.items);
        coverage.push({ ticker: w.label, status: r.items.length ? "news" : "quiet" });
        ok = true;
      } catch (err) {
        if (attempt === 1) {
          coverage.push({ ticker: w.label, status: "failed" });
          console.error(err);
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }

  // Spadlo všechno? Pak mail nesmí tvrdit, že se nic nestalo.
  const allFailed = coverage.length > 0 && coverage.every((c) => c.status === "failed");

  // Seřadit podle dopadu, ale omezit počet zpráv na jeden titul,
  // ať jeden „ukecaný" titul nevytlačí ostatní.
  allHighlights.sort((a, b) => (b.importance || 0) - (a.importance || 0));
  const perTicker = {};
  const highlights = [];
  for (const h of allHighlights) {
    const t = h.ticker || "—";
    perTicker[t] = perTicker[t] || 0;
    if (perTicker[t] >= MAX_PER_TICKER) continue;
    perTicker[t]++;
    highlights.push(h);
    if (highlights.length >= MAX_HIGHLIGHTS) break;
  }

  // ── 2. HLOUBKA ── jen na položky, které v triáži prošly prahem.
  const toEscalate = highlights
    .filter((h) => (h.importance || 0) >= ESCALATE_MIN)
    .slice(0, ESCALATE_MAX);
  for (const h of toEscalate) {
    try {
      const d = await deepDive(h, today, apiKey);
      if (d.analysis) h.analysis = d.analysis;
      if (d.revised !== null) h.importance = d.revised;
    } catch (err) {
      // Hloubka je bonus, ne blokátor — když selže, mail dorazí bez ní.
      console.error(`deepDive ${h.ticker}:`, err.message);
    }
  }
  // Po přehodnocení může být pořadí jiné.
  highlights.sort((a, b) => (b.importance || 0) - (a.importance || 0));

  // ── Skejwin ── vlastní blok; jeho selhání nesmí shodit zbytek digestu.
  const skejwin = await scanSkejwin(today, apiKey);

  const html = renderEmail({
    today,
    triggers,
    highlights,
    watchItems,
    considerations: considerations.slice(0, 3),
    coverage,
    allFailed,
    skejwin,
  });

  // Předmět dá vědět, co se děje, ještě před otevřením.
  let subject = `Týdenní puls portfolia · ${today}`;
  if (allFailed) {
    subject = `\u26A0 Týdenní puls portfolia · ${today} · nepodařilo se sestavit`;
  } else {
    const parts = [];
    if (toEscalate.length) parts.push(`${toEscalate.length}\u00D7 k rozboru`);
    if (triggers.length) parts.push(`${triggers.length}\u00D7 spouštěč`);
    if (parts.length) subject += ` · ${parts.join(", ")}`;
  }

  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!mail.ok) {
    console.error("Resend:", await mail.text());
    return new Response("Digest sestaven, ale e-mail se nepodařilo odeslat", { status: 502 });
  }

  return new Response("OK — digest odeslán");
};

// Cron: každou neděli v 7:00 UTC (9:00 letního času v ČR).
export const config = {
  schedule: "0 7 * * 0",
};
