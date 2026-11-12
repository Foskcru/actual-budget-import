// ============================================================================
//  « C'est quoi ce commerçant ? » : nettoyage du nom + recherche web
//  - DuckDuckGo (version HTML, sans clé) par défaut ; Brave Search API si une clé est fournie.
//  - Seul le NOM nettoyé du commerçant part sur internet (jamais montant / date / compte).
//  Les fonctions de parsing sont PURES -> testables sans réseau.
// ============================================================================

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Préfixes des terminaux de paiement / intermédiaires : « SUMUP *CAMARGUE GLACO » -> « CAMARGUE GLACO »
const PSP = /^(?:sum\s?up|paypal|pp|sq|square|zettle|izettle|iz|stripe|payplug|viva(?:wallet)?|mypos|ingenico|lydia|lyf|uber\s?eats|ubr|sncf\s?connect|google|apple\.com\/bill|amzn\s?mktp|amazon\s?mktplace)\s*\*\s*/i;

/** Nom de commerçant exploitable pour une recherche (ou '' si rien d'utile). */
export function merchantName(payeeName, notes) {
  let s = String(payeeName || '').trim();
  if (!s) {
    s = String(notes || '').split(/\r?\n/)[0];
    const m = s.match(/(?:paiement|transaction)\s+carte\b[^:]*:\s*(.+)$/i); if (m) s = m[1];
  }
  s = s.replace(/^\s*(?:cb|carte|paiement\s+cb|prlv\s+sepa|prlv|achat\s+cb)\s+/i, '');
  for (let i = 0; i < 2; i++) s = s.replace(PSP, '');
  if (s.includes('*')) { const after = s.split('*').pop().trim(); if (after.length >= 3) s = after; }
  s = s.replace(/\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/g, ' ')   // dates
    .replace(/\b[A-Z]{0,3}\d{3,}\w*\b/gi, ' ')                       // n° de carte, références
    .replace(/[_|#]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 3 ? s.slice(0, 80) : '';
}
/** Clé de cache d'un commerçant (insensible casse/accents/ponctuation). */
export function merchantKey(name) {
  return stripAccents(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Virements entre ses propres comptes : ne doivent PAS recevoir de catégorie (à relier dans Actual)
const INTERNAL = /virement\s+interne|porte[\s-]?monnaie|vers\s+(?:votre|mon|ma|le)?\s*(?:livret|compte|cagnotte|coffre|epargne|épargne)|depuis\s+(?:votre|mon|ma|le)?\s*(?:livret|compte|cagnotte|coffre)|transfert\s+(?:vers|depuis|entre)|vir(?:ement)?\s+(?:permanent\s+)?(?:de|vers)\s+(?:livret|ldd|lep|pel)\b/i;
export function looksInternal(payeeName, notes) {
  return INTERNAL.test(`${payeeName || ''} ${notes || ''}`);
}

// ---------------------------- parsing des résultats ----------------------------
const decodeEntities = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
function realUrl(href) {
  const h = String(href || '').replace(/&amp;/g, '&');
  const m = h.match(/[?&]uddg=([^&]+)/);
  try { return m ? decodeURIComponent(m[1]) : (h.startsWith('//') ? 'https:' + h : h); } catch { return h; }
}

/** Page html.duckduckgo.com/html OU lite.duckduckgo.com/lite -> [{title, snippet, url}] */
export function parseDDG(html, max = 5) {
  const out = [];
  const s = String(html || '');
  // Version « html » : <a class="result__a" href=...>titre</a> ... <a class="result__snippet" ...>extrait</a>
  const blocks = s.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b|y\.js\?ad_/i.test(b.slice(0, 400))) continue;               // publicités
    const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
           || b.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const sn = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    const url = realUrl(a[1]);
    if (/duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: decodeEntities(a[2]), snippet: decodeEntities(sn ? sn[1] : ''), url });
    if (out.length >= max) return out;
  }
  if (out.length) return out;
  // Version « lite » : <a class="result-link" href=...>titre</a> ... <td class="result-snippet">extrait</td>
  const re = /<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [...s.matchAll(re)];
  const snippets = [...s.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)].map(m => decodeEntities(m[1]));
  links.forEach((m, i) => {
    if (out.length >= max) return;
    const href = m[2] || (m[0].match(/href=['"]([^'"]+)['"]/i) || [])[1];
    const url = realUrl(href);
    if (/duckduckgo\.com\/y\.js/.test(url)) return;
    out.push({ title: decodeEntities(m[3] || m[1]), snippet: snippets[i] || '', url });
  });
  return out;
}
export function ddgBlocked(status, html) {
  return status === 202 || status === 403 || status === 429 || /anomaly-modal|challenge-form|captcha/i.test(String(html || '').slice(0, 20000));
}
/** Réponse JSON de l'API Brave -> [{title, snippet, url}] */
export function parseBrave(json, max = 5) {
  return ((json && json.web && json.web.results) || []).slice(0, max)
    .map(r => ({ title: decodeEntities(r.title), snippet: decodeEntities(r.description), url: r.url || '' }));
}

// ---------------------------- recherche (réseau) ----------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let lastCall = 0;
async function politeDelay() { // 1 recherche / 1,5 s max : on reste discret (et pas de blocage)
  const wait = lastCall + 1500 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}
async function getText(url, headers) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' }); return { status: r.status, text: await r.text() }; }
  finally { clearTimeout(t); }
}

/** Cherche un commerçant. -> { results:[{title,snippet,url}], provider } ; lève une Error lisible sinon. */
export async function searchMerchant(name, { braveKey = '' } = {}) {
  const q = String(name || '').trim().slice(0, 80);
  if (q.length < 3) throw new Error('Nom trop court pour une recherche.');
  await politeDelay();
  if (braveKey) {
    const u = 'https://api.search.brave.com/res/v1/web/search?count=5&country=fr&search_lang=fr&q=' + encodeURIComponent(q);
    const r = await getText(u, { 'Accept': 'application/json', 'X-Subscription-Token': braveKey });
    if (r.status === 401 || r.status === 403) throw new Error('Brave : clé refusée (vérifie-la dans Paramètres → IA locale).');
    if (r.status === 429) throw new Error('Brave : quota atteint, réessaie plus tard.');
    if (r.status !== 200) throw new Error('Brave : HTTP ' + r.status);
    let j; try { j = JSON.parse(r.text); } catch { throw new Error('Brave : réponse illisible.'); }
    return { results: parseBrave(j), provider: 'brave' };
  }
  const headers = { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  let lastErr = null;
  for (const base of ['https://html.duckduckgo.com/html/?kl=fr-fr&q=', 'https://lite.duckduckgo.com/lite/?kl=fr-fr&q=']) {
    try {
      const r = await getText(base + encodeURIComponent(q), headers);
      if (ddgBlocked(r.status, r.text)) { lastErr = new Error('DuckDuckGo a temporairement bloqué la recherche (trop de requêtes). Réessaie plus tard, ou ajoute une clé Brave.'); continue; }
      if (r.status !== 200) { lastErr = new Error('DuckDuckGo : HTTP ' + r.status); continue; }
      const results = parseDDG(r.text);
      if (results.length) return { results, provider: 'duckduckgo' };
      lastErr = null; // page lue mais aucun résultat : on tente la version « lite »
    } catch (e) { lastErr = new Error('DuckDuckGo injoignable depuis le NAS (' + (e?.name === 'AbortError' ? 'délai dépassé' : (e?.cause?.code || e?.message || e)) + ').'); }
  }
  if (lastErr) throw lastErr;
  return { results: [], provider: 'duckduckgo' };
}
