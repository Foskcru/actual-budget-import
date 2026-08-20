// ============================================================================
//  Sumeria -> Actual : interface web d'import (conteneur a cote d'Actual)
//  Upload de releves Sumeria bruts -> parse -> preview / import via l'API Actual.
// ============================================================================
import express from 'express';
import multer from 'multer';
import * as api from '@actual-app/api';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config (variables d'environnement, definies dans docker-compose) ----------
const SERVER_URL = process.env.ACTUAL_SERVER_URL;
const PASSWORD   = process.env.ACTUAL_PASSWORD;
const SYNC_ID    = process.env.ACTUAL_SYNC_ID || '';
const BUDGET_NAME= process.env.ACTUAL_BUDGET_NAME || '';
const E2E_PASSWORD = process.env.ACTUAL_E2E_PASSWORD || ''; // mot de passe de chiffrement (budget end-to-end encrypted)
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT       = process.env.PORT || 3000;
let ALIASES = {};
try { if (process.env.ACTUAL_ALIASES) ALIASES = JSON.parse(process.env.ACTUAL_ALIASES); } catch {}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================ parseur Sumeria ============================
const YEAR_RE = /Du\s+\d{1,2}\/\d{1,2}\/(\d{4})/;
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(s).toLowerCase().trim().replace(/\s+/g, ' ');
const accountKey = (name) => norm(name).replace(/^(sum|bnp)\s+/, '');

function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
function toCents(s) {
  if (s == null) return null;
  const t = String(s).replace(/\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.');
  if (t === '' || t === '-') return null;
  const v = parseFloat(t); return isNaN(v) ? null : Math.round(v * 100);
}
function toISO(dstr, year) {
  const m = String(dstr).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
  let yy = m[3] || year; if (yy && yy.length === 2) yy = '20' + yy;
  return yy ? `${yy}-${mm}-${dd}` : null;
}
function parseSumeria(text) {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  let account = null;
  for (let k = 0; k < Math.min(rawLines.length, 8); k++) {
    if (/^Nom du compte,/i.test(rawLines[k])) { account = rawLines[k].slice(rawLines[k].indexOf(',') + 1).trim().replace(/^"|"$/g, ''); break; }
  }
  const my = text.match(YEAR_RE); const year = my ? my[1] : null;
  let headerIdx = -1;
  for (let k = 0; k < rawLines.length; k++) { if (/Débit/i.test(rawLines[k])) { headerIdx = k; break; } }
  if (headerIdx < 0) return { account, transactions: [] };
  const rows = parseCSV(rawLines.slice(headerIdx + 1).join('\n')).filter(r => r.length >= 4 && r.some(x => x.trim() !== ''));
  const transactions = [];
  for (const r of rows) {
    const n = r.length;
    const iso = toISO(r[0], year); if (!iso) continue;
    const debit = toCents(r[n - 3]), credit = toCents(r[n - 2]);
    let amount = null;
    if (debit != null) amount = -Math.abs(debit); else if (credit != null) amount = Math.abs(credit); else continue;
    let dcount = 0; while (dcount < n && /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(String(r[dcount]).trim())) dcount++;
    const desc = r.slice(dcount, n - 3).join(' ').replace(/\s*\n\s*/g, '\n').trim();
    const descLines = desc.split('\n').map(x => x.trim()).filter(Boolean);
    const notes = descLines.join(' | ') || null;   // libelle+refs dans Notes, beneficiaire vide
    const refInt = desc.match(/interne\s*:\s*([0-9a-fA-F-]{8,})/);
    transactions.push({ date: iso, amount, notes, imported_id: refInt ? refInt[1] : undefined, cleared: true });
  }
  return { account, transactions };
}

// ============================ connexion Actual ============================
let initialized = false, busy = false;
async function ensureInit() {
  if (initialized) return;
  if (!SERVER_URL || !PASSWORD) throw new Error("ACTUAL_SERVER_URL / ACTUAL_PASSWORD manquants (docker-compose).");
  await api.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD });
  initialized = true;
}
async function resolveSyncId(budgets) {
  if (SYNC_ID) return SYNC_ID;
  const b = budgets.find(x => norm(x.name) === norm(BUDGET_NAME));
  if (!b) throw new Error(`Budget "${BUDGET_NAME}" introuvable et ACTUAL_SYNC_ID vide.`);
  return b.groupId || b.cloudFileId || b.id;
}
async function openBudget() {
  await ensureInit();
  const budgets = await api.getBudgets();
  const syncId = await resolveSyncId(budgets);
  await api.downloadBudget(syncId, E2E_PASSWORD ? { password: E2E_PASSWORD } : undefined);
  return { budgets, syncId };
}
function findAccount(accounts, sumName) {
  if (ALIASES[sumName]) { const t = accountKey(ALIASES[sumName]); const a = accounts.find(a => accountKey(a.name) === t); if (a) return a; }
  const key = accountKey(sumName);
  return accounts.find(a => { const k = accountKey(a.name); return k === key || k === key + 's' || k + 's' === key; });
}

// ============================ serveur web ============================
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (_req, res) => {
  try {
    const { budgets, syncId } = await openBudget();
    let version = null;
    try { const v = await api.getServerVersion(); version = (v && typeof v === 'object') ? (v.version || JSON.stringify(v)) : v; } catch {}
    const accounts = await api.getAccounts();
    res.json({ ok: true, serverVersion: version, syncId,
      budgets: budgets.map(b => b.name),
      accounts: accounts.filter(a => !a.closed).map(a => a.name) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

app.post('/api/run', upload.array('files'), async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: "Un traitement est deja en cours." });
  const dryRun = req.body.dryRun !== 'false';
  const replaceExisting = req.body.replaceExisting === 'true';
  busy = true;
  try {
    // 1) parse des fichiers
    const parsed = [];
    for (const f of (req.files || [])) {
      // multer decode le nom en latin1 -> reconvertir en UTF-8 pour les accents
      const fname = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const text = f.buffer.toString('utf8');
      if (!/Nom du compte,/i.test(text)) { parsed.push({ file: fname, skipped: 'pas un releve Sumeria' }); continue; }
      const p = parseSumeria(text);
      if (!p.account) { parsed.push({ file: fname, skipped: 'compte introuvable (ligne 2)' }); continue; }
      if (!p.transactions.length) { parsed.push({ file: fname, skipped: '0 operation' }); continue; }
      parsed.push({ file: fname, account: p.account, transactions: p.transactions });
    }
    if (!parsed.some(p => p.transactions)) { busy = false; return res.json({ ok: true, dryRun, results: parsed.map(p => ({ ...p, transactions: undefined })) }); }

    // 2) connexion + mapping
    await openBudget();
    const accounts = await api.getAccounts();

    const results = [];
    for (const p of parsed) {
      if (!p.transactions) { results.push({ file: p.file, skipped: p.skipped }); continue; }
      const acc = findAccount(accounts, p.account);
      if (!acc) { results.push({ file: p.file, account: p.account, count: p.transactions.length, matched: false }); continue; }
      const base = { file: p.file, account: p.account, mapped: acc.name, count: p.transactions.length, matched: true,
        sample: p.transactions.slice(0, 3).map(t => `${t.date}  ${(t.amount / 100).toFixed(2)}€  ${(t.notes || '').slice(0, 40)}`) };
      if (dryRun) { results.push(base); continue; }
      if (replaceExisting) {
        const ids = new Set(p.transactions.map(t => t.imported_id).filter(Boolean));
        const dates = p.transactions.map(t => t.date).sort();
        const existing = await api.getTransactions(acc.id, dates[0], dates[dates.length - 1]);
        let del = 0; for (const t of existing) if (t.imported_id && ids.has(t.imported_id)) { await api.deleteTransaction(t.id); del++; }
        base.deleted = del;
      }
      const r = await api.importTransactions(acc.id, p.transactions);
      base.added = r.added?.length ?? 0; base.updated = r.updated?.length ?? 0;
      results.push(base);
    }
    if (!dryRun) await api.sync();
    res.json({ ok: true, dryRun, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally { busy = false; }
});

app.listen(PORT, () => console.log(`Sumeria->Actual web sur le port ${PORT}`));
