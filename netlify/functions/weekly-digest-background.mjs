// netlify/functions/weekly-digest-background.mjs
// Týdenní puls portfolia — běží automaticky (cron) a posílá digest e-mailem přes Resend.
//
// ENV proměnné (Netlify → Site settings → Environment variables):
//   ANTHROPIC_API_KEY  — klíč z console.anthropic.com
//   RESEND_API_KEY     — klíč z resend.com
//   DIGEST_TO          — tvůj e-mail (kam digest chodí)
//   DIGEST_FROM        — odesílatel, např. "Puls <onboarding@resend.dev>"

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

// Kolik zpráv maximálně v mailu a kolik nejvýš na jeden titul
// (aby jeden titul s hodně zprávami nevytlačil ostatní).
const MAX_HIGHLIGHTS = 8;
const MAX_PER_TICKER = 2;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5"; // případně novější, viz docs.claude.com

function buildPrompt(p, today) {
  return `Dnešní datum: ${today}. Mluv česky, tykej. Připravuješ položku do STRUČNÉHO týdenního přehledu pro drobného investora.

Titul: ${p.name} (${p.ticker}, ${p.ccy}).

Pomocí web search projdi ZPRÁVY ZA POSLEDNÍCH 7 DNÍ a použij FILTR MATERIALITY — u každé zprávy: "mohlo by tohle pohnout cenou o víc než pár procent?" Co neprojde, zahoď.

MATERIÁLNÍ (zařaď): nové obchody / velké kontrakty / partnerství, akvizice/fúze, spin-off; výsledky a hlavně změna nebo stažení guidance; financování (nový dluh, refinancování, emise nových akcií = ředění, likvidita/runway); regulace a politika; odchod CEO nebo velký insider trade; změna či škrt dividendy; VÝRAZNÁ změna analytického cíle či up/downgrade od váženého domu.
NEMATERIÁLNÍ (zahoď): běžné PR, marketing, rutinní potvrzení ratingů, makrošum, drobné pohyby bez příčiny.

Vrať POUZE validní JSON, nic dalšího:
{"highlights":[{"ticker":"${p.ticker}","headline":"max 8 slov","detail":"1 věta kontextu","importance":4,"sentiment":"bullish","url":"https://..."}],"considerations":["krátká neutrální úvaha (ne pokyn)"]}
Pravidla: "sentiment" je "bullish" (dopad na cenu spíš pozitivní), "bearish" (spíš negativní), nebo "neutral" (nejednoznačný/smíšený). "url" je odkaz na zdrojový článek — použij POUZE skutečnou URL z výsledků hledání; pokud si nejsi jistý, pole url úplně vynech, NIKDY URL nevymýšlej.
Když nic materiálního není, vrať prázdná pole.`;
}

async function scanTicker(p, today, apiKey) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: buildPrompt(p, today) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  });
  if (!res.ok) throw new Error(`${p.ticker}: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`${p.ticker}: odpověď bez JSON`);
  const parsed = JSON.parse(clean.slice(s, e + 1));
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

function renderEmail({ today, highlights, considerations, coverage }) {
  const SENT = {
    bullish: { label: "▲ bullish", color: "#17734a", bg: "#e4f2ea" },
    bearish: { label: "▼ bearish", color: "#a83232", bg: "#f7e7e7" },
    neutral: { label: "◆ neutrální", color: "#7c7b74", bg: "#ececea" },
  };
  const rows = highlights.length
    ? highlights
        .map((h, i) => {
          const s = SENT[h.sentiment] || SENT.neutral;
          const safeUrl =
            typeof h.url === "string" && /^https:\/\//.test(h.url) ? h.url : null;
          const headline = safeUrl
            ? `<a href="${safeUrl}" style="color:#191a1c;text-decoration:underline;text-decoration-color:#b9b7ae;">${h.headline}</a>`
            : h.headline;
          const readMore = safeUrl
            ? ` <a href="${safeUrl}" style="font:12px Arial,sans-serif;color:#24427a;text-decoration:none;white-space:nowrap;">číst dál →</a>`
            : "";
          return `
      <tr>
        <td style="padding:14px 14px;border-top:1px solid #dcdad2;vertical-align:top;
                   font:600 13px 'Courier New',monospace;color:#24427a;">${String(i + 1).padStart(2, "0")}</td>
        <td style="padding:14px 16px 14px 0;border-top:1px solid #dcdad2;">
          <div style="margin-bottom:6px;">
            <span style="display:inline-block;background:#24427a;color:#fbfaf6;border-radius:5px;
                         padding:3px 9px;font:700 12px 'Courier New',monospace;letter-spacing:.08em;">${h.ticker}</span>
            <span style="display:inline-block;background:${s.bg};color:${s.color};border-radius:5px;
                         padding:3px 9px;font:600 11px Arial,sans-serif;margin-left:6px;">${s.label}</span>
          </div>
          <div style="font:600 16px Arial,sans-serif;color:#191a1c;margin:2px 0 4px;">${headline}</div>
          <div style="font:14px/1.45 Arial,sans-serif;color:#40413f;">${h.detail}${readMore}</div>
        </td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="2" style="padding:16px;font:14px Arial,sans-serif;color:#40413f;">
         Tento týden nic zásadního — žádná zpráva neprošla filtrem materiality. To je taky užitečná informace.
       </td></tr>`;

  const cons = considerations.length
    ? `<h3 style="font:11px 'Courier New',monospace;letter-spacing:.18em;color:#7c7b74;margin:28px 0 8px;">K ZVÁŽENÍ</h3>
       <ul style="margin:0;padding-left:18px;">
         ${considerations.map((c) => `<li style="font:14px/1.6 Arial,sans-serif;color:#40413f;">${c}</li>`).join("")}
       </ul>`
    : "";

  // Přehled pokrytí — které tituly měly zprávu, které byly klidné, které selhaly.
  const withNews = coverage.filter((c) => c.status === "news").map((c) => c.ticker);
  const quiet = coverage.filter((c) => c.status === "quiet").map((c) => c.ticker);
  const failed = coverage.filter((c) => c.status === "failed").map((c) => c.ticker);
  const line = (label, arr, color) =>
    arr.length
      ? `<div style="font:13px/1.6 Arial,sans-serif;color:${color};margin-top:4px;">
           <strong style="font-weight:600;">${label}:</strong> ${arr.join(", ")}
         </div>`
      : "";
  const coverageBlock = `
    <h3 style="font:11px 'Courier New',monospace;letter-spacing:.18em;color:#7c7b74;margin:28px 0 8px;">POKRYTÍ</h3>
    <div style="background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;padding:14px 16px;">
      ${line("Se zprávou", withNews, "#191a1c")}
      ${line("Bez zásadních zpráv", quiet, "#7c7b74")}
      ${line("Nepodařilo se prověřit", failed, "#a83232")}
    </div>`;

  return `
  <div style="max-width:640px;margin:0 auto;background:#f2f1ec;padding:28px 22px;">
    <div style="font:11px 'Courier New',monospace;letter-spacing:.18em;color:#7c7b74;">PATRIA · OSOBNÍ ÚČET</div>
    <h1 style="font:700 26px Arial,sans-serif;color:#191a1c;margin:6px 0 2px;">Týdenní puls portfolia</h1>
    <div style="font:13px Arial,sans-serif;color:#7c7b74;margin-bottom:20px;">${today} · seřazeno podle dopadu</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#fbfaf6;border:1px solid #dcdad2;border-radius:12px;">
      ${rows}
    </table>
    ${cons}
    ${coverageBlock}
    <p style="font:11px/1.55 Arial,sans-serif;color:#7c7b74;border-top:1px solid #dcdad2;margin-top:28px;padding-top:14px;">
      Přehled je informativní, sestavený z veřejných zdrojů, a nejde o investiční doporučení.
      Štítky bullish/bearish jsou odhad pravděpodobného směru dopadu, ne signál k obchodu.
      Body „k zvážení" jsou neutrální pozorování, ne pokyny k nákupu či prodeji.
    </p>
  </div>`;
}

export default async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_TO;
  const from = process.env.DIGEST_FROM;
  if (!apiKey || !resendKey || !to || !from) {
    return new Response("Chybí ENV proměnné", { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const allHighlights = [];
  const considerations = [];
  const coverage = []; // { ticker, status: "news" | "quiet" | "failed" }

  // Sekvenčně, s jedním retry na titul — šetrné k rate limitům.
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
        if (attempt === 1) { coverage.push({ ticker: p.ticker, status: "failed" }); console.error(err); }
        else await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

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

  const html = renderEmail({
    today,
    highlights,
    considerations: considerations.slice(0, 3),
    coverage,
  });

  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Týdenní puls portfolia · ${today}`,
      html,
    }),
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
