let setup = false;
const $ = id => document.getElementById(id);
async function init(){
  try {
    const d = await (await fetch('/api/needs-setup')).json();
    setup = !!d.needsSetup;
    if(setup){
      $('title').textContent = 'Créer le compte admin';
      $('sub').textContent = 'Première utilisation : choisis tes identifiants.';
      $('btn').textContent = 'Créer le compte';
      $('password').autocomplete = 'new-password';
    }
  } catch {}
  // deja connecte ? -> app
  try { const m = await (await fetch('/api/me')).json(); if(m.ok) location.href = '/'; } catch {}
}
$('form').onsubmit = async (e) => {
  e.preventDefault(); $('btn').disabled = true; $('err').textContent = '';
  try {
    const body = JSON.stringify({ username: $('username').value, password: $('password').value });
    const r = await fetch(setup ? '/api/setup' : '/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const d = await r.json();
    if(!d.ok) throw new Error(d.error || 'Échec');
    location.href = '/';
  } catch(err){ $('err').textContent = err.message; $('btn').disabled = false; }
};
init();
