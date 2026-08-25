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
let IS_ADMIN = false, CURRENT_USER = '';
(async function guard(){
  try {
    const m = await (await fetch('/api/me')).json();
    if(!m.ok){ location.href='/login.html'; return; }
    IS_ADMIN = !!m.isAdmin; CURRENT_USER = m.username;
    $('who').textContent = m.username + (m.isAdmin ? ' · admin' : '');
    $('btnSettings').style.display='';           // chacun gère ses propres réglages
    if(IS_ADMIN) $('tabAdmin').style.display='';
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
  renderAliases(); fetchAccounts(); loadSeedConfig();
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
        <input type="text" class="catName" value="${esc(c.name||'')}" placeholder="catégorie" style="flex:1;max-width:220px">
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
  growSeedTextareas();
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
  if(t.classList.contains('catDel')){ e.preventDefault(); t.closest('.cat').remove(); }
  else if(t.classList.contains('grpDel')){ e.preventDefault(); t.closest('.grp').remove(); }
  else if(t.classList.contains('catAdd')){ e.preventDefault(); t.previousElementSibling.insertAdjacentHTML('beforeend', seedCatRow({name:'',kws:[]}, SEED_CONFLICT)); }
});
$('seedEditor').addEventListener('input', e=>{ if(e.target.classList.contains('catKws')) autoGrow(e.target); });
$('seedAddGroup').onclick = ()=>{ $('seedEditor').insertAdjacentHTML('beforeend', seedGroupRow({name:'',income:false,cats:[{name:'',kws:[]}]}, SEED_CONFLICT)); };
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
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
