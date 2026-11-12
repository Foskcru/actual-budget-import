let files = [];
const $ = (id) => document.getElementById(id);
const drop = $('drop'), input = $('file');

drop.onclick = () => input.click();
input.onchange = () => { files = [...input.files]; renderFiles(); };
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('hover')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('hover')}));
drop.addEventListener('drop', ev => { files = [...ev.dataTransfer.files].filter(f=>/\.(csv|ofx)$/i.test(f.name)); renderFiles(); });

function renderFiles(){
  $('fileList').textContent = files.length ? `${files.length} fichier(s) : ` + files.map(f=>f.name).join(', ') : '';
  $('btnRun').disabled = files.length === 0;
}

// --- authentification ---
let IS_ADMIN = false, CURRENT_USER = '', APP_API_VER = '';
(async function guard(){
  try {
    const m = await (await fetch('/api/me')).json();
    if(!m.ok){ location.href='/login.html'; return; }
    IS_ADMIN = !!m.isAdmin; CURRENT_USER = m.username; APP_API_VER = m.apiVersion || '';
    $('who').textContent = m.username + (m.isAdmin ? ' · admin' : '');
    $('btnSettings').style.display='';           // chacun gère ses propres réglages
    if(IS_ADMIN) $('tabAdmin').style.display='';
    $('verInfo').innerHTML = `Version de l'app (API Actual) : <b>v${esc(APP_API_VER||'?')}</b> <span class="mini">— clique « Tester la connexion » pour comparer au serveur.</span>`;
  } catch { location.href='/login.html'; }
})();
$('btnLogout').onclick = async () => { await fetch('/api/logout',{method:'POST'}); location.href='/login.html'; };
// --- modale Paramètres + onglets ---
function showTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.tabpane').forEach(p=>p.style.display = p.dataset.pane===name ? '' : 'none');
  if(name==='rules') growSeedTextareas(); // les textarea rendues cachées ont besoin d'être redimensionnées
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>showTab(t.dataset.tab));
$('btnSettings').onclick = () => { $('modalOverlay').style.display='flex'; showTab('conn'); loadSettings(); };
$('modalClose').onclick = () => { $('modalOverlay').style.display='none'; };
$('modalOverlay').onclick = (e) => { if(e.target===$('modalOverlay')) $('modalOverlay').style.display='none'; };
document.addEventListener('keydown', e=>{ if(e.key==='Escape') $('modalOverlay').style.display='none'; });
let ALIASES = {}, ACCOUNTS = [];
async function loadSettings(){
  const d = await (await fetch('/api/settings')).json(); if(!d.ok) return;
  $('s_url').value=d.serverURL||''; $('s_sync').value=d.syncId||''; $('s_budget').value=d.budgetName||'';
  $('s_pw').placeholder = d.hasPassword?'(inchangé)':'(vide)'; $('s_e2e').placeholder = d.hasE2e?'(inchangé)':'(vide)';
  try { ALIASES = JSON.parse(d.aliases||'{}'); } catch { ALIASES={}; }
  renderAliases(); fetchAccounts(); loadSeedConfig(); fillAiSettings(d);
  if(IS_ADMIN){ loadUsers(); loadLocks(); loadNtfy(); }
}
$('s_save').onclick = async () => {
  $('s_msg').textContent='…';
  const body = { serverURL:$('s_url').value, syncId:$('s_sync').value, budgetName:$('s_budget').value };
  if($('s_pw').value) body.password=$('s_pw').value;
  if($('s_e2e').value) body.e2ePassword=$('s_e2e').value;
  const d = await (await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  $('s_msg').textContent = d.ok ? 'Enregistré ✓' : ('Erreur : '+d.error);
  $('s_pw').value=''; $('s_e2e').value='';
  fetchAccounts(); // recharge la liste des comptes une fois la connexion configurée
};
// --- Correspondances de comptes (sans JSON) ---
function renderAliases(){
  const rows = Object.entries(ALIASES);
  $('aliasRows').innerHTML = rows.length
    ? rows.map(([k,v])=>`<div class="row" style="gap:8px;margin:4px 0"><span class="mini" style="min-width:160px">${esc(k)}</span><span class="mini">→</span><span class="mini" style="flex:1">${esc(v)}</span><a href="#" class="del" data-k="${esc(k)}">✕</a></div>`).join('')
    : '<div class="mini">Aucune correspondance.</div>';
  document.querySelectorAll('#aliasRows .del').forEach(a=>a.onclick=e=>{
    e.preventDefault();
    const k=a.dataset.k;
    if(confirm('Supprimer la correspondance « '+k+' → '+(ALIASES[k]||'')+' » ?')){ delete ALIASES[k]; renderAliases(); saveAliases(); }
  });
}
async function fetchAccounts(){
  try {
    const s = await (await fetch('/api/status')).json();
    if(s.ok){
      ACCOUNTS = s.accounts||[];
      const sel = $('a_val');
      if(sel){
        const cur = sel.value;
        sel.innerHTML = '<option value="">— choisir un compte —</option>' + ACCOUNTS.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
        if(cur && ACCOUNTS.includes(cur)) sel.value = cur;
      }
    }
  } catch {}
}
async function saveAliases(){
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aliases:JSON.stringify(ALIASES)})});
}
$('a_add').onclick = () => {
  const k=$('a_key').value.trim(), v=$('a_val').value.trim();
  if(!k||!v){ return; }
  ALIASES[k]=v; $('a_key').value=''; $('a_val').value=''; renderAliases(); saveAliases();
};

// --- Éditeur des catégories & règles de départ (config par utilisateur) ---
function norm2(s){ return String(s||'').toLowerCase().trim(); }
let SEED_CONFLICT = 'À vérifier';
function seedCatRow(c, conflictName){
  const isConf = norm2(c.name) === norm2(conflictName);
  return `<div class="cat" style="margin:6px 0;padding:6px 0;border-top:1px solid var(--line)">
      <div class="row" style="gap:8px">
        <span class="chandle" draggable="true" title="Glisser pour déplacer / réordonner">⠿</span>
        <input type="text" class="catName" value="${esc(c.name||'')}" placeholder="catégorie" style="flex:1;max-width:200px">
        <label class="chk" title="Catégorie garde-fou (libellés ambigus)"><input type="radio" name="seedConflict" class="catConf" ${isConf?'checked':''}> garde-fou</label>
        <a href="#" class="del catDel" title="Supprimer la catégorie">✕</a>
      </div>
      <textarea class="catKws" rows="2" placeholder="mots-clés séparés par des virgules" style="width:100%;margin-top:4px;min-height:36px;overflow:hidden">${esc((c.kws||[]).join(', '))}</textarea>
    </div>`;
}
function seedGroupRow(g, conflictName){
  const cats = (g.cats||[]).map(c=>seedCatRow(c, conflictName)).join('');
  return `<div class="grp" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px">
      <div class="row" style="gap:8px">
        <span class="gcaret" title="Replier / déplier">▾</span>
        <span class="ghandle" draggable="true" title="Glisser pour réordonner">⠿</span>
        <input type="text" class="grpName" value="${esc(g.name||'')}" placeholder="nom du groupe" style="flex:1;font-weight:600">
        <label class="chk" title="Groupe de revenus"><input type="checkbox" class="grpInc" ${g.income?'checked':''}> revenu</label>
        <a href="#" class="del grpDel" title="Supprimer le groupe">✕ groupe</a>
      </div>
      <div class="cats" style="margin-top:6px">${cats}</div>
      <button class="ghost catAdd" style="margin-top:6px">+ catégorie</button>
    </div>`;
}
function autoGrow(el){ if(!el) return; el.style.height='auto'; el.style.height=(el.scrollHeight)+'px'; }
function growSeedTextareas(){ document.querySelectorAll('#seedEditor .catKws').forEach(autoGrow); }
function renderSeedEditor(cfg){
  SEED_CONFLICT = cfg.conflictName || 'À vérifier';
  $('seedEditor').innerHTML = (cfg.groups||[]).map(g=>seedGroupRow(g, SEED_CONFLICT)).join('');
  growSeedTextareas(); pinIncomeLast();
}
function readSeedEditor(){
  const groups = []; let conflictName = '';
  document.querySelectorAll('#seedEditor .grp').forEach(gEl=>{
    const name = gEl.querySelector('.grpName').value.trim();
    const income = gEl.querySelector('.grpInc').checked;
    const cats = [];
    gEl.querySelectorAll('.cat').forEach(cEl=>{
      const cname = cEl.querySelector('.catName').value.trim(); if(!cname) return;
      const kws = cEl.querySelector('.catKws').value.split(',').map(s=>s.trim()).filter(Boolean);
      if(cEl.querySelector('.catConf').checked) conflictName = cname;
      cats.push({name:cname, kws});
    });
    if(name) groups.push({name, income, cats});
  });
  return { groups, conflictName: conflictName || SEED_CONFLICT || 'À vérifier' };
}
$('seedEditor').addEventListener('click', e=>{
  const t = e.target;
  if(t.classList.contains('gcaret')){ const g=t.closest('.grp'); g.classList.toggle('collapsed'); t.textContent = g.classList.contains('collapsed') ? '▸' : '▾'; return; }
  if(t.classList.contains('catDel')){ e.preventDefault(); t.closest('.cat').remove(); }
  else if(t.classList.contains('grpDel')){ e.preventDefault(); t.closest('.grp').remove(); }
  else if(t.classList.contains('catAdd')){ e.preventDefault(); t.previousElementSibling.insertAdjacentHTML('beforeend', seedCatRow({name:'',kws:[]}, SEED_CONFLICT)); }
});
$('seedEditor').addEventListener('input', e=>{ if(e.target.classList.contains('catKws')) autoGrow(e.target); });
// Marquer un groupe comme "revenu" le renvoie en bas
$('seedEditor').addEventListener('change', e=>{ if(e.target.classList.contains('grpInc')) pinIncomeLast(); });
// Le groupe de revenu reste toujours en bas (ordre relatif des revenus préservé)
function pinIncomeLast(){
  const ed = $('seedEditor');
  [...ed.querySelectorAll(':scope > .grp')].filter(g=>g.querySelector('.grpInc').checked).forEach(g=>ed.appendChild(g));
}
// --- Glisser-déposer : réordonner groupes et catégories (catégories déplaçables entre groupes) ---
let dragEl = null;
function dragAfter(container, y, selector){
  let closest = null, closestOffset = -Infinity;
  container.querySelectorAll(selector).forEach(el=>{
    if(el===dragEl) return;
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height/2;
    if(offset < 0 && offset > closestOffset){ closestOffset = offset; closest = el; }
  });
  return closest;
}
$('seedEditor').addEventListener('dragstart', e=>{
  const h = e.target;
  if(h.classList.contains('ghandle')) dragEl = h.closest('.grp');
  else if(h.classList.contains('chandle')) dragEl = h.closest('.cat');
  else return;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', ''); } catch(_){}
  setTimeout(()=>{ if(dragEl) dragEl.classList.add('dragging'); }, 0);
});
$('seedEditor').addEventListener('dragover', e=>{
  if(!dragEl) return;
  e.preventDefault();
  if(dragEl.classList.contains('grp')){
    const ed = $('seedEditor');
    const after = dragAfter(ed, e.clientY, ':scope > .grp');
    if(after) ed.insertBefore(dragEl, after); else ed.appendChild(dragEl);
  } else {
    const grp = e.target.closest('.grp'); if(!grp) return;
    const cats = grp.querySelector('.cats'); if(!cats) return;
    const after = dragAfter(cats, e.clientY, '.cat');
    if(after) cats.insertBefore(dragEl, after); else cats.appendChild(dragEl);
  }
});
$('seedEditor').addEventListener('drop', e=>{ if(dragEl) e.preventDefault(); });
$('seedEditor').addEventListener('dragend', ()=>{ if(dragEl){ dragEl.classList.remove('dragging'); dragEl=null; pinIncomeLast(); } });
$('seedAddGroup').onclick = ()=>{ $('seedEditor').insertAdjacentHTML('beforeend', seedGroupRow({name:'',income:false,cats:[{name:'',kws:[]}]}, SEED_CONFLICT)); pinIncomeLast(); };
$('seedToggleAll').onclick = ()=>{
  const grps = [...document.querySelectorAll('#seedEditor .grp')];
  const anyOpen = grps.some(g=>!g.classList.contains('collapsed')); // s'il en reste d'ouverts -> tout replier
  grps.forEach(g=>{ g.classList.toggle('collapsed', anyOpen); const car=g.querySelector('.gcaret'); if(car) car.textContent = anyOpen ? '▸' : '▾'; });
  $('seedToggleAll').textContent = anyOpen ? 'Tout déplier' : 'Tout replier';
};
$('seedSave').onclick = async ()=>{
  $('seedMsg').textContent='…';
  const cfg = readSeedEditor();
  if(!cfg.groups.length){ $('seedMsg').textContent='Ajoute au moins un groupe avec une catégorie.'; return; }
  try {
    const d = await (await fetch('/api/seed-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)})).json();
    if(!d.ok) throw new Error(d.error);
    renderSeedEditor(d.config); $('seedMsg').textContent='Enregistré ✓';
  } catch(e){ $('seedMsg').textContent='Erreur : '+e.message; }
};
$('seedReset').onclick = async ()=>{
  if(!confirm('Réinitialiser au modèle par défaut ? Tes personnalisations seront perdues.')) return;
  try {
    const d = await (await fetch('/api/seed-config/reset',{method:'POST'})).json();
    if(!d.ok) throw new Error(d.error);
    renderSeedEditor(d.config); $('seedMsg').textContent='Réinitialisé ✓';
  } catch(e){ $('seedMsg').textContent='Erreur : '+e.message; }
};
async function loadSeedConfig(){
  try { const d = await (await fetch('/api/seed-config')).json(); if(d.ok) renderSeedEditor(d.config); } catch {}
}
$('seedFromActual').onclick = async ()=>{
  $('seedFromActual').disabled = true; const old = $('seedFromActual').textContent; $('seedFromActual').textContent = 'Chargement…';
  $('seedMsg').textContent = '';
  try {
    const d = await (await fetch('/api/seed-config/from-actual')).json();
    if(!d.ok) throw new Error(d.error);
    renderSeedEditor(d.config);
    $('seedMsg').innerHTML = '<span class="tag-ok">Chargé depuis Actual ✓</span> — vérifie, puis clique « Enregistrer » pour garder. (Les règles avancées d\'Actual ne sont pas affichées mais restent actives.)';
  } catch(e){ $('seedMsg').textContent = 'Erreur : '+e.message; }
  finally { $('seedFromActual').disabled = false; $('seedFromActual').textContent = old; }
};
async function loadUsers(){
  const d = await (await fetch('/api/users')).json(); if(!d.ok) return;
  $('userList').innerHTML = d.users.map(u=>{
    const state = u.disabled ? ' <span class="tag-no">désactivé</span>' : '';
    if(u.username === CURRENT_USER) return `<div style="margin:3px 0">${esc(u.username)}${u.is_admin?' · admin':''} <span class="mini">(vous)</span></div>`;
    const tgl = `<a href="#" class="tgl" data-id="${u.id}" data-name="${esc(u.username)}" data-act="${u.disabled?'0':'1'}">${u.disabled?'réactiver':'désactiver'}</a>`;
    return `<div style="margin:3px 0">${esc(u.username)}${u.is_admin?' · admin':''}${state} &nbsp; ${tgl} &nbsp; <a href="#" class="del" data-id="${u.id}" data-name="${esc(u.username)}">supprimer</a></div>`;
  }).join('');
  document.querySelectorAll('#userList .del').forEach(a=>a.onclick=async e=>{e.preventDefault(); if(confirm('Supprimer l\'utilisateur « '+a.dataset.name+' » ?')){ await fetch('/api/users/'+a.dataset.id,{method:'DELETE'}); loadUsers(); }});
  document.querySelectorAll('#userList .tgl').forEach(a=>a.onclick=async e=>{e.preventDefault(); const act=a.dataset.act==='1'; if(confirm((act?'Désactiver':'Réactiver')+' le compte « '+a.dataset.name+' » ?')){ await fetch('/api/users/'+a.dataset.id+'/disabled',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabled:act})}); loadUsers(); }});
}
function fmtLeft(ms){
  if(ms<=0) return 'expiré';
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000);
  return h>0 ? (h+' h '+m+' min') : (m+' min');
}
async function loadLocks(){
  const d = await (await fetch('/api/locks')).json(); if(!d.ok) return;
  if(!d.locks.length){ $('lockList').innerHTML='<span class="mini">Aucune connexion bloquée.</span>'; return; }
  const now = Date.now();
  $('lockList').innerHTML = d.locks.map(l=>{
    const who = l.key && l.key.indexOf('u:')===0 ? ('compte « '+esc(l.username||l.key.slice(2))+' »') : ('IP '+esc(l.ip||(l.key||'').slice(3)));
    const left = fmtLeft(l.reset_at - now);
    return `<div style="margin:3px 0">🔒 ${who} · ${l.count} échecs · <b>reste ${esc(left)}</b> &nbsp; <a href="#" class="unlk" data-key="${esc(l.key)}">débloquer</a></div>`;
  }).join('');
  document.querySelectorAll('#lockList .unlk').forEach(a=>a.onclick=async e=>{e.preventDefault(); await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:a.dataset.key})}); loadLocks(); });
}
async function loadNtfy(){
  const d = await (await fetch('/api/ntfy')).json(); if(!d.ok) return;
  $('n_url').value = d.url||''; $('n_tpl').value = d.template||'';
  $('n_token').placeholder = d.hasToken ? '(inchangé)' : '(aucun)';
}
async function saveNtfy(){
  const body = { url:$('n_url').value, template:$('n_tpl').value };
  if($('n_token').value) body.token = $('n_token').value;
  await fetch('/api/ntfy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  $('n_token').value='';
}
$('n_save').onclick = async () => { $('n_msg').textContent='…'; await saveNtfy(); $('n_msg').textContent='Enregistré ✓'; };
$('n_test').onclick = async () => {
  $('n_msg').textContent='Envoi du test…'; await saveNtfy();
  const r = await (await fetch('/api/ntfy/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:$('n_tpl').value})})).json();
  $('n_msg').textContent = r.ok ? 'Test envoyé ✓ (vérifie ntfy)' : ('Échec : '+r.error);
};
$('unlockAll').onclick = async () => { if(confirm('Débloquer TOUTES les connexions bloquées ?')){ await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}); loadLocks(); } };
$('p_btn').onclick = async () => {
  $('p_msg').textContent = '…';
  const d = await (await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:$('p_cur').value,newPassword:$('p_new').value})})).json();
  $('p_msg').textContent = d.ok ? 'Modifié ✓' : ('Erreur : '+d.error);
  if(d.ok){ $('p_cur').value=''; $('p_new').value=''; }
};
$('u_add').onclick = async () => {
  const d = await (await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('u_name').value,password:$('u_pw').value,isAdmin:$('u_admin').checked})})).json();
  if(d.ok){ $('u_name').value=''; $('u_pw').value=''; $('u_admin').checked=false; loadUsers(); } else alert(d.error);
};

$('btnStatus').onclick = async () => {
  $('status').innerHTML = 'Test en cours…';
  try {
    const r = await fetch('/api/status'); const d = await r.json();
    if(!d.ok) throw new Error(d.error);
    const rep = (d.repaired||d.repairedTp) ? ` · <span class="tag-ok">réparé : ${d.repaired||0} catégorie(s), ${d.repairedTp||0} compte(s)</span>` : '';
    $('status').innerHTML = `<span class="pill ok">connecté</span> serveur v${d.serverVersion||'?'} · ${d.accounts.length} comptes · budget ouvert${rep}`;
    const sv = d.serverVersion||'?', av = d.apiVersion||APP_API_VER||'?';
    const mism = (sv!=='?' && av!=='?' && String(sv)!==String(av));
    $('verInfo').innerHTML = `Version de l'app (API Actual) : <b>v${esc(av)}</b> · Serveur Actual : <b>v${esc(sv)}</b> `
      + (mism ? `<span class="tag-no">⚠️ versions différentes → risque d'erreur de schéma (mets l'app à la même version que le serveur)</span>`
              : `<span class="tag-ok">✓ alignées</span>`);
  } catch(e){ $('status').innerHTML = `<span class="pill err">échec</span> ${e.message}`; }
};

$('btnRun').onclick = async () => {
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  fd.append('dryRun', $('dry').checked ? 'true':'false');
  fd.append('replaceExisting', $('replace').checked ? 'true':'false');
  $('btnRun').disabled = true; $('btnRun').textContent = 'Traitement…';
  try {
    const r = await fetch('/api/run', { method:'POST', body: fd });
    const d = await r.json();
    if(!d.ok) throw new Error(d.error);
    render(d);
  } catch(e){ alert('Erreur : ' + e.message); }
  finally { $('btnRun').disabled = false; $('btnRun').textContent = 'Lancer'; }
};

$('btnCats').onclick = async () => {
  $('btnCats').disabled = true; $('btnCats').textContent = 'Création…';
  $('catsRes').textContent = '';
  try {
    const r = await fetch('/api/seed-categories', { method:'POST' });
    const d = await r.json();
    if(!d.ok) throw new Error(d.error);
    let msg = `<span class="tag-ok">${d.created.length} catégorie(s) créée(s)</span>`;
    if(d.existing.length) msg += ` · ${d.existing.length} déjà présente(s)`;
    if(d.moved) msg += ` · ${d.moved} déplacée(s) de groupe`;
    if(d.ordered) msg += ` · ${d.ordered} réordonnée(s)`;
    if(d.renamedGroup) msg += ` · groupe revenu renommé en « ${esc(d.renamedGroup)} »`;
    if(d.created.length) msg += `<br>Créées : ${d.created.map(esc).join(' · ')}`;
    $('catsRes').innerHTML = msg;
  } catch(e){ $('catsRes').innerHTML = `<span class="tag-no">Erreur : ${esc(e.message)}</span>`; }
  finally { $('btnCats').disabled = false; $('btnCats').textContent = '1 · Créer les catégories de départ'; }
};

$('btnRules').onclick = async () => {
  $('btnRules').disabled = true; $('btnRules').textContent = 'Création…';
  $('rulesRes').textContent = '';
  try {
    const r = await fetch('/api/seed-rules', { method:'POST' });
    const d = await r.json();
    if(!d.ok) throw new Error(d.error);
    let msg = `<span class="tag-ok">${d.created} règle(s) créée(s)</span> (1 par catégorie, conditions en « OU »)`;
    if(d.removed) msg += ` · ${d.removed} ancienne(s) remplacée(s)`;
    if(d.missingCategories?.length) msg += `<br><span class="tag-skip">Catégories introuvables (ignorées) : ${d.missingCategories.map(esc).join(', ')}</span>`;
    if(d.done?.length) msg += `<br>${d.done.map(esc).join(' · ')}`;
    $('rulesRes').innerHTML = msg;
  } catch(e){ $('rulesRes').innerHTML = `<span class="tag-no">Erreur : ${esc(e.message)}</span>`; }
  finally { $('btnRules').disabled = false; $('btnRules').textContent = '2 · Créer les règles de départ'; }
};

function render(d){
  $('resCard').style.display = 'block';
  const mode = d.dryRun ? '<span class="pill" style="background:var(--soft);color:var(--muted)">SIMULATION</span>' : '<span class="pill ok">IMPORT RÉEL</span>';
  let add=0, del=0, ko=0;
  d.results.forEach(x=>{ add+=x.added||0; del+=x.deleted||0; if(x.matched===false) ko++; });
  $('summary').innerHTML = `${mode} &nbsp; ${d.dryRun?'':`<b>${add}</b> ajoutée(s), <b>${del}</b> supprimée(s) &nbsp;`}${d.repaired?`<span class="tag-ok">${d.repaired} catégorie(s) réparée(s)</span> &nbsp;`:''}${d.repairedTp?`<span class="tag-ok">${d.repairedTp} compte(s) réparé(s)</span> &nbsp;`:''}${ko?`<span class="tag-no">${ko} compte(s) non trouvé(s)</span>`:''}`;
  let h = '<tr><th>Fichier</th><th>Compte</th><th>Op.</th><th>Résultat</th></tr>';
  let i = 0;
  for(const x of d.results){
    if(x.skipped){ h+=`<tr><td>${esc(x.file)}</td><td colspan="3" class="tag-skip">ignoré : ${esc(x.skipped)}</td></tr>`; continue; }
    if(x.matched===false){
      const bal = (x.balance!=null) ? (x.balance/100).toFixed(2)+' €' : '?';
      const suggested = x.last4 ? ('BNP …'+x.last4) : '';
      const idx = i++;
      const opts = (d.accounts||[]).map(a=>`<option>${esc(a)}</option>`).join('');
      const create = `
        <div class="tag-no">Compte non connecté</div>
        <div class="mini">n° …${esc(x.last4||'?')} · ACCTID ${esc(x.account)} · solde ${esc(bal)}</div>
        <div class="row" style="gap:6px;margin-top:6px">
          <select id="lk_${idx}" style="max-width:190px">${opts}</select>
          <button class="ghost linkacc" data-i="${idx}" data-acctid="${esc(x.account)}">Lier à ce compte</button>
        </div>
        <div class="row" style="gap:6px;margin-top:4px">
          <span class="mini">ou créer :</span>
          <input type="text" id="na_${idx}" placeholder="nom" value="${esc(suggested)}" style="max-width:130px">
          <label class="chk"><input type="checkbox" id="no_${idx}"> hors budget</label>
          <button class="ghost createacc" data-i="${idx}" data-acctid="${esc(x.account)}" data-bal="${x.balance!=null?x.balance:''}">Créer</button>
        </div>`;
      h+=`<tr><td>${esc(x.file)}</td><td>${esc(x.account)}</td><td>${x.count}</td><td>${create}</td></tr>`;
      continue;
    }
    let result = x.empty
      ? `<span class="tag-ok">→ ${esc(x.mapped)}</span> <span class="mini">· compte connecté, aucune opération</span>`
      : d.dryRun
      ? `<span class="tag-ok">→ ${esc(x.mapped)}</span>${x.categorized?` · <b>${x.categorized} catégorisée(s)</b>`:''}<div class="mini">${(x.sample||[]).map(esc).join('<br>')}</div>`
      : `<span class="tag-ok">+${x.added} ajoutée(s)</span>${x.deleted?` · ${x.deleted} suppr.`:''}${x.updated?` · ${x.updated} maj`:''}${x.categorized?` · ${x.categorized} catégorisée(s)`:''} <span class="mini">→ ${esc(x.mapped)}</span>`;
    h += `<tr><td>${esc(x.file)}</td><td>${esc(x.account)}</td><td>${x.count}</td><td>${result}</td></tr>`;
  }
  $('resTable').innerHTML = h;
  document.querySelectorAll('.linkacc').forEach(b=>b.onclick=async()=>{
    const idx=b.dataset.i, name=$('lk_'+idx).value;
    if(!name){ alert('Choisis un compte.'); return; }
    b.disabled=true; b.textContent='…';
    try {
      const r = await (await fetch('/api/map-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acctid:b.dataset.acctid, name})})).json();
      if(!r.ok) throw new Error(r.error);
      b.textContent='Lié ✓ — relance l\'import';
    } catch(e){ alert('Erreur : '+e.message); b.disabled=false; b.textContent='Lier à ce compte'; }
  });
  document.querySelectorAll('.createacc').forEach(b=>b.onclick=async()=>{
    const idx=b.dataset.i, name=$('na_'+idx).value.trim(), off=$('no_'+idx).checked;
    if(!name){ alert('Donne un nom au compte.'); return; }
    b.disabled=true; b.textContent='Création…';
    const bal = b.dataset.bal==='' ? null : Number(b.dataset.bal);
    try {
      const r = await (await fetch('/api/create-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acctid:b.dataset.acctid, name, balance:bal, offbudget:off})})).json();
      if(!r.ok) throw new Error(r.error);
      b.textContent='Créé ✓ — relance l\'import'; fetchAccounts();
    } catch(e){ alert('Erreur : '+e.message); b.disabled=false; b.textContent='Créer le compte'; }
  });
}
// ============================================================================
//  IA locale (sur le PC de l'utilisateur) : réglages + appel depuis le navigateur
// ============================================================================
let AI = { provider:'ollama', url:'http://localhost:11434', model:'' };
function fillAiSettings(d){
  AI = { provider:d.aiProvider||'ollama', url:d.aiUrl||'http://localhost:11434', model:d.aiModel||'' };
  $('ai_provider').value = AI.provider; $('ai_url').value = AI.url;
  setModelOptions(AI.model ? [AI.model] : [], AI.model);
  $('ai_origin').textContent = location.origin;
  $('ai_brave').value = ''; $('ai_brave').placeholder = d.hasBraveKey ? '(enregistrée — vide pour la garder)' : '(aucune)';
}
async function loadAiSettings(){
  try { const d = await (await fetch('/api/settings')).json(); if(d.ok) AI = { provider:d.aiProvider||'ollama', url:d.aiUrl||'http://localhost:11434', model:d.aiModel||'' }; } catch {}
  return AI;
}
function setModelOptions(list, selected){
  const sel = $('ai_model');
  sel.innerHTML = list.length ? list.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('') : '<option value="">— clique « Tester » —</option>';
  if(selected && list.includes(selected)) sel.value = selected;
}
$('ai_provider').onchange = () => {
  const u = $('ai_url').value.trim();
  if(!u || /localhost:(11434|1234)\/?$/.test(u)) $('ai_url').value = $('ai_provider').value==='openai' ? 'http://localhost:1234' : 'http://localhost:11434';
};
// Base d'URL sans « / » final ni « /v1 » (on ajoute le chemin nous-mêmes)
function aiBase(url){ return String(url||'').trim().replace(/\/+$/,'').replace(/\/v1$/,''); }
// Chrome (« Local Network Access ») : pour une IA sur un AUTRE PC du réseau, il faut annoncer la cible.
function aiFetch(url, opts={}){
  let o = { ...opts };
  try { const h = new URL(url).hostname; if(!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) o.targetAddressSpace = 'local'; } catch {}
  return fetch(url, o);
}
function aiNetError(e){
  if(e && e.name === 'TypeError') return `IA injoignable à ${aiBase(AI.url)}. Vérifie qu'elle est lancée sur CE PC et que OLLAMA_ORIGINS contient ${location.origin} (voir Paramètres → IA locale).`;
  return e?.message || String(e);
}
async function aiListModels(cfg){
  const base = aiBase(cfg.url);
  if(cfg.provider === 'openai'){
    const r = await aiFetch(base + '/v1/models'); if(!r.ok) throw new Error('HTTP '+r.status);
    return ((await r.json()).data||[]).map(m=>m.id);
  }
  const r = await aiFetch(base + '/api/tags'); if(!r.ok) throw new Error('HTTP '+r.status);
  return ((await r.json()).models||[]).map(m=>m.name);
}
$('ai_test').onclick = async () => {
  const cfg = { provider:$('ai_provider').value, url:$('ai_url').value };
  $('ai_msg').textContent = 'Test…';
  try {
    const models = await aiListModels(cfg);
    const cur = $('ai_model').value || AI.model;
    setModelOptions(models, cur);
    $('ai_msg').innerHTML = models.length ? `<span class="tag-ok">IA joignable ✓</span> ${models.length} modèle(s)` : '<span class="tag-skip">IA joignable, mais aucun modèle installé (ollama pull qwen2.5:3b)</span>';
  } catch(e){ AI.url = cfg.url; $('ai_msg').innerHTML = `<span class="tag-no">${esc(aiNetError(e))}</span>`; }
};
$('ai_save').onclick = async () => {
  const body = { aiProvider:$('ai_provider').value, aiUrl:$('ai_url').value, aiModel:$('ai_model').value };
  if($('ai_brave').value.trim()) body.braveKey = $('ai_brave').value.trim();
  const d = await (await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  if(d.ok){ AI = { provider:body.aiProvider, url:body.aiUrl.trim().replace(/\/+$/,''), model:body.aiModel }; }
  $('ai_msg').textContent = d.ok ? 'Enregistré ✓' : ('Erreur : '+d.error);
  if(d.ok && body.braveKey){ $('ai_brave').value=''; $('ai_brave').placeholder='(enregistrée — vide pour la garder)'; }
};

// Appel « chat » générique, réponse JSON contrainte par un schéma.
// think:false = les modèles « qui réfléchissent » (Qwen3, gpt-oss…) répondent directement (bien plus rapide).
let AI_NO_THINK = true;
async function aiChat(messages, schema){
  const base = aiBase(AI.url);
  if(AI.provider === 'openai'){
    const r = await aiFetch(base + '/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model:AI.model, temperature:0, messages, response_format:{ type:'json_schema', json_schema:{ name:'reponse', strict:true, schema } } }) });
    if(!r.ok) throw new Error('IA : HTTP '+r.status);
    return (await r.json()).choices?.[0]?.message?.content;
  }
  const send = (noThink) => aiFetch(base + '/api/chat', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model:AI.model, stream:false, format:schema, options:{ temperature:0 }, messages, ...(noThink ? { think:false } : {}) }) });
  let r = await send(AI_NO_THINK);
  if(!r.ok && AI_NO_THINK && r.status === 400){ AI_NO_THINK = false; r = await send(false); } // vieil Ollama / modèle sans option « think »
  if(!r.ok) throw new Error('IA : HTTP '+r.status+(r.status===404?' (modèle introuvable ?)':''));
  return (await r.json()).message?.content;
}
const parseJSON = (c) => { try { return JSON.parse(c||'{}'); } catch { return {}; } };
const webBlock = (name, results) => (results||[]).length
  ? `Résultats d'une recherche web sur « ${name} » (peuvent être hors sujet) :\n` + results.slice(0,5).map(r=>`- ${r.title}${r.snippet?' — '+r.snippet:''}`).join('\n') + '\n\n'
  : '';

// Demande UNE catégorie (et, si besoin, une description du commerçant) à l'IA.
// Réponse contrainte (JSON + liste fermée) -> pas de catégorie inventée.
async function aiClassify(item, cats, web){
  const labelOf = (c) => c.group ? `${c.group} › ${c.name}` : c.name;
  const labels = cats.map(labelOf);
  const byLabel = new Map(cats.map(c=>[labelOf(c), c.id]));
  const byId = new Map(cats.map(c=>[c.id, c]));
  const eur = (cents) => (cents/100).toLocaleString('fr-FR',{minimumFractionDigits:2}) + ' €';
  const ex = (item.examples||[]).filter(e=>byId.has(e.category))
    .map(e=>`- ${e.text}${e.amount!=null?` (${eur(e.amount)})`:''} → ${labelOf(byId.get(e.category))}`).join('\n');
  const wantDesc = !!item.merchant && !item.merchantInfo;
  const props = { categorie:{ type:'string', enum:labels }, confiance:{ type:'number' } };
  if(wantDesc) props.description = { type:'string' };
  const schema = { type:'object', properties:props, required:Object.keys(props) };
  const ctx = item.merchantInfo ? `Ce commerçant (« ${item.merchant} ») est : ${item.merchantInfo}\n\n` : webBlock(item.merchant, web);
  const messages = [
    { role:'system', content:"Tu classes des opérations bancaires françaises dans les catégories du budget personnel de l'utilisateur. "
      + "Tu choisis UNIQUEMENT une catégorie de la liste fournie, en recopiant son nom exactement. "
      + "Les exemples viennent de l'historique de l'utilisateur : ils montrent SES habitudes, suis-les en priorité. "
      + "Un montant positif est un crédit (revenu ou remboursement). "
      + (wantDesc ? "Le champ « description » est une phrase courte en français disant ce qu'est le commerçant (type de commerce, ville si connue) ; laisse-le VIDE si tu ne sais pas, n'invente jamais. " : '')
      + "Réponds uniquement en JSON." },
    { role:'user', content:
      `Catégories disponibles :\n${cats.map(c=>'- '+labelOf(c)+(c.income?' (revenu)':'')).join('\n')}\n\n`
      + (ex ? `Exemples de l'historique (libellé → catégorie) :\n${ex}\n\n` : '')
      + ctx
      + `Opération à classer :\nDate : ${item.date}\nMontant : ${eur(item.amount)}\nBénéficiaire : ${item.payeeName||'(inconnu)'}\nLibellé : ${item.notes||'(vide)'}\n\n`
      + `Réponds {"categorie": "<nom exact de la liste>", "confiance": <nombre entre 0 et 1>${wantDesc?', "description": "<ce qu\'est le commerçant, ou vide>"':''}}.` },
  ];
  const out = parseJSON(await aiChat(messages, schema));
  const id = byLabel.get(String(out.categorie||'').trim());
  let conf = Number(out.confiance); if(!(conf>=0 && conf<=1)) conf = 0.5;
  const description = wantDesc ? String(out.description||'').trim().slice(0,300) : '';
  return { suggestion: id ? { category:id, source:'ia', confidence: Math.round(conf*100)/100 } : null, description };
}
// Résume des résultats web en une phrase « C'est quoi ? » (bouton 🔎 d'une ligne)
async function aiDescribe(name, web){
  const schema = { type:'object', properties:{ description:{ type:'string' } }, required:['description'] };
  const out = parseJSON(await aiChat([
    { role:'system', content:"Tu dis en UNE phrase courte, en français, ce qu'est un commerçant (type de commerce, ville si connue), d'après des résultats de recherche. Si les résultats ne permettent pas de savoir, renvoie une description vide. N'invente rien. Réponds en JSON." },
    { role:'user', content: webBlock(name, web) + `Commerçant : « ${name} ». Réponds {"description": "..."}.` },
  ], schema));
  return String(out.description||'').trim().slice(0,300);
}

// ============================================================================
//  Suggestions de catégories (historique + IA locale) — rien n'est écrit sans « Appliquer »
// ============================================================================
let SG = { items:[], categories:[] }, SG_STOP = false;
const PRECHECK = 0.8;          // suggestion cochée d'office à partir de 80 %
const AI_BELOW = 0.6;          // l'IA traite ce qui est sous 60 % (ou tout, si coché)
function sgKeyword(it){
  const p = String(it.payeeName||'').trim(), n = String(it.notes||'');
  if(p.length >= 3 && n.toLowerCase().includes(p.toLowerCase())) return p;
  const words = n.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z]+/g,' ').split(' ')
    .filter(w=>w.length>=3 && !/^(CB|CARTE|PAIEMENT|PRLV|SEPA|VIR|VIREMENT|FACTURE|ACHAT|RETRAIT|DAB|ECH|REF|MANDAT|INST|RECU|EMIS|DES|DU|DE|LE|LA|LES|POUR|PAR|SUR)$/.test(w));
  return words.slice(0,2).join(' ') || p;
}
function srcBadge(s){
  if(!s) return '<span class="src man">aucune</span>';
  const pct = s.confidence!=null ? ' '+Math.round(s.confidence*100)+' %' : '';
  if(s.source==='manuel') return '<span class="src man">ton choix</span>';
  if(s.source==='ia') return `<span class="src ia" title="Suggestion de l'IA locale">IA${pct}</span>`;
  const lbl = { beneficiaire:'même bénéficiaire', libelle:'même libellé', mots:'mots proches' }[s.source] || 'historique';
  return `<span class="src ${s.confidence>=PRECHECK?'hist':'low'}" title="Historique : ${esc(lbl)} (${s.support||0} op.)">${esc(lbl)}${pct}</span>`;
}
function catOptions(selected){
  const groups = new Map();
  for(const c of SG.categories){ if(!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
  let h = `<option value="">— choisir —</option>`;
  for(const [g, cs] of groups){
    h += `<optgroup label="${esc(g||'Sans groupe')}">` + cs.map(c=>`<option value="${esc(c.id)}"${c.id===selected?' selected':''}>${esc(c.name)}</option>`).join('') + '</optgroup>';
  }
  return h;
}
function renderSuggestions(){
  const rows = SG.items;
  $('sgBar').style.display = rows.length ? '' : 'none';
  if(!rows.length){ $('sgTable').innerHTML = ''; return; }
  let h = '<tr><th></th><th>Date</th><th>Montant</th><th>Opération</th><th>Catégorie</th><th>Source</th><th>Règle</th></tr>';
  rows.forEach((it, i)=>{
    const s = it.suggestion, cat = it.chosen ?? s?.category ?? '';
    const checked = it.checked ?? (!!s && s.source !== 'ia' && !it.internal && s.confidence >= PRECHECK);
    it.checked = checked;
    const amt = (it.amount/100).toLocaleString('fr-FR',{minimumFractionDigits:2});
    h += `<tr data-i="${i}">
      <td><input type="checkbox" class="sgChk"${checked?' checked':''}></td>
      <td class="mini" style="white-space:nowrap">${esc(it.date||'')}<div>${esc(it.account||'')}</div></td>
      <td style="white-space:nowrap" class="${it.amount>0?'amt-pos':'amt-neg'}">${esc(amt)} €</td>
      <td><b>${esc(it.payeeName||'')}</b><div class="mini">${esc(it.notes||'')}</div>
        ${it.internal ? '<div class="mini tag-skip">↔ Virement entre tes comptes ? Dans Actual, relie-le plutôt comme <b>virement</b> (pas de catégorie).</div>'
          : it.merchant ? `<div class="what"><input type="text" class="sgWhat" value="${esc(it.merchantInfo||'')}" placeholder="C'est quoi « ${esc(it.merchant)} » ?" title="Ce qu'est ce commerçant (enregistré pour les prochaines fois)"><button class="ghost sgSearch" title="Chercher sur internet ce qu'est « ${esc(it.merchant)} »">🔎</button></div>` : ''}</td>
      <td><select class="sgCat">${catOptions(cat)}</select></td>
      <td>${it.internal && !it.chosen ? '<span class="src int">virement interne ?</span>' : srcBadge(it.chosen && it.chosen!==s?.category ? {source:'manuel'} : s)}</td>
      <td><label class="chk mini" title="Ajoute ce mot-clé à la règle de la catégorie dans Actual : les prochaines opérations seront classées dès l'import"><input type="checkbox" class="sgRule"${it.rule?' checked':''}> créer</label>
        <input type="text" class="kw sgKw" value="${esc(it.keyword ?? sgKeyword(it))}" style="${it.rule?'':'display:none'}" placeholder="mot-clé du libellé"></td>
    </tr>`;
  });
  $('sgTable').innerHTML = h;
}
$('sgTable').addEventListener('change', e=>{
  const tr = e.target.closest('tr[data-i]'); if(!tr) return;
  const it = SG.items[+tr.dataset.i];
  if(e.target.classList.contains('sgChk')) it.checked = e.target.checked;
  else if(e.target.classList.contains('sgCat')){ it.chosen = e.target.value; it.checked = !!e.target.value; renderSuggestions(); }
  else if(e.target.classList.contains('sgRule')){ it.rule = e.target.checked; if(it.rule && it.keyword==null) it.keyword = sgKeyword(it); if(it.rule) it.checked = true; renderSuggestions(); }
});
// « C'est quoi ? » : description d'un commerçant, partagée par toutes ses lignes
function setMerchantInfo(merchant, text){
  const k = merchant.toLowerCase();
  SG.items.forEach(x=>{ if((x.merchant||'').toLowerCase()===k) x.merchantInfo = text; });
}
async function saveMerchantInfo(merchant, description, source){
  setMerchantInfo(merchant, description);
  try { await fetch('/api/merchant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:merchant, description, source})}); } catch {}
}
async function webSearch(merchant, force){
  const d = await (await fetch('/api/merchant/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:merchant, force:!!force})})).json();
  if(!d.ok) throw new Error(d.error);
  return d.results || [];
}
$('sgTable').addEventListener('focusout', e=>{
  if(!e.target.classList.contains('sgWhat')) return;
  const it = SG.items[+e.target.closest('tr[data-i]').dataset.i];
  const v = e.target.value.trim();
  if(v !== (it.merchantInfo||'')) saveMerchantInfo(it.merchant, v, 'manuel');
});
$('sgTable').addEventListener('click', async e=>{
  const b = e.target.closest('.sgSearch'); if(!b) return;
  const it = SG.items[+b.closest('tr[data-i]').dataset.i];
  b.disabled = true; b.textContent = '…';
  try {
    const web = await webSearch(it.merchant, true);
    if(!web.length){ $('sgMsg').textContent = `Rien trouvé sur internet pour « ${it.merchant} ». Tu peux remplir le champ toi-même.`; return; }
    await loadAiSettings();
    let desc = '', src = 'web';
    if(AI.model){ try { desc = await aiDescribe(it.merchant, web); src = 'web+ia'; } catch(err){ $('sgMsg').textContent = aiNetError(err); } }
    if(!desc){ const r = web[0]; desc = (r.title + (r.snippet ? ' — ' + r.snippet : '')).slice(0,200); src = 'web'; }
    await saveMerchantInfo(it.merchant, desc, src);
  } catch(err){ $('sgMsg').innerHTML = `<span class="tag-no">${esc(err.message)}</span>`; }
  finally { renderSuggestions(); }
});
$('sgTable').addEventListener('input', e=>{
  if(!e.target.classList.contains('sgKw')) return;
  SG.items[+e.target.closest('tr[data-i]').dataset.i].keyword = e.target.value;
});
$('sgCheckAll').onclick = ()=>{
  const all = SG.items.every(it=>it.checked || !(it.chosen ?? it.suggestion?.category));
  SG.items.forEach(it=>{ if(it.chosen ?? it.suggestion?.category) it.checked = !all; });
  renderSuggestions();
};
$('sgLoad').onclick = async ()=>{
  const b = $('sgLoad'); b.disabled = true; b.textContent = 'Analyse…';
  $('sgMsg').textContent = 'Lecture de ton historique dans Actual…';
  try {
    const d = await (await fetch('/api/suggest?months='+encodeURIComponent($('sgMonths').value))).json();
    if(!d.ok) throw new Error(d.error);
    SG = { items:d.items, categories:d.categories };
    const more = d.total > d.items.length ? ` (les ${d.items.length} plus récentes affichées)` : '';
    $('sgMsg').innerHTML = d.items.length
      ? `<b>${d.total}</b> opération(s) à classer${more} · <span class="tag-ok">${d.withSuggestion} suggestion(s) par l'historique</span> · appris sur ${d.learned} opération(s) déjà classées.`
      : `<span class="tag-ok">Rien à classer ✓</span> (appris sur ${d.learned} opération(s)).`;
    if(d.internal) $('sgMsg').innerHTML += ` · <span class="tag-skip">${d.internal} virement(s) interne(s) probable(s), à relier dans Actual</span>`;
    renderSuggestions();
  } catch(e){ $('sgMsg').innerHTML = `<span class="tag-no">Erreur : ${esc(e.message)}</span>`; }
  finally { b.disabled = false; b.textContent = 'Analyser'; }
};
$('sgAI').onclick = async ()=>{
  await loadAiSettings();
  if(!AI.model){ $('sgMsg').innerHTML = '<span class="tag-skip">Configure d\'abord ton IA : Paramètres → IA locale (Tester, choisir le modèle, Enregistrer).</span>'; return; }
  const all = $('sgAIAll').checked;
  const todo = SG.items.filter(it=>!it.chosen && !it.internal && (all || !it.suggestion || it.suggestion.confidence < AI_BELOW));
  const useWeb = $('sgWeb').checked; let webErr = '';
  if(!todo.length){
    const nInt = SG.items.filter(it=>!it.chosen && it.internal).length;
    const nOthers = SG.items.filter(it=>!it.chosen && !it.internal).length;
    $('sgMsg').innerHTML = (nInt && !nOthers)
      ? `Rien à demander à l'IA : il ne reste que <b>${nInt} virement(s) interne(s)</b>. Ils n'ont pas de catégorie : dans Actual, relie-les comme <b>virement</b> entre tes comptes (ou choisis une catégorie à la main si ce n'en est pas un).`
      : !SG.items.length ? 'Rien à classer.'
      : !all ? 'Les opérations restantes ont déjà une suggestion fiable de l\'historique (coche « aussi les suggestions déjà fiables » pour les repasser à l\'IA).'
      : 'Rien à demander à l\'IA : tu as déjà choisi une catégorie pour les opérations restantes.';
    return;
  }
  SG_STOP = false; $('sgAI').disabled = true; $('sgAIStop').style.display = '';
  let done = 0, got = 0, t0 = Date.now();
  try {
    for(const it of todo){
      if(SG_STOP) break;
      $('sgMsg').textContent = `IA (${AI.model}) : ${done}/${todo.length}…` + (done ? ` ~${Math.round((Date.now()-t0)/done/100)/10} s/op.` : '');
      let web = [];
      if(useWeb && it.merchant && !it.merchantInfo && !webErr){
        try { web = await webSearch(it.merchant); } catch(err){ webErr = err.message; }   // 1re erreur : on continue sans le web
      }
      const r = await aiClassify(it, SG.categories, web);
      done++;
      if(r.description) await saveMerchantInfo(it.merchant, r.description, web.length ? 'web+ia' : 'ia');
      if(r.suggestion){ got++; it.suggestion = { ...r.suggestion, support:0 }; it.checked = false; } // l'IA propose, tu valides
      if(done % 5 === 0) renderSuggestions();
    }
    $('sgMsg').innerHTML = `<span class="tag-ok">IA : ${got} suggestion(s)</span> sur ${done} opération(s)${SG_STOP?' (arrêté)':''}. Coche celles qui te conviennent, puis « Appliquer la sélection ».`
      + (webErr ? `<br><span class="tag-skip">Recherche web interrompue : ${esc(webErr)}</span>` : '');
  } catch(e){ $('sgMsg').innerHTML = `<span class="tag-no">${esc(aiNetError(e))}</span>`; }
  finally { $('sgAI').disabled = false; $('sgAIStop').style.display = 'none'; renderSuggestions(); }
};
$('sgAIStop').onclick = ()=>{ SG_STOP = true; };
$('sgApply').onclick = async ()=>{
  const sel = SG.items.filter(it=>it.checked && (it.chosen ?? it.suggestion?.category));
  if(!sel.length){ $('sgMsg').textContent = 'Coche au moins une opération avec une catégorie.'; return; }
  const items = sel.map(it=>({ id:it.id, category: it.chosen ?? it.suggestion.category }));
  const rules = sel.filter(it=>it.rule && String(it.keyword||'').trim().length>=3).map(it=>({ category: it.chosen ?? it.suggestion.category, keyword: it.keyword.trim() }));
  if(!confirm(`Classer ${items.length} opération(s) dans Actual`+(rules.length?` et ajouter ${rules.length} mot(s)-clé(s) aux règles`:'')+' ?')) return;
  const b = $('sgApply'); b.disabled = true; b.textContent = 'Application…';
  try {
    const d = await (await fetch('/api/suggest/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items, rules})})).json();
    if(!d.ok) throw new Error(d.error);
    const doneIds = new Set(items.map(x=>x.id));
    SG.items = SG.items.filter(it=>!doneIds.has(it.id));
    let msg = `<span class="tag-ok">${d.applied} opération(s) classée(s) ✓</span>`;
    if(d.rulesCreated || d.rulesUpdated) msg += ` · règles : ${d.rulesCreated} créée(s), ${d.rulesUpdated} complétée(s)`;
    if(d.warnings?.length) msg += `<br><span class="tag-skip">⚠️ Garde-fou : ${d.warnings.map(esc).join(' ; ')}</span>`;
    if(d.errors?.length) msg += `<br><span class="tag-no">${d.errors.map(esc).join(' ; ')}</span>`;
    $('sgMsg').innerHTML = msg;
    renderSuggestions();
  } catch(e){ $('sgMsg').innerHTML = `<span class="tag-no">Erreur : ${esc(e.message)}</span>`; }
  finally { b.disabled = false; b.textContent = 'Appliquer la sélection'; }
};

function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
