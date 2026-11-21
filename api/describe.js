// api/describe.js - Vercel Serverless Function
// Env vars to set in Vercel Dashboard (NEVER in HTML / chat):
//   GEMINI_API_KEY  - from https://aistudio.google.com/app/apikey
//   SERPAPI_KEY     - from https://serpapi.com (for Google Lens + Google Search)
// Flow: 1) Gemini Vision identifies product -> keywords
//       2) SerpApi Google Lens on the image + Google Search on AliExpress / Alibaba / Pinterest / Google
//       3) Gemini generates description FROM the found products only.
//       4) If exact product not found -> similar products -> "similar" flag.

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

const SITES = ["aliexpress.com", "alibaba.com", "pinterest.com"];

async function geminiVision(imageBase64, mime, prompt) {
  const key = process.env.GEMINI_API_KEY;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: mime || "image/jpeg", data: imageBase64 } }
    ] }] })
  });
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
}

async function geminiText(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
}

async function serpLens(imageUrl, serpKey) {
  // Google Lens via SerpApi - needs a public image URL. If imageUrl is data: we skip Lens and use keyword search.
  if (!imageUrl || imageUrl.startsWith("data:")) return [];
  try {
    const u = "https://serpapi.com/search.json?engine=google_lens&url=" + encodeURIComponent(imageUrl) + "&api_key=" + serpKey;
    const r = await fetch(u); const j = await r.json();
    return (j.visual_matches || []).slice(0, 8).map(m => ({ title: m.title, link: m.link, source: m.source, thumbnail: m.thumbnail, price: m.price?.value || "" }));
  } catch { return []; }
}

async function serpSiteSearch(query, site, serpKey) {
  try {
    const q = "site:" + site + " " + query;
    const u = "https://serpapi.com/search.json?engine=google&q=" + encodeURIComponent(q) + "&num=6&api_key=" + serpKey;
    const r = await fetch(u); const j = await r.json();
    return (j.organic_results || []).slice(0, 6).map(x => ({ title: x.title, link: x.link, snippet: x.snippet || "", source: site }));
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { imageBase64, mime, imageUrl, productName, lang } = req.body || {};
    if (!imageBase64 && !imageUrl) return res.status(400).json({ error: "image required" });
    const language = lang || "ar";
    // 1) Identify product from image
    const identifyPrompt = `Identify this product precisely for shopping search. Return JSON only: {"product":"...","keywords":"...","color":"...","category":"..."}. Product name in English, 3-6 keywords.`;
    let identify = "";
    if (imageBase64) identify = await geminiVision(imageBase64, mime, identifyPrompt);
    let parsed = {};
    try { parsed = JSON.parse(identify.replace(/```json|```/g, "").trim()); } catch { parsed = { product: productName || "", keywords: productName || "" }; }
    const query = (parsed.product || productName || "") + " " + (parsed.keywords || "");
    // 2) Search: Lens + 3 sites + Google
    const serpKey = process.env.SERPAPI_KEY;
    let all = [];
    if (serpKey) {
      const lens = await serpLens(imageUrl || "", serpKey);
      all.push(...lens.map(x => ({ ...x, platform: "Google Lens" })));
      for (const site of SITES) {
        const rows = await serpSiteSearch(query, site, serpKey);
        all.push(...rows.map(x => ({ ...x, platform: site })));
      }
      const g = await serpSiteSearch(query, "", serpKey);
      all.push(...g.map(x => ({ ...x, platform: "Google" })));
    }
    // Dedupe by link
    const seen = new Set(); all = all.filter(x => { if (!x.link || seen.has(x.link)) return false; seen.add(x.link); return true; });
    // 3) Generate description FROM found products
    const sourcesText = all.slice(0, 12).map((x,i)=> `${i+1}. [${x.platform}] ${x.title} - ${x.snippet||""} - ${x.link}`).join("\n") || "No external products found.";
    const genPrompt = `You are a product copywriter. Language: ${language}.
Product in photo: ${parsed.product || productName} | Keywords: ${query} | Color: ${parsed.color||""} | Category: ${parsed.category||""}.
Found products (use ONLY these, do not invent specs):
${sourcesText}
Task: If an exact same product is in the list, say found=true and write the description from ITS title/specs. If not, say found=false and write description from the most SIMILAR products, and say it is similar.
Return JSON only: {"found":true/false,"short":"2-3 lines selling description","long":"8-12 lines with features, use, materials if in sources, CTA","sources_used":["...titles..."],"match_percent":0-100}`;
    const genRaw = await geminiText(genPrompt);
    let gen = {};
    try { gen = JSON.parse(genRaw.replace(/```json|```/g, "").trim()); } catch { gen = { found: all.length>0, short: genRaw.slice(0,400), long: genRaw, sources_used: [], match_percent: all.length?70:0 }; }
    return res.status(200).json({ product: parsed.product || productName, keywords: query, found: gen.found, match_percent: gen.match_percent, short: gen.short, long: gen.long, sources: all.slice(0,12), sources_used: gen.sources_used || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
