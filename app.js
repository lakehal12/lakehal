(function () {
'use strict';
const CFG = window.APP_CONFIG || {};
const URL_ = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
const CONFIGURED = URL_.startsWith('https://') && !URL_.includes('PASTE') && KEY.length > 20 && !KEY.includes('PASTE');
const LS = 'arruapan:v1';
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const label = (n) => (Math.abs(n) <= 1 ? 'caisse' : 'caisses');
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (k === 'value') e.value = v; else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// ---------- saved data ----------
let st = { code: null, server: [], outbox: [] };
try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s && Array.isArray(s.server) && Array.isArray(s.outbox)) st = s; } catch (e) {}
function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {} }

// ---------- server calls ----------
async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: KEY };
  if (KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + KEY;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  let r;
  try { r = await fetch(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args), signal: ctl.signal }); }
  catch (e) { const x = new Error('No connection'); x.net = true; throw x; }
  finally { clearTimeout(t); }
  const text = await r.text();
  if (!r.ok) { const x = new Error(text.includes('bad_code') ? 'Wrong code' : 'Serveur ' + r.status + ': ' + text.slice(0, 140)); x.bad = text.includes('bad_code'); throw x; }
  return text ? JSON.parse(text) : null;
}
const fetchStores = async (code) => (await rpc('list_stores', { p_code: code })).map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.createdAt), balance: Number(r.balance) || 0 }));
const fetchMoves = async (code, id) => (await rpc('list_movements', { p_code: code, p_store_id: id })).map((r) => ({ id: String(r.id), type: r.type === 'return' ? 'return' : 'delivery', count: Number(r.count) || 0, createdAt: String(r.createdAt) }));

// ---------- what the screen shows = server list + changes not sent yet ----------
function applyOp(list, op) {
  if (op.kind === 'addStore') return list.some((s) => s.id === op.id) ? list : [...list, { id: op.id, name: op.name, createdAt: op.createdAt, balance: 0 }];
  if (op.kind === 'rename') return list.map((s) => (s.id === op.id ? { ...s, name: op.name } : s));
  return list.map((s) => (s.id === op.storeId ? { ...s, balance: s.balance + (op.type === 'delivery' ? op.count : -op.count) } : s));
}
function stores() { const seen = new Set(); let l = st.server; for (const o of st.outbox) { if (seen.has(o.opId)) continue; seen.add(o.opId); l = applyOp(l, o); } return l; }
function dispatch(op) { st.outbox.push(op); save(); render(); renderHist(); sync(); }
const addStore = (name) => dispatch({ opId: uid(), kind: 'addStore', id: uid(), name, createdAt: new Date().toISOString() });
const renameStore = (id, name) => dispatch({ opId: uid(), kind: 'rename', id, name });
const move = (storeId, type, count) => { const id = uid(); dispatch({ opId: id, kind: 'movement', id, storeId, type, count, createdAt: new Date().toISOString() }); };

// ---------- sync ----------
let syncing = false, again = false, status = CONFIGURED ? 'syncing' : 'local', statusMsg = '', serverHist = [], openId = null;
function setStatus(s, m) { status = s; statusMsg = m || ''; render(); }
async function sync() {
  if (!CONFIGURED || !st.code) return;
  if (syncing) { again = true; return; }
  syncing = true;
  if (st.outbox.length || status !== 'synced') setStatus('syncing');
  try {
    do {
      again = false; const code = st.code; if (!code) break;
      const batch = st.outbox.slice(0, 200);
      if (batch.length) {
        await rpc('apply_ops', { p_code: code, p_ops: batch });
        const sent = new Set(batch.map((o) => o.opId)); st.outbox = st.outbox.filter((o) => !sent.has(o.opId)); save();
        if (st.outbox.length) { again = true; continue; }
      }
      st.server = await fetchStores(code); save();
    } while (again);
    setStatus('synced'); if (openId) loadHist();
  } catch (e) {
    if (e.bad) { st.code = null; save(); showGate(); setStatus('error', 'Le code d’accès a été refusé.'); }
    else if (e.net) setStatus('offline'); else setStatus('error', e.message);
  } finally { syncing = false; }
}

// ---------- main screen ----------
function render() {
  const all = stores(), q = norm($('q').value);
  const sum = (l) => l.reduce((t, s) => t + s.balance, 0);
  $('total').textContent = sum(all);
  $('across').textContent = 'Dans ' + all.length + (all.length <= 1 ? ' supermarché' : ' supermarchés');
  const shown = all.filter((s) => norm(s.name).includes(q)).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  $('sum').textContent = q ? shown.length + ' sur ' + all.length + ' trouvé(s) · ' + sum(shown) + ' ' + label(sum(shown)) : '';
  const n = st.outbox.length;
  const text = { local: 'Cloud non configuré · enregistré sur ce téléphone seulement', syncing: 'Synchronisation…', error: 'Problème de serveur' + (statusMsg ? ' · ' + statusMsg : ''),
    offline: n ? 'Hors ligne · ' + n + (n === 1 ? ' modification' : ' modifications') + ' en attente d’envoi' : 'Hors ligne · dernière liste enregistrée affichée',
    synced: 'Partagé avec vos autres téléphones · à jour (appuyez pour actualiser)' }[status];
  $('status').textContent = text; $('status').className = status === 'offline' || status === 'error' ? 'bad' : '';
  const list = $('list'); list.textContent = '';
  if (!shown.length) {
    list.append(h('p', { class: 'sum' }, all.length ? 'Aucun supermarché trouvé.' : 'Aucun supermarché pour l’instant. Appuyez sur « + Ajouter un magasin ».'));
    if (all.length && q) list.append(h('button', { onclick: () => openAdd($('q').value.trim()) }, 'Ajouter « ' + $('q').value.trim() + ' »'));
  }
  for (const s of shown) list.append(h('button', { class: 'row', onclick: () => openDetail(s.id) }, h('span', {}, s.name), h('b', {}, String(s.balance))));
}

// ---------- sheets ----------
const sheet = $('sheet'), body = $('sbody');
function closeSheet() { sheet.classList.add('hide'); openId = null; serverHist = []; }
function openSheet(nodes) { body.textContent = ''; body.append(...nodes); sheet.classList.remove('hide'); }
sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function openAdd(prefill) {
  const inp = h('input', { maxlength: '60', placeholder: 'Nom du supermarché', value: prefill || '' }), err = h('p', { class: 'err' });
  const go = () => {
    const name = inp.value.trim();
    if (!name) { err.textContent = 'Entrez le nom du supermarché.'; return; }
    if (stores().some((s) => norm(s.name) === norm(name))) { err.textContent = 'Ce supermarché est déjà dans votre liste.'; return; }
    addStore(name); closeSheet(); $('q').value = ''; render();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  openSheet([h('div', { class: 'top' }, h('h2', {}, 'Ajouter un supermarché'), h('button', { class: 'alt', onclick: closeSheet }, '✕')), h('label', {}, 'Nom'), inp, err,
    h('button', { style: 'width:100%;margin-top:6px', onclick: go }, 'Ajouter le supermarché')]);
  inp.focus();
}

function openDetail(id) {
  openId = id; serverHist = [];
  const cur = () => stores().find((s) => s.id === id);
  let type = 'delivery';
  const title = h('h2', {}), bal = h('b', {}), balTxt = h('span', {});
  const nm = h('input', { maxlength: '60' }), nerr = h('p', { class: 'err' });
  const rbox = h('div', { class: 'box hide' }, h('label', { style: 'margin-top:0' }, 'Nom du supermarché'), nm, nerr,
    h('div', { class: 'two', style: 'margin-top:10px' }, h('button', { class: 'alt', onclick: () => rbox.classList.add('hide') }, 'Annuler'),
      h('button', { onclick: () => {
        const name = nm.value.trim(), s = cur();
        if (!name) { nerr.textContent = 'Entrez le nom du supermarché.'; return; }
        if (stores().some((x) => x.id !== id && norm(x.name) === norm(name))) { nerr.textContent = 'Un autre supermarché porte déjà ce nom.'; return; }
        if (s && name !== s.name) renameStore(id, name);
        rbox.classList.add('hide');
      } }, 'Enregistrer le nom')));
  const bDel = h('button', { class: 'sel' }, 'Livré +'), bRet = h('button', { class: 'alt' }, 'Repris −');
  const pick = (t) => { type = t; bDel.className = t === 'delivery' ? 'sel' : 'alt'; bRet.className = t === 'return' ? 'sel' : 'alt'; };
  bDel.onclick = () => pick('delivery'); bRet.onclick = () => pick('return');
  const cnt = h('input', { inputmode: 'numeric', placeholder: 'Nombre de caisses' }), merr = h('p', { class: 'err' });
  const rec = () => {
    const c = Number(cnt.value), s = cur(); if (!s) return;
    if (!Number.isInteger(c) || c < 1) { merr.textContent = 'Entrez un nombre entier supérieur à zéro.'; return; }
    if (type === 'return' && c > s.balance) { merr.textContent = 'Seulement ' + s.balance + ' ' + label(s.balance) + ' chez ce supermarché.'; return; }
    move(id, type, c); cnt.value = ''; merr.textContent = '';
  };
  cnt.onkeydown = (e) => { if (e.key === 'Enter') rec(); };
  const ex = h('input', { inputmode: 'numeric', placeholder: 'Total exact' }), xerr = h('p', { class: 'err' });
  const setEx = () => {
    const t = Number(ex.value), s = cur(); if (!s) return;
    if (ex.value.trim() === '' || !Number.isInteger(t) || t < 0) { xerr.textContent = 'Entrez un nombre entier, 0 ou plus.'; return; }
    if (t !== s.balance) move(id, t > s.balance ? 'delivery' : 'return', Math.abs(t - s.balance));
    ex.value = ''; xerr.textContent = '';
  };
  const hist = h('div', { id: 'hist' });
  refreshDetail = () => { const s = cur(); if (!s) { closeSheet(); return; } title.textContent = s.name; bal.textContent = String(s.balance); balTxt.textContent = ' ' + label(s.balance) + ' encore chez ce supermarché'; };
  openSheet([h('div', { class: 'top' }, title, h('button', { class: 'alt', 'aria-label': 'Modifier le nom', onclick: () => { nm.value = cur().name; nerr.textContent = ''; rbox.classList.remove('hide'); nm.focus(); } }, '✎'),
      h('button', { class: 'alt', onclick: closeSheet }, '✕')),
    rbox, h('div', { class: 'bal' }, bal, balTxt),
    h('div', { class: 'two' }, bDel, bRet), h('label', {}, 'Combien de caisses ?'), cnt, merr, h('button', { style: 'width:100%', onclick: rec }, 'Enregistrer'),
    h('label', {}, 'Ou définir le total exact'), h('div', { class: 'two' }, ex, h('button', { class: 'alt', style: 'flex:0 0 auto', onclick: setEx }, 'Valider')), xerr,
    h('label', {}, 'Activité récente'), hist]);
  refreshDetail(); renderHist(); loadHist();
}
let refreshDetail = () => {};

function histRows() {
  const pend = st.outbox.filter((o) => o.kind === 'movement' && o.storeId === openId).map((o) => ({ id: o.id, type: o.type, count: o.count, createdAt: o.createdAt })).reverse();
  return [...pend, ...serverHist.filter((r) => !pend.some((p) => p.id === r.id))].slice(0, 8);
}
function renderHist() {
  const el = $('hist'); if (!el || !openId) return; refreshDetail();
  const rows = histRows(); el.textContent = '';
  if (!rows.length) el.append(h('p', { class: 'sum' }, 'Aucune activité pour l’instant.'));
  for (const r of rows) {
    const d = new Date(r.createdAt), today = d.toDateString() === new Date().toDateString();
    el.append(h('div', { class: 'hist' }, h('span', {}, (r.type === 'delivery' ? 'Livré' : 'Repris') + ' · ' + (today ? 'Aujourd’hui' : d.toLocaleDateString('fr', { day: 'numeric', month: 'short' }))),
      h('b', { style: 'color:var(' + (r.type === 'delivery' ? '--pri' : '--bad') + ')' }, (r.type === 'delivery' ? '+' : '−') + r.count)));
  }
}
async function loadHist() {
  if (!CONFIGURED || !st.code || !openId) return; const id = openId;
  try { const rows = await fetchMoves(st.code, id); if (openId === id) { serverHist = rows; renderHist(); } } catch (e) {}
}

// ---------- access code ----------
function showGate() { $('main').classList.add('hide'); $('codeScreen').classList.remove('hide'); closeSheet(); }
function hideGate() { $('codeScreen').classList.add('hide'); $('main').classList.remove('hide'); }
$('connect').onclick = async () => {
  const code = $('code').value.trim(); if (!code) { $('cerr').textContent = 'Entrez le code.'; return; }
  $('connect').disabled = true; $('cerr').textContent = '';
  try { st.server = await fetchStores(code); st.code = code; save(); $('code').value = ''; hideGate(); setStatus('syncing'); sync(); }
  catch (e) { $('cerr').textContent = e.bad ? 'Code incorrect. Réessayez.' : e.net ? 'Pas de connexion Internet. Réessayez.' : e.message; }
  $('connect').disabled = false;
};
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('connect').click(); };

// ---------- start ----------
$('add').onclick = () => openAdd('');
$('q').oninput = render;
$('status').onclick = () => sync();
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', () => sync());
if (CONFIGURED && !st.code) showGate();
render(); sync();
})();
