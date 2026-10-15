(function () {
'use strict';
const CFG = window.APP_CONFIG || {};
const URL_ = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
const CONFIGURED = URL_.startsWith('https://') && !URL_.includes('PASTE') && KEY.length > 20 && !KEY.includes('PASTE');
const LS = 'arruapan:v2';
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
const iso = () => new Date().toISOString();
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const label = (n) => (Math.abs(n) <= 1 ? 'caisse' : 'caisses');
const err = (msg, flags) => Object.assign(new Error(msg), flags || {});
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (k === 'value') e.value = v; else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const fmtDate = (s) => new Date(s).toLocaleString('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- données enregistrées sur le téléphone ----------
let st = { session: null, user: null, profile: null, server: [], warehouse: null, outbox: [], rejected: 0 };
try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s && Array.isArray(s.server) && Array.isArray(s.outbox)) st = Object.assign(st, s); } catch (e) {}
function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {} }
const isAdmin = () => !!st.profile && st.profile.role === 'admin';

// ---------- connexion au serveur ----------
async function http(url, init) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, init)); }
  catch (e) { throw err('Pas de connexion', { net: true }); }
  finally { clearTimeout(t); }
}
async function authCall(grant, body) {
  const r = await http(URL_ + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw err(data.msg || data.error_description || data.message || 'Auth ' + r.status, { auth: true, status: r.status });
  return data;
}
function setSession(d) {
  st.session = { access: d.access_token, refresh: d.refresh_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  if (d.user) st.user = { id: d.user.id, email: d.user.email };
  save();
}
let refreshing = null;
function refreshSession() {
  if (!st.session) return Promise.reject(err('Non connecté', { auth: true }));
  if (!refreshing) refreshing = authCall('refresh_token', { refresh_token: st.session.refresh }).then(setSession).finally(() => { refreshing = null; });
  return refreshing;
}
async function rawRpc(fn, args) {
  const r = await http(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + st.session.access }, body: JSON.stringify(args || {}) });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
async function rpc(fn, args) {
  if (!st.session) throw err('Non connecté', { auth: true });
  if (Date.now() > st.session.exp - 60000) await refreshSession();
  let r = await rawRpc(fn, args);
  if (r.status === 401) { await refreshSession(); r = await rawRpc(fn, args); }
  if (!r.ok) {
    const denied = r.text.includes('not_allowed');
    throw err(denied ? 'Accès refusé' : 'Serveur ' + r.status + ' : ' + r.text.slice(0, 140), { denied, auth: r.status === 401 || r.text.includes('not_signed_in') });
  }
  return r.text ? JSON.parse(r.text) : null;
}

// ---------- ce que l’écran affiche = liste du serveur + modifications pas encore envoyées ----------
function applyOp(list, op) {
  if (op.kind === 'addStore') return list.some((s) => s.id === op.id) ? list : [...list, { id: op.id, name: op.name, createdAt: op.createdAt, balance: 0 }];
  if (op.kind === 'rename') return list.map((s) => (s.id === op.id ? { ...s, name: op.name } : s));
  if (op.kind === 'movement') {
    const d = op.type === 'delivery' ? op.count : op.type === 'return' ? -op.count : op.count;
    return list.map((s) => (s.id === op.storeId ? { ...s, balance: s.balance + d } : s));
  }
  return list;
}
function stores() { const seen = new Set(); let l = st.server; for (const o of st.outbox) { if (seen.has(o.opId)) continue; seen.add(o.opId); l = applyOp(l, o); } return l; }
function warehouse() {
  if (st.warehouse == null) return null;
  const seen = new Set(); let w = st.warehouse;
  for (const o of st.outbox) {
    if (seen.has(o.opId)) continue; seen.add(o.opId);
    if (o.kind === 'movement' && o.type === 'delivery') w -= o.count;
    else if (o.kind === 'movement' && o.type === 'return') w += o.count;
    else if (o.kind === 'warehouse') w += o.delta;
  }
  return w;
}
function dispatch(op) { st.outbox.push(op); save(); render(); renderHist(); sync(); }
const addStore = (name) => dispatch({ opId: uid(), kind: 'addStore', id: uid(), name, createdAt: iso() });
const renameStore = (id, name) => dispatch({ opId: uid(), kind: 'rename', id, name });
const move = (storeId, type, count) => { const id = uid(); dispatch({ opId: id, kind: 'movement', id, storeId, type, count, createdAt: iso() }); };
const whOp = (wkind, delta, note) => { const id = uid(); dispatch({ opId: id, kind: 'warehouse', id, wkind, delta, note: note || '', createdAt: iso() }); };

// ---------- synchronisation ----------
let syncing = false, again = false, status = 'syncing', statusMsg = '', serverHist = [], openId = null;
function setStatus(s, m) { status = s; statusMsg = m || ''; render(); }
async function pushOneByOne(batch) {
  for (const op of batch) {
    try { await rpc('apply_ops', { p_ops: [op] }); }
    catch (e) { if (e.net || e.auth || e.denied) throw e; st.rejected++; }
  }
}
async function sync() {
  if (!CONFIGURED || !st.session) return;
  if (syncing) { again = true; return; }
  syncing = true;
  if (st.outbox.length || status !== 'synced') setStatus('syncing');
  try {
    if (!st.profile || st.profile.role === 'pending') {
      st.profile = await rpc('me'); save(); route();
      if (st.profile.role === 'pending') { setStatus('synced'); return; }
    }
    do {
      again = false;
      const batch = st.outbox.slice(0, 200);
      if (batch.length) {
        try { await rpc('apply_ops', { p_ops: batch }); }
        catch (e) { if (e.net || e.auth || e.denied) throw e; await pushOneByOne(batch); }
        const sent = new Set(batch.map((o) => o.opId)); st.outbox = st.outbox.filter((o) => !sent.has(o.opId)); save();
        if (st.outbox.length) { again = true; continue; }
      }
      const res = await rpc('list_stores');
      st.server = res.stores.map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.createdAt), balance: Number(r.balance) || 0 }));
      st.warehouse = res.warehouse == null ? null : Number(res.warehouse);
      st.profile = Object.assign({}, st.profile, { role: res.role, name: res.name }); save(); route();
    } while (again);
    setStatus('synced'); if (openId) loadHist();
  } catch (e) {
    if (e.net) setStatus('offline');
    else if (e.denied) { try { st.profile = await rpc('me'); save(); route(); } catch (x) {} setStatus('error', 'Accès refusé'); }
    else if (e.auth) forceLogout('Session expirée. Reconnectez-vous.');
    else setStatus('error', e.message);
  } finally { syncing = false; }
}

// ---------- écrans ----------
function route() {
  const logged = !!st.session;
  const pending = logged && !!st.profile && st.profile.role === 'pending';
  $('loginScreen').classList.toggle('hide', logged);
  $('pendingScreen').classList.toggle('hide', !pending);
  $('main').classList.toggle('hide', !logged || pending);
  for (const id of ['add', 'adminCards', 'adminBar']) $(id).classList.toggle('hide', !isAdmin());
  if (!logged || pending) closeSheet();
  render();
}
function render() {
  const all = stores(), q = norm($('q').value);
  const sum = (l) => l.reduce((t, s) => t + s.balance, 0);
  const outside = sum(all);
  $('total').textContent = outside;
  $('across').textContent = 'Dans ' + all.length + (all.length <= 1 ? ' supermarché' : ' supermarchés');
  const w = warehouse();
  $('wh').textContent = w == null ? '–' : w;
  $('all').textContent = w == null ? '–' : w + outside;
  const shown = all.filter((s) => norm(s.name).includes(q)).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  $('sum').textContent = q ? shown.length + ' sur ' + all.length + ' trouvé(s) · ' + sum(shown) + ' ' + label(sum(shown)) : '';
  const n = st.outbox.length;
  const text = { syncing: 'Synchronisation…', error: 'Problème de serveur' + (statusMsg ? ' · ' + statusMsg : ''),
    offline: n ? 'Hors ligne · ' + n + (n === 1 ? ' modification' : ' modifications') + ' en attente d’envoi' : 'Hors ligne · dernière liste enregistrée affichée',
    synced: 'Partagé avec les autres appareils · à jour (appuyez pour actualiser)' }[status];
  $('status').textContent = text + (st.rejected ? ' · ' + st.rejected + ' modification(s) refusée(s) par le serveur' : '');
  $('status').className = status === 'offline' || status === 'error' ? 'bad' : '';
  $('who').textContent = st.profile ? 'Connecté : ' + st.profile.name + ' (' + (st.profile.role === 'admin' ? 'responsable' : 'travailleur') + ')' : '';
  const list = $('list'); list.textContent = '';
  if (!shown.length) {
    list.append(h('p', { class: 'sum' }, all.length ? 'Aucun supermarché trouvé.' : 'Aucun supermarché pour l’instant.' + (isAdmin() ? ' Appuyez sur « + Ajouter un magasin ».' : '')));
    if (all.length && q && isAdmin()) list.append(h('button', { onclick: () => openAdd($('q').value.trim()) }, 'Ajouter « ' + $('q').value.trim() + ' »'));
  }
  for (const s of shown) list.append(h('button', { class: 'row', onclick: () => openDetail(s.id) }, h('span', {}, s.name), h('b', {}, String(s.balance))));
}

// ---------- fenêtres ----------
const sheet = $('sheet'), body = $('sbody');
function closeSheet() { sheet.classList.add('hide'); openId = null; serverHist = []; }
function openSheet(nodes) { body.textContent = ''; body.append(...nodes); sheet.classList.remove('hide'); }
const closeBtn = () => h('button', { class: 'alt', onclick: closeSheet }, '✕');
sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function openAdd(prefill) {
  if (!isAdmin()) return;
  const inp = h('input', { maxlength: '60', placeholder: 'Nom du supermarché', value: prefill || '' }), e1 = h('p', { class: 'err' });
  const go = () => {
    const name = inp.value.trim();
    if (!name) { e1.textContent = 'Entrez le nom du supermarché.'; return; }
    if (stores().some((s) => norm(s.name) === norm(name))) { e1.textContent = 'Ce supermarché est déjà dans votre liste.'; return; }
    addStore(name); closeSheet(); $('q').value = ''; render();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  openSheet([h('div', { class: 'top' }, h('h2', {}, 'Ajouter un supermarché'), closeBtn()), h('label', {}, 'Nom'), inp, e1,
    h('button', { style: 'width:100%;margin-top:6px', onclick: go }, 'Ajouter le supermarché')]);
  inp.focus();
}

function openDetail(id) {
  openId = id; serverHist = [];
  const cur = () => stores().find((s) => s.id === id);
  let type = 'delivery';
  const title = h('h2', {}), bal = h('b', {}), balTxt = h('span', {});
  const parts = [];
  const top = h('div', { class: 'top' }, title);
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
  if (isAdmin()) top.append(h('button', { class: 'alt', 'aria-label': 'Modifier le nom', onclick: () => { nm.value = cur().name; nerr.textContent = ''; rbox.classList.remove('hide'); nm.focus(); } }, '✎'));
  top.append(closeBtn());
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
  const hist = h('div', { id: 'hist' });
  parts.push(top, isAdmin() ? rbox : null, h('div', { class: 'bal' }, bal, balTxt), h('div', { class: 'two' }, bDel, bRet),
    h('label', {}, 'Combien de caisses ?'), cnt, merr, h('button', { style: 'width:100%', onclick: rec }, 'Enregistrer'));
  if (isAdmin()) {
    const ex = h('input', { inputmode: 'numeric', placeholder: 'Total exact' }), xerr = h('p', { class: 'err' });
    const setEx = () => {
      const t = Number(ex.value), s = cur(); if (!s) return;
      if (ex.value.trim() === '' || !Number.isInteger(t) || t < 0) { xerr.textContent = 'Entrez un nombre entier, 0 ou plus.'; return; }
      if (t !== s.balance) move(id, 'correction', t - s.balance);
      ex.value = ''; xerr.textContent = '';
    };
    parts.push(h('label', {}, 'Ou définir le total exact (correction)'), h('div', { class: 'two' }, ex, h('button', { class: 'alt', style: 'flex:0 0 auto', onclick: setEx }, 'Valider')), xerr);
  }
  parts.push(h('label', {}, 'Activité récente'), hist);
  refreshDetail = () => { const s = cur(); if (!s) { closeSheet(); return; } title.textContent = s.name; bal.textContent = String(s.balance); balTxt.textContent = ' ' + label(s.balance) + ' encore chez ce supermarché'; };
  openSheet(parts); refreshDetail(); renderHist(); loadHist();
}
let refreshDetail = () => {};

const typeName = (t, c) => (t === 'delivery' ? 'Livré' : t === 'return' ? 'Repris' : 'Correction');
function histRows() {
  const me = st.profile ? st.profile.name : null;
  const pend = st.outbox.filter((o) => o.kind === 'movement' && o.storeId === openId).map((o) => ({ id: o.id, type: o.type, count: o.count, createdAt: o.createdAt, by: me })).reverse();
  return [...pend, ...serverHist.filter((r) => !pend.some((p) => p.id === r.id))].slice(0, 8);
}
function renderHist() {
  const el = $('hist'); if (!el || !openId) return; refreshDetail();
  const rows = histRows(); el.textContent = '';
  if (!rows.length) el.append(h('p', { class: 'sum' }, 'Aucune activité pour l’instant.'));
  for (const r of rows) {
    const d = new Date(r.createdAt), today = d.toDateString() === new Date().toDateString();
    const sign = r.type === 'delivery' ? '+' : r.type === 'return' ? '−' : (r.count > 0 ? '+' : '−');
    el.append(h('div', { class: 'hist' },
      h('span', {}, typeName(r.type) + ' · ' + (today ? 'Aujourd’hui' : d.toLocaleDateString('fr', { day: 'numeric', month: 'short' })) + (isAdmin() && r.by ? ' · ' + r.by : '')),
      h('b', { style: 'color:var(' + (sign === '+' ? '--pri' : '--bad') + ')' }, sign + Math.abs(r.count))));
  }
}
async function loadHist() {
  if (!CONFIGURED || !st.session || !openId) return; const id = openId;
  try { const rows = await rpc('list_movements', { p_store_id: id }); if (openId === id) { serverHist = rows.map((r) => ({ id: String(r.id), type: r.type, count: Number(r.count) || 0, createdAt: String(r.createdAt), by: r.by || null })); renderHist(); } } catch (e) {}
}

// ----- Entrepôt (responsable) -----
function openWarehouse() {
  if (!isAdmin()) return;
  const outside = stores().reduce((t, s) => t + s.balance, 0);
  const wNow = () => warehouse() || 0;
  const stats = h('div', { class: 'cards' }, h('div', {}, h('small', {}, 'EN ENTREPÔT'), h('b', {})), h('div', {}, h('small', {}, 'DEHORS'), h('b', {})));
  const total = h('p', { class: 'sum' });
  const paint = () => { stats.querySelectorAll('b')[0].textContent = wNow(); stats.querySelectorAll('b')[1].textContent = outside; total.textContent = 'Total possédé : ' + (wNow() + outside) + ' caisses'; };
  let kind = 'truck_in';
  const bIn = h('button', { class: 'sel' }, 'Reçu du camion +'), bOut = h('button', { class: 'alt' }, 'Remis au camion −'), bFix = h('button', { class: 'alt' }, 'Corriger');
  const num = h('input', { inputmode: 'numeric', placeholder: 'Nombre de caisses' }), note = h('input', { maxlength: '80', placeholder: 'Note (facultatif)' }), msg = h('p', { class: 'err' });
  const pickK = (k) => { kind = k; bIn.className = k === 'truck_in' ? 'sel' : 'alt'; bOut.className = k === 'truck_out' ? 'sel' : 'alt'; bFix.className = k === 'correction' ? 'sel' : 'alt';
    num.placeholder = k === 'correction' ? 'Total exact en entrepôt' : 'Nombre de caisses'; };
  bIn.onclick = () => pickK('truck_in'); bOut.onclick = () => pickK('truck_out'); bFix.onclick = () => pickK('correction');
  const saveWh = () => {
    const v = Number(num.value);
    if (num.value.trim() === '' || !Number.isInteger(v) || v < 0 || (kind !== 'correction' && v < 1)) { msg.textContent = 'Entrez un nombre entier valide.'; return; }
    if (kind === 'truck_out' && v > wNow()) { msg.textContent = 'Vous n’avez que ' + wNow() + ' caisses en entrepôt.'; return; }
    const delta = kind === 'truck_in' ? v : kind === 'truck_out' ? -v : v - wNow();
    if (delta === 0) { msg.textContent = 'Aucun changement.'; return; }
    whOp(kind, delta, note.value.trim()); num.value = ''; note.value = ''; msg.textContent = ''; paint();
  };
  const tv = h('input', { inputmode: 'numeric', placeholder: 'Le camion apporte… caisses' }), res = h('div', { class: 'res hide' });
  tv.oninput = () => {
    const n = Number(tv.value);
    if (tv.value.trim() === '' || !Number.isInteger(n) || n < 1) { res.classList.add('hide'); return; }
    res.classList.remove('hide');
    const w = wNow();
    res.className = 'res' + (w < n ? ' bad' : '');
    res.textContent = w >= n ? 'Vous devez rendre ' + n + ' caisses. Vous en avez ' + w + ' : c’est bon (il vous en restera ' + (w - n) + ').'
      : 'Vous devez rendre ' + n + ' caisses mais vous en avez ' + w + '. Il en manque ' + (n - w) + ' à acheter avec la marchandise.';
  };
  openSheet([h('div', { class: 'top' }, h('h2', {}, 'Entrepôt'), closeBtn()), h('div', { style: 'height:12px' }), stats, total,
    h('label', {}, 'Enregistrer un mouvement'), h('div', { class: 'two' }, bIn, bOut, bFix), h('div', { style: 'height:8px' }), num, h('div', { style: 'height:8px' }), note, msg,
    h('button', { style: 'width:100%', onclick: saveWh }, 'Enregistrer'),
    h('p', { class: 'sum' }, 'Les caisses « Livré » aux supermarchés sortent de l’entrepôt, et celles « Reprises » y rentrent automatiquement.'),
    h('label', {}, 'Camion du jour'), tv, res]);
  paint();
}

// ----- Journal (responsable) -----
async function openJournal() {
  if (!isAdmin()) return;
  const box = h('div', {}, h('p', { class: 'sum' }, 'Chargement…'));
  openSheet([h('div', { class: 'top' }, h('h2', {}, 'Journal'), h('button', { class: 'alt', onclick: openJournal }, '↻'), closeBtn()), h('p', { class: 'sum' }, 'Les 100 dernières opérations : qui a fait quoi.'), box]);
  try {
    const rows = await rpc('list_activity', { p_limit: 100 });
    box.textContent = '';
    if (!rows.length) box.append(h('p', { class: 'sum' }, 'Aucune opération.'));
    for (const r of rows) {
      const q = Number(r.qty), a = Math.abs(q), by = r.by || 'ancien enregistrement';
      let t = '';
      if (r.kind === 'movement') t = r.sub === 'delivery' ? 'Livré ' + a + ' à ' + r.store : r.sub === 'return' ? 'Repris ' + a + ' chez ' + r.store : 'Correction ' + (q > 0 ? '+' : '−') + a + ' chez ' + r.store;
      else if (r.kind === 'warehouse') t = 'Entrepôt : ' + (r.sub === 'truck_in' ? 'reçu du camion +' + a : r.sub === 'truck_out' ? 'remis au camion −' + a : 'correction ' + (q > 0 ? '+' : '−') + a) + (r.note ? ' (' + r.note + ')' : '');
      else t = { store_added: 'Magasin ajouté : ', store_renamed: 'Nom modifié : ', role_changed: 'Rôle modifié : ' }[r.sub] + (r.note || '');
      box.append(h('div', { class: 'log' }, t, h('small', {}, fmtDate(r.at) + ' · ' + by)));
    }
  } catch (e) { box.textContent = ''; box.append(h('p', { class: 'err' }, e.net ? 'Pas de connexion Internet.' : e.message)); }
}

// ----- Équipe (responsable) -----
async function openTeam() {
  if (!isAdmin()) return;
  const box = h('div', {}, h('p', { class: 'sum' }, 'Chargement…'));
  openSheet([h('div', { class: 'top' }, h('h2', {}, 'Équipe'), closeBtn()),
    h('p', { class: 'sum' }, 'Créez un compte dans Supabase (Authentication → Users → Add user), puis activez-le ici comme « Travailleur ».'), box]);
  try {
    const rows = await rpc('list_team');
    box.textContent = '';
    for (const m of rows) {
      const self = st.user && m.id === st.user.id, msg = h('p', { class: 'err' });
      const nameIn = h('input', { value: m.name, maxlength: '40' });
      nameIn.onchange = async () => { try { await rpc('set_name', { p_user: m.id, p_name: nameIn.value }); msg.textContent = ''; } catch (e) { msg.textContent = e.message; } };
      const sel = h('select', {}, h('option', { value: 'pending' }, 'En attente'), h('option', { value: 'worker' }, 'Travailleur'), h('option', { value: 'admin' }, 'Responsable'));
      sel.value = m.role; if (self) sel.disabled = true;
      sel.onchange = async () => { try { await rpc('set_role', { p_user: m.id, p_role: sel.value }); msg.textContent = 'Enregistré.'; } catch (e) { msg.textContent = e.message; sel.value = m.role; } };
      box.append(h('div', { class: 'member' }, nameIn, h('small', {}, (m.email || '') + (self ? ' (vous)' : '')), sel, msg));
    }
  } catch (e) { box.textContent = ''; box.append(h('p', { class: 'err' }, e.net ? 'Pas de connexion Internet.' : e.message)); }
}

// ---------- connexion / déconnexion ----------
function forceLogout(msg) { st.session = null; st.profile = null; save(); route(); $('lerr').textContent = msg || ''; setStatus('synced'); }
async function login() {
  const email = $('email').value.trim().toLowerCase(), pw = $('pw').value;
  if (!CONFIGURED) { $('lerr').textContent = 'Le site n’est pas configuré (fichier config.js).'; return; }
  if (!email || !pw) { $('lerr').textContent = 'Entrez votre email et votre mot de passe.'; return; }
  $('loginBtn').disabled = true; $('lerr').textContent = '';
  try {
    const d = await authCall('password', { email, password: pw });
    if (st.outbox.length && st.user && st.user.id !== d.user.id) { $('lerr').textContent = 'Des modifications non envoyées appartiennent à ' + st.user.email + '. Connectez-vous avec ce compte pour les envoyer.'; return; }
    if (st.user && st.user.id !== d.user.id) { st.server = []; st.warehouse = null; st.profile = null; }
    setSession(d); $('pw').value = '';
    try { st.profile = await rpc('me'); save(); } catch (e) { st.profile = null; }
    route(); sync();
  } catch (e) {
    $('lerr').textContent = e.net ? 'Pas de connexion Internet. Réessayez.' : e.auth ? 'Email ou mot de passe incorrect.' : e.message;
  } finally { $('loginBtn').disabled = false; }
}
function logout() {
  if (st.outbox.length) { $('lomsg').textContent = st.outbox.length + ' modification(s) pas encore envoyée(s). Attendez l’envoi (connexion Internet) avant de vous déconnecter.'; sync(); return; }
  $('lomsg').textContent = '';
  st.session = null; st.user = null; st.profile = null; st.server = []; st.warehouse = null; save(); route();
}

// ---------- démarrage ----------
$('loginBtn').onclick = login;
$('pw').onkeydown = (e) => { if (e.key === 'Enter') login(); };
$('logout').onclick = logout; $('pendLogout').onclick = logout;
$('pendRefresh').onclick = async () => { try { st.profile = await rpc('me'); save(); route(); if (st.profile.role !== 'pending') sync(); } catch (e) { if (e.auth) forceLogout('Session expirée. Reconnectez-vous.'); } };
$('add').onclick = () => openAdd('');
$('bWh').onclick = openWarehouse; $('bLog').onclick = openJournal; $('bTeam').onclick = openTeam;
$('q').oninput = render;
$('status').onclick = () => sync();
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', () => sync());
route(); sync();
})();
