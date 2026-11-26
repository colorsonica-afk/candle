/* POS Velas de Navidad — app del celular. Todos los datos vienen de la API (Apps Script). */
(function () {
  'use strict';

  const CFG = window.POS_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const fmt = (n) => money.format(Number(n) || 0);
  const num = new Intl.NumberFormat('es-CO');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } }
  };

  const S = {
    token: store.get('pos_token'),
    user: null,
    products: [],
    payMethods: ['Efectivo'],
    cart: {},          // id -> { qty, precio }  (precio = null usa el del producto)
    metodo: 'Efectivo',
    view: 'sell',
    scope: 'hoy',
    report: null,
    pin: '',
    clients: [],
    clientId: null,     // cliente elegido para la venta actual
    sheetUrl: null,
    entrega: 'entregado',
    orders: null
  };

  /* ───────────── API ───────────── */
  let busyCount = 0;
  function busy(on) {
    busyCount += on ? 1 : -1;
    $('#busy').classList.toggle('hidden', busyCount <= 0);
  }

  async function api(action, data, opts) {
    opts = opts || {};
    if (!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) throw new Error('Falta configurar la URL de la API en config.js');
    if (!opts.quiet) busy(true);
    try {
      const res = await fetch(CFG.API_URL, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action, token: S.token }, data || {})),
        redirect: 'follow'
      });
      const out = await res.json();
      if (!out.ok) {
        if (out.code === 'SESSION') { endSession(out.msg); }
        const err = new Error(out.msg || 'Error');
        err.handled = out.code === 'SESSION';
        throw err;
      }
      return out;
    } catch (e) {
      if (e instanceof TypeError) throw new Error(navigator.onLine ? 'No se pudo conectar. Intenta de nuevo.' : 'Sin internet. Revisa tu conexión.');
      throw e;
    } finally {
      if (!opts.quiet) busy(false);
    }
  }

  function toast(msg, bad, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  function showErr(e) { if (!e.handled) toast(e.message || 'Error', true, 4000); }

  /* ───────────── Login ───────────── */
  function showLogin(msg) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#email').value = store.get('pos_email') || '';
    S.pin = ''; drawPin();
    $('#loginMsg').textContent = msg || '';
  }
  function drawPin() {
    $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < S.pin.length));
  }
  $('#keypad').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'back') S.pin = S.pin.slice(0, -1);
    else if (k === 'clear') S.pin = '';
    else if (S.pin.length < 4) S.pin += k;
    drawPin();
    if (S.pin.length === 4) doLogin();
  });
  document.addEventListener('keydown', (ev) => {
    if ($('#login').classList.contains('hidden') || ev.target === $('#email')) return;
    if (/^\d$/.test(ev.key) && S.pin.length < 4) { S.pin += ev.key; drawPin(); if (S.pin.length === 4) doLogin(); }
    if (ev.key === 'Backspace') { S.pin = S.pin.slice(0, -1); drawPin(); }
  });

  async function doLogin() {
    const email = $('#email').value.trim().toLowerCase();
    $('#loginMsg').textContent = '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      $('#loginMsg').textContent = 'Escribe tu correo primero 📧';
      S.pin = ''; drawPin(); return;
    }
    try {
      const r = await api('login', { email: email, pin: S.pin });
      S.token = r.token; store.set('pos_token', r.token); store.set('pos_email', email);
      S.pin = ''; drawPin();
      await start();
    } catch (e) {
      $('#loginMsg').textContent = e.message;
      S.pin = ''; drawPin();
    }
  }

  function endSession(msg) {
    S.token = null; S.user = null; store.del('pos_token'); store.del('pos_boot');
    showLogin(msg);
  }

  /* ───────────── Arranque ───────────── */
  // La sesión queda abierta en el celular: solo se pide el PIN otra vez si el servidor
  // la rechaza (cerrar sesión o usuaria desactivada). Sin internet se abre con lo último guardado.
  function enterApp(r) {
    S.user = r.user; S.products = r.products || []; S.payMethods = r.payMethods || S.payMethods;
    S.clients = r.clients || S.clients || []; S.sheetUrl = r.sheetUrl || null;
    $('#sheetCard').classList.toggle('hidden', !S.sheetUrl);
    if (S.sheetUrl) $('#sheetLink').href = S.sheetUrl;
    if (S.payMethods.indexOf(S.metodo) < 0) S.metodo = S.payMethods[0];
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#hdrUser').textContent = '¡Hola, ' + S.user.nombre + '! ' + greetEmoji();
    $('#accInfo').textContent = S.user.email + ' · rol ' + S.user.rol;
    $('#btnNewProduct').classList.toggle('hidden', !isAdmin());
    renderAll();
    go(S.view);
    if (!S.orders) loadOrders(true);
  }

  async function start() {
    let cached = null;
    try { cached = JSON.parse(store.get('pos_boot') || 'null'); } catch (e) { cached = null; }
    if (cached && cached.user) enterApp(cached);   // abre al instante con lo último conocido
    try {
      const r = await api('bootstrap', null, { quiet: !!cached });
      saveBoot(r);
      enterApp(r);
    } catch (e) {
      if (e.handled) return;                        // sesión rechazada: ya se mostró el login
      if (cached && cached.user) toast(e.message + ' Mostrando datos guardados.', true, 4000);
      else showRetry(e.message);
    }
  }

  function showRetry(msg) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginMsg').textContent = msg + ' Toca ⟳ para reintentar.';
    if (!$('#btnRetry')) {
      const b = document.createElement('button');
      b.id = 'btnRetry'; b.className = 'secondary big'; b.textContent = '⟳ Reintentar';
      b.addEventListener('click', () => { b.remove(); $('#loginMsg').textContent = ''; start(); });
      $('#loginMsg').after(b);
    }
  }
  const isAdmin = () => S.user && S.user.rol === 'admin';
  const PAY_EMOJI = { Efectivo: '💵', Transferencia: '🏦', Nequi: '📱', Daviplata: '📲', Tarjeta: '💳', Fiado: '📝', Llave: '🔑' };
  function greetEmoji() { const h = new Date().getHours(); return h < 12 ? '☕🎄' : h < 18 ? '☀️🎁' : '🌙✨'; }
  function prodEmoji(name) {
    const n = String(name).toLowerCase();
    if (/aroma|canela|olor|pino/.test(n)) return '🌲';
    if (/estrella/.test(n)) return '⭐';
    if (/regalo|caja/.test(n)) return '🎁';
    if (/farol|lampar/.test(n)) return '🏮';
    return '🕯️';
  }

  function saveBoot(r) {
    store.set('pos_boot', JSON.stringify({ user: r.user || S.user, products: r.products || S.products, payMethods: r.payMethods || S.payMethods,
      clients: r.clients || S.clients, sheetUrl: r.sheetUrl || S.sheetUrl }));
  }
  function setProducts(list) {
    if (list) { S.products = list; if (S.user) saveBoot({}); }
    renderAll();
  }
  function setClients(list) {
    if (list) { S.clients = list; if (S.user) saveBoot({}); }
    renderClientPick(); renderClients();
  }
  function renderAll() { renderLowStock(); renderProducts(); renderCart(); renderPayMethods(); renderProductAdmin(); renderClientPick(); renderClients(); }

  /* ───────────── Navegación ───────────── */
  $('.tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (b) go(b.dataset.v);
  });
  function go(v) {
    S.view = v;
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
    if (v === 'report') loadReport();
    if (v === 'clients') loadClients();
    if (v === 'orders') loadOrders();
    window.scrollTo(0, 0);
  }
  $('#btnRefresh').addEventListener('click', async () => {
    try {
      const r = await api('bootstrap'); setProducts(r.products);
      if (S.view === 'report') await loadReport();
      toast('Actualizado');
    } catch (e) { showErr(e); }
  });

  /* ───────────── Stock bajo ───────────── */
  function renderLowStock() {
    const low = S.products.filter((p) => p.activo && p.bajo);
    const el = $('#lowStock');
    if (!low.length) { el.classList.add('hidden'); return; }
    el.innerHTML = '⚠️ <strong>¡Ojo, se están acabando!</strong> ' + low.map((p) => esc(p.nombre) + ' (' + num.format(p.stock) + ' und)').join(', ');
    el.classList.remove('hidden');
  }

  /* ───────────── Vender ───────────── */
  function cartQty(id) { return S.cart[id] ? S.cart[id].qty : 0; }

  function renderProducts() {
    const active = S.products.filter((p) => p.activo);
    if (!active.length) { $('#productGrid').innerHTML = '<p class="muted">No hay productos activos.</p>'; return; }
    $('#productGrid').innerHTML = active.map((p) => {
      const q = cartQty(p.id);
      const cls = ['prod', p.bajo ? 'low' : '', p.stock <= 0 ? 'out' : ''].join(' ');
      return '<button class="' + cls + '" data-id="' + esc(p.id) + '"' + (p.stock <= 0 ? ' disabled' : '') + '>' +
        (q ? '<span class="badge">' + q + '</span>' : '') +
        '<span class="pemoji" aria-hidden="true">' + prodEmoji(p.nombre) + '</span>' +
        '<span class="name">' + esc(p.nombre) + '</span>' +
        '<span class="price">' + (p.precio ? fmt(p.precio) : 'Sin precio') + '</span>' +
        '<span class="stock">' + (p.stock <= 0 ? '😢 Agotado' : (p.bajo ? '⚠️ Quedan ' : '📦 Quedan ') + num.format(p.stock)) + '</span>' +
        '</button>';
    }).join('');
  }
  $('#productGrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('.prod'); if (!b || b.disabled) return;
    const p = S.products.find((x) => x.id === b.dataset.id);
    if (!p) return;
    if (cartQty(p.id) >= p.stock) { toast('Solo quedan ' + p.stock + ' de ' + p.nombre, true); return; }
    if (!S.cart[p.id]) S.cart[p.id] = { qty: 0, precio: null };
    S.cart[p.id].qty++;
    renderProducts(); renderCart();
  });

  function linePrice(id) {
    const p = S.products.find((x) => x.id === id);
    const c = S.cart[id];
    return c.precio != null ? c.precio : (p ? p.precio : 0);
  }
  function cartTotal() {
    return Object.keys(S.cart).reduce((t, id) => t + S.cart[id].qty * linePrice(id), 0);
  }

  function renderCart() {
    // Quitar del carrito lo que ya no existe o quedó inactivo.
    Object.keys(S.cart).forEach((id) => {
      const p = S.products.find((x) => x.id === id);
      if (!p || !p.activo || S.cart[id].qty <= 0) delete S.cart[id];
      else if (S.cart[id].qty > p.stock) S.cart[id].qty = p.stock;
    });
    const ids = Object.keys(S.cart);
    const box = $('#cartLines');
    if (!ids.length) {
      box.innerHTML = '<p class="muted">👆 Toca una vela para agregarla.</p>';
    } else {
      box.innerHTML = ids.map((id) => {
        const p = S.products.find((x) => x.id === id);
        const c = S.cart[id];
        const price = linePrice(id);
        const changed = c.precio != null && c.precio !== p.precio;
        return '<div class="line" data-id="' + esc(id) + '">' +
          '<div><div class="lname">' + prodEmoji(p.nombre) + ' ' + esc(p.nombre) + '</div>' +
          '<div class="lsub">' + fmt(price) + ' c/u' + (changed ? ' (ajustado)' : '') +
          (isAdmin() ? ' · <button data-act="price">cambiar precio</button>' : '') + '</div></div>' +
          '<div class="stepper">' +
          '<button data-act="minus" aria-label="Menos">−</button>' +
          '<input data-act="qty" type="number" inputmode="numeric" min="0" value="' + c.qty + '" aria-label="Cantidad">' +
          '<button data-act="plus" aria-label="Más">+</button></div>' +
          '<div class="lsub" style="grid-column:1/-1;text-align:right"><b>' + fmt(c.qty * price) + '</b></div>' +
          '</div>';
      }).join('');
    }
    const total = cartTotal();
    const units = ids.reduce((t, id) => t + S.cart[id].qty, 0);
    const btn = $('#btnCharge');
    btn.disabled = !units;
    btn.textContent = units ? '🎁 Cobrar ' + fmt(total) + ' · ' + units + ' und' : '🎁 Cobrar $0';
  }

  $('#cartLines').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('.line').dataset.id;
    const p = S.products.find((x) => x.id === id);
    const c = S.cart[id];
    if (b.dataset.act === 'plus') {
      if (c.qty >= p.stock) { toast('Solo quedan ' + p.stock, true); return; }
      c.qty++;
    } else if (b.dataset.act === 'minus') {
      c.qty--;
    } else if (b.dataset.act === 'price') {
      openSheet('Precio para esta venta',
        '<p class="muted small">' + esc(p.nombre) + ' · precio de lista ' + fmt(p.precio) + '</p>' +
        '<label class="field"><span>Precio unitario</span><input id="fPrice" type="number" inputmode="numeric" min="0" value="' + linePrice(id) + '"></label>',
        'Aplicar', () => {
          const v = Math.round(Number($('#fPrice').value));
          if (!(v >= 0)) { toast('Precio inválido', true); return false; }
          c.precio = v === p.precio ? null : v;
          renderCart();
        });
      return;
    }
    renderProducts(); renderCart();
  });
  $('#cartLines').addEventListener('change', (ev) => {
    if (ev.target.dataset.act !== 'qty') return;
    const id = ev.target.closest('.line').dataset.id;
    const p = S.products.find((x) => x.id === id);
    let v = Math.max(0, Math.round(Number(ev.target.value) || 0));
    if (v > p.stock) { toast('Solo quedan ' + p.stock, true); v = p.stock; }
    S.cart[id].qty = v;
    // Diferido: el evento puede llegar mientras el campo pierde el foco.
    setTimeout(() => { renderProducts(); renderCart(); }, 0);
  });

  function renderPayMethods() {
    $('#payMethods').innerHTML = S.payMethods.map((m) =>
      '<button data-m="' + esc(m) + '" class="' + (m === S.metodo ? 'on' : '') + '">' + (PAY_EMOJI[m] ? PAY_EMOJI[m] + ' ' : '') + esc(m) + '</button>').join('');
  }
  $('#payMethods').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    S.metodo = b.dataset.m; renderPayMethods();
  });

  $('#btnCharge').addEventListener('click', () => {
    const ids = Object.keys(S.cart);
    if (!ids.length) return;
    if (S.metodo === 'Fiado' && !S.clientId) { toast('📝 Para fiar, elige primero el cliente que queda debiendo', true, 3500); openClientPicker(); return; }
    const cli = S.clients.find((c) => c.id === S.clientId);
    const detail = ids.map((id) => {
      const p = S.products.find((x) => x.id === id);
      return '<tr><td>' + S.cart[id].qty + ' × ' + esc(p.nombre) + '</td><td class="n">' + fmt(S.cart[id].qty * linePrice(id)) + '</td></tr>';
    }).join('');
    openSheet('🎁 Confirmar venta',
      (cli ? '<p>🙋 <b>' + esc(cli.nombre) + '</b>' + (S.metodo === 'Fiado' ? ' — queda debiendo 📝' : '') + '</p>' : '') +
      '<table class="table">' + detail + '<tr><th>Total · ' + esc(S.metodo) + '</th><th class="n">' + fmt(cartTotal()) + '</th></tr></table>' +
      '<p>' + (S.entrega === 'en proceso' ? '⏳ Pedido <b>en proceso</b> (queda pendiente por entregar)' : '✅ Se entrega ya') + '</p>',
      '✅ Registrar venta', async () => {
        const items = ids.map((id) => ({ id: id, qty: S.cart[id].qty, precio: S.cart[id].precio }));
        const lines = ids.map((id) => ({ nombre: S.products.find((x) => x.id === id).nombre, qty: S.cart[id].qty, valor: S.cart[id].qty * linePrice(id) }));
        try {
          const r = await api('sell', { items: items, metodo: S.metodo, cliente_id: S.clientId, entrega: S.entrega });
          S.cart = {}; S.clientId = null; S.orders = null; setEntrega('entregado');
          loadOrders(true);
          setProducts(r.products);
          S.report = null;
          celebrate();
          if (r.alerts && r.alerts.length) {
            toast('⚠️ Se acaba: ' + r.alerts.map((a) => a.nombre + ' (' + a.stock + ')').join(', '), true, 6000);
          }
          if (r.cliente) { const c = S.clients.find((x) => x.id === r.cliente.id); if (c) c.saldo = r.cliente.saldo; renderClients(); }
          showReceipt(r, lines);
          return false;
        } catch (e) {
          showErr(e);
          try { const b = await api('bootstrap', null, { quiet: true }); setProducts(b.products); } catch (x) { /* ignorar */ }
        }
      });
  });

  /* ───────────── Informes ───────────── */
  $('#reportScope').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    S.scope = b.dataset.s;
    $$('#reportScope button').forEach((x) => x.classList.toggle('on', x === b));
    renderReport();
  });

  async function loadReport() {
    try {
      S.report = await api('report');
      setProducts(S.report.products);
      renderReport();
    } catch (e) { showErr(e); }
  }

  function groupTable(title, obj, medals) {
    const rows = Object.keys(obj || {}).map((k) => ({ k: k, u: obj[k].unidades, t: obj[k].total }))
      .sort((a, b) => b.t - a.t || b.u - a.u);
    if (medals) rows.forEach((r, i) => { r.k = (['🥇 ', '🥈 ', '🥉 '][i] || '') + r.k; });
    if (!rows.length) return '';
    return '<div class="card"><h2>' + esc(title) + '</h2><table class="table"><tr><th></th><th class="n">Und</th><th class="n">Valor</th></tr>' +
      rows.map((r) => '<tr><td>' + esc(r.k) + '</td><td class="n">' + num.format(r.u) + '</td><td class="n">' + fmt(r.t) + '</td></tr>').join('') +
      '</table></div>';
  }

  function renderReport() {
    const R = S.report;
    if (!R) { $('#reportBody').innerHTML = '<p class="muted center">Cargando…</p>'; return; }
    const sc = S.scope;
    const b = R.resumen[sc];
    const label = { hoy: '🎄 Vendido hoy', semana: '📅 Vendido esta semana', total: '🏆 Vendido en total' }[sc];
    let html = '<div class="kpis">' +
      '<div class="kpi main"><span>' + label + '</span><b>' + fmt(b.total) + '</b></div>' +
      '<div class="kpi"><span>🕯️ Unidades</span><b>' + num.format(b.unidades) + '</b></div>' +
      '<div class="kpi"><span>🧾 Ventas</span><b>' + num.format(b.ventas) + '</b></div>' +
      '<div class="kpi"><span>⭐ Promedio</span><b>' + fmt(b.ventas ? b.total / b.ventas : 0) + '</b></div>' +
      '</div>' +
      (R.porCobrar ? '<button class="card debt-line" data-goto="clients">💰 Por cobrar (fiado): <b>' + fmt(R.porCobrar) + '</b> ›</button>' : '');

    if (sc === 'semana') {
      const max = Math.max.apply(null, R.semanaDias.map((d) => d.total).concat([1]));
      const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
      const days = names.map((n, i) => R.semanaDias[i] || null);
      const todayKey = R.generado.slice(0, 10);
      html += '<div class="card"><h2>📅 Por día</h2><div class="bars">' +
        days.map((d) => d ? '<div class="bar' + (d.dia === todayKey ? ' today' : '') + '" style="height:' + Math.round(d.total / max * 100) + '%" title="' + esc(d.dia + ': ' + fmt(d.total)) + '"></div>' : '<div></div>').join('') +
        '</div><div class="bar-labels">' + names.map((n) => '<span>' + n + '</span>').join('') + '</div>' +
        '<table class="table">' + R.semanaDias.map((d, i) => '<tr><td>' + names[i] + ' ' + esc(d.dia.slice(8)) + '</td><td class="n">' + num.format(d.unidades) + ' und</td><td class="n">' + fmt(d.total) + '</td></tr>').join('') + '</table></div>';
    }

    html += groupTable('🎁 Por producto', R.porProducto[sc]);
    html += groupTable('🏆 Por vendedor(a)', R.porVendedor[sc], true);
    html += groupTable('💳 Por medio de pago', R.porMetodo[sc]);

    const inv = S.products.filter((p) => p.activo);
    html += '<div class="card"><h2>📦 Inventario actual</h2><table class="table"><tr><th></th><th class="n">Stock</th><th class="n">Mínimo</th></tr>' +
      inv.map((p) => '<tr><td>' + esc(p.nombre) + (p.bajo ? ' ⚠️' : '') + '</td><td class="n">' + num.format(p.stock) + '</td><td class="n">' + num.format(p.stock_minimo) + '</td></tr>').join('') +
      '</table></div>';

    if (sc === 'hoy') {
      html += '<div class="card"><h2>🧾 Ventas de hoy</h2>' + (R.ventasHoy.length ? R.ventasHoy.map((v) =>
        '<div class="sale' + (v.estado === 'anulada' ? ' void' : '') + '">' +
        '<div><b>' + esc(v.hora) + '</b> · ' + esc(v.vendedor) + ' · ' + esc(v.metodo) + (v.cliente ? ' · ' + esc(v.cliente) : '') + (v.entrega === 'en proceso' && v.estado !== 'anulada' ? ' · ⏳ en proceso' : '') + '</div>' +
        '<div class="stot">' + fmt(v.total) + '</div>' +
        '<div class="sdet">' + v.items.map((i) => esc(i.cantidad + ' × ' + i.producto + ' a ' + fmt(i.precio))).join('<br>') + '</div>' +
        (v.estado === 'anulada' ? '<div class="svoid">Anulada</div>' : (isAdmin() ? '<button class="svoid" data-void="' + esc(v.venta_id) + '">Anular</button>' : '<div></div>')) +
        '</div>').join('') : '<p class="muted">Aún no hay ventas hoy. ¡A vender! 🎅</p>') + '</div>';
    }
    html += '<p class="muted small center">Actualizado ' + esc(R.generado) + '</p>';
    $('#reportBody').innerHTML = html;
  }

  $('#reportBody').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-goto]')) { go('clients'); return; }
    const b = ev.target.closest('button[data-void]'); if (!b) return;
    const id = b.dataset.void;
    openSheet('¿Anular venta?', '<p>La venta se marca como anulada y las unidades vuelven al inventario.</p>', 'Anular', async () => {
      try {
        const r = await api('void', { venta_id: id });
        setProducts(r.products);
        toast('↩️ Venta anulada');
        await loadReport();
      } catch (e) { showErr(e); }
    }, true);
  });

  /* ───────────── Clientes, fiado y WhatsApp ───────────── */
  const STORE = () => CFG.STORE_NAME || 'Sahana';
  function waUrl(cel, text) {
    const d = String(cel || '').replace(/\D/g, '');
    return 'https://wa.me/' + (d ? (d.length === 10 ? '57' + d : d) : '') + '?text=' + encodeURIComponent(text);
  }
  function waButton(cel, text, label) {
    return '<a class="wa-btn" href="' + esc(waUrl(cel, text)) + '" target="_blank" rel="noopener">' + esc(label || '📲 Enviar por WhatsApp') + '</a>';
  }
  function saldoText(v) {
    return v > 0 ? '📝 Debe ' + fmt(v) : v < 0 ? '💚 A favor ' + fmt(-v) : '✅ Al día';
  }

  function showReceipt(r, lines) {
    const c = r.cliente;
    let msg = '🎄 *' + STORE() + ' — Velas de Navidad* 🕯️\n';
    msg += c ? '¡Hola, ' + c.nombre + '! Este es tu pedido:\n\n' : 'Este es tu pedido:\n\n';
    msg += lines.map((l) => '• ' + l.qty + ' × ' + l.nombre + ' — ' + fmt(l.valor)).join('\n');
    msg += '\n\n*Total: ' + fmt(r.total) + '*';
    if (r.metodo === 'Fiado') {
      msg += '\n📝 Queda pendiente de pago.';
      if (c && c.saldo > 0) msg += '\n*Saldo total que debes: ' + fmt(c.saldo) + '*';
    } else {
      msg += '\nPago: ' + r.metodo + ' ✅';
    }
    if (r.entrega === 'en proceso') msg += '\n\n⏳ Tu pedido está *en proceso*. Te avisamos cuando esté listo para entregar.';
    msg += '\n\n¡Gracias por tu compra y feliz Navidad! 🎅✨';
    openSheet('✅ ¡Venta registrada!',
      '<p class="big-total">' + fmt(r.total) + '</p>' +
      (c ? '<p>🙋 ' + esc(c.nombre) + (r.metodo === 'Fiado' ? ' · ' + saldoText(c.saldo) : '') + '</p>' : '') +
      waButton(c && c.celular, msg, c && c.celular ? '📲 Enviar cuenta a ' + c.nombre : '📲 Enviar cuenta por WhatsApp') +
      (c && !c.celular ? '<p class="muted small">Este cliente no tiene celular guardado: WhatsApp te deja elegir el contacto.</p>' : ''),
      'Listo 🎄', () => {}, false, true);
  }

  function renderClientPick() {
    const c = S.clients.find((x) => x.id === S.clientId);
    if (S.clientId && !c) S.clientId = null;
    $('#btnClient').textContent = c ? '🙋 ' + c.nombre + (c.saldo > 0 ? ' · debe ' + fmt(c.saldo) : '') : '👤 Elegir cliente (opcional)';
    $('#btnClient').classList.toggle('chosen', !!c);
    $('#btnClientClear').classList.toggle('hidden', !c);
  }
  $('#btnClient').addEventListener('click', () => openClientPicker());
  $('#btnClientClear').addEventListener('click', () => { S.clientId = null; renderClientPick(); });

  function matchClient(c, q) {
    q = q.trim().toLowerCase();
    return !q || c.nombre.toLowerCase().indexOf(q) >= 0 || String(c.celular).indexOf(q.replace(/\D/g, '') || '§') >= 0;
  }
  function clientRows(list, pick) {
    if (!list.length) return '<p class="muted">No hay clientes con ese nombre. Créalo con ➕.</p>';
    return list.map((c) => '<button class="client-item" data-cid="' + esc(c.id) + '"' + (pick ? ' data-pick="1"' : '') + '>' +
      '<span><b>' + esc(c.nombre) + '</b><small>' + (c.celular ? '📱 ' + esc(c.celular) : 'sin celular') + '</small></span>' +
      '<span class="saldo ' + (c.saldo > 0 ? 'debe' : '') + '">' + saldoText(c.saldo) + '</span></button>').join('');
  }

  function openClientPicker() {
    openSheet('👥 ¿Quién compra?',
      '<input id="pickSearch" type="search" placeholder="🔎 Buscar nombre o celular" autocomplete="off">' +
      '<div id="pickList" class="client-list"></div>' +
      '<button id="pickNew" class="secondary big">➕ Nuevo cliente</button>',
      'Cerrar', () => {}, false, true);
    const draw = () => { $('#pickList').innerHTML = clientRows(S.clients.filter((c) => matchClient(c, $('#pickSearch').value)), true); };
    draw();
    $('#pickSearch').addEventListener('input', draw);
    $('#pickList').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-cid]'); if (!b) return;
      S.clientId = b.dataset.cid; renderClientPick(); closeSheet();
    });
    $('#pickNew').addEventListener('click', () => clientForm(null, $('#pickSearch').value, true));
  }

  function clientForm(c, prefill, pickAfter) {
    const guessPhone = prefill && /\d{6,}/.test(prefill) ? prefill.replace(/\D/g, '') : '';
    const guessName = prefill && !guessPhone ? prefill : '';
    openSheet(c ? '✏️ Editar cliente' : '➕ Nuevo cliente',
      '<label class="field"><span>🙋 Nombre</span><input id="cName" maxlength="80" value="' + esc(c ? c.nombre : guessName) + '" placeholder="Ej: Doña Rosa"></label>' +
      '<label class="field"><span>📱 Celular (WhatsApp)</span><input id="cPhone" type="tel" inputmode="tel" maxlength="16" value="' + esc(c ? c.celular : guessPhone) + '" placeholder="300 123 4567"></label>' +
      '<label class="field"><span>📝 Nota (opcional)</span><input id="cNote" maxlength="120" value="' + esc(c ? c.nota : '') + '" placeholder="Ej: vecina del 302"></label>',
      'Guardar', async () => {
        const nombre = $('#cName').value.trim();
        if (!nombre) { toast('Escribe el nombre', true); return false; }
        try {
          const r = await api('saveClient', { client: { id: c ? c.id : undefined, nombre: nombre, celular: $('#cPhone').value, nota: $('#cNote').value } });
          setClients(r.clients);
          if (pickAfter) { S.clientId = r.id; renderClientPick(); }
          toast('🙋 Cliente guardado ✓');
        } catch (e) { showErr(e); return false; }
      });
  }

  async function loadClients() {
    try { const r = await api('clients', null, { quiet: S.clients.length > 0 }); setClients(r.clients); } catch (e) { showErr(e); }
  }
  function renderClients() {
    if (!$('#clientList')) return;
    const total = S.clients.reduce((t, c) => t + (c.saldo > 0 ? c.saldo : 0), 0);
    $('#debtTotal').textContent = fmt(total);
    const list = S.clients.filter((c) => matchClient(c, $('#clientSearch').value));
    $('#clientList').innerHTML = S.clients.length ? clientRows(list, false) : '<p class="muted center">Aún no hay clientes. ¡Crea el primero! 🎅</p>';
  }
  $('#clientSearch').addEventListener('input', renderClients);
  $('#btnNewClient').addEventListener('click', () => clientForm(null, $('#clientSearch').value, false));
  $('#clientList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cid]'); if (b) openClient(b.dataset.cid);
  });

  async function openClient(id) {
    let r;
    try { r = await api('clientDetail', { cliente_id: id }); } catch (e) { showErr(e); return; }
    const c = Object.assign({}, S.clients.find((x) => x.id === id) || {}, r.cliente);
    const cobro = '🎄 *' + STORE() + '* 🕯️\nHola, ' + c.nombre + '. Te recuerdo con cariño tu saldo pendiente de velas: *' + fmt(c.saldo) +
      '*.\nPuedes pagar con llave 🔑, Nequi, Daviplata o en efectivo. ¡Gracias y feliz Navidad! 🎅';
    const hist = r.historial.length ? r.historial.map((h) =>
      '<div class="hist ' + h.tipo + (h.estado === 'anulada' ? ' void' : '') + '"><span>' + (h.tipo === 'abono' ? '💵 Abono' : (h.metodo === 'Fiado' ? '📝 Fiado' : '🛍️ Compra')) +
      ' · ' + esc(h.fecha.slice(5)) + (h.estado === 'anulada' ? ' · anulada' : '') + '<small>' + esc(h.detalle.filter(Boolean).join(', ') || (h.metodo || '')) + '</small>' +
      (h.metodo === 'Fiado' && h.tipo === 'compra' && h.estado !== 'anulada'
        ? (h.pagada ? '<em class="paid">✅ Pagada</em>' : '<button class="mark-paid" data-paid="' + esc(h.venta_id) + '">✅ Marcar pagado</button>') : '') +
      '</span><b>' + (h.tipo === 'abono' ? '−' : '') + fmt(h.valor) + '</b></div>').join('') : '<p class="muted">Sin movimientos todavía.</p>';
    openSheet('🙋 ' + c.nombre,
      '<p class="big-total ' + (c.saldo > 0 ? 'debe' : '') + '">' + saldoText(c.saldo) + '</p>' +
      (c.celular ? '<p class="muted">📱 ' + esc(c.celular) + '</p>' : '') +
      '<div class="row wrap">' +
      (c.saldo > 0 ? '<button id="cPay" class="secondary">💵 Registrar abono</button>' : '') +
      '<button id="cSell" class="secondary">🛍️ Venderle</button><button id="cEdit" class="ghost">✏️ Editar</button></div>' +
      (c.saldo > 0 ? waButton(c.celular, cobro, '📲 Cobrar por WhatsApp') : '') +
      '<h2 style="margin-top:16px">🧾 Historial</h2>' + hist,
      'Cerrar', () => {}, false, true);
    if ($('#cPay')) $('#cPay').addEventListener('click', () => payForm(c));
    $('#cSell').addEventListener('click', () => { S.clientId = c.id; renderClientPick(); closeSheet(); go('sell'); });
    $('#cEdit').addEventListener('click', () => clientForm(c, '', false));
    $$('#sheetBody [data-paid]').forEach((b) => b.addEventListener('click', () => {
      markPaid(c, r.historial.find((x) => x.venta_id === b.dataset.paid));
    }));
  }

  function markPaid(c, h) {
    const methods = S.payMethods.filter((m) => m !== 'Fiado');
    openSheet('✅ Marcar pagado',
      '<p>🙋 ' + esc(c.nombre) + ' · fiado del ' + esc(h.fecha.slice(5)) + '</p><p class="big-total">' + fmt(h.valor) + '</p>' +
      '<div class="field"><span>¿Cómo pagó?</span><div class="chips" id="pMet">' +
      methods.map((m, i) => '<button data-m="' + esc(m) + '" class="' + (i ? '' : 'on') + '">' + (PAY_EMOJI[m] || '') + ' ' + esc(m) + '</button>').join('') + '</div></div>',
      'Confirmar pago', async () => {
        try {
          const r = await api('payFiado', { venta_id: h.venta_id, metodo: $('#pMet .on').dataset.m });
          setClients(r.clients); S.report = null; celebrate();
          const msg = '🎄 *' + STORE() + '* 🕯️\n¡Gracias, ' + c.nombre + '! Recibimos el pago de *' + fmt(h.valor) + '*.\n' +
            (r.cliente.saldo > 0 ? 'Saldo pendiente: *' + fmt(r.cliente.saldo) + '*' : '✅ ¡Quedaste al día!') + '\n¡Feliz Navidad! 🎅';
          openSheet('✅ ¡Pagado!', '<p class="big-total">' + saldoText(r.cliente.saldo) + '</p>' + waButton(c.celular, msg, '📲 Enviar recibo por WhatsApp'), 'Listo 🎄', () => {}, false, true);
          return false;
        } catch (e) { showErr(e); return false; }
      });
    $('#pMet').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      $$('#pMet button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  /* ───────────── Pedidos (entrega) ───────────── */
  function setEntrega(v) {
    S.entrega = v;
    $$('#deliveryOpts button').forEach((b) => b.classList.toggle('on', b.dataset.e === v));
  }
  $('#deliveryOpts').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (b) setEntrega(b.dataset.e);
  });

  async function loadOrders(quiet) {
    try {
      S.orders = await api('orders', null, { quiet: !!quiet || !!S.orders }); renderOrders();
    } catch (e) {
      if (e.handled) return;
      const old = /desconocida/i.test(e.message);
      $('#ordersBody').innerHTML = '<div class="card center"><p>😕 ' + (old
        ? 'Los pedidos aún no están activos: falta publicar la versión nueva del script en Google (Implementar → Nueva versión).'
        : esc(e.message)) + '</p><button id="ordersRetry" class="secondary">⟳ Reintentar</button></div>';
      $('#ordersRetry').addEventListener('click', () => { $('#ordersBody').innerHTML = '<p class="muted center">Cargando…</p>'; loadOrders(); });
      if (!quiet && !old) showErr(e);
    }
  }
  function orderCard(o, pending) {
    const items = o.items.map((i) => i.cantidad + ' × ' + i.producto).join(', ');
    const listo = '🎄 *' + STORE() + '* 🕯️\nHola' + (o.cliente ? ', ' + o.cliente : '') + '. ¡Tu pedido está listo! 🎁\n' + items +
      '\nTotal: *' + fmt(o.total) + '*' + (o.metodo === 'Fiado' ? ' (pendiente de pago)' : '') + '\n¡Feliz Navidad! 🎅';
    return '<div class="card order ' + (pending ? 'pending' : 'done') + '">' +
      '<div class="order-top"><b>' + (o.cliente ? '🙋 ' + esc(o.cliente) : '🛍️ Sin cliente') + '</b><b>' + fmt(o.total) + '</b></div>' +
      '<div class="muted small">' + esc(o.fecha.slice(5)) + ' · ' + esc(o.vendedor) + ' · ' + (PAY_EMOJI[o.metodo] || '') + ' ' + esc(o.metodo) +
      (!pending && o.entregado_fecha ? ' · entregado ' + esc(o.entregado_fecha.slice(5)) : '') + '</div>' +
      '<div class="order-items">' + esc(items) + '</div>' +
      (pending
        ? '<div class="row"><button class="primary" data-deliver="' + esc(o.venta_id) + '">✅ Marcar entregado</button></div>' + waButton(o.celular, listo, '📲 Avisar que está listo')
        : '<button class="ghost small-btn" data-undo="' + esc(o.venta_id) + '">↩️ Volver a en proceso</button>') +
      '</div>';
  }
  function renderOrders() {
    const O = S.orders; if (!O) return;
    const n = O.enProceso.length;
    $('#ordersBadge').textContent = n; $('#ordersBadge').classList.toggle('hidden', !n);
    $('#ordersBody').innerHTML =
      '<h2>⏳ En proceso (' + n + ')</h2>' +
      (n ? O.enProceso.map((o) => orderCard(o, true)).join('') : '<p class="muted card">🎉 No hay pedidos pendientes por entregar.</p>') +
      '<h2 style="margin-top:18px">✅ Entregados recientes</h2>' +
      (O.entregados.length ? O.entregados.map((o) => orderCard(o, false)).join('') : '<p class="muted">Aún no hay entregas registradas.</p>');
  }
  $('#ordersBody').addEventListener('click', async (ev) => {
    const d = ev.target.closest('[data-deliver]'), u = ev.target.closest('[data-undo]');
    if (!d && !u) return;
    try {
      S.orders = await api('setDelivery', { venta_id: d ? d.dataset.deliver : u.dataset.undo, estado: d ? 'entregado' : 'en proceso' });
      renderOrders(); S.report = null;
      if (d) { celebrate(); toast('🎁 ¡Pedido entregado!'); } else toast('⏳ Volvió a en proceso');
    } catch (e) { showErr(e); }
  });


  function payForm(c) {
    const methods = S.payMethods.filter((m) => m !== 'Fiado');
    openSheet('💵 Abono de ' + c.nombre,
      '<p class="muted">Debe ' + fmt(c.saldo) + '</p>' +
      '<label class="field"><span>Valor del abono</span><input id="pVal" type="number" inputmode="numeric" min="1" value="' + c.saldo + '"></label>' +
      '<div class="field"><span>¿Cómo pagó?</span><div class="chips" id="pMet">' +
      methods.map((m, i) => '<button data-m="' + esc(m) + '" class="' + (i ? '' : 'on') + '">' + (PAY_EMOJI[m] || '') + ' ' + esc(m) + '</button>').join('') + '</div></div>',
      'Guardar abono', async () => {
        const v = Math.round(Number($('#pVal').value));
        if (!(v > 0)) { toast('Escribe el valor', true); return false; }
        try {
          const r = await api('addPayment', { cliente_id: c.id, valor: v, metodo: $('#pMet .on').dataset.m });
          setClients(r.clients); S.report = null; celebrate();
          const msg = '🎄 *' + STORE() + '* 🕯️\n¡Gracias, ' + c.nombre + '! Recibimos tu abono de *' + fmt(v) + '*.\n' +
            (r.saldo > 0 ? 'Saldo pendiente: *' + fmt(r.saldo) + '*' : '✅ ¡Quedaste al día!') + '\n¡Feliz Navidad! 🎅';
          openSheet('✅ Abono registrado', '<p class="big-total">' + saldoText(r.saldo) + '</p>' + waButton(c.celular, msg, '📲 Enviar recibo por WhatsApp'), 'Listo 🎄', () => {}, false, true);
          return false;
        } catch (e) { showErr(e); return false; }
      });
    $('#pMet').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      $$('#pMet button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  /* ───────────── Productos ───────────── */
  function renderProductAdmin() {
    if (!S.user) return;
    $('#productAdmin').innerHTML = S.products.map((p) =>
      '<div class="card padmin" data-id="' + esc(p.id) + '">' +
      '<div class="pname">' + prodEmoji(p.nombre) + ' ' + esc(p.nombre) + (p.activo ? '' : '<span class="tag">inactivo</span>') + '</div>' +
      '<div class="price"><b>' + fmt(p.precio) + '</b></div>' +
      '<div class="pmeta" style="grid-column:1/-1">📦 Stock <b class="' + (p.bajo ? 'low' : '') + '">' + num.format(p.stock) + '</b> · ⚠️ aviso en ' + num.format(p.stock_minimo) + '</div>' +
      (isAdmin() ? '<div class="actions"><button class="ghost" data-act="edit">✏️ Editar / precio</button><button class="ghost" data-act="stock">📦 Entrada / ajuste</button></div>' : '') +
      '</div>').join('') || '<p class="muted">Sin productos.</p>';
  }

  $('#productAdmin').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const p = S.products.find((x) => x.id === b.closest('.padmin').dataset.id);
    if (b.dataset.act === 'edit') productForm(p);
    else stockForm(p);
  });
  $('#btnNewProduct').addEventListener('click', () => productForm(null));

  function productForm(p) {
    const isNew = !p;
    openSheet(isNew ? 'Nuevo producto' : 'Editar producto',
      '<label class="field"><span>Nombre</span><input id="fName" maxlength="80" value="' + esc(p ? p.nombre : '') + '"></label>' +
      '<label class="field"><span>Precio de venta</span><input id="fPrice" type="number" inputmode="numeric" min="0" value="' + (p ? p.precio : '') + '"></label>' +
      (isNew ? '<label class="field"><span>Unidades iniciales</span><input id="fStock" type="number" inputmode="numeric" min="0" value="0"></label>' : '') +
      '<label class="field"><span>Avisar cuando queden (stock mínimo)</span><input id="fMin" type="number" inputmode="numeric" min="0" value="' + (p ? p.stock_minimo : 10) + '"></label>' +
      (isNew ? '' : '<label class="field" style="display:flex;gap:10px;align-items:center"><input id="fActive" type="checkbox" style="width:auto"' + (p.activo ? ' checked' : '') + '><span style="margin:0">Activo (visible para vender)</span></label>'),
      'Guardar', async () => {
        const prod = {
          id: p ? p.id : undefined,
          nombre: $('#fName').value.trim(),
          precio: Number($('#fPrice').value),
          stock_minimo: Number($('#fMin').value),
          stock: isNew ? Number($('#fStock').value) : undefined,
          activo: isNew ? true : $('#fActive').checked
        };
        if (!prod.nombre) { toast('Escribe el nombre', true); return false; }
        if ($('#fPrice').value === '' || !(prod.precio >= 0)) { toast('Precio inválido', true); return false; }
        try {
          const r = await api('saveProduct', { product: prod });
          setProducts(r.products); S.report = null;
          toast('🎁 Producto guardado ✓');
        } catch (e) { showErr(e); }
      });
  }

  function stockForm(p) {
    openSheet('Inventario: ' + p.nombre,
      '<p class="muted">Stock actual: <b>' + num.format(p.stock) + '</b></p>' +
      '<div class="chips" id="fType"><button data-t="in" class="on">Entrada (+)</button><button data-t="out">Salida / ajuste (−)</button></div>' +
      '<label class="field"><span>Unidades</span><input id="fQty" type="number" inputmode="numeric" min="1"></label>' +
      '<label class="field"><span>Nota (opcional)</span><input id="fNote" maxlength="120" placeholder="Ej: llegó pedido, vela dañada"></label>',
      'Guardar', async () => {
        const out = $('#fType .on').dataset.t === 'out';
        const q = Math.round(Number($('#fQty').value));
        if (!(q > 0)) { toast('Escribe las unidades', true); return false; }
        try {
          const r = await api('adjustStock', { id: p.id, cantidad: out ? -q : q, nota: $('#fNote').value.trim() });
          setProducts(r.products); S.report = null;
          toast('📦 Inventario actualizado ✓');
        } catch (e) { showErr(e); }
      });
    $('#fType').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      $$('#fType button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  /* ───────────── Cuenta ───────────── */
  $('#btnPin').addEventListener('click', async () => {
    const a = $('#pinOld').value, n = $('#pinNew').value;
    if (!/^\d{4}$/.test(a) || !/^\d{4}$/.test(n)) { toast('El PIN debe tener 4 dígitos', true); return; }
    try {
      await api('changePin', { actual: a, nueva: n });
      $('#pinOld').value = ''; $('#pinNew').value = '';
      toast('🔒 PIN cambiado ✓');
    } catch (e) { showErr(e); }
  });
  $('#btnLogout').addEventListener('click', async () => {
    try { await api('logout'); } catch (e) { /* igual se cierra */ }
    S.cart = {};
    endSession('');
  });

  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); installEvt = e;
    $('#btnInstall').classList.remove('hidden'); $('#installBar').classList.remove('hidden');
  });
  async function doInstall() {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice; installEvt = null;
    $('#btnInstall').classList.add('hidden'); $('#installBar').classList.add('hidden');
  }
  $('#btnInstall').addEventListener('click', doInstall);
  $('#btnInstallTop').addEventListener('click', doInstall);
  window.addEventListener('appinstalled', () => { $('#installBar').classList.add('hidden'); $('#btnInstall').classList.add('hidden'); });

  /* ───────────── Hoja de diálogo ───────────── */
  let sheetAction = null;
  function openSheet(title, body, okText, onOk, danger, hideCancel) {
    $('#sheetCancel').classList.toggle('hidden', !!hideCancel);
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = body;
    const ok = $('#sheetOk');
    ok.textContent = okText || 'Guardar';
    ok.className = danger ? 'primary' : 'primary';
    sheetAction = onOk;
    $('#sheet').classList.remove('hidden');
    const first = $('#sheetBody input'); if (first) setTimeout(() => first.focus(), 50);
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); sheetAction = null; }
  $('#sheetCancel').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (ev) => { if (ev.target.id === 'sheet') closeSheet(); });
  $('#sheetOk').addEventListener('click', async () => {
    const fn = sheetAction;
    if (!fn) return;
    $('#sheetOk').disabled = true;
    try {
      const keep = await fn();
      if (keep !== false) closeSheet();
    } finally { $('#sheetOk').disabled = false; }
  });

  /* ───────────── Ambiente navideño ───────────── */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function makeSnow() {
    const box = $('#snow'); if (!box || reduceMotion) return;
    const flakes = ['❄', '❅', '❆', '•'];
    for (let i = 0; i < 22; i++) {
      const f = document.createElement('span');
      f.textContent = flakes[i % flakes.length];
      f.style.left = Math.random() * 100 + 'vw';
      f.style.fontSize = (8 + Math.random() * 12) + 'px';
      f.style.animationDuration = (9 + Math.random() * 12) + 's';
      f.style.animationDelay = (-Math.random() * 20) + 's';
      f.style.opacity = (0.35 + Math.random() * 0.5).toFixed(2);
      box.appendChild(f);
    }
  }
  function celebrate() {
    if (reduceMotion) return;
    const items = ['🎉', '🎄', '⭐', '🎁', '✨', '🕯️', '❄️'];
    for (let i = 0; i < 18; i++) {
      const c = document.createElement('span');
      c.className = 'confetti';
      c.textContent = items[i % items.length];
      c.style.left = (10 + Math.random() * 80) + 'vw';
      c.style.animationDelay = (Math.random() * 0.4) + 's';
      c.style.fontSize = (18 + Math.random() * 14) + 'px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 2600);
    }
  }
  makeSnow();

  /* ───────────── Inicio ───────────── */
  if (CFG.STORE_NAME) { $('#storeName').textContent = CFG.STORE_NAME; $('#hdrStore').textContent = '🎄 ' + CFG.STORE_NAME; document.title = '🎄 ' + CFG.STORE_NAME; }
  // Pedir a Chrome que no borre los datos de la app (la sesión) aunque falte espacio.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}, false, true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}, false, true);
  if (S.token) start(); else showLogin();
})();
