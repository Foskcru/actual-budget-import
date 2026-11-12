// ============================================================================
//  Suggestions de catégories à partir de l'HISTORIQUE (sans IA, sans réseau)
//  - On apprend sur les opérations déjà catégorisées du budget.
//  - 3 niveaux, du plus sûr au plus flou :
//      1. même bénéficiaire (payee Actual)        -> source 'beneficiaire'
//      2. même libellé normalisé                  -> source 'libelle'
//      3. mots communs pondérés (type TF-IDF)     -> source 'mots'
//  - Fournit aussi, pour chaque opération, les exemples historiques les plus
//    proches : ils servent de « mémoire » à l'IA locale (apprentissage par exemples).
//  Module PUR (aucune dépendance) -> testable sans Actual.
// ============================================================================

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Mots bancaires sans valeur pour deviner la catégorie
const STOP = new Set(('cb carte paiement paiem achat facture fact prlv prelevement prel sepa vir virement '
  + 'recu emis instantane inst de du des le la les un une au aux et en sur pour par avec chez ref '
  + 'mandat ech echeance date num numero transaction operation retrait dab frais commission eur euro euros '
  + 'fr france sas sarl sa www com http https')
  .split(/\s+/));

// Libellé -> forme canonique (minuscules, sans accents, sans chiffres ni ponctuation)
export function normLabel(s) {
  return stripAccents(s).toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
export function tokens(s) {
  const out = [];
  for (const w of normLabel(s).split(' ')) if (w.length >= 3 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}
// Clé « libellé » : les 4 premiers mots utiles (assez stable d'un mois sur l'autre)
export function labelKey(s) { return tokens(s).slice(0, 4).join(' '); }

const textOf = (t) => [t.payeeName || '', t.notes || '', t.importedPayee || ''].join(' ');

/**
 * history : [{ payee, payeeName, notes, importedPayee, category, amount }]
 *           (opérations DÉJÀ catégorisées, hors virements internes et hors « À vérifier »)
 */
export function buildModel(history) {
  const byPayee = new Map();   // payeeId -> Map(cat -> n)
  const byKey = new Map();     // labelKey -> Map(cat -> n)
  const byTok = new Map();     // token -> Map(cat -> n)
  const docFreq = new Map();   // token -> nb d'opérations
  const docs = [];             // pour retrouver les exemples proches
  const inc = (m, k, cat) => { let c = m.get(k); if (!c) m.set(k, c = new Map()); c.set(cat, (c.get(cat) || 0) + 1); };
  for (const t of history) {
    if (!t || !t.category) continue;
    if (t.payee) inc(byPayee, t.payee, t.category);
    const txt = textOf(t);
    const key = labelKey(txt);
    if (key) inc(byKey, key, t.category);
    const toks = tokens(txt);
    for (const w of toks) { inc(byTok, w, t.category); docFreq.set(w, (docFreq.get(w) || 0) + 1); }
    docs.push({ toks, key, cat: t.category, text: shortText(t), amount: t.amount });
  }
  return { byPayee, byKey, byTok, docFreq, docs, n: docs.length };
}

function shortText(t) {
  const p = (t.payeeName || '').trim(), n = (t.notes || '').replace(/\s+/g, ' ').trim();
  const s = p && n && !normLabel(n).includes(normLabel(p)) ? `${p} — ${n}` : (n || p);
  return s.slice(0, 140);
}

// Catégorie dominante d'une distribution {cat -> n}
function dominant(dist) {
  let best = null, bestN = 0, total = 0;
  for (const [cat, n] of dist) { total += n; if (n > bestN) { bestN = n; best = cat; } }
  return { cat: best, n: bestN, total, share: total ? bestN / total : 0 };
}
// Plus il y a d'occurrences, plus on a confiance (1 -> 0.6, 2 -> 0.8, 3 -> 0.87, 5+ -> ~0.92+)
const supportFactor = (n) => n / (n + 0.67);

/**
 * Suggère une catégorie pour une opération. Renvoie null si rien d'assez fiable.
 * tx : { payee, payeeName, notes, importedPayee }
 * -> { category, source, confidence (0..1), support (nb d'opérations semblables) }
 */
export function suggest(model, tx, { minConfidence = 0.45 } = {}) {
  // 1. Même bénéficiaire
  if (tx.payee && model.byPayee.has(tx.payee)) {
    const d = dominant(model.byPayee.get(tx.payee));
    const conf = d.share * supportFactor(d.n);
    if (d.share >= 0.6 && conf >= minConfidence) return { category: d.cat, source: 'beneficiaire', confidence: round2(conf), support: d.total };
  }
  const txt = textOf(tx);
  // 2. Même libellé normalisé
  const key = labelKey(txt);
  if (key && model.byKey.has(key)) {
    const d = dominant(model.byKey.get(key));
    const conf = d.share * supportFactor(d.n);
    if (d.share >= 0.6 && conf >= minConfidence) return { category: d.cat, source: 'libelle', confidence: round2(conf), support: d.total };
  }
  // 3. Mots communs pondérés par leur rareté (IDF)
  const toks = tokens(txt);
  const scores = new Map(); let mass = 0, seen = 0;
  for (const w of toks) {
    const dist = model.byTok.get(w); if (!dist) continue;
    const df = model.docFreq.get(w) || 1;
    const idf = Math.log(1 + model.n / df);
    let tot = 0; for (const n of dist.values()) tot += n;
    for (const [cat, n] of dist) scores.set(cat, (scores.get(cat) || 0) + idf * (n / tot));
    mass += idf; seen++;
  }
  if (!seen) return null;
  let best = null, bestS = 0;
  for (const [cat, s] of scores) if (s > bestS) { bestS = s; best = cat; }
  // part du score gagnant x part (adoucie) des mots connus : un seul mot connu = confiance moyenne
  const coverage = Math.sqrt(Math.min(1, seen / Math.max(1, Math.min(toks.length, 3))));
  const conf = (bestS / mass) * coverage * 0.9;
  if (conf < minConfidence) return null;
  return { category: best, source: 'mots', confidence: round2(conf), support: seen };
}

/** Les k opérations historiques les plus proches (exemples pour l'IA). Une seule par libellé. */
export function nearestExamples(model, tx, k = 8) {
  const toks = new Set(tokens(textOf(tx)));
  if (!toks.size) return [];
  const scored = [];
  for (const d of model.docs) {
    let inter = 0;
    for (const w of d.toks) if (toks.has(w)) inter += Math.log(1 + model.n / (model.docFreq.get(w) || 1));
    if (inter > 0) scored.push([inter / Math.sqrt(d.toks.length || 1), d]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out = [], seenKey = new Set();
  for (const [, d] of scored) {
    const k2 = d.key + '|' + d.cat; if (seenKey.has(k2)) continue; seenKey.add(k2);
    out.push({ text: d.text, category: d.cat, amount: d.amount });
    if (out.length >= k) break;
  }
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;
