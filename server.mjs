// ============================================================================
//  Sumeria -> Actual : interface web d'import + comptes utilisateurs + reglages
//  - login/mot de passe (SQLite, mot de passe hashe scrypt, session cookie)
//  - reglages Actual editables dans l'UI (stockes en base, defaut = env)
//  - upload de releves Sumeria -> parse -> preview / import via l'API Actual
// ============================================================================
import express from 'express';
import multer from 'multer';
import * as api from '@actual-app/api';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = process.env.PORT || 3000;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================ base de donnees ============================
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created TEXT
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );
`);
// Reglages PAR UTILISATEUR : chacun a sa propre config Actual (budget isole).
const getSetting = (uid, k, def = '') => { const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, k); return r ? r.value : def; };
const setSetting = (uid, k, v) => db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(uid, k, String(v ?? ''));
const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;

function cfg(uid) {
  let aliases = {}; try { aliases = JSON.parse(getSetting(uid, 'aliases', '{}')); } catch {}
  return {
    serverURL: getSetting(uid, 'serverURL'), password: getSetting(uid, 'password'),
    syncId: getSetting(uid, 'syncId'), budgetName: getSetting(uid, 'budgetName'),
    e2ePassword: getSetting(uid, 'e2ePassword'), aliases,
  };
}
// Migration : anciens reglages GLOBAUX (table settings) -> config du 1er admin
try {
  const hasOld = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (hasOld) {
    const admin = db.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get();
    const oldRows = db.prepare('SELECT key,value FROM settings').all();
    if (admin && oldRows.length) {
      const already = db.prepare('SELECT COUNT(*) c FROM user_settings WHERE user_id=?').get(admin.id).c;
      if (!already) for (const r of oldRows) setSetting(admin.id, r.key, r.value);
    }
    db.exec('DROP TABLE settings');
  }
} catch {}

// Pre-remplit la config d'un utilisateur depuis les variables d'env (defaut au 1er admin)
function seedUserFromEnv(uid) {
  if (!process.env.ACTUAL_SERVER_URL) return;
  setSetting(uid, 'serverURL', process.env.ACTUAL_SERVER_URL);
  setSetting(uid, 'password', process.env.ACTUAL_PASSWORD || '');
  setSetting(uid, 'syncId', process.env.ACTUAL_SYNC_ID || '');
  setSetting(uid, 'budgetName', process.env.ACTUAL_BUDGET_NAME || '');
  setSetting(uid, 'e2ePassword', process.env.ACTUAL_E2E_PASSWORD || '');
  setSetting(uid, 'aliases', process.env.ACTUAL_ALIASES || '{}');
}

// ============================ auth ============================
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const dk = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(dk, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}
const sessions = new Map(); // token -> { userId, username, isAdmin, exp }
const SESSION_MS = 7 * 24 * 3600 * 1000;
function newSession(u) {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, { userId: u.id, username: u.username, isAdmin: !!u.is_admin, exp: Date.now() + SESSION_MS });
  return t;
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionOf(req) {
  const t = getCookie(req, 'sid'); if (!t) return null;
  const s = sessions.get(t); if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return { token: t, ...s };
}
function requireAuth(req, res, next) { const s = sessionOf(req); if (!s) return res.status(401).json({ ok: false, error: 'non authentifie' }); req.user = s; next(); }
function requireAdmin(req, res, next) { if (!req.user?.isAdmin) return res.status(403).json({ ok: false, error: 'admin requis' }); next(); }

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
function extractPayee(firstLine) {
  let s = String(firstLine || '').replace(/\s+/g, ' ').trim();
  let m;
  if ((m = s.match(/(?:Paiement|Transaction)\s+carte\b[^:]*:\s*(.+)$/i))) s = m[1];
  else if ((m = s.match(/Remboursement\s+de\s+(.+?)\s+sur\s+carte\b/i))) s = m[1];
  else if ((m = s.match(/Virement\s+SEPA\s+re[çc]u\s+de\s+(.+)$/i))) s = m[1].replace(/\s+pour\s.*$/i, '');
  else if ((m = s.match(/Virement\s+interne\s+\S+\s*-\s*(.+)$/i))) s = m[1].replace(/\s*\(.*\)\s*$/, '');
  else return null;
  s = s.replace(/\s+\d{3,}$/, '').replace(/\s+/g, ' ').trim();
  return s || null;
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
    const notes = descLines.join(' | ') || null;
    const payee = extractPayee(descLines[0]);
    const refInt = desc.match(/interne\s*:\s*([0-9a-fA-F-]{8,})/);
    const tx = { date: iso, amount, notes, imported_id: refInt ? refInt[1] : undefined, cleared: true };
    if (payee) tx.payee_name = payee;
    transactions.push(tx);
  }
  return { account, transactions };
}

// ---- OFX (BNP et autres banques) ----
const decodeEntities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
function extractPayeeBNP(name, memo) {
  const n = (name || '').trim();
  if (/FACTURE CARTE/i.test(n)) {
    const m = memo.match(/DU\s+\d{6}\s+(.+?)\s+CARTE\b/i);
    if (m) return (m[1].split(/\s{2,}/)[0].replace(/\s+/g, ' ').trim()) || n;
    return n;
  }
  return n || null;
}
function parseOFX(text) {
  const account = (text.match(/<ACCTID>([^<\r\n]+)/i) || [])[1]?.trim() || null;
  const balM = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)/i) || text.match(/<BALAMT>([^<\r\n]+)/i);
  const balance = balM ? Math.round(parseFloat(balM[1].replace(',', '.')) * 100) : null;
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const transactions = [];
  for (const b of blocks) {
    const g = (t) => { const m = b.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    const dt = g('DTPOSTED');
    const iso = dt.length >= 8 ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : null;
    if (!iso) continue;
    const amt = parseFloat(g('TRNAMT').replace(',', '.'));
    if (isNaN(amt)) continue;
    const name = decodeEntities(g('NAME')), memo = decodeEntities(g('MEMO'));
    const payee = extractPayeeBNP(name, memo);
    const notes = [name, memo].filter(Boolean).join(' — ') || null;
    const tx = { date: iso, amount: Math.round(amt * 100), notes, imported_id: g('FITID') || undefined, cleared: true };
    if (payee) tx.payee_name = payee;
    transactions.push(tx);
  }
  return { account, balance, transactions };
}

// Regles de demarrage : [mot-cle dans les Notes, nom de categorie]
const SEED_RULES = [
  ['CARREFOUR', 'Alimentation'], ['MONOPRIX', 'Alimentation'], ['FRANPRIX', 'Alimentation'],
  ['LIDL', 'Alimentation'], ['AUCHAN', 'Alimentation'], ['INTERMARCHE', 'Alimentation'], ['BOULANGERIE', 'Alimentation'],
  ['MCDO', 'Restaurants'], ['MCDONALD', 'Restaurants'], ['DELIVEROO', 'Restaurants'], ['UBER EATS', 'Restaurants'],
  ['SUSHI', 'Restaurants'], ['SWILE', 'Restaurants'], ['BURGER', 'Restaurants'],
  ['PATHE', 'Sorties'], ['CINE', 'Sorties'], ['ACHATBILLETCINE', 'Sorties'],
  ['AMAZON', 'Shopping / Vêtements'], ['VINTED', 'Shopping / Vêtements'], ['ZALANDO', 'Shopping / Vêtements'], ['ACTION', 'Shopping / Vêtements'],
  ['APPLE.COM', 'Abonnements'], ['NETFLIX', 'Abonnements'], ['SPOTIFY', 'Abonnements'], ['YOUTUBE', 'Abonnements'],
  ['SNCF', 'Transport'], ['TOTAL', 'Transport'], ['ESSO', 'Transport'], ['CARBURANT', 'Transport'], ['UBER ', 'Transport'],
  ['PHARMACIE', 'Santé'],
];

// ============================ connexion Actual ============================
let initialized = false, initedWith = null, busy = false;
async function ensureInit(uid) {
  const c = cfg(uid);
  if (!c.serverURL || !c.password) throw new Error("Reglages manquants : renseigne l'URL et le mot de passe du serveur Actual dans tes Parametres.");
  const key = c.serverURL + '|' + c.password;
  if (initialized && initedWith === key) return;
  if (initialized) { try { await api.shutdown(); } catch {} initialized = false; }
  await api.init({ dataDir: DATA_DIR, serverURL: c.serverURL, password: c.password });
  initialized = true; initedWith = key;
}
async function openBudget(uid) {
  await ensureInit(uid);
  const c = cfg(uid);
  const budgets = await api.getBudgets();
  let syncId = c.syncId;
  if (!syncId) {
    if (!c.budgetName) throw new Error("Aucun budget cible : renseigne l'ID de synchronisation (ou le nom de budget) dans tes Parametres.");
    const b = budgets.find(x => norm(x.name) === norm(c.budgetName));
    if (!b) throw new Error(`Budget "${c.budgetName}" introuvable et ID de synchro vide.`);
    syncId = b.groupId || b.cloudFileId || b.id;
  }
  const dl = await api.downloadBudget(syncId, c.e2ePassword ? { password: c.e2ePassword } : undefined);
  if (dl && dl.error) {
    const msg = String(dl.error);
    if (/key|decrypt/i.test(msg)) throw new Error("Budget chiffre : renseigne le mot de passe de chiffrement (Parametres).");
    throw new Error('Ouverture du budget impossible : ' + msg);
  }
  return { budgets, syncId };
}
function findAccount(accounts, sumName, aliases) {
  if (aliases[sumName]) { const t = accountKey(aliases[sumName]); const a = accounts.find(a => accountKey(a.name) === t); if (a) return a; }
  const key = accountKey(sumName);
  return accounts.find(a => { const k = accountKey(a.name); return k === key || k === key + 's' || k + 's' === key; });
}

// ============================ serveur web ============================
const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- Auth : setup / login / logout / me ---
app.get('/api/needs-setup', (_req, res) => res.json({ needsSetup: userCount() === 0 }));

app.post('/api/setup', (req, res) => {
  if (userCount() > 0) return res.status(403).json({ ok: false, error: 'Deja configure.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) return res.status(400).json({ ok: false, error: 'Identifiant requis, mot de passe >= 6 caracteres.' });
  const info = db.prepare('INSERT INTO users(username,pass_hash,is_admin,created) VALUES(?,?,1,?)').run(username, hashPassword(password), new Date().toISOString());
  const uid = Number(info.lastInsertRowid);
  seedUserFromEnv(uid); // pre-remplit la config du 1er admin depuis les variables d'env
  const token = newSession({ id: uid, username, is_admin: 1 });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true, username, isAdmin: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  if (!u || !verifyPassword(String(password || ''), u.pass_hash)) return res.status(401).json({ ok: false, error: 'Identifiant ou mot de passe incorrect.' });
  const token = newSession(u);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true, username: u.username, isAdmin: !!u.is_admin });
});

app.post('/api/logout', (req, res) => {
  const s = sessionOf(req); if (s) sessions.delete(s.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, username: req.user.username, isAdmin: req.user.isAdmin }));

// Changer son propre mot de passe
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, error: 'Nouveau mot de passe : 6 caracteres minimum.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!u || !verifyPassword(String(currentPassword || ''), u.pass_hash)) return res.status(401).json({ ok: false, error: 'Mot de passe actuel incorrect.' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(newPassword), u.id);
  res.json({ ok: true });
});

// --- Gestion des utilisateurs (admin) ---
app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT id,username,is_admin,created FROM users ORDER BY id').all() });
});
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password || password.length < 6) return res.status(400).json({ ok: false, error: 'Identifiant requis, mot de passe >= 6 caracteres.' });
  try {
    db.prepare('INSERT INTO users(username,pass_hash,is_admin,created) VALUES(?,?,?,?)').run(username, hashPassword(password), isAdmin ? 1 : 0, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: /UNIQUE/.test(String(e)) ? 'Cet identifiant existe deja.' : String(e.message || e) }); }
});
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.userId) return res.status(400).json({ ok: false, error: 'Impossible de te supprimer toi-meme.' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// --- Reglages PAR UTILISATEUR (chacun sa config Actual) ---
app.get('/api/settings', requireAuth, (req, res) => {
  const c = cfg(req.user.userId);
  res.json({
    ok: true,
    serverURL: c.serverURL, syncId: c.syncId, budgetName: c.budgetName,
    aliases: JSON.stringify(c.aliases),
    hasPassword: !!c.password, hasE2e: !!c.e2ePassword,   // secrets non renvoyes
  });
});
app.post('/api/settings', requireAuth, (req, res) => {
  const uid = req.user.userId;
  const b = req.body || {};
  if (b.serverURL !== undefined) setSetting(uid, 'serverURL', b.serverURL.trim());
  if (b.syncId !== undefined) setSetting(uid, 'syncId', b.syncId.trim());
  if (b.budgetName !== undefined) setSetting(uid, 'budgetName', b.budgetName.trim());
  if (b.aliases !== undefined) { try { JSON.parse(b.aliases || '{}'); setSetting(uid, 'aliases', b.aliases || '{}'); } catch { return res.status(400).json({ ok: false, error: 'Aliases : JSON invalide.' }); } }
  if (b.password) setSetting(uid, 'password', b.password);
  if (b.e2ePassword) setSetting(uid, 'e2ePassword', b.e2ePassword);
  if (b.clearE2e) setSetting(uid, 'e2ePassword', '');
  initedWith = null; // force une reconnexion avec les nouveaux reglages
  res.json({ ok: true });
});

// --- Creer un compte Actual (avec solde) pour un compte de fichier non connu ---
app.post('/api/create-account', requireAuth, async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: 'Un traitement est deja en cours.' });
  const { acctid, name, balance, offbudget } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: 'Nom de compte requis.' });
  busy = true;
  try {
    await openBudget(req.user.userId);
    const id = await api.createAccount({ name: String(name).trim(), offbudget: !!offbudget }, Number.isFinite(balance) ? Math.round(balance) : 0);
    if (acctid) { // enregistre la correspondance acctid -> nom pour les prochains imports
      const uid = req.user.userId;
      let aliases = {}; try { aliases = JSON.parse(getSetting(uid, 'aliases', '{}')); } catch {}
      aliases[String(acctid)] = String(name).trim();
      setSetting(uid, 'aliases', JSON.stringify(aliases));
    }
    await api.sync();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

// --- Actual : statut / import / regles (auth) ---
app.get('/api/status', requireAuth, async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: 'Un traitement est deja en cours.' });
  busy = true;
  try {
    const { budgets, syncId } = await openBudget(req.user.userId);
    let version = null;
    try { const v = await api.getServerVersion(); version = (v && typeof v === 'object') ? (v.version || JSON.stringify(v)) : v; } catch {}
    const accounts = await api.getAccounts();
    res.json({ ok: true, serverVersion: version, syncId, budgets: budgets.map(b => b.name), accounts: accounts.filter(a => !a.closed).map(a => a.name) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

app.post('/api/run', requireAuth, upload.array('files'), async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: 'Un traitement est deja en cours.' });
  const dryRun = req.body.dryRun !== 'false';
  const replaceExisting = req.body.replaceExisting === 'true';
  busy = true;
  try {
    const parsed = [];
    for (const f of (req.files || [])) {
      const fname = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const text = f.buffer.toString('utf8');
      let p, kind;
      if (/<OFX>|<STMTTRN>/i.test(text)) { p = parseOFX(text); kind = 'OFX'; }
      else if (/Nom du compte,/i.test(text)) { p = parseSumeria(text); kind = 'Sumeria'; }
      else { parsed.push({ file: fname, skipped: 'format non reconnu (ni CSV Sumeria ni OFX)' }); continue; }
      if (!p.account) { parsed.push({ file: fname, skipped: kind === 'OFX' ? 'compte OFX introuvable (ACCTID)' : 'compte introuvable (ligne 2)' }); continue; }
      if (!p.transactions.length) { parsed.push({ file: fname, skipped: '0 operation' }); continue; }
      parsed.push({ file: fname, account: p.account, balance: p.balance ?? null, transactions: p.transactions });
    }
    if (!parsed.some(p => p.transactions)) { busy = false; return res.json({ ok: true, dryRun, results: parsed.map(p => ({ file: p.file, skipped: p.skipped })) }); }

    await openBudget(req.user.userId);
    const accounts = await api.getAccounts();
    const aliases = cfg(req.user.userId).aliases;
    const results = [];
    for (const p of parsed) {
      if (!p.transactions) { results.push({ file: p.file, skipped: p.skipped }); continue; }
      const acc = findAccount(accounts, p.account, aliases);
      if (!acc) { results.push({ file: p.file, account: p.account, count: p.transactions.length, matched: false, balance: p.balance ?? null, last4: p.account ? String(p.account).slice(-4) : null }); continue; }
      const base = { file: p.file, account: p.account, mapped: acc.name, count: p.transactions.length, matched: true,
        sample: p.transactions.slice(0, 3).map(t => `${t.date}  ${(t.amount / 100).toFixed(2)}€  ${t.payee_name || '(sans bénéficiaire)'}`) };
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
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

app.post('/api/seed-rules', requireAuth, async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: 'Un traitement est deja en cours.' });
  busy = true;
  try {
    await openBudget(req.user.userId);
    const cats = await api.getCategories();
    const catByName = new Map(cats.map(c => [norm(c.name), c.id]));
    const rules = await api.getRules();
    const existing = new Set();
    for (const r of rules) for (const c of (r.conditions || [])) if (c.field === 'notes' && c.op === 'contains') existing.add(String(c.value).toLowerCase());
    let created = 0, skipped = 0; const missing = new Set(); const done = [];
    for (const [kw, catName] of SEED_RULES) {
      const catId = catByName.get(norm(catName));
      if (!catId) { missing.add(catName); continue; }
      if (existing.has(kw.toLowerCase().trim())) { skipped++; continue; }
      await api.createRule({ stage: 'pre', conditionsOp: 'and', conditions: [{ field: 'notes', op: 'contains', value: kw }], actions: [{ field: 'category', op: 'set', value: catId }] });
      created++; done.push(`${kw.trim()} → ${catName}`);
    }
    await api.sync();
    res.json({ ok: true, created, skipped, missingCategories: [...missing], done });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Sumeria->Actual web sur le port ${PORT}`));
