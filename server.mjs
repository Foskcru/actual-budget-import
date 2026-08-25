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
const SECURE_COOKIE = /^(1|true|yes)$/i.test((process.env.COOKIE_SECURE || '').trim().replace(/^["']|["']$/g, '')); // mettre true derriere HTTPS
const LOCK_MAX = 8;                       // echecs avant blocage
const LOCK_MS = 24 * 3600 * 1000;         // duree du blocage : 1 jour
const NTFY_URL = (process.env.NTFY_URL || '').trim();   // ex https://ntfy.mon-nas/actual-alertes
const NTFY_TOKEN = (process.env.NTFY_TOKEN || '').trim();
fs.mkdirSync(DATA_DIR, { recursive: true });

// Chiffrement au repos des secrets (M3) : cle depuis APP_SECRET (hors volume /data).
// Sans APP_SECRET -> stockage en clair (retro-compatible), avec avertissement.
const SECRET_KEY = process.env.APP_SECRET ? crypto.createHash('sha256').update(process.env.APP_SECRET).digest() : null;
if (!SECRET_KEY) console.warn('[secu] APP_SECRET absent : les mots de passe Actual sont stockes en clair. Definis APP_SECRET pour les chiffrer.');
function encSecret(plain) {
  if (!SECRET_KEY || plain == null || plain === '') return plain ?? '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decSecret(stored) {
  if (!stored || !String(stored).startsWith('enc:v1:')) return stored || ''; // clair (legacy)
  if (!SECRET_KEY) return ''; // chiffre mais plus de cle -> illisible
  try {
    const raw = Buffer.from(String(stored).slice(7), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return ''; }
}

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
  CREATE TABLE IF NOT EXISTS login_locks (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL DEFAULT 0,
    username TEXT, ip TEXT, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS app_config ( key TEXT PRIMARY KEY, value TEXT );
`);
// Colonne "disabled" (compte desactive par un admin) : ajout si absente
try { db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0'); } catch {}
// Soupape de secours : RESET_LOCKS=true efface tous les blocages au demarrage
// (utile si l'unique admin se verrouille lui-meme). A retirer apres usage.
if (/^(1|true|yes)$/i.test((process.env.RESET_LOCKS || '').trim().replace(/^["']|["']$/g, ''))) {
  try { db.exec('DELETE FROM login_locks'); console.warn('[secu] RESET_LOCKS actif : tous les blocages de connexion ont ete effaces.'); } catch {}
}
// Reglages PAR UTILISATEUR : chacun a sa propre config Actual (budget isole).
const getSetting = (uid, k, def = '') => { const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, k); return r ? r.value : def; };
const setSetting = (uid, k, v) => db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(uid, k, String(v ?? ''));
const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
// Config globale de l'app (ntfy...) editable par l'admin
const getApp = (k, def = '') => { const r = db.prepare('SELECT value FROM app_config WHERE key=?').get(k); return r ? r.value : def; };
const setApp = (k, v) => db.prepare('INSERT INTO app_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? ''));
const DEFAULT_NTFY_TPL = 'Compte "{account}" bloque apres {max} echecs de connexion.\nIP : {ip}\nBlocage 24 h (ou deblocage par un admin).';
// Pre-remplit la config ntfy depuis les variables d'env au 1er demarrage
if (!getApp('ntfyUrl') && NTFY_URL) setApp('ntfyUrl', NTFY_URL);
if (!getApp('ntfyToken') && NTFY_TOKEN) setApp('ntfyToken', encSecret(NTFY_TOKEN));
if (!getApp('ntfyTemplate')) setApp('ntfyTemplate', DEFAULT_NTFY_TPL);
// Secrets (mot de passe serveur / chiffrement) : chiffres au repos
const getSecret = (uid, k) => decSecret(getSetting(uid, k));
const setSecret = (uid, k, v) => setSetting(uid, k, encSecret(v));

function cfg(uid) {
  let aliases = {}; try { aliases = JSON.parse(getSetting(uid, 'aliases', '{}')); } catch {}
  return {
    serverURL: getSetting(uid, 'serverURL'), password: getSecret(uid, 'password'),
    syncId: getSetting(uid, 'syncId'), budgetName: getSetting(uid, 'budgetName'),
    e2ePassword: getSecret(uid, 'e2ePassword'), aliases,
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
  setSecret(uid, 'password', process.env.ACTUAL_PASSWORD || '');
  setSetting(uid, 'syncId', process.env.ACTUAL_SYNC_ID || '');
  setSetting(uid, 'budgetName', process.env.ACTUAL_BUDGET_NAME || '');
  setSecret(uid, 'e2ePassword', process.env.ACTUAL_E2E_PASSWORD || '');
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
// Purge periodique des sessions expirees (F6) + verrous de connexion expires
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  try { db.prepare('DELETE FROM login_locks WHERE reset_at < ?').run(now); } catch {}
}, 3600 * 1000).unref?.();
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

// Hash bidon pour un temps de reponse constant meme si l'identifiant n'existe pas (F1)
const DUMMY_HASH = hashPassword('timing-dummy-please-ignore');
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `sid=; HttpOnly; Path=/; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
}
// Rate-limiting PERSISTANT (M2) : par identifiant ET par IP, survit au redemarrage, blocage 24 h
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'; }
function rlKeys(req, username) { return ['u:' + String(username || '').toLowerCase(), 'ip:' + clientIp(req)]; }
function rlBlocked(keys) {
  const now = Date.now();
  return keys.some(k => { const e = db.prepare('SELECT count,reset_at FROM login_locks WHERE key=?').get(k); return e && e.reset_at > now && e.count >= LOCK_MAX; });
}
// incremente les compteurs ; retourne true si le seuil vient d'etre atteint (transition -> bloque)
function rlFail(keys, username, ip) {
  const now = Date.now(); let became = false;
  for (const k of keys) {
    const e = db.prepare('SELECT count,reset_at FROM login_locks WHERE key=?').get(k);
    const count = (!e || e.reset_at < now) ? 1 : e.count + 1;
    db.prepare('INSERT INTO login_locks(key,count,reset_at,username,ip,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at,username=excluded.username,ip=excluded.ip,updated=excluded.updated')
      .run(k, count, now + LOCK_MS, username, ip, now);
    if (count === LOCK_MAX) became = true;
  }
  return became;
}
function rlReset(keys) { for (const k of keys) db.prepare('DELETE FROM login_locks WHERE key=?').run(k); }
// Config + envoi ntfy (editable dans l'UI admin)
function ntfyConf() {
  return { url: getApp('ntfyUrl', ''), token: decSecret(getApp('ntfyToken', '')), template: getApp('ntfyTemplate', DEFAULT_NTFY_TPL) };
}
function renderTpl(tpl, username, ip) {
  return String(tpl || '').replace(/\{account\}/g, username || '?').replace(/\{ip\}/g, ip || '?').replace(/\{max\}/g, String(LOCK_MAX));
}
async function sendNtfy(title, body) {
  const c = ntfyConf();
  if (!c.url) return { ok: false, error: 'URL ntfy non configuree.' };
  try {
    const r = await fetch(c.url, { method: 'POST', headers: { 'Title': title, 'Priority': 'high', 'Tags': 'warning,lock', ...(c.token ? { 'Authorization': 'Bearer ' + c.token } : {}) }, body });
    if (!r.ok) return { ok: false, error: 'ntfy a repondu HTTP ' + r.status };
    return { ok: true };
  } catch (e) { console.error('[ntfy]', e?.message || e); return { ok: false, error: String(e?.message || e) }; }
}
// Alerte ntfy quand un compte se bloque (compte + IP)
async function notifyLock(username, ip) {
  if (!ntfyConf().url) return;
  await sendNtfy('Actual Import : compte bloque', renderTpl(ntfyConf().template, username, ip));
}

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

// ---- QIF (Societe Generale et autres) ----
function extractPayeeSG(N, P, M) {
  const m = String(M || ''); let mm;
  if ((mm = m.match(/CARTE\s+\S+\s+\d{2}\/\d{2}\s+(.+?)\s+\d{6,}\w*\s*$/i))) return mm[1].replace(/\s+/g, ' ').trim();
  const cleaned = m.replace(/\s+\d{6,}\w*\s*$/, '').trim();
  return cleaned || String(P || '').trim() || String(N || '').trim() || null;
}
function parseQIF(text) {
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const transactions = [];
  for (const blk of norm.split(/\n\^/)) {
    let date = null, amount = null, N = '', P = '', M = '';
    for (const ln of blk.split('\n')) {
      const s = ln.trim(); if (!s || s[0] === '!') continue;
      const t = s[0], v = s.slice(1);
      if (t === 'D') date = v; else if (t === 'T') amount = v;
      else if (t === 'N') N = v; else if (t === 'P') P = v; else if (t === 'M') M = v;
    }
    if (!date || amount == null) continue;
    const iso = toISO(date, null); if (!iso) continue;
    const cents = toCents(amount); if (cents == null) continue;
    const payee = extractPayeeSG(N, P, M);
    const imported_id = 'sg-' + crypto.createHash('sha1').update(iso + '|' + cents + '|' + (M || P || '')).digest('hex').slice(0, 20);
    const tx = { date: iso, amount: cents, notes: (M || P) || null, imported_id, cleared: true };
    if (payee) tx.payee_name = payee;
    transactions.push(tx);
  }
  return { transactions };
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
// Regroupe par categorie : { 'Alimentation': ['CARREFOUR', ...], ... } -> 1 regle OR par categorie
const SEED_BY_CAT = {};
for (const [kw, cat] of SEED_RULES) { (SEED_BY_CAT[cat] ||= []).push(kw); }
const SEED_KW = new Set(SEED_RULES.map(([kw]) => kw.toLowerCase().trim()));

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
// Construit un "matcher" a partir des regles Actual (conditions notes-contains -> set category).
// Permet d'assigner la categorie DIRECTEMENT a l'import (independant du moteur de regles).
async function buildCategoryMatcher() {
  let rules = [], cats = [];
  try { rules = await api.getRules(); cats = await api.getCategories(); } catch { return () => null; }
  const validIds = new Set(cats.map(c => c.id));
  const matchers = [];
  for (const r of rules) {
    const setCat = (r.actions || []).find(a => a.field === 'category' && a.op === 'set');
    if (!setCat || !validIds.has(setCat.value)) continue; // ignore les regles pointant une categorie inexistante
    const notesConds = (r.conditions || []).filter(c => c.field === 'notes' && c.op === 'contains');
    if (!notesConds.length) continue;
    matchers.push({ op: r.conditionsOp || 'and', kws: notesConds.map(c => String(c.value).toLowerCase()), catId: setCat.value });
  }
  const fn = (notes) => {
    const n = String(notes || '').toLowerCase();
    for (const m of matchers) {
      const hit = m.op === 'and' ? m.kws.every(k => n.includes(k)) : m.kws.some(k => n.includes(k));
      if (hit) return m.catId;
    }
    return null;
  };
  fn.count = matchers.length;
  fn.rulesTotal = rules.length;
  fn.catsTotal = cats.length;
  return fn;
}

// ============================ serveur web ============================
const app = express();
// En-tetes de securite (M5)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (SECURE_COOKIE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json());
// Uploads en memoire : 10 Mo/fichier, 30 fichiers max (M6)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 30 } });

// --- Auth : setup / login / logout / me ---
app.get('/api/needs-setup', (_req, res) => res.json({ needsSetup: userCount() === 0 }));

app.post('/api/setup', (req, res) => {
  if (userCount() > 0) return res.status(403).json({ ok: false, error: 'Deja configure.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 10) return res.status(400).json({ ok: false, error: 'Identifiant requis, mot de passe >= 10 caracteres.' });
  const info = db.prepare('INSERT INTO users(username,pass_hash,is_admin,created) VALUES(?,?,1,?)').run(username, hashPassword(password), new Date().toISOString());
  const uid = Number(info.lastInsertRowid);
  seedUserFromEnv(uid); // pre-remplit la config du 1er admin depuis les variables d'env
  const token = newSession({ id: uid, username, is_admin: 1 });
  setSessionCookie(res, token);
  res.json({ ok: true, username, isAdmin: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = clientIp(req);
  const keys = rlKeys(req, username);
  if (rlBlocked(keys)) return res.status(429).json({ ok: false, error: 'Compte temporairement bloque (trop de tentatives). Contacte un administrateur.' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  if (u && u.disabled) return res.status(403).json({ ok: false, error: 'Compte desactive. Contacte un administrateur.' });
  // scrypt s'execute toujours (vrai hash ou hash bidon) -> pas d'enumeration par timing
  const ok = u ? verifyPassword(String(password || ''), u.pass_hash) : (verifyPassword(String(password || ''), DUMMY_HASH) && false);
  if (!u || !ok) {
    const became = rlFail(keys, String(username || ''), ip);
    if (became) notifyLock(String(username || ''), ip); // alerte ntfy (fire-and-forget)
    return res.status(401).json({ ok: false, error: 'Identifiant ou mot de passe incorrect.' });
  }
  rlReset(keys);
  const token = newSession(u);
  setSessionCookie(res, token);
  res.json({ ok: true, username: u.username, isAdmin: !!u.is_admin });
});

app.post('/api/logout', (req, res) => {
  const s = sessionOf(req); if (s) sessions.delete(s.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, username: req.user.username, isAdmin: req.user.isAdmin }));

// Changer son propre mot de passe
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 10) return res.status(400).json({ ok: false, error: 'Nouveau mot de passe : 10 caracteres minimum.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!u || !verifyPassword(String(currentPassword || ''), u.pass_hash)) return res.status(401).json({ ok: false, error: 'Mot de passe actuel incorrect.' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(newPassword), u.id);
  res.json({ ok: true });
});

// --- Gestion des utilisateurs (admin) ---
app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT id,username,is_admin,disabled,created FROM users ORDER BY id').all() });
});
// Activer / desactiver un compte indefiniment (admin)
app.post('/api/users/:id/disabled', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const disabled = req.body?.disabled ? 1 : 0;
  if (id === req.user.userId && disabled) return res.status(400).json({ ok: false, error: 'Impossible de te desactiver toi-meme.' });
  db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled, id);
  if (disabled) for (const [t, s] of sessions) if (s.userId === id) sessions.delete(t); // coupe ses sessions
  res.json({ ok: true });
});
// Connexions bloquees : lister / debloquer (admin)
app.get('/api/locks', requireAuth, requireAdmin, (_req, res) => {
  const now = Date.now();
  const locks = db.prepare('SELECT key,count,reset_at,username,ip FROM login_locks WHERE reset_at>? AND count>=? ORDER BY reset_at DESC').all(now, LOCK_MAX);
  res.json({ ok: true, locks });
});
app.post('/api/unlock', requireAuth, requireAdmin, (req, res) => {
  const key = req.body?.key;
  if (key) db.prepare('DELETE FROM login_locks WHERE key=?').run(String(key));
  else db.exec('DELETE FROM login_locks'); // tout debloquer
  res.json({ ok: true });
});

// Config ntfy (admin) : lire / enregistrer / tester
app.get('/api/ntfy', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, url: getApp('ntfyUrl', ''), template: getApp('ntfyTemplate', DEFAULT_NTFY_TPL), hasToken: !!decSecret(getApp('ntfyToken', '')) });
});
app.post('/api/ntfy', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.url !== undefined) setApp('ntfyUrl', String(b.url).trim());
  if (b.template !== undefined) setApp('ntfyTemplate', String(b.template));
  if (b.token) setApp('ntfyToken', encSecret(String(b.token)));
  if (b.clearToken) setApp('ntfyToken', '');
  res.json({ ok: true });
});
app.post('/api/ntfy/test', requireAuth, requireAdmin, async (req, res) => {
  const tpl = (req.body && req.body.template != null) ? req.body.template : ntfyConf().template;
  const r = await sendNtfy('Actual Import : test', renderTpl(tpl, 'compte-test', '192.168.0.1'));
  res.json(r);
});
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password || password.length < 10) return res.status(400).json({ ok: false, error: 'Identifiant requis, mot de passe >= 10 caracteres.' });
  try {
    db.prepare('INSERT INTO users(username,pass_hash,is_admin,created) VALUES(?,?,?,?)').run(username, hashPassword(password), isAdmin ? 1 : 0, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: /UNIQUE/.test(String(e)) ? 'Cet identifiant existe deja.' : String(e.message || e) }); }
});
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.userId) return res.status(400).json({ ok: false, error: 'Impossible de te supprimer toi-meme.' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id=?').run(id); // F2 : pas de secrets orphelins
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
  if (b.password) setSecret(uid, 'password', b.password);
  if (b.e2ePassword) setSecret(uid, 'e2ePassword', b.e2ePassword);
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
  } catch (e) { console.error('[erreur]', e?.message || e); res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

// --- Relier un compte de fichier (ACCTID) a un compte Actual existant ---
app.post('/api/map-account', requireAuth, (req, res) => {
  const { acctid, name } = req.body || {};
  if (!acctid || !name) return res.status(400).json({ ok: false, error: 'acctid et nom requis.' });
  const uid = req.user.userId;
  let aliases = {}; try { aliases = JSON.parse(getSetting(uid, 'aliases', '{}')); } catch {}
  aliases[String(acctid)] = String(name);
  setSetting(uid, 'aliases', JSON.stringify(aliases));
  res.json({ ok: true });
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
  } catch (e) { console.error('[erreur]', e?.message || e); res.status(500).json({ ok: false, error: String(e?.message || e) }); }
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
      else if (/^\s*!type:/i.test(text)) { p = parseQIF(text); p.account = fname.replace(/\.[^.]*$/, ''); kind = 'QIF'; }
      else if (/Nom du compte,/i.test(text)) { p = parseSumeria(text); kind = 'Sumeria'; }
      else { parsed.push({ file: fname, skipped: 'format non reconnu (ni CSV Sumeria, ni OFX, ni QIF)' }); continue; }
      if (!p.account) { parsed.push({ file: fname, skipped: kind === 'OFX' ? 'compte OFX introuvable (ACCTID)' : 'compte introuvable (ligne 2)' }); continue; }
      // Sumeria a 0 op = ignore ; OFX/QIF a 0 op = on garde pour permettre la creation/mapping du compte
      if (!p.transactions.length && kind === 'Sumeria') { parsed.push({ file: fname, skipped: '0 operation' }); continue; }
      parsed.push({ file: fname, account: p.account, balance: p.balance ?? null, transactions: p.transactions });
    }
    if (!parsed.some(p => p.account)) { busy = false; return res.json({ ok: true, dryRun, results: parsed.map(p => ({ file: p.file, skipped: p.skipped })) }); }

    await openBudget(req.user.userId);
    const accounts = await api.getAccounts();
    const aliases = cfg(req.user.userId).aliases;
    const matchCat = await buildCategoryMatcher(); // categorisation directe via les regles
    const results = [];
    for (const p of parsed) {
      if (!p.transactions) { results.push({ file: p.file, skipped: p.skipped }); continue; }
      const acc = findAccount(accounts, p.account, aliases);
      if (!acc) { results.push({ file: p.file, account: p.account, count: p.transactions.length, matched: false, balance: p.balance ?? null, last4: p.account ? String(p.account).slice(-4) : null }); continue; }
      if (!p.transactions.length) { results.push({ file: p.file, account: p.account, mapped: acc.name, count: 0, matched: true, empty: true }); continue; }
      // Assigne la categorie directement (independant du moteur de regles d'Actual)
      let categorized = 0, assignedCat = null;
      for (const t of p.transactions) { if (!t.category) { const c = matchCat(t.notes); if (c) { t.category = c; if (!assignedCat) assignedCat = c; categorized++; } } }
      const base = { file: p.file, account: p.account, mapped: acc.name, count: p.transactions.length, matched: true, categorized,
        dbg: { matchers: matchCat.count, rules: matchCat.rulesTotal, cats: matchCat.catsTotal, tagged: categorized },
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
      // Garantit la categorie : on la (re)pose explicitement apres import, par Ref. interne
      const needCat = p.transactions.filter(t => t.category && t.imported_id);
      let found = 0, updated2 = 0, err = null, postCat = null;
      if (needCat.length) {
        const dates = p.transactions.map(t => t.date).sort();
        const existing = await api.getTransactions(acc.id, dates[0], dates[dates.length - 1]);
        const byImp = new Map(existing.filter(e => e.imported_id).map(e => [e.imported_id, e]));
        const ex0 = byImp.get(needCat[0].imported_id); postCat = ex0 ? (ex0.category ?? 'null') : 'introuvable';
        for (const t of needCat) {
          const ex = byImp.get(t.imported_id);
          if (!ex) continue;
          found++;
          try {
            const ret = await api.updateTransaction(ex.id, { category: t.category });
            if (Array.isArray(ret) && ret.length) updated2++;
            else if (!err) err = `noop retLen=${Array.isArray(ret) ? ret.length : typeof ret} exCat=${ex.category ?? 'null'} id=${String(ex.id).slice(0, 8)}`;
          } catch (e) { if (!err) err = 'THROW:' + String(e?.message || e); }
        }
      }
      base.dbg = { ...base.dbg, assignedCat: assignedCat ? String(assignedCat).slice(0, 8) : null, postCat: postCat ? String(postCat).slice(0, 12) : null, need: needCat.length, found, updated: updated2, err };
      results.push(base);
    }
    if (!dryRun) await api.sync();
    res.json({ ok: true, dryRun, results, accounts: accounts.filter(a => !a.closed).map(a => a.name) });
  } catch (e) { console.error('[erreur]', e?.message || e); res.status(500).json({ ok: false, error: String(e?.message || e) }); }
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
    // Supprime nos anciennes regles de categorisation (100% notes-contains sur nos mots-cles -> set category)
    let removed = 0;
    for (const r of rules) {
      const conds = r.conditions || [];
      const isSeed = conds.length > 0
        && conds.every(c => c.field === 'notes' && c.op === 'contains' && SEED_KW.has(String(c.value).toLowerCase().trim()))
        && (r.actions || []).some(a => a.field === 'category' && a.op === 'set');
      if (isSeed) { try { await api.deleteRule(r.id); removed++; } catch {} }
    }
    // Cree UNE regle par categorie, avec toutes ses conditions en "OU"
    let created = 0; const missing = new Set(); const done = [];
    for (const [catName, kws] of Object.entries(SEED_BY_CAT)) {
      const catId = catByName.get(norm(catName));
      if (!catId) { missing.add(catName); continue; }
      await api.createRule({
        stage: 'pre', conditionsOp: 'or',
        conditions: kws.map(k => ({ field: 'notes', op: 'contains', value: k })),
        actions: [{ field: 'category', op: 'set', value: catId }],
      });
      created++; done.push(`${catName} (${kws.length} mots-clés)`);
    }
    await api.sync();
    res.json({ ok: true, created, removed, missingCategories: [...missing], done });
  } catch (e) { console.error('[erreur]', e?.message || e); res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  finally { busy = false; }
});

app.use(express.static(path.join(__dirname, 'public')));

// Gestion centralisee des erreurs (multer + imprevu) : reponse JSON, detail en log (F3, M6)
app.use((err, _req, res, next) => {
  console.error('[erreur]', err?.message || err);
  if (res.headersSent) return next(err);
  const msg = err?.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 10 Mo).'
    : err?.code === 'LIMIT_FILE_COUNT' ? 'Trop de fichiers (max 30).'
    : 'Requete invalide.';
  res.status(400).json({ ok: false, error: msg });
});

app.listen(PORT, () => console.log(`Import Actual : serveur sur le port ${PORT}`));
