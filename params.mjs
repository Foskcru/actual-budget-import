// ============================================================================
//  Paramètres globaux de l'app, modifiables À CHAUD par un admin (onglet Admin).
//  Priorité : valeur enregistrée en base  >  variable d'environnement  >  défaut.
//  Module PUR (pas de base, pas de réseau) -> testable seul.
// ============================================================================

const ORIGIN_RE = /^https?:\/\/[\w.\-\[\]:*]+$/;

/** Définition des paramètres (ordre = ordre d'affichage). */
export const PARAMS = [
  // --- Sécurité ---
  { key: 'lockMax', group: 'Sécurité', type: 'int', def: 8, min: 3, max: 100,
    label: 'Échecs de connexion avant blocage', help: 'Par identifiant et par adresse IP.' },
  { key: 'lockHours', group: 'Sécurité', type: 'int', def: 24, min: 1, max: 720, unit: 'h',
    label: 'Durée du blocage', help: 'Un admin peut débloquer avant.' },
  { key: 'sessionDays', group: 'Sécurité', type: 'int', def: 7, min: 1, max: 90, unit: 'jours',
    label: 'Durée d\'une session', help: 'S\'applique aux prochaines connexions.' },
  { key: 'uploadMaxMb', group: 'Sécurité', type: 'int', def: 10, min: 1, max: 100, unit: 'Mo',
    label: 'Taille max d\'un fichier importé' },

  // --- IA locale ---
  { key: 'aiConnectSrc', group: 'IA locale', type: 'origins', def: '', env: 'AI_CONNECT_SRC',
    label: 'Adresses d\'IA autorisées en plus de localhost',
    help: 'Séparées par des espaces, ex. http://192.168.1.20:11434 (IA sur un autre PC du réseau). Le navigateur doit recharger la page (Ctrl+F5).' },
  { key: 'aiDefaultProvider', group: 'IA locale', type: 'enum', def: 'ollama',
    options: [['ollama', 'Ollama'], ['openai', 'Compatible OpenAI (LM Studio…)']],
    label: 'Type d\'IA proposé par défaut', help: 'Pour les utilisateurs qui n\'ont encore rien réglé.' },
  { key: 'aiDefaultUrl', group: 'IA locale', type: 'url', def: 'http://localhost:11434',
    label: 'Adresse de l\'IA par défaut' },
  { key: 'aiDefaultModel', group: 'IA locale', type: 'string', def: '', max: 120,
    label: 'Modèle par défaut', help: 'Ex. qwen3:14b. Vide = l\'utilisateur choisit.' },

  // --- Suggestions ---
  { key: 'suggestMinConfidence', group: 'Suggestions', type: 'pct', def: 45, min: 10, max: 95,
    label: 'Confiance minimale d\'une suggestion de l\'historique', help: 'En dessous, pas de suggestion.' },
  { key: 'suggestPrecheck', group: 'Suggestions', type: 'pct', def: 80, min: 50, max: 100,
    label: 'Cocher d\'office à partir de', help: 'Les suggestions de l\'IA ne sont jamais cochées d\'office.' },
  { key: 'suggestAiBelow', group: 'Suggestions', type: 'pct', def: 60, min: 0, max: 100,
    label: 'Demander à l\'IA sous', help: 'L\'IA traite les opérations dont la suggestion est sous ce seuil.' },
  { key: 'suggestLearnMonths', group: 'Suggestions', type: 'int', def: 24, min: 3, max: 120, unit: 'mois',
    label: 'Historique pour apprendre (minimum)' },
  { key: 'suggestMaxItems', group: 'Suggestions', type: 'int', def: 500, min: 50, max: 3000,
    label: 'Opérations max par analyse' },

  // --- Recherche web ---
  { key: 'webSearch', group: 'Recherche web', type: 'enum', def: 'on',
    options: [['on', 'Activée'], ['off', 'Désactivée pour tout le monde']],
    label: 'Recherche « C\'est quoi ? »' },
  { key: 'webDelayMs', group: 'Recherche web', type: 'int', def: 1500, min: 500, max: 10000, unit: 'ms',
    label: 'Délai minimum entre deux recherches', help: 'Plus long = moins de risque de blocage par DuckDuckGo.' },
  { key: 'braveKeyGlobal', group: 'Recherche web', type: 'secret', def: '',
    label: 'Clé Brave partagée', help: 'Utilisée pour les utilisateurs sans clé personnelle. Vide = DuckDuckGo.' },
];
export const PARAM_BY_KEY = new Map(PARAMS.map(p => [p.key, p]));

/**
 * Valide / normalise une valeur saisie. -> { ok:true, value:string } | { ok:false, error }
 * (value est la forme stockée en base, toujours une chaîne)
 */
export function validateParam(key, raw) {
  const p = PARAM_BY_KEY.get(key);
  if (!p) return { ok: false, error: `Paramètre inconnu : ${key}` };
  const s = String(raw ?? '').trim();
  switch (p.type) {
    case 'int': case 'pct': {
      if (!/^-?\d+$/.test(s)) return { ok: false, error: `${p.label} : nombre entier attendu.` };
      const n = parseInt(s, 10);
      if (n < p.min || n > p.max) return { ok: false, error: `${p.label} : entre ${p.min} et ${p.max}.` };
      return { ok: true, value: String(n) };
    }
    case 'enum':
      if (!p.options.some(([v]) => v === s)) return { ok: false, error: `${p.label} : valeur non permise.` };
      return { ok: true, value: s };
    case 'url': {
      const u = s.replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return { ok: false, error: `${p.label} : adresse http(s) attendue.` };
      return { ok: true, value: u };
    }
    case 'origins': {
      const list = s.split(/\s+/).filter(Boolean).map(x => x.replace(/\/+$/, ''));
      const bad = list.find(x => !ORIGIN_RE.test(x));
      if (bad) return { ok: false, error: `${p.label} : « ${bad} » n'est pas une origine valide (ex. http://192.168.1.20:11434).` };
      return { ok: true, value: [...new Set(list)].join(' ') };
    }
    case 'string': return { ok: true, value: s.replace(/[\r\n\t]+/g, ' ').slice(0, p.max || 200) };
    case 'secret': return { ok: true, value: s.slice(0, 200) };
    default: return { ok: false, error: 'Type inconnu.' };
  }
}

/** Valeur effective (typée) à partir de la valeur stockée (ou undefined) et de l'env. */
export function effectiveParam(key, stored, env = {}) {
  const p = PARAM_BY_KEY.get(key);
  if (!p) return undefined;
  let s = stored;
  if ((s === undefined || s === null) && p.env && env[p.env] != null && String(env[p.env]).trim() !== '') {
    const v = validateParam(key, env[p.env]); if (v.ok) s = v.value;
  }
  if (s === undefined || s === null) return p.def;
  if (p.type === 'int' || p.type === 'pct') { const n = parseInt(s, 10); return Number.isFinite(n) ? n : p.def; }
  return s;
}
