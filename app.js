/**
 * Arruapan — Gestion des caisses à pain
 * Logistique & Traçabilité des caisses entre entrepôt et établissements.
 * Role-Based Access Control (RBAC): Responsable (admin) & Travailleur (worker)
 */

(function () {
  'use strict';

  // Configuration Supabase
  const CFG = window.APP_CONFIG || {};
  const URL_ = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
  const CONFIGURED = URL_.startsWith('https://') && !URL_.includes('PASTE') && KEY.length > 20 && !KEY.includes('PASTE');
  const LS = 'arruapan:v2';

  // Utilitaires DOM & Formatage
  const $ = (id) => document.getElementById(id);
  const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  const iso = () => new Date().toISOString();
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const label = (n) => (Math.abs(n) <= 1 ? 'caisse' : 'caisses');
  const err = (msg, flags) => Object.assign(new Error(msg), flags || {});

  const fmtDate = (s) => {
    if (!s) return '–';
    try {
      const d = new Date(s);
      const isToday = d.toDateString() === new Date().toDateString();
      const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      if (isToday) return `Aujourd'hui à ${timeStr}`;
      return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) + ` à ${timeStr}`;
    } catch (e) {
      return String(s);
    }
  };

  const fmtShortDate = (s) => {
    if (!s) return '–';
    try {
      const d = new Date(s);
      return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return String(s);
    }
  };

  // Helper pour créer des éléments DOM de manière sécurisée
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e[k] = v;
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c != null && c !== false) {
        e.append(c.nodeType ? c : document.createTextNode(c));
      }
    }
    return e;
  }

  // Toast Notification System
  function showToast(message, type = 'success', duration = 3500) {
    const container = $('toast-container');
    if (!container) return;

    const toast = h('div', { class: `toast ${type === 'error' ? 'toast-error' : type === 'warning' ? 'toast-warning' : ''}` },
      h('span', {}, message)
    );
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, duration);
  }

  // =========================================================================
  // ÉTAT DE L'APPLICATION & STOCKAGE LOCAL
  // =========================================================================
  let st = {
    session: null,
    user: null,
    profile: null,
    server: [],
    warehouse: null,
    outbox: [],
    rejected: 0
  };

  try {
    const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if (s && Array.isArray(s.server) && Array.isArray(s.outbox)) {
      st = Object.assign(st, s);
    }
  } catch (e) {
    console.error('Erreur lecture localStorage:', e);
  }

  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify(st));
    } catch (e) {
      console.error('Erreur écriture localStorage:', e);
    }
  }

  // Contrôles RBAC
  const isAdmin = () => !!st.profile && st.profile.role === 'admin';
  const isWorker = () => !!st.profile && st.profile.role === 'worker';
  const isPending = () => !!st.profile && st.profile.role === 'pending';

  // Navigation interne
  let currentView = 'dashboard';
  let storeFilter = 'all';
  let storeSearchQuery = '';
  let workerSearchQuery = '';
  let storeSortCriteria = 'balance-desc';
  let movementTypeFilterValue = 'all';
  let movementStoreFilterValue = 'all';

  // Cache mémoire pour les données serveur étendues
  let serverHistCache = [];
  let movementsCache = [];
  let serverTeamCache = [];
  let openStoreDetailId = null;

  // Nettoyage : ancienne session de démonstration éventuelle (le mode démo n'existe plus)
  if (st.session && String(st.session.access).startsWith('demo-')) {
    st = { session: null, user: null, profile: null, server: [], warehouse: null, outbox: [], rejected: 0 };
    save();
  }

  // =========================================================================
  // APPELS RÉSEAU ET SUPABASE
  // =========================================================================
  async function http(url, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      return await fetch(url, Object.assign({ signal: ctl.signal }, init));
    } catch (e) {
      throw err('Pas de connexion Internet ou serveur inaccessible.', { net: true });
    } finally {
      clearTimeout(t);
    }
  }

  async function authCall(grant, body) {
    const r = await http(URL_ + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw err(data.msg || data.error_description || data.message || 'Erreur d’authentification (' + r.status + ')', {
        auth: true,
        status: r.status
      });
    }
    return data;
  }

  function setSession(d) {
    st.session = {
      access: d.access_token,
      refresh: d.refresh_token,
      exp: Date.now() + (d.expires_in || 3600) * 1000
    };
    if (d.user) {
      st.user = { id: d.user.id, email: d.user.email };
    }
    save();
  }

  let refreshing = null;
  function refreshSession() {
    if (!st.session) return Promise.reject(err('Non connecté', { auth: true }));
    if (!refreshing) {
      refreshing = authCall('refresh_token', { refresh_token: st.session.refresh })
        .then(setSession)
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function rawRpc(fn, args) {
    const r = await http(URL_ + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: 'Bearer ' + st.session.access
      },
      body: JSON.stringify(args || {})
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  }

  async function rpc(fn, args) {
    if (!st.session) throw err('Non connecté', { auth: true });
    if (Date.now() > st.session.exp - 60000) {
      await refreshSession();
    }
    let r = await rawRpc(fn, args);
    if (r.status === 401) {
      await refreshSession();
      r = await rawRpc(fn, args);
    }
    if (!r.ok) {
      const denied = r.text.includes('not_allowed') || r.text.includes('permission denied');
      throw err(denied ? 'Accès refusé pour cette opération.' : 'Serveur ' + r.status + ' : ' + r.text.slice(0, 140), {
        denied,
        auth: r.status === 401 || r.text.includes('not_signed_in')
      });
    }
    return r.text ? JSON.parse(r.text) : null;
  }

  // =========================================================================
  // GESTION OPTIMISTE DU PARC DE CAISSES (SERVER + OUTBOX)
  // =========================================================================
  function applyOp(list, op) {
    if (op.kind === 'addStore') {
      return list.some((s) => s.id === op.id)
        ? list
        : [...list, { id: op.id, name: op.name, createdAt: op.createdAt, balance: 0 }];
    }
    if (op.kind === 'rename') {
      return list.map((s) => (s.id === op.id ? { ...s, name: op.name } : s));
    }
    if (op.kind === 'movement') {
      const delta = op.type === 'delivery' ? op.count : op.type === 'return' ? -op.count : op.count;
      return list.map((s) => (s.id === op.storeId ? { ...s, balance: s.balance + delta } : s));
    }
    return list;
  }

  function stores() {
    const seen = new Set();
    let l = st.server || [];
    for (const o of st.outbox) {
      if (seen.has(o.opId)) continue;
      seen.add(o.opId);
      l = applyOp(l, o);
    }
    return l;
  }

  function warehouse() {
    if (st.warehouse == null) return null;
    const seen = new Set();
    let w = st.warehouse;
    for (const o of st.outbox) {
      if (seen.has(o.opId)) continue;
      seen.add(o.opId);
      if (o.kind === 'movement' && o.type === 'delivery') w -= o.count;
      else if (o.kind === 'movement' && o.type === 'return') w += o.count;
      else if (o.kind === 'warehouse') w += o.delta;
    }
    return w;
  }

  function dispatch(op) {
    st.outbox.push(op);
    save();
    renderAll();
    sync();
  }

  // Opérations métier
  const addStore = (name) => {
    if (!(isAdmin() || isWorker())) throw err('Compte non activé.', { denied: true });
    dispatch({ opId: uid(), kind: 'addStore', id: uid(), name, createdAt: iso() });
  };

  const renameStore = (id, name) => {
    if (!(isAdmin() || isWorker())) throw err('Compte non activé.', { denied: true });
    dispatch({ opId: uid(), kind: 'rename', id, name });
  };

  const move = (storeId, type, count) => {
    const id = uid();
    dispatch({
      opId: id,
      kind: 'movement',
      id,
      storeId,
      type,
      count: Number(count),
      createdAt: iso(),
      by: st.profile ? st.profile.name : null
    });
  };

  const whOp = (wkind, delta, note) => {
    if (!isAdmin()) throw err('Seul un Responsable peut ajuster l’entrepôt.', { denied: true });
    const id = uid();
    dispatch({
      opId: id,
      kind: 'warehouse',
      id,
      wkind,
      delta: Number(delta),
      note: note || '',
      createdAt: iso(),
      by: st.profile ? st.profile.name : null
    });
  };

  // =========================================================================
  // SYNCHRONISATION EN ARRIÈRE-PLAN
  // =========================================================================
  let syncing = false;
  let syncAgain = false;
  let syncStatus = 'synced'; // 'synced' | 'syncing' | 'offline' | 'error'
  let syncStatusMsg = '';

  function setSyncStatus(s, m) {
    syncStatus = s;
    syncStatusMsg = m || '';
    renderSyncPill();
  }

  async function pushOneByOne(batch) {
    for (const op of batch) {
      try {
        await rpc('apply_ops', { p_ops: [op] });
      } catch (e) {
        if (e.net || e.auth || e.denied) throw e;
        st.rejected++;
      }
    }
  }

  async function sync() {
    if (!CONFIGURED || !st.session) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    if (st.outbox.length || syncStatus !== 'synced') {
      setSyncStatus('syncing', 'Synchronisation…');
    }

    try {
      // 1. Profil utilisateur / vérification rôle
      if (!st.profile || st.profile.role === 'pending') {
        st.profile = await rpc('me');
        save();
        route();
        if (st.profile.role === 'pending') {
          setSyncStatus('synced');
          return;
        }
      }

      // 2. Traitement outbox
      do {
        syncAgain = false;
        const batch = st.outbox.slice(0, 200);
        if (batch.length) {
          try {
            await rpc('apply_ops', { p_ops: batch });
          } catch (e) {
            if (e.net || e.auth || e.denied) throw e;
            await pushOneByOne(batch);
          }
          const sent = new Set(batch.map((o) => o.opId));
          st.outbox = st.outbox.filter((o) => !sent.has(o.opId));
          save();
          if (st.outbox.length) {
            syncAgain = true;
            continue;
          }
        }

        // 3. Récupération des magasins et du stock
        const res = await rpc('list_stores');
        st.server = (res.stores || []).map((r) => ({
          id: String(r.id),
          name: String(r.name),
          createdAt: String(r.createdAt),
          balance: Number(r.balance) || 0
        }));
        st.warehouse = res.warehouse == null ? null : Number(res.warehouse);
        st.profile = Object.assign({}, st.profile, { role: res.role, name: res.name });
        save();
      } while (syncAgain);

      setSyncStatus('synced', 'À jour');
      renderAll();

      if (openStoreDetailId) {
        loadStoreHistory(openStoreDetailId);
      }
      if (isAdmin() && (currentView === 'dashboard' || currentView === 'movements')) {
        loadMovementsData();
      }
      if (currentView === 'team' && isAdmin()) {
        loadTeamData();
      }
    } catch (e) {
      if (e.net) {
        setSyncStatus('offline', 'Hors ligne');
      } else if (e.denied) {
        try {
          st.profile = await rpc('me');
          save();
          route();
        } catch (x) {}
        setSyncStatus('error', 'Accès refusé');
      } else if (e.auth) {
        forceLogout('Votre session a expiré. Veuillez vous reconnecter.');
      } else {
        setSyncStatus('error', e.message || 'Erreur serveur');
      }
    } finally {
      syncing = false;
    }
  }

  // =========================================================================
  // ROUTAGE ET GESTION DES VUES (RBAC)
  // =========================================================================
  function route() {
    const logged = !!st.session;
    const pending = logged && isPending();

    $('loginScreen').classList.toggle('hide', logged);
    $('pendingScreen').classList.toggle('hide', !pending);
    $('appShell').classList.toggle('hide', !logged || pending);

    if (!logged || pending) {
      closeModal();
      return;
    }

    // Gestion du rôle dans l'interface
    const admin = isAdmin();
    const roleName = admin ? 'Responsable' : 'Travailleur';
    const roleBadgeClass = admin ? 'badge-indigo' : 'badge-emerald';

    // Rôle dans la barre latérale
    const roleBadge = $('sidebarRoleBadge');
    if (roleBadge) {
      roleBadge.textContent = roleName;
      roleBadge.className = `badge ${roleBadgeClass}`;
    }

    const userName = st.profile ? st.profile.name : (st.user ? st.user.email : 'Utilisateur');
    if ($('sidebarUserName')) $('sidebarUserName').textContent = userName;
    if ($('sidebarUserRole')) $('sidebarUserRole').textContent = roleName;
    if ($('sidebarAvatar')) $('sidebarAvatar').textContent = (userName.charAt(0) || 'U').toUpperCase();

    // Masquage / affichage strict des éléments réservés aux administrateurs
    document.querySelectorAll('.admin-only').forEach((el) => {
      el.classList.toggle('hide', !admin);
    });

    // Titres adaptés aux travailleurs
    if ($('navDashboardText')) {
      $('navDashboardText').textContent = admin ? 'Tableau de bord' : 'Mon Espace Travailleur';
    }

    // Éléments réservés aux travailleurs
    document.querySelectorAll('.worker-only').forEach((el) => {
      el.classList.toggle('hide', admin);
    });

    // Un travailleur n'a accès qu'à son espace
    if (!admin && currentView !== 'dashboard') {
      currentView = 'dashboard';
    }

    switchView(currentView);
    renderAll();
  }

  function switchView(viewName) {
    // Vérification de sécurité RBAC côté client
    if (!isAdmin() && viewName !== 'dashboard') {
      viewName = 'dashboard';
    }

    currentView = viewName;

    // Fermeture du menu mobile et du voile d’arrière-plan s’ils étaient ouverts
    const sidebar = $('appSidebar');
    if (sidebar) sidebar.classList.remove('open');
    const backdrop = $('sidebarBackdrop');
    if (backdrop) backdrop.classList.add('hide');

    // Mise à jour des boutons de navigation (Sidebar + Bottom Nav)
    document.querySelectorAll('[data-view]').forEach((btn) => {
      const match = btn.getAttribute('data-view') === viewName;
      btn.classList.toggle('active', match);
    });

    // Basculement des sections de page
    document.querySelectorAll('.page-view').forEach((sec) => {
      sec.classList.add('hide');
    });

    const activeSec = $(`view-${viewName}`);
    if (activeSec) activeSec.classList.remove('hide');

    // Titre de la barre supérieure (concis pour mobile et bureau)
    const titles = {
      dashboard: isAdmin() ? 'Tableau de bord' : 'Mon Espace',
      stores: 'Établissements',
      warehouse: 'Entrepôt',
      movements: 'Mouvements',
      team: 'Équipe'
    };
    if ($('pageTitle')) $('pageTitle').textContent = titles[viewName] || 'Arruapan';

    // Chargement dynamique des données distantes selon la vue
    if ((viewName === 'movements' || viewName === 'dashboard') && isAdmin()) loadMovementsData();
    if (viewName === 'team' && isAdmin()) loadTeamData();
    if (viewName === 'movements') populateMovementStoreFilter();

    renderAll();
  }

  // =========================================================================
  // RENDU DES VUES & CALCULS EN TEMPS RÉEL (AUCUNE STATISTIQUE INVENTÉE)
  // =========================================================================
  function renderAll() {
    renderSyncPill();
    renderDashboard();
    renderStores();
    renderWorkerStores();
    renderWarehouse();
    renderMovements();
  }

  function renderSyncPill() {
    const pill = $('syncStatusPill');
    const textEl = $('syncStatusText');
    const outboxCount = st.outbox.length;

    if (pill && textEl) {
      pill.className = `sync-pill ${syncStatus}`;
      const dot = pill.querySelector('.sync-dot');
      if (dot) dot.classList.toggle('pulse', syncStatus === 'syncing');

      if (syncStatus === 'syncing') {
        textEl.textContent = outboxCount ? `Envoi (${outboxCount})…` : 'Synchronisation…';
      } else if (syncStatus === 'offline') {
        textEl.textContent = outboxCount ? `Hors ligne (${outboxCount} en attente)` : 'Hors ligne';
      } else if (syncStatus === 'error') {
        textEl.textContent = syncStatusMsg || 'Erreur serveur';
      } else {
        textEl.textContent = 'En ligne';
      }
    }

    // Bannière hors-ligne dans le dashboard
    const banner = $('offlineNoticeBanner');
    if (banner) {
      banner.classList.toggle('hide', outboxCount === 0);
      const countEl = $('offlineBannerCount');
      if (countEl) {
        countEl.textContent = `Vous avez ${outboxCount} modification(s) enregistrée(s) localement en attente de réseau.`;
      }
    }
  }

  // --- 1. Rendu du Dashboard ---
  function renderDashboard() {
    const allStores = stores();
    const sumOutside = allStores.reduce((acc, s) => acc + s.balance, 0);
    const whStock = warehouse();
    const totalPark = whStock != null ? whStock + sumOutside : sumOutside;

    // Métriques
    if ($('dashCratesOutside')) $('dashCratesOutside').textContent = sumOutside;
    if ($('dashStoresCountText')) {
      $('dashStoresCountText').textContent = `Dans ${allStores.length} magasins`;
    }
    if ($('dashCratesWarehouse')) $('dashCratesWarehouse').textContent = whStock == null ? '–' : whStock;
    if ($('dashCratesTotal')) $('dashCratesTotal').textContent = whStock == null ? '–' : totalPark;
    if ($('dashStoresActive')) $('dashStoresActive').textContent = allStores.length;

    const holdingStores = allStores.filter((s) => s.balance > 0);
    if ($('dashStoresHoldingSub')) {
      $('dashStoresHoldingSub').textContent = `${holdingStores.length} avec caisses`;
    }

    // Établissements avec caisses à récupérer en priorité (clic sur la ligne = ouvrir le magasin)
    const priorityList = allStores.filter((s) => s.balance > 0).sort((a, b) => b.balance - a.balance);
    const tableBody = $('dashHighRetentionList');
    const mobileBody = $('dashHighRetentionMobileList');
    const alertCard = $('dashRetentionAlertCard');

    if (alertCard) alertCard.classList.toggle('hide', priorityList.length === 0 || !isAdmin());
    if (mobileBody) mobileBody.textContent = '';

    if (tableBody) {
      tableBody.textContent = '';
      if (!priorityList.length) {
        tableBody.append(
          h('tr', {},
            h('td', { colspan: '2', style: 'text-align: center; color: var(--text-muted); padding: 24px;' },
              'Toutes les caisses sont rentrées ! Aucun établissement ne détient de caisses en ce moment.'
            )
          )
        );
      } else {
        for (const s of priorityList.slice(0, 5)) {
          const isHigh = s.balance >= 30;
          tableBody.append(
            h('tr', { class: 'clickable-row', onclick: () => openStoreDetailModal(s.id) },
              h('td', { style: 'font-weight: 600;' }, s.name),
              h('td', {}, h('span', { class: `cell-balance ${isHigh ? 'high' : 'positive'}` }, String(s.balance)))
            )
          );

          if (mobileBody) {
            mobileBody.append(
              h('div', { class: 'store-touch-card clickable', style: 'border-left: 4px solid var(--amber-500);', onclick: () => openStoreDetailModal(s.id) },
                h('div', { class: 'store-touch-header' },
                  h('div', { class: 'store-touch-info' },
                    h('div', { class: 'store-touch-title' }, s.name)
                  ),
                  h('div', { class: 'store-touch-badge-col' },
                    h('div', { class: 'store-touch-num high' }, String(s.balance))
                  )
                )
              )
            );
          }
        }
      }
    }

    // Flux récent des opérations (combiné : outbox en attente + activités serveur)
    renderDashboardRecentFeed();
  }

  function renderDashboardRecentFeed() {
    const feed = $('dashRecentFeed');
    if (!feed) return;
    feed.textContent = '';
    if (!isAdmin()) return;

    const localMoves = st.outbox
      .filter((o) => o.kind === 'movement')
      .map((o) => {
        const store = stores().find((s) => s.id === o.storeId);
        return { storeName: store ? store.name : 'Magasin', type: o.type, count: o.count, createdAt: o.createdAt, by: o.by || (st.profile ? st.profile.name : null), isPending: true };
      })
      .reverse();

    const combined = [...localMoves, ...movementsCache];
    if (!combined.length) {
      feed.append(
        h('div', { class: 'empty-state', style: 'padding: 24px;' },
          h('p', {}, 'Aucun mouvement enregistré pour l’instant.')
        )
      );
      return;
    }

    for (const item of combined.slice(0, 6)) {
      const isDeliv = item.type === 'delivery';
      const isRet = item.type === 'return';
      const sign = isDeliv ? '+' : isRet ? '−' : (item.count > 0 ? '+' : '−');
      const qtyClass = isDeliv ? 'plus' : isRet ? 'minus' : 'fix';
      const typeLabel = isDeliv ? 'Livraison' : isRet ? 'Reprise' : 'Correction';
      feed.append(
        h('div', { class: 'timeline-row' },
          h('div', { class: 'timeline-info' },
            h('span', { class: 'timeline-title' }, `${typeLabel} · ${item.storeName || 'Magasin'}`),
            h('span', { class: 'timeline-sub' }, `${fmtDate(item.createdAt)} · ${item.by || '—'}${item.isPending ? ' · En attente de sync' : ''}`)
          ),
          h('div', { class: `timeline-qty ${qtyClass}` }, `${sign}${Math.abs(item.count)}`)
        )
      );
    }
  }

  // --- 2. Rendu des Établissements & Magasins ---
  function renderStores() {
    const all = stores();
    const query = norm(storeSearchQuery);

    // Mise à jour des compteurs sur les filtres
    const countAll = all.length;
    const countOutside = all.filter((s) => s.balance > 0).length;
    const countHigh = all.filter((s) => s.balance >= 20).length;
    const countZero = all.filter((s) => s.balance === 0).length;

    if ($('chipCountAll')) $('chipCountAll').textContent = countAll;
    if ($('chipCountOutside')) $('chipCountOutside').textContent = countOutside;
    if ($('chipCountHigh')) $('chipCountHigh').textContent = countHigh;
    if ($('chipCountZero')) $('chipCountZero').textContent = countZero;
    if ($('navStoresCount')) $('navStoresCount').textContent = countAll;

    // Application des filtres
    let filtered = all.filter((s) => {
      const matchSearch = norm(s.name).includes(query);
      if (!matchSearch) return false;

      if (storeFilter === 'outside') return s.balance > 0;
      if (storeFilter === 'high') return s.balance >= 20;
      if (storeFilter === 'zero') return s.balance === 0;
      return true;
    });

    // Tri
    filtered.sort((a, b) => {
      if (storeSortCriteria === 'balance-desc') return b.balance - a.balance || a.name.localeCompare(b.name);
      if (storeSortCriteria === 'balance-asc') return a.balance - b.balance || a.name.localeCompare(b.name);
      if (storeSortCriteria === 'name-asc') return a.name.localeCompare(b.name);
      if (storeSortCriteria === 'name-desc') return b.name.localeCompare(a.name);
      return 0;
    });

    const tbody = $('storesTableBody');
    const mobileList = $('storesMobileList');
    if (tbody) tbody.textContent = '';
    if (mobileList) mobileList.textContent = '';

    if (!filtered.length) {
      if (tbody) {
        tbody.append(
          h('tr', {},
            h('td', { colspan: '3' },
              h('div', { class: 'empty-state' },
                h('div', { class: 'empty-icon-box' },
                  h('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
                    h('circle', { cx: '11', cy: '11', r: '8' }),
                    h('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })
                  )
                ),
                h('h4', {}, all.length ? 'Aucun établissement ne correspond aux critères.' : 'Aucun établissement répertorié pour le moment.'),
                h('p', {}, all.length ? 'Modifiez votre recherche ou réinitialisez les filtres.' : (isAdmin() ? 'Commencez par ajouter votre premier supermarché ou boulangerie partenaire.' : 'Votre responsable doit d’abord ajouter des magasins.')),
                (isAdmin() && !all.length) ? h('button', { class: 'btn-primary', onclick: () => openAddStoreModal() }, '+ Ajouter un magasin') : null
              )
            )
          )
        );
      }

      if (mobileList) {
        mobileList.append(
          h('div', { class: 'empty-state', style: 'padding: 24px;' },
            h('div', { class: 'empty-icon-box' },
              h('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
                h('circle', { cx: '11', cy: '11', r: '8' }),
                h('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })
              )
            ),
            h('h4', {}, all.length ? 'Aucun établissement trouvé.' : 'Aucun magasin enregistré.'),
            h('p', {}, all.length ? 'Modifiez vos filtres ou votre recherche.' : (isAdmin() ? 'Ajoutez un établissement pour démarrer.' : 'Votre responsable doit ajouter des magasins.')),
            (isAdmin() && !all.length) ? h('button', { class: 'btn-primary', onclick: () => openAddStoreModal() }, '+ Ajouter un magasin') : null
          )
        );
      }
      return;
    }

    for (const s of filtered) {
      const isHigh = s.balance >= 30;
      const isZero = s.balance === 0;

      if (tbody) {
        tbody.append(
          h('tr', { class: 'clickable-row', onclick: () => openStoreDetailModal(s.id) },
            h('td', { style: 'font-weight: 600;' }, s.name),
            h('td', {},
              h('span', { class: `cell-balance ${isHigh ? 'high' : isZero ? 'zero' : 'positive'}` }, String(s.balance)),
              h('span', { style: 'font-size: 0.8rem; color: var(--text-muted); margin-left: 6px;' }, label(s.balance))
            ),
            h('td', { style: 'color: var(--text-muted); font-size: 0.85rem;' }, fmtShortDate(s.createdAt))
          )
        );
      }

      if (mobileList) {
        mobileList.append(
          h('div', { class: 'store-touch-card clickable', onclick: () => openStoreDetailModal(s.id) },
            h('div', { class: 'store-touch-header' },
              h('div', { class: 'store-touch-info' },
                h('div', { class: 'store-touch-title' }, s.name),
                h('div', { class: 'store-touch-sub' }, `Ajouté le ${fmtShortDate(s.createdAt)}`)
              ),
              h('div', { class: 'store-touch-badge-col' },
                h('div', { class: `store-touch-num ${isHigh ? 'high' : isZero ? 'zero' : 'positive'}` }, String(s.balance))
              )
            )
          )
        );
      }
    }
  }

  // --- 2b. Liste des établissements pour le travailleur (son unique page) ---
  function renderWorkerStores() {
    const box = $('workerStoresList');
    if (!box || isAdmin()) return;
    const all = stores();
    const q = norm(workerSearchQuery);
    const list = all.filter((s) => norm(s.name).includes(q)).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    if ($('workerStoresCount')) $('workerStoresCount').textContent = q ? `${list.length} sur ${all.length}` : all.length;
    box.textContent = '';
    if (!list.length) {
      box.append(h('div', { class: 'empty-state', style: 'padding: 20px;' },
        h('p', {}, all.length ? 'Aucun établissement trouvé.' : 'Aucun établissement pour l’instant. Appuyez sur « + Ajouter un magasin ».')));
      return;
    }
    for (const s of list) {
      box.append(h('button', { type: 'button', class: 'worker-store-row', onclick: () => openStoreDetailModal(s.id) },
        h('span', { class: 'ws-name' }, s.name),
        h('span', { class: `ws-num ${s.balance === 0 ? 'zero' : ''}` }, String(s.balance))));
    }
  }

  // --- 3. Rendu de l'Entrepôt (Responsable) ---
  function renderWarehouse() {
    if (!isAdmin()) return;
    const wNow = warehouse() || 0;
    const outside = stores().reduce((t, s) => t + s.balance, 0);

    if ($('whCurrentStock')) $('whCurrentStock').textContent = wNow;
    if ($('whOutsideStock')) $('whOutsideStock').textContent = outside;
    if ($('whTotalPark')) $('whTotalPark').textContent = wNow + outside;
  }

  // --- 4. Rendu des Mouvements Globaux & Traceability ---
  async function loadMovementsData() {
    if (!isAdmin()) return;
    try {
      const rows = await rpc('list_activity', { p_limit: 300 });
      movementsCache = (rows || [])
        .filter((r) => r.kind === 'movement')
        .map((r) => ({
          storeName: r.store || 'Magasin',
          type: r.sub,
          count: Number(r.qty) || 0,
          createdAt: String(r.at),
          by: r.by || null
        }));
      renderMovements();
      renderDashboardRecentFeed();
    } catch (e) {
      console.error('Erreur chargement mouvements:', e);
    }
  }

  function renderMovements() {
    if (!isAdmin()) return;
    const all = stores();
    const tbody = $('movementsTableBody');
    const mobileMoves = $('movementsMobileList');
    if (tbody) tbody.textContent = '';
    if (mobileMoves) mobileMoves.textContent = '';

    const localMoves = st.outbox
      .filter((o) => o.kind === 'movement')
      .map((o) => {
        const store = all.find((s) => s.id === o.storeId);
        return { storeName: store ? store.name : 'Magasin', type: o.type, count: o.count, createdAt: o.createdAt, by: o.by || (st.profile ? st.profile.name : null), isPending: true };
      })
      .reverse();

    let combined = [...localMoves, ...movementsCache];

    if (movementTypeFilterValue !== 'all') {
      combined = combined.filter((m) => m.type === movementTypeFilterValue);
    }
    if (movementStoreFilterValue !== 'all') {
      const sel = all.find((s) => s.id === movementStoreFilterValue);
      combined = combined.filter((m) => sel && m.storeName === sel.name);
    }

    if (!combined.length) {
      if (tbody) {
        tbody.append(
          h('tr', {},
            h('td', { colspan: '5' },
              h('div', { class: 'empty-state', style: 'padding: 32px;' },
                h('p', {}, 'Aucun mouvement ne correspond aux filtres sélectionnés.')
              )
            )
          )
        );
      }
      if (mobileMoves) {
        mobileMoves.append(
          h('div', { class: 'empty-state', style: 'padding: 24px;' },
            h('p', {}, 'Aucun mouvement ne correspond aux critères.')
          )
        );
      }
      return;
    }

    for (const m of combined) {
      const isDeliv = m.type === 'delivery';
      const isRet = m.type === 'return';
      const badgeClass = isDeliv ? 'badge-navy' : isRet ? 'badge-emerald' : 'badge-amber';
      const typeLabel = isDeliv ? 'Livraison (+)' : isRet ? 'Reprise (−)' : 'Correction';
      const sign = isDeliv ? '+' : isRet ? '−' : (m.count > 0 ? '+' : '−');
      const qtyColor = isDeliv ? 'var(--navy-900)' : isRet ? 'var(--emerald-600)' : 'var(--amber-600)';
      const borderAccent = isDeliv ? 'var(--navy-700)' : isRet ? 'var(--emerald-500)' : 'var(--amber-500)';
      const who = m.by || '—';

      if (tbody) {
        tbody.append(
          h('tr', {},
            h('td', { style: 'font-size: 0.85rem; color: var(--text-muted);' }, fmtDate(m.createdAt)),
            h('td', { style: 'font-weight: 600;' }, m.storeName || 'Magasin'),
            h('td', {}, h('span', { class: `badge ${badgeClass}` }, typeLabel)),
            h('td', {}, h('b', { style: `font-size: 1.05rem; color: ${qtyColor}` }, `${sign}${Math.abs(m.count)}`)),
            h('td', { style: 'font-size: 0.85rem;' },
              who,
              m.isPending ? h('span', { class: 'badge badge-gray', style: 'margin-left: 8px;' }, 'En cours de sync') : null
            )
          )
        );
      }

      if (mobileMoves) {
        mobileMoves.append(
          h('div', { class: 'movement-touch-card', style: `border-left: 4px solid ${borderAccent};` },
            h('div', { style: 'display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;' },
              h('div', {},
                h('div', { style: 'font-weight: 700; font-size: 0.98rem; color: var(--navy-950);' }, m.storeName || 'Magasin'),
                h('div', { style: 'font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;' }, fmtDate(m.createdAt))
              ),
              h('div', { style: `font-size: 1.45rem; font-weight: 800; color: ${qtyColor}; line-height: 1; text-align: right;` },
                `${sign}${Math.abs(m.count)}`,
                h('div', { style: 'font-size: 0.7rem; font-weight: 600; color: var(--text-muted);' }, label(m.count))
              )
            ),
            h('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-light); font-size: 0.8rem; color: var(--text-muted);' },
              h('span', { class: `badge ${badgeClass}`, style: 'font-size: 0.72rem; padding: 2px 7px;' }, typeLabel),
              h('span', {}, who, m.isPending ? h('span', { class: 'badge badge-gray', style: 'margin-left: 6px;' }, 'En attente') : null)
            )
          )
        );
      }
    }
  }

  function populateMovementStoreFilter() {
    const sel = $('movementStoreFilter');
    if (!sel) return;
    const currentVal = sel.value;
    sel.textContent = '';
    sel.append(h('option', { value: 'all' }, 'Tous les établissements'));

    const list = [...stores()].sort((a, b) => a.name.localeCompare(b.name));
    for (const s of list) {
      sel.append(h('option', { value: s.id }, `${s.name} (${s.balance} caisses)`));
    }
    sel.value = currentVal || 'all';
  }

  // =========================================================================
  // GESTION DE L'ÉQUIPE (RESPONSABLE ONLY)
  // =========================================================================
  async function loadTeamData() {
    if (!isAdmin()) return;
    const pendingList = $('teamPendingList');
    const activeList = $('teamActiveList');
    if (!pendingList || !activeList) return;

    pendingList.textContent = 'Chargement des comptes…';
    activeList.textContent = 'Chargement des comptes…';

    try {
      const rows = await rpc('list_team');
      serverTeamCache = rows || [];
      renderTeamLists();
    } catch (e) {
      pendingList.textContent = '';
      activeList.textContent = '';
      pendingList.append(h('p', { class: 'form-err' }, e.net ? 'Pas de connexion.' : e.message));
    }
  }

  function renderTeamLists() {
    const pendingList = $('teamPendingList');
    const activeList = $('teamActiveList');
    const pendingCard = $('teamPendingCard');
    const pendingBadge = $('teamPendingCountBadge');
    const navPendingBadge = $('navPendingCount');

    if (!pendingList || !activeList) return;

    const pendingUsers = serverTeamCache.filter((u) => u.role === 'pending');
    const activeUsers = serverTeamCache.filter((u) => u.role !== 'pending');

    if (pendingBadge) pendingBadge.textContent = pendingUsers.length;
    if (navPendingBadge) {
      navPendingBadge.textContent = pendingUsers.length;
      navPendingBadge.classList.toggle('hide', pendingUsers.length === 0);
    }
    if (pendingCard) pendingCard.classList.toggle('hide', pendingUsers.length === 0);

    // 1. Liste des comptes en attente d'approbation
    pendingList.textContent = '';
    if (!pendingUsers.length) {
      pendingList.append(h('p', { style: 'color: var(--text-muted); font-size: 0.9rem;' }, 'Aucune demande en attente.'));
    } else {
      for (const u of pendingUsers) {
        const itemBox = h('div', { class: 'timeline-row', style: 'padding: 14px; margin-bottom: 8px;' },
          h('div', { class: 'timeline-info' },
            h('span', { class: 'timeline-title' }, u.name || 'Nouvel utilisateur'),
            h('span', { class: 'timeline-sub' }, u.email || 'Email non renseigné')
          ),
          h('div', { style: 'display: flex; gap: 8px;' },
            h('button', {
              class: 'btn-emerald btn-sm',
              onclick: async () => {
                try {
                  await rpc('set_role', { p_user: u.id, p_role: 'worker' });
                  showToast(`Compte ${u.name || u.email} activé comme Travailleur !`);
                  loadTeamData();
                } catch (e) {
                  showToast(e.message, 'error');
                }
              }
            }, 'Activer Travailleur'),
            h('button', {
              class: 'btn-primary btn-sm',
              onclick: async () => {
                try {
                  await rpc('set_role', { p_user: u.id, p_role: 'admin' });
                  showToast(`Compte ${u.name || u.email} activé comme Responsable !`);
                  loadTeamData();
                } catch (e) {
                  showToast(e.message, 'error');
                }
              }
            }, 'Activer Responsable')
          )
        );
        pendingList.append(itemBox);
      }
    }

    // 2. Liste des membres actifs
    activeList.textContent = '';
    for (const m of activeUsers) {
      const isSelf = st.user && m.id === st.user.id;
      const rowErr = h('div', { class: 'form-err' });

      // Modification du nom
      const nameInput = h('input', {
        value: m.name || '',
        maxlength: '40',
        style: 'max-width: 200px; padding: 7px 10px; font-size: 0.88rem;'
      });
      nameInput.onchange = async () => {
        try {
          await rpc('set_name', { p_user: m.id, p_name: nameInput.value.trim() });
          showToast(`Nom mis à jour pour ${m.email}`);
          rowErr.textContent = '';
        } catch (e) {
          rowErr.textContent = e.message;
        }
      };

      // Sélecteur de rôle (Admin, Worker, Pending pour désactiver)
      const roleSelect = h('select', { style: 'max-width: 160px; padding: 7px 10px; font-size: 0.88rem;' },
        h('option', { value: 'worker' }, 'Travailleur'),
        h('option', { value: 'admin' }, 'Responsable'),
        h('option', { value: 'pending' }, 'Désactiver (En attente)')
      );
      roleSelect.value = m.role;

      if (isSelf) {
        roleSelect.disabled = true;
        roleSelect.title = 'Vous ne pouvez pas modifier votre propre rôle pour éviter tout verrouillage.';
      }

      roleSelect.onchange = async () => {
        if (!confirm(`Confirmez-vous le passage de ${m.name || m.email} au rôle "${roleSelect.options[roleSelect.selectedIndex].text}" ?`)) {
          roleSelect.value = m.role;
          return;
        }
        try {
          await rpc('set_role', { p_user: m.id, p_role: roleSelect.value });
          showToast(`Rôle mis à jour.`);
          rowErr.textContent = '';
          loadTeamData();
        } catch (e) {
          rowErr.textContent = e.message;
          roleSelect.value = m.role;
        }
      };

      const memberBox = h('div', { class: 'timeline-row', style: 'padding: 14px; margin-bottom: 8px;' },
        h('div', { class: 'timeline-info', style: 'flex: 1;' },
          nameInput,
          h('span', { class: 'timeline-sub', style: 'margin-top: 4px;' },
            `${m.email || ''} ${isSelf ? ' (Votre compte actuel)' : ''}`
          ),
          rowErr
        ),
        h('div', { style: 'display: flex; align-items: center; gap: 8px;' },
          roleSelect
        )
      );

      activeList.append(memberBox);
    }
  }

  // =========================================================================
  // GESTION DU MODAL SYSTÈME & ACTIONS SPÉCIFIQUES
  // =========================================================================
  const modalBackdrop = $('modalBackdrop');
  const modalBody = $('modalBody');
  const modalTitle = $('modalTitle');

  function closeModal() {
    if (modalBackdrop) modalBackdrop.classList.add('hide');
    openStoreDetailId = null;
  }

  function openModal(title, nodes) {
    if (modalTitle) modalTitle.textContent = title;
    if (modalBody) {
      modalBody.textContent = '';
      modalBody.append(...nodes);
    }
    if (modalBackdrop) modalBackdrop.classList.remove('hide');
  }

  // --- Modal : Ajouter un établissement (Responsable) ---
  function openAddStoreModal(prefill = '') {
    if (!(isAdmin() || isWorker())) {
      showToast('Votre compte n’est pas encore activé.', 'error');
      return;
    }

    const inp = h('input', {
      maxlength: '60',
      placeholder: 'Nom du supermarché ou de la boulangerie',
      value: prefill || ''
    });
    const errBox = h('div', { class: 'form-err' });
    const btnSubmit = h('button', { class: 'btn-primary', style: 'width: 100%; margin-top: 14px;' }, 'Enregistrer l’établissement');

    const submit = () => {
      const name = inp.value.trim();
      if (!name) {
        errBox.textContent = 'Veuillez saisir un nom d’établissement.';
        inp.focus();
        return;
      }
      if (stores().some((s) => norm(s.name) === norm(name))) {
        errBox.textContent = 'Un établissement portant ce nom existe déjà dans votre liste.';
        inp.focus();
        return;
      }
      btnSubmit.disabled = true;
      try {
        addStore(name);
        closeModal();
        showToast(`Établissement « ${name} » ajouté avec succès !`);
        if (storeSearchQuery) {
          storeSearchQuery = '';
          if ($('storeSearchInput')) $('storeSearchInput').value = '';
        }
        renderStores();
      } catch (e) {
        errBox.textContent = e.message;
        btnSubmit.disabled = false;
      }
    };

    btnSubmit.onclick = submit;
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

    openModal('Ajouter un établissement', [
      h('div', { class: 'form-group' },
        h('label', {}, 'Nom du magasin partenaire'),
        inp,
        errBox
      ),
      btnSubmit
    ]);

    setTimeout(() => inp.focus(), 60);
  }

  // --- Modal : Détails Établissement & Enregistrement de Mouvement ---
  function openStoreDetailModal(storeId, initialOp = 'delivery') {
    openStoreDetailId = storeId;
    const cur = () => stores().find((s) => s.id === storeId);
    const store = cur();
    if (!store) return;

    let opType = (initialOp === 'return') ? 'return' : 'delivery';
    const balNum = h('b', {}, String(store.balance));
    const balLabel = h('small', {}, `Caisses en circulation chez ${store.name}`);

    // Bannière Solde
    const heroBanner = h('div', { class: 'modal-balance-hero' },
      h('div', {}, balLabel, balNum)
    );

    // Renommage (Responsable et Travailleur)
    let renameContainer = null;
    if (isAdmin() || isWorker()) {
      const nameInp = h('input', { value: store.name, maxlength: '60' });
      const nameErr = h('div', { class: 'form-err' });
      const renameBox = h('div', { class: 'card hide', style: 'padding: 14px; margin-bottom: 16px;' },
        h('label', {}, 'Modifier le nom de l’établissement'),
        nameInp,
        nameErr,
        h('div', { style: 'display: flex; gap: 8px; margin-top: 10px;' },
          h('button', {
            class: 'btn-secondary btn-sm',
            onclick: () => renameBox.classList.add('hide')
          }, 'Annuler'),
          h('button', {
            class: 'btn-primary btn-sm',
            onclick: () => {
              const newName = nameInp.value.trim();
              if (!newName) {
                nameErr.textContent = 'Le nom ne peut être vide.';
                return;
              }
              if (stores().some((x) => x.id !== storeId && norm(x.name) === norm(newName))) {
                nameErr.textContent = 'Un autre établissement porte déjà ce nom.';
                return;
              }
              renameStore(storeId, newName);
              showToast('Nom mis à jour.');
              renameBox.classList.add('hide');
              openStoreDetailModal(storeId);
            }
          }, 'Enregistrer le nouveau nom')
        )
      );

      const btnToggleRename = h('button', {
        class: 'btn-ghost btn-sm rename-store-button',
        type: 'button',
        style: 'margin-bottom: 12px; display: inline-flex; align-items: center; gap: 6px;',
        onclick: () => {
          renameBox.classList.toggle('hide');
          nameInp.focus();
        }
      },
        h('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M12 20h9' }),
          h('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z' })
        ),
        'Modifier le nom du magasin'
      );

      renameContainer = h('div', {}, btnToggleRename, renameBox);
    }

    // Sélecteur d'opération (Livré vs Repris)
    const bDeliv = h('button', { type: 'button', class: `segmented-btn ${opType === 'delivery' ? 'active delivery' : ''}` }, 'Livraison (+)');
    const bReturn = h('button', { type: 'button', class: `segmented-btn ${opType === 'return' ? 'active return' : ''}` }, 'Reprise (−)');

    const pickOp = (t) => {
      opType = t;
      bDeliv.className = `segmented-btn ${t === 'delivery' ? 'active delivery' : ''}`;
      bReturn.className = `segmented-btn ${t === 'return' ? 'active return' : ''}`;
      cntInput.placeholder = t === 'delivery' ? 'Quantité livrée' : 'Quantité reprise';
    };

    bDeliv.onclick = () => pickOp('delivery');
    bReturn.onclick = () => pickOp('return');

    // Saisie quantité avec stepper tactile grand format
    const cntInput = h('input', {
      type: 'number',
      min: '1',
      placeholder: opType === 'delivery' ? 'Quantité livrée' : 'Quantité reprise',
      inputmode: 'numeric',
      class: 'stepper-input'
    });
    const moveErr = h('div', { class: 'form-err' });

    const btnDec = h('button', {
      type: 'button',
      class: 'stepper-btn',
      'aria-label': 'Diminuer de 1',
      onclick: () => {
        let v = parseInt(cntInput.value, 10);
        if (isNaN(v) || v <= 1) v = 1;
        else v -= 1;
        cntInput.value = v;
      }
    }, '−');

    const btnInc = h('button', {
      type: 'button',
      class: 'stepper-btn',
      'aria-label': 'Augmenter de 1',
      onclick: () => {
        let v = parseInt(cntInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        else v += 1;
        cntInput.value = v;
      }
    }, '+');

    const stepperWrap = h('div', { class: 'quantity-stepper' },
      btnDec,
      cntInput,
      btnInc
    );

    // Puces rapides (+5, +10, +25, +50, +Tout reprendre)
    const quickChips = h('div', { class: 'quick-chips' },
      h('button', { type: 'button', class: 'quick-chip', onclick: () => { cntInput.value = 5; } }, '+5'),
      h('button', { type: 'button', class: 'quick-chip', onclick: () => { cntInput.value = 10; } }, '+10'),
      h('button', { type: 'button', class: 'quick-chip', onclick: () => { cntInput.value = 25; } }, '+25'),
      h('button', { type: 'button', class: 'quick-chip', onclick: () => { cntInput.value = 50; } }, '+50'),
      h('button', {
        type: 'button',
        class: 'quick-chip',
        style: 'font-weight: 700; color: var(--emerald-700);',
        onclick: () => {
          const s = cur();
          if (s && s.balance > 0) {
            pickOp('return');
            cntInput.value = s.balance;
          }
        }
      }, 'Tout reprendre (Solde)')
    );

    const btnSubmitMove = h('button', { class: 'btn-primary', style: 'width: 100%; min-height: 48px; font-size: 1rem; font-weight: 700;' }, 'Enregistrer l’opération');

    const record = () => {
      const c = Number(cntInput.value);
      const s = cur();
      if (!s) return;

      if (!Number.isInteger(c) || c < 1) {
        moveErr.textContent = 'Veuillez saisir un nombre entier supérieur à zéro.';
        cntInput.focus();
        return;
      }

      if (opType === 'return' && c > s.balance) {
        moveErr.textContent = `Impossible de reprendre ${c} caisses : il n'y a que ${s.balance} ${label(s.balance)} chez ce magasin.`;
        cntInput.focus();
        return;
      }

      btnSubmitMove.disabled = true;
      try {
        move(storeId, opType, c);
        showToast(`${opType === 'delivery' ? 'Livraison' : 'Reprise'} de ${c} caisses enregistrée.`);
        cntInput.value = '';
        moveErr.textContent = '';
        const after = cur();
        balNum.textContent = String(after ? after.balance : s.balance);
        renderStoreModalHistory();
      } catch (e) {
        moveErr.textContent = e.message;
      } finally {
        btnSubmitMove.disabled = false;
      }
    };

    btnSubmitMove.onclick = record;
    cntInput.onkeydown = (e) => { if (e.key === 'Enter') record(); };

    // Section Historique récent du magasin
    const histFeed = h('div', { id: 'storeModalHist', class: 'activity-timeline', style: 'margin-top: 14px;' });

    const modalParts = [
      heroBanner,
      renameContainer,
      h('div', { class: 'segmented-control' }, bDeliv, bReturn),
      h('div', { class: 'form-group' },
        h('label', {}, 'Nombre de caisses'),
        stepperWrap,
        quickChips,
        moveErr
      ),
      btnSubmitMove,
      h('div', { style: 'margin-top: 24px;' },
        h('h4', { style: 'font-size: 0.95rem; margin-bottom: 8px;' }, 'Activité récente chez ce magasin'),
        histFeed
      )
    ];

    openModal(`Gestion : ${store.name}`, modalParts);
    loadStoreHistory(storeId);
  }

  function renderStoreModalHistory() {
    const el = $('storeModalHist');
    if (!el || !openStoreDetailId) return;
    el.textContent = '';

    const curStore = stores().find((s) => s.id === openStoreDetailId);
    if (!curStore) return;

    // Récupérer les mouvements outbox de ce magasin
    const pendingMoves = st.outbox
      .filter((o) => o.kind === 'movement' && o.storeId === openStoreDetailId)
      .map((o) => ({
        id: o.id,
        type: o.type,
        count: o.count,
        createdAt: o.createdAt,
        by: o.by || (st.profile ? st.profile.name : 'Vous'),
        isPending: true
      }))
      .reverse();

    const rows = [...pendingMoves, ...serverHistCache.filter((r) => r.storeId === openStoreDetailId && !pendingMoves.some((p) => p.id === r.id))].slice(0, 8);

    if (!rows.length) {
      el.append(h('p', { class: 'sum' }, 'Aucun mouvement enregistré pour cet établissement.'));
      return;
    }

    for (const r of rows) {
      const isDeliv = r.type === 'delivery';
      const isRet = r.type === 'return';
      const sign = isDeliv ? '+' : isRet ? '−' : (r.count > 0 ? '+' : '−');
      const qtyClass = isDeliv ? 'plus' : isRet ? 'minus' : 'fix';
      const typeLabel = isDeliv ? 'Livré' : isRet ? 'Repris' : 'Correction';

      el.append(
        h('div', { class: 'timeline-row' },
          h('div', { class: 'timeline-info' },
            h('span', { class: 'timeline-title' }, `${typeLabel}`),
            h('span', { class: 'timeline-sub' }, `${fmtDate(r.createdAt)} · ${r.by || '—'}${r.isPending ? ' · En attente' : ''}`)
          ),
          h('div', { class: `timeline-qty ${qtyClass}` }, `${sign}${Math.abs(r.count)}`)
        )
      );
    }
  }

  async function loadStoreHistory(storeId) {
    if (!CONFIGURED || !st.session || !storeId) return;
    try {
      const rows = await rpc('list_movements', { p_store_id: storeId });
      if (openStoreDetailId === storeId) {
        const store = stores().find((s) => s.id === storeId);
        serverHistCache = (rows || []).map((r) => ({
          id: String(r.id),
          storeId,
          storeName: store ? store.name : 'Magasin',
          type: r.type,
          count: Number(r.count) || 0,
          createdAt: String(r.createdAt),
          by: r.by || null
        }));
        renderStoreModalHistory();
      }
    } catch (e) {
      console.error('Erreur chargement historique magasin:', e);
    }
  }

  // =========================================================================
  // EXPORTS CSV DES DONNÉES
  // =========================================================================
  function downloadCSV(filename, headers, rows) {
    const escapeCol = (val) => {
      const str = String(val == null ? '' : val).replace(/"/g, '""');
      return `"${str}"`;
    };

    let csvContent = '\uFEFF'; // UTF-8 BOM pour ouverture propre dans Excel
    csvContent += headers.map(escapeCol).join(';') + '\r\n';

    for (const row of rows) {
      csvContent += row.map(escapeCol).join(';') + '\r\n';
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function exportMovementsCSV() {
    if (!movementsCache.length) {
      showToast('Aucun mouvement à exporter.', 'warning');
      return;
    }
    const data = movementsCache.map((m) => {
      const isDeliv = m.type === 'delivery';
      const isRet = m.type === 'return';
      return [
        m.createdAt ? new Date(m.createdAt).toLocaleString('fr-FR') : '',
        m.storeName || 'Magasin',
        isDeliv ? 'Livraison' : isRet ? 'Reprise' : 'Correction',
        isDeliv ? m.count : isRet ? -m.count : m.count,
        m.by || ''
      ];
    });
    downloadCSV(
      `arruapan_mouvements_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Établissement', 'Type', 'Quantité', 'Opérateur'],
      data
    );
    showToast('Export CSV des mouvements téléchargé.');
  }

  // =========================================================================
  // AUTHENTIFICATION : CONNEXION ET DÉCONNEXION
  // =========================================================================
  function forceLogout(msg) {
    st.session = null;
    st.profile = null;
    save();
    route();
    const errBox = $('lerr');
    if (errBox) errBox.textContent = msg || '';
    setSyncStatus('synced');
  }

  async function login() {
    const emailInp = $('email');
    const pwInp = $('pw');
    const errBox = $('lerr');
    const btn = $('loginBtn');

    const email = emailInp ? emailInp.value.trim().toLowerCase() : '';
    const pw = pwInp ? pwInp.value : '';

    if (!CONFIGURED) {
      if (errBox) errBox.textContent = 'Configuration Supabase manquante dans config.js.';
      return;
    }
    if (!email || !pw) {
      if (errBox) errBox.textContent = 'Veuillez saisir votre email et votre mot de passe.';
      return;
    }

    btn.disabled = true;
    if (errBox) errBox.textContent = '';

    try {
      const d = await authCall('password', { email, password: pw });

      // Vérification outbox multi-utilisateurs
      if (st.outbox.length && st.user && st.user.id !== d.user.id) {
        if (errBox) {
          errBox.textContent = `Des modifications non envoyées appartiennent à ${st.user.email}. Connectez-vous avec ce compte pour les synchroniser.`;
        }
        btn.disabled = false;
        return;
      }

      if (st.user && st.user.id !== d.user.id) {
        st.server = [];
        st.warehouse = null;
        st.profile = null;
      }

      setSession(d);
      if (pwInp) pwInp.value = '';

      try {
        st.profile = await rpc('me');
        save();
      } catch (e) {
        st.profile = null;
      }

      route();
      sync();
      showToast('Connexion réussie !');
    } catch (e) {
      if (errBox) {
        errBox.textContent = e.net
          ? 'Pas de connexion Internet. Réessayez.'
          : e.auth
          ? 'Email ou mot de passe incorrect.'
          : e.message;
      }
    } finally {
      btn.disabled = false;
    }
  }

  function logout() {
    if (st.outbox.length) {
      if (!confirm(`Attention : ${st.outbox.length} modification(s) n’ont pas encore été synchronisées avec le serveur. Si vous vous déconnectez maintenant, elles resteront en attente sur cet appareil. Voulez-vous vraiment vous déconnecter ?`)) {
        return;
      }
    }

    st.session = null;
    // On garde l'identité tant que des modifications ne sont pas envoyées :
    // elles ne pourront être envoyées que par le même compte (le nom affiché dans l'historique reste exact).
    if (!st.outbox.length) st.user = null;
    st.profile = null;
    st.server = [];
    st.warehouse = null;
    save();
    route();
    showToast('Vous avez été déconnecté.');
  }

  // =========================================================================
  // INITIALISATION DES ÉVÉNEMENTS & ÉCOUTEURS
  // =========================================================================
  function initEvents() {
    // Connexion
    const loginBtn = $('loginBtn');
    if (loginBtn) loginBtn.onclick = login;

    const pwInput = $('pw');
    if (pwInput) {
      pwInput.onkeydown = (e) => {
        if (e.key === 'Enter') login();
      };
    }

    // Écran attente
    const pendRefresh = $('pendRefresh');
    if (pendRefresh) {
      pendRefresh.onclick = async () => {
        try {
          pendRefresh.disabled = true;
          st.profile = await rpc('me');
          save();
          route();
          if (st.profile && st.profile.role !== 'pending') {
            showToast('Votre compte a été activé ! Bienvenue.');
            sync();
          } else {
            showToast('Compte toujours en attente de validation par un Responsable.', 'warning');
          }
        } catch (e) {
          if (e.auth) forceLogout('Session expirée. Veuillez vous reconnecter.');
        } finally {
          pendRefresh.disabled = false;
        }
      };
    }

    const pendLogout = $('pendLogout');
    if (pendLogout) pendLogout.onclick = logout;

    // Déconnexion latérale
    const sidebarLogout = $('sidebarLogoutBtn');
    if (sidebarLogout) sidebarLogout.onclick = logout;

    // Navigation (Sidebar + Mobile Bottom Nav)
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.onclick = () => {
        const view = btn.getAttribute('data-view');
        if (view) switchView(view);
      };
    });

    // Menu mobile burger et voile d'arrière-plan tactile (Drawer Backdrop)
    const mobileMenuBtn = $('mobileMenuBtn');
    const sidebarBackdrop = $('sidebarBackdrop');
    const appSidebar = $('appSidebar');

    const closeSidebarDrawer = () => {
      if (appSidebar) appSidebar.classList.remove('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.add('hide');
    };

    const toggleSidebarDrawer = () => {
      if (!appSidebar) return;
      const willOpen = !appSidebar.classList.contains('open');
      appSidebar.classList.toggle('open', willOpen);
      if (sidebarBackdrop) sidebarBackdrop.classList.toggle('hide', !willOpen);
    };

    if (mobileMenuBtn) mobileMenuBtn.onclick = toggleSidebarDrawer;
    if (sidebarBackdrop) sidebarBackdrop.onclick = closeSidebarDrawer;

    // Bouton de synchronisation manuelle
    const syncPill = $('syncStatusPill');
    if (syncPill) syncPill.onclick = () => sync();

    const btnForceSync = $('btnForceSync');
    if (btnForceSync) btnForceSync.onclick = () => sync();

    // Boutons d'action
    const btnAddStoreTop = $('btnAddStoreTop');
    if (btnAddStoreTop) btnAddStoreTop.onclick = () => openAddStoreModal();

    const btnAddStoreMain = $('btnAddStoreMain');
    if (btnAddStoreMain) btnAddStoreMain.onclick = () => openAddStoreModal();

    // Liens Dashboard -> Autres vues
    const btnSeeAllStores = $('btnSeeAllStores');
    if (btnSeeAllStores) btnSeeAllStores.onclick = () => switchView('stores');

    const btnSeeAllMovements = $('btnSeeAllMovements');
    if (btnSeeAllMovements) btnSeeAllMovements.onclick = () => switchView('movements');

    // Recherche et Filtres Magasins
    const storeSearchInput = $('storeSearchInput');
    if (storeSearchInput) {
      storeSearchInput.oninput = (e) => {
        storeSearchQuery = e.target.value;
        renderStores();
      };
    }

    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.onclick = () => {
        document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        storeFilter = chip.getAttribute('data-filter') || 'all';
        renderStores();
      };
    });

    const storeSortSelect = $('storeSortSelect');
    if (storeSortSelect) {
      storeSortSelect.onchange = (e) => {
        storeSortCriteria = e.target.value;
        renderStores();
      };
    }

    // Filtres Mouvements
    const movementTypeFilter = $('movementTypeFilter');
    if (movementTypeFilter) {
      movementTypeFilter.onchange = (e) => {
        movementTypeFilterValue = e.target.value;
        renderMovements();
      };
    }

    const movementStoreFilter = $('movementStoreFilter');
    if (movementStoreFilter) {
      movementStoreFilter.onchange = (e) => {
        movementStoreFilterValue = e.target.value;
        renderMovements();
      };
    }

    const btnExportMovementsCSV = $('btnExportMovementsCSV');
    if (btnExportMovementsCSV) btnExportMovementsCSV.onclick = exportMovementsCSV;

    // Recherche (espace travailleur)
    const workerSearchInput = $('workerSearchInput');
    if (workerSearchInput) {
      workerSearchInput.oninput = (e) => {
        workerSearchQuery = e.target.value;
        renderWorkerStores();
      };
    }

    // Gestion Entrepôt (Responsable)
    let whOpType = 'truck_in'; // 'truck_in' | 'truck_out' | 'correction'
    const whBtnIn = $('whBtnIn');
    const whBtnOut = $('whBtnOut');
    const whBtnFix = $('whBtnFix');
    const whCountInput = $('whCountInput');
    const whCountLabel = $('whCountLabel');
    const whFormErr = $('whFormErr');
    const btnSaveWhOp = $('btnSaveWhOp');

    const pickWhKind = (k) => {
      whOpType = k;
      if (whBtnIn) whBtnIn.className = `segmented-btn ${k === 'truck_in' ? 'active delivery' : ''}`;
      if (whBtnOut) whBtnOut.className = `segmented-btn ${k === 'truck_out' ? 'active return' : ''}`;
      if (whBtnFix) whBtnFix.className = `segmented-btn ${k === 'correction' ? 'active delivery' : ''}`;

      if (whCountLabel) {
        whCountLabel.textContent = k === 'truck_in' ? 'Nombre de caisses reçues' : k === 'truck_out' ? 'Nombre de caisses remises au camion' : 'Nouveau solde réel en entrepôt';
      }
      if (whCountInput) {
        whCountInput.placeholder = k === 'correction' ? 'Total exact en entrepôt' : 'Ex: 50';
      }
    };

    if (whBtnIn) whBtnIn.onclick = () => pickWhKind('truck_in');
    if (whBtnOut) whBtnOut.onclick = () => pickWhKind('truck_out');
    if (whBtnFix) whBtnFix.onclick = () => pickWhKind('correction');

    if (btnSaveWhOp) {
      btnSaveWhOp.onclick = () => {
        const v = Number(whCountInput.value);
        const wNow = warehouse() || 0;

        if (whCountInput.value.trim() === '' || !Number.isInteger(v) || v < 0 || (whOpType !== 'correction' && v < 1)) {
          if (whFormErr) whFormErr.textContent = 'Veuillez saisir un nombre entier valide.';
          whCountInput.focus();
          return;
        }

        if (whOpType === 'truck_out' && v > wNow) {
          if (whFormErr) whFormErr.textContent = `Impossible : vous n’avez que ${wNow} caisses en entrepôt.`;
          whCountInput.focus();
          return;
        }

        const delta = whOpType === 'truck_in' ? v : whOpType === 'truck_out' ? -v : v - wNow;
        if (delta === 0) {
          if (whFormErr) whFormErr.textContent = 'Aucune modification nécessaire.';
          return;
        }

        btnSaveWhOp.disabled = true;
        try {
          whOp(whOpType, delta, '');
          whCountInput.value = '';
          if (whFormErr) whFormErr.textContent = '';
          showToast('Mouvement d’entrepôt enregistré !');
          renderWarehouse();
        } catch (e) {
          if (whFormErr) whFormErr.textContent = e.message;
        } finally {
          btnSaveWhOp.disabled = false;
        }
      };
    }

    // Modal close handlers
    const modalCloseBtn = $('modalCloseBtn');
    if (modalCloseBtn) modalCloseBtn.onclick = closeModal;

    if (modalBackdrop) {
      modalBackdrop.onclick = (e) => {
        if (e.target === modalBackdrop) closeModal();
      };
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Synchronisation périodique et écoute réseau
    setInterval(() => {
      if (document.visibilityState === 'visible') sync();
    }, 15000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync();
    });

    window.addEventListener('online', () => {
      showToast('Connexion Internet rétablie. Synchronisation…');
      sync();
    });

    window.addEventListener('offline', () => {
      setSyncStatus('offline', 'Hors ligne');
      showToast('Mode hors-ligne activé.', 'warning');
    });
  }

  // Lancement de l'application
  initEvents();
  route();
  sync();

})();
