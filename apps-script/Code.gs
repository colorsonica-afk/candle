/**
 * POS Velas de Navidad — backend (Google Apps Script sobre una hoja de cálculo).
 *
 * La hoja guarda todo:
 *   usuarios     -> quién puede entrar (correo + PIN de 4 dígitos + rol)
 *   productos    -> catálogo, precio, stock y stock mínimo
 *   ventas       -> una fila por línea vendida
 *   movimientos  -> historial de inventario (ventas, entradas, ajustes, anulaciones, precios)
 *   accesos      -> registro de inicios de sesión
 *
 * La app web (carpeta /web) llama a esta API por POST. Sin sesión válida no se devuelve ningún dato.
 */

const TZ = 'America/Bogota';
const SESSION_DAYS = 365;        // la sesión queda abierta en el celular; se cierra con "Cerrar sesión" o desactivando a la usuaria
const CACHE_SECONDS = 21600;
const MAX_FAILS = 5;             // intentos fallidos antes de bloquear
const LOCK_SECONDS = 900;        // 15 min de bloqueo

const SH = {
  USERS: 'usuarios',
  PRODUCTS: 'productos',
  SALES: 'ventas',
  MOVES: 'movimientos',
  LOG: 'accesos',
  CLIENTS: 'clientes',
  PAYMENTS: 'abonos'
};

const HEADERS = {
  usuarios: ['email', 'nombre', 'pin', 'rol', 'activo'],
  productos: ['id', 'nombre', 'precio', 'stock', 'stock_minimo', 'activo', 'actualizado'],
  ventas: ['venta_id', 'fecha', 'email', 'vendedor', 'producto_id', 'producto', 'cantidad', 'precio_unit', 'total', 'metodo_pago', 'cliente', 'estado', 'cliente_id', 'entrega', 'entregado_fecha'],
  movimientos: ['fecha', 'email', 'producto_id', 'producto', 'tipo', 'cantidad', 'stock_resultante', 'nota'],
  accesos: ['fecha', 'email', 'resultado'],
  clientes: ['id', 'nombre', 'celular', 'nota', 'creado', 'creado_por'],
  abonos: ['fecha', 'cliente_id', 'cliente', 'valor', 'metodo_pago', 'email', 'nota']
};

/** Correos y nombres de quienes pueden entrar. Llénalo ANTES de ejecutar setup() (no se guarda en el repositorio). */
const USUARIOS_INICIALES = [
  // ['correo@gmail.com', 'Nombre'],
];

const PAY_METHODS = ['Efectivo', 'Llave', 'Transferencia', 'Nequi', 'Daviplata', 'Tarjeta', 'Fiado'];
const FIADO = 'Fiado';
const EN_PROCESO = 'en proceso', ENTREGADO = 'entregado';
const STORE_NAME = 'Sahana';

/* ───────────────────────── Configuración inicial ───────────────────────── */

/**
 * Ejecutar UNA vez desde el editor de Apps Script (botón ▶ con "setup" seleccionado).
 * Crea las pestañas, los 3 usuarios con PIN aleatorio y el producto inicial.
 * Es seguro volver a correrlo: no borra datos existentes.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  });

  sheet_(SH.CLIENTS); sheet_(SH.PAYMENTS);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PIN_SALT')) props.setProperty('PIN_SALT', Utilities.getUuid() + Utilities.getUuid());

  const users = ss.getSheetByName(SH.USERS);
  if (users.getLastRow() === 1) {
    const rows = USUARIOS_INICIALES.map(function (u) { return [u[0].toLowerCase(), u[1], randomPin_(), 'admin', true]; });
    if (rows.length) users.getRange(2, 1, rows.length, 5).setValues(rows);
    // Columna PIN como texto para que "0420" no se vuelva 420.
    users.getRange(2, 3, 200, 1).setNumberFormat('@');
  }

  const prods = ss.getSheetByName(SH.PRODUCTS);
  if (prods.getLastRow() === 1) {
    prods.getRange(2, 1, 1, 7).setValues([['P001', 'Kit alumbrado', 35000, 150, 20, true, new Date()]]);
    addMove_('setup', 'P001', 'Kit alumbrado', 'alta', 150, 150, 'Inventario inicial');
  }
  Logger.log('Listo. Los PIN iniciales están en la pestaña "usuarios" (se cifran solos al primer ingreso).');
}

function randomPin_() {
  return ('000' + Math.floor(Math.random() * 10000)).slice(-4);
}

/* ───────────────────────────────── API ───────────────────────────────── */

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  balancesMemo_ = null;
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, msg: 'Solicitud inválida' });
  }
  try {
    if (req.action === 'login') return json_(login_(req));
    const user = auth_(req.token);
    if (!user) return json_({ ok: false, code: 'SESSION', msg: 'Tu sesión venció. Ingresa de nuevo.' });

    switch (req.action) {
      case 'bootstrap': return json_(bootstrap_(user));
      case 'sell': return json_(sell_(user, req));
      case 'void': return json_(voidSale_(user, req));
      case 'saveProduct': return json_(saveProduct_(user, req));
      case 'adjustStock': return json_(adjustStock_(user, req));
      case 'report': return json_(report_(user));
      case 'changePin': return json_(changePin_(user, req));
      case 'clients': return json_({ ok: true, clients: clientsWithBalance_() });
      case 'saveClient': return json_(saveClient_(user, req));
      case 'addPayment': return json_(addPayment_(user, req));
      case 'clientDetail': return json_(clientDetail_(req));
      case 'orders': return json_(orders_());
      case 'setDelivery': return json_(setDelivery_(user, req));
      case 'payFiado': return json_(payFiado_(user, req));
      case 'logout': dropSession_(req.token); return json_({ ok: true });
      default: return json_({ ok: false, msg: 'Acción desconocida' });
    }
  } catch (err) {
    if (!(err && err.userMsg)) console.error(err && err.stack || err);
    return json_({ ok: false, msg: (err && err.userMsg) || 'Error en el servidor. Intenta de nuevo.' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg) {
  const e = new Error(msg);
  e.userMsg = msg;
  throw e;
}

/* ─────────────────────────────── Acceso ─────────────────────────────── */

function login_(req) {
  const email = String(req.email || '').trim().toLowerCase();
  const pin = String(req.pin || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^\d{4}$/.test(pin)) {
    return { ok: false, msg: 'Correo o PIN inválido' };
  }
  const cache = CacheService.getScriptCache();
  const failKey = 'f:' + email;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) {
    return { ok: false, msg: 'Demasiados intentos. Espera 15 minutos.' };
  }

  const sh = sheet_(SH.USERS);
  const rows = sh.getDataRange().getValues();
  let found = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email && isTrue_(rows[i][4])) { found = i; break; }
  }

  let okPin = false;
  if (found > 0) {
    const stored = String(rows[found][2]).trim();
    if (stored.indexOf('h:') === 0) {
      okPin = stored === hashPin_(email, pin);
    } else {
      // PIN escrito a mano en la hoja: se compara y se reemplaza por su versión cifrada.
      const plain = ('0000' + stored).slice(-4);
      okPin = /^\d{1,4}$/.test(stored) && plain === pin;
      if (okPin) sh.getRange(found + 1, 3).setValue(hashPin_(email, pin));
    }
  }

  if (!okPin) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    logAccess_(email, 'fallido');
    return { ok: false, msg: 'Correo o PIN incorrecto' };
  }

  cache.remove(failKey);
  const user = { email: email, nombre: String(rows[found][1] || email), rol: String(rows[found][3] || 'vendedor').toLowerCase() };
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  saveSession_(token, user.email);
  logAccess_(email, 'ok');
  return { ok: true, token: token, user: user };
}

/**
 * Las sesiones se guardan de forma permanente (propiedades del script) con el token cifrado,
 * así sobreviven a reinicios del celular y a la caché de Google. En cada uso se confirma que
 * la usuaria siga activa en la hoja: poner "activo" en FALSE la saca de inmediato.
 */
function sessionKey_(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  return 'sess:' + bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function saveSession_(token, email) {
  const now = Date.now();
  PropertiesService.getScriptProperties().setProperty(sessionKey_(token), JSON.stringify({ email: email, created: now, seen: now }));
  purgeSessions_();
}

function dropSession_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return;
  const key = sessionKey_(token);
  PropertiesService.getScriptProperties().deleteProperty(key);
  CacheService.getScriptCache().remove(key);
}

function purgeSessions_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const limit = Date.now() - SESSION_DAYS * 86400000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess:') !== 0) return;
    try { if (JSON.parse(all[k]).seen < limit) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function auth_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const key = sessionKey_(token);
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  let raw = cache.get(key) || props.getProperty(key);
  if (!raw) return null;
  const sess = JSON.parse(raw);
  const now = Date.now();
  if (now - sess.seen > SESSION_DAYS * 86400000) { dropSession_(token); return null; }
  if (now - sess.seen > 86400000) { // marcar uso como máximo una vez al día
    sess.seen = now; raw = JSON.stringify(sess); props.setProperty(key, raw);
  }
  cache.put(key, raw, CACHE_SECONDS);
  const user = activeUser_(sess.email);
  if (!user) { dropSession_(token); return null; }
  return user;
}

/** Datos vigentes de la usuaria (nombre y rol pueden cambiar en la hoja). null si ya no está activa. */
function activeUser_(email) {
  const rows = sheet_(SH.USERS).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email) {
      if (!isTrue_(rows[i][4])) return null;
      return { email: email, nombre: String(rows[i][1] || email), rol: String(rows[i][3] || 'vendedor').toLowerCase() };
    }
  }
  return null;
}

function requireAdmin_(user) {
  if (user.rol !== 'admin') fail_('No tienes permiso para esta acción.');
}

function hashPin_(email, pin) {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('PIN_SALT');
  if (!salt) { salt = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('PIN_SALT', salt); }
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + email + '|' + pin, Utilities.Charset.UTF_8);
  return 'h:' + bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function changePin_(user, req) {
  const actual = String(req.actual || ''), nueva = String(req.nueva || '');
  if (!/^\d{4}$/.test(nueva)) fail_('El nuevo PIN debe tener 4 dígitos.');
  const sh = sheet_(SH.USERS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === user.email) {
      const stored = String(rows[i][2]).trim();
      const ok = stored.indexOf('h:') === 0 ? stored === hashPin_(user.email, actual) : ('0000' + stored).slice(-4) === actual;
      if (!ok) fail_('El PIN actual no es correcto.');
      sh.getRange(i + 1, 3).setValue(hashPin_(user.email, nueva));
      return { ok: true };
    }
  }
  fail_('Usuario no encontrado.');
}

function logAccess_(email, result) {
  try { sheet_(SH.LOG).appendRow([new Date(), safeText_(email), result]); } catch (e) { /* no bloquear el login */ }
}

/* ─────────────────────────────── Productos ─────────────────────────────── */

function readProducts_() {
  const sh = sheet_(SH.PRODUCTS);
  const rows = sh.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    list.push({
      row: i + 1,
      id: String(r[0]),
      nombre: String(r[1]),
      precio: Number(r[2]) || 0,
      stock: Number(r[3]) || 0,
      stock_minimo: Number(r[4]) || 0,
      activo: isTrue_(r[5])
    });
  }
  return list;
}

function publicProduct_(p) {
  return { id: p.id, nombre: p.nombre, precio: p.precio, stock: p.stock, stock_minimo: p.stock_minimo, activo: p.activo, bajo: p.stock <= p.stock_minimo };
}

function bootstrap_(user) {
  const products = readProducts_().map(publicProduct_);
  const out = { ok: true, user: user, products: products, payMethods: PAY_METHODS, clients: clientsWithBalance_() };
  if (user.rol === 'admin') out.sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  return out;
}

function saveProduct_(user, req) {
  requireAdmin_(user);
  const p = req.product || {};
  const nombre = safeText_(String(p.nombre || '').trim()).slice(0, 80);
  const precio = Math.round(Number(p.precio));
  const minimo = Math.round(Number(p.stock_minimo));
  if (!nombre) fail_('El producto necesita un nombre.');
  if (!(precio >= 0)) fail_('Precio inválido.');
  if (!(minimo >= 0)) fail_('Stock mínimo inválido.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SH.PRODUCTS);
    const list = readProducts_();
    if (p.id) {
      const cur = list.filter(function (x) { return x.id === String(p.id); })[0];
      if (!cur) fail_('Producto no encontrado.');
      const activo = p.activo === undefined ? cur.activo : !!p.activo;
      sh.getRange(cur.row, 2, 1, 6).setValues([[nombre, precio, cur.stock, minimo, activo, new Date()]]);
      if (cur.precio !== precio) addMove_(user.email, cur.id, nombre, 'precio', 0, cur.stock, 'Precio ' + cur.precio + ' → ' + precio);
    } else {
      const inicial = Math.round(Number(p.stock || 0));
      if (!(inicial >= 0)) fail_('Stock inicial inválido.');
      let max = 0;
      list.forEach(function (x) { const n = Number(String(x.id).replace(/\D/g, '')); if (n > max) max = n; });
      const id = 'P' + ('00' + (max + 1)).slice(-3);
      sh.appendRow([id, nombre, precio, inicial, minimo, true, new Date()]);
      addMove_(user.email, id, nombre, 'alta', inicial, inicial, 'Producto nuevo');
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, products: readProducts_().map(publicProduct_) };
}

function adjustStock_(user, req) {
  requireAdmin_(user);
  const qty = Math.round(Number(req.cantidad));
  if (!qty || !isFinite(qty)) fail_('Cantidad inválida.');
  const nota = safeText_(String(req.nota || '').trim()).slice(0, 120);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cur = readProducts_().filter(function (x) { return x.id === String(req.id); })[0];
    if (!cur) fail_('Producto no encontrado.');
    const nuevo = cur.stock + qty;
    if (nuevo < 0) fail_('El stock no puede quedar negativo (hay ' + cur.stock + ').');
    sheet_(SH.PRODUCTS).getRange(cur.row, 4).setValue(nuevo);
    sheet_(SH.PRODUCTS).getRange(cur.row, 7).setValue(new Date());
    addMove_(user.email, cur.id, cur.nombre, qty > 0 ? 'entrada' : 'ajuste', qty, nuevo, nota);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, products: readProducts_().map(publicProduct_) };
}

/* ──────────────────────────────── Ventas ──────────────────────────────── */

function sell_(user, req) {
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length || items.length > 50) fail_('El carrito está vacío.');
  const metodo = PAY_METHODS.indexOf(req.metodo) >= 0 ? req.metodo : PAY_METHODS[0];
  let cliente = '', clienteId = '', client = null;
  if (req.cliente_id) {
    client = findClient_(String(req.cliente_id));
    if (!client) fail_('El cliente ya no existe.');
    cliente = client.nombre; clienteId = client.id;
  }
  if (metodo === FIADO && !client) fail_('Para fiar, elige el cliente que queda debiendo.');
  const entrega = req.entrega === EN_PROCESO ? EN_PROCESO : ENTREGADO;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let result;
  try {
    const products = readProducts_();
    const byId = {};
    products.forEach(function (p) { byId[p.id] = p; });

    // Agrupar por producto y validar todo antes de escribir.
    const lines = {};
    items.forEach(function (it) {
      const p = byId[String(it.id)];
      if (!p || !p.activo) fail_('Un producto del carrito ya no está disponible.');
      const qty = Math.round(Number(it.qty));
      if (!(qty > 0) || qty > 10000) fail_('Cantidad inválida para ' + p.nombre + '.');
      let price = p.precio;
      if (it.precio !== undefined && it.precio !== null && user.rol === 'admin') {
        price = Math.round(Number(it.precio));
        if (!(price >= 0)) fail_('Precio inválido para ' + p.nombre + '.');
      }
      const key = p.id + '|' + price;
      if (!lines[key]) lines[key] = { p: p, qty: 0, price: price };
      lines[key].qty += qty;
    });
    const need = {};
    Object.keys(lines).forEach(function (k) { const l = lines[k]; need[l.p.id] = (need[l.p.id] || 0) + l.qty; });
    Object.keys(need).forEach(function (id) {
      if (need[id] > byId[id].stock) fail_('No hay suficiente ' + byId[id].nombre + ': quedan ' + byId[id].stock + '.');
    });

    const now = new Date();
    const ventaId = 'V' + Utilities.formatDate(now, TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
    const rows = [];
    let total = 0, unidades = 0;
    Object.keys(lines).forEach(function (k) {
      const l = lines[k];
      const t = l.qty * l.price;
      total += t; unidades += l.qty;
      rows.push([ventaId, now, user.email, safeText_(user.nombre), l.p.id, l.p.nombre, l.qty, l.price, t, metodo, cliente, 'ok', clienteId, entrega, entrega === ENTREGADO ? now : '']);
    });
    const sales = sheet_(SH.SALES);
    sales.getRange(sales.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    const alerts = [];
    const prodSheet = sheet_(SH.PRODUCTS);
    Object.keys(need).forEach(function (id) {
      const p = byId[id];
      const antes = p.stock;
      p.stock = antes - need[id];
      prodSheet.getRange(p.row, 4).setValue(p.stock);
      addMove_(user.email, id, p.nombre, 'venta', -need[id], p.stock, ventaId);
      if (p.stock <= p.stock_minimo && antes > p.stock_minimo) alerts.push(p);
    });
    result = { ok: true, venta_id: ventaId, total: total, unidades: unidades, metodo: metodo, entrega: entrega, products: products.map(publicProduct_) };
    if (client) {
      result.cliente = { id: client.id, nombre: client.nombre, celular: client.celular, saldo: balances_()[client.id] || 0 };
    }
    result.alerts = alerts.map(function (p) { return { nombre: p.nombre, stock: p.stock, stock_minimo: p.stock_minimo }; });
    if (alerts.length) notifyLowStock_(alerts);
  } finally {
    lock.releaseLock();
  }
  return result;
}

function voidSale_(user, req) {
  requireAdmin_(user);
  const ventaId = String(req.venta_id || '');
  if (!/^V\d+$/.test(ventaId)) fail_('Venta inválida.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SH.SALES);
    const rows = sh.getDataRange().getValues();
    const restore = {};
    let found = false;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) !== ventaId) continue;
      found = true;
      if (rows[i][11] === 'anulada') fail_('Esa venta ya estaba anulada.');
      sh.getRange(i + 1, 12).setValue('anulada');
      restore[rows[i][4]] = (restore[rows[i][4]] || 0) + Number(rows[i][6]);
    }
    if (!found) fail_('Venta no encontrada.');
    const products = readProducts_();
    products.forEach(function (p) {
      if (!restore[p.id]) return;
      p.stock += restore[p.id];
      sheet_(SH.PRODUCTS).getRange(p.row, 4).setValue(p.stock);
      addMove_(user.email, p.id, p.nombre, 'anulacion', restore[p.id], p.stock, ventaId);
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, products: readProducts_().map(publicProduct_) };
}

function notifyLowStock_(alerts) {
  try {
    const rows = sheet_(SH.USERS).getDataRange().getValues();
    const to = [];
    for (let i = 1; i < rows.length; i++) if (isTrue_(rows[i][4]) && rows[i][0]) to.push(String(rows[i][0]).trim());
    if (!to.length) return;
    const lines = alerts.map(function (a) { return '• ' + a.nombre + ': quedan ' + a.stock + ' (mínimo ' + a.stock_minimo + ')'; });
    MailApp.sendEmail({
      to: to.join(','),
      subject: '🕯️ ' + STORE_NAME + ' — stock bajo: ' + alerts.map(function (a) { return a.nombre; }).join(', '),
      body: 'Aviso del punto de venta ' + STORE_NAME + ':\n\n' + lines.join('\n') + '\n\nEs momento de reponer inventario.'
    });
  } catch (e) {
    console.error('No se pudo enviar el aviso de stock: ' + e);
  }
}

/* ─────────────────────────────── Informes ─────────────────────────────── */

function report_(user) {
  const now = new Date();
  const today = dayKey_(now);
  const dow = Number(Utilities.formatDate(now, TZ, 'u')); // 1 = lunes … 7 = domingo
  const weekDays = [];
  for (let i = dow - 1; i >= 0; i--) weekDays.push(dayKey_(new Date(now.getTime() - i * 86400000)));
  const inWeek = {};
  weekDays.forEach(function (d) { inWeek[d] = true; });

  function bucket() { return { ventas: 0, unidades: 0, total: 0, _ids: {} }; }
  const res = { hoy: bucket(), semana: bucket(), total: bucket() };
  const porDia = {}; weekDays.forEach(function (d) { porDia[d] = { unidades: 0, total: 0 }; });
  const porProducto = {}, porVendedor = {}, porMetodo = {};
  const ventasHoy = {};

  const rows = sheet_(SH.SALES).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    if (r[11] === 'anulada') {
      // Las anuladas se muestran en la lista de hoy, pero no suman.
      if (dayKey_(asDate_(r[1])) === today) addToday_(ventasHoy, r);
      continue;
    }
    const d = dayKey_(asDate_(r[1]));
    const qty = Number(r[6]) || 0, tot = Number(r[8]) || 0;
    const scopes = ['total'];
    if (inWeek[d]) scopes.push('semana');
    if (d === today) scopes.push('hoy');
    scopes.forEach(function (s) {
      const b = res[s];
      b.unidades += qty; b.total += tot;
      if (!b._ids[r[0]]) { b._ids[r[0]] = 1; b.ventas++; }
      addGroup_(porProducto, s, String(r[5]), qty, tot);
      addGroup_(porVendedor, s, String(r[3] || r[2]), qty, tot);
      addGroup_(porMetodo, s, String(r[9] || '—'), qty, tot);
    });
    if (porDia[d]) { porDia[d].unidades += qty; porDia[d].total += tot; }
    if (d === today) addToday_(ventasHoy, r);
  }
  Object.keys(res).forEach(function (k) { delete res[k]._ids; });

  // Las filas están en orden de registro: la más reciente queda primero.
  const lista = Object.keys(ventasHoy).map(function (k) { return ventasHoy[k]; }).reverse();

  return {
    ok: true,
    generado: Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm'),
    resumen: res,
    semanaDias: weekDays.map(function (d) { return { dia: d, unidades: porDia[d].unidades, total: porDia[d].total }; }),
    porProducto: porProducto,
    porVendedor: porVendedor,
    porMetodo: porMetodo,
    ventasHoy: lista,
    porCobrar: Object.keys(balances_()).reduce(function (t, k) { const b = balances_()[k]; return t + (b > 0 ? b : 0); }, 0),
    products: readProducts_().map(publicProduct_)
  };
}

function addGroup_(obj, scope, key, qty, tot) {
  if (!obj[scope]) obj[scope] = {};
  if (!obj[scope][key]) obj[scope][key] = { unidades: 0, total: 0 };
  obj[scope][key].unidades += qty;
  obj[scope][key].total += tot;
}

function addToday_(map, r) {
  const id = String(r[0]);
  if (!map[id]) {
    map[id] = {
      venta_id: id,
      hora: Utilities.formatDate(asDate_(r[1]), TZ, 'HH:mm'),
      vendedor: String(r[3] || r[2]),
      metodo: String(r[9] || ''),
      cliente: String(r[10] || ''),
      estado: String(r[11] || 'ok'),
      entrega: String(r[13] || ENTREGADO),
      items: [],
      total: 0
    };
  }
  map[id].items.push({ producto: String(r[5]), cantidad: Number(r[6]), precio: Number(r[7]) });
  map[id].total += Number(r[8]) || 0;
}

/* ─────────────────────────────── Clientes y fiado ─────────────────────────────── */

function readClients_() {
  const rows = sheet_(SH.CLIENTS).getDataRange().getValues();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    list.push({ row: i + 1, id: String(rows[i][0]), nombre: String(rows[i][1]), celular: String(rows[i][2] || ''), nota: String(rows[i][3] || '') });
  }
  return list;
}

function findClient_(id) {
  return readClients_().filter(function (c) { return c.id === id; })[0] || null;
}

let balancesMemo_ = null;
/** Saldo por cliente = ventas fiadas (no anuladas) − abonos. */
function balances_() {
  if (balancesMemo_) return balancesMemo_;
  const bal = {};
  const sales = sheet_(SH.SALES).getDataRange().getValues();
  for (let i = 1; i < sales.length; i++) {
    const r = sales[i];
    if (!r[0] || r[11] === 'anulada' || r[9] !== FIADO || !r[12]) continue;
    bal[r[12]] = (bal[r[12]] || 0) + (Number(r[8]) || 0);
  }
  const pays = sheet_(SH.PAYMENTS).getDataRange().getValues();
  for (let j = 1; j < pays.length; j++) {
    if (!pays[j][1]) continue;
    bal[pays[j][1]] = (bal[pays[j][1]] || 0) - (Number(pays[j][3]) || 0);
  }
  balancesMemo_ = bal;
  return bal;
}

function clientsWithBalance_() {
  balancesMemo_ = null;
  const bal = balances_();
  return readClients_().map(function (c) {
    return { id: c.id, nombre: c.nombre, celular: c.celular, nota: c.nota, saldo: bal[c.id] || 0 };
  }).sort(function (a, b) { return (b.saldo > 0) - (a.saldo > 0) || a.nombre.localeCompare(b.nombre); });
}

function cleanPhone_(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('57') === 0) d = d.slice(2);
  if (d && !/^\d{7,10}$/.test(d)) fail_('Celular inválido: escribe los 10 dígitos.');
  return d;
}

function saveClient_(user, req) {
  const c = req.client || {};
  const nombre = safeText_(String(c.nombre || '').trim()).slice(0, 80);
  if (!nombre) fail_('El cliente necesita un nombre.');
  const celular = cleanPhone_(c.celular);
  const nota = safeText_(String(c.nota || '').trim()).slice(0, 120);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let id;
  try {
    const sh = sheet_(SH.CLIENTS);
    const list = readClients_();
    if (c.id) {
      const cur = list.filter(function (x) { return x.id === String(c.id); })[0];
      if (!cur) fail_('Cliente no encontrado.');
      sh.getRange(cur.row, 2, 1, 3).setValues([[nombre, celular, nota]]);
      id = cur.id;
    } else {
      if (celular && list.some(function (x) { return x.celular === celular; })) fail_('Ya existe un cliente con ese celular.');
      let max = 0;
      list.forEach(function (x) { const n = Number(String(x.id).replace(/\D/g, '')); if (n > max) max = n; });
      id = 'C' + ('000' + (max + 1)).slice(-4);
      sh.appendRow([id, nombre, celular, nota, new Date(), user.email]);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id, clients: clientsWithBalance_() };
}

function addPayment_(user, req) {
  const valor = Math.round(Number(req.valor));
  if (!(valor > 0)) fail_('Escribe el valor del abono.');
  const metodo = PAY_METHODS.indexOf(req.metodo) >= 0 && req.metodo !== FIADO ? req.metodo : 'Efectivo';
  const client = findClient_(String(req.cliente_id || ''));
  if (!client) fail_('Cliente no encontrado.');
  const nota = safeText_(String(req.nota || '').trim()).slice(0, 120);
  sheet_(SH.PAYMENTS).appendRow([new Date(), client.id, client.nombre, valor, metodo, user.email, nota]);
  const clients = clientsWithBalance_();
  const saldo = (clients.filter(function (c) { return c.id === client.id; })[0] || {}).saldo || 0;
  return { ok: true, saldo: saldo, clients: clients };
}

/** Historial de un cliente: compras fiadas y abonos, más recientes primero. */
function clientDetail_(req) {
  const id = String(req.cliente_id || '');
  const client = findClient_(id);
  if (!client) fail_('Cliente no encontrado.');
  const items = {};
  const sales = sheet_(SH.SALES).getDataRange().getValues();
  for (let i = 1; i < sales.length; i++) {
    const r = sales[i];
    if (String(r[12]) !== id) continue;
    const k = String(r[0]);
    if (!items[k]) items[k] = { tipo: 'compra', venta_id: k, fecha: Utilities.formatDate(asDate_(r[1]), TZ, 'yyyy-MM-dd HH:mm'), metodo: String(r[9]), estado: String(r[11]), entrega: String(r[13] || ENTREGADO), detalle: [], valor: 0 };
    items[k].detalle.push(r[6] + ' × ' + r[5]);
    items[k].valor += Number(r[8]) || 0;
  }
  const list = Object.keys(items).map(function (k) { return items[k]; });
  const pays = sheet_(SH.PAYMENTS).getDataRange().getValues();
  for (let j = 1; j < pays.length; j++) {
    if (String(pays[j][1]) !== id) continue;
    list.push({ tipo: 'abono', fecha: Utilities.formatDate(asDate_(pays[j][0]), TZ, 'yyyy-MM-dd HH:mm'), metodo: String(pays[j][4]), valor: Number(pays[j][3]) || 0, detalle: [String(pays[j][6] || '')] });
  }
  const paid = paidSales_();
  list.forEach(function (h) { if (h.tipo === 'compra' && h.metodo === FIADO) h.pagada = !!paid[h.venta_id]; });
  list.sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
  balancesMemo_ = null;
  return { ok: true, cliente: { id: client.id, nombre: client.nombre, celular: client.celular, saldo: balances_()[id] || 0 }, historial: list.slice(0, 60) };
}

/** Ventas fiadas que ya se marcaron como pagadas (abono con venta_id). */
function paidSales_() {
  const out = {};
  const pays = sheet_(SH.PAYMENTS).getDataRange().getValues();
  for (let j = 1; j < pays.length; j++) { const m = /^Pago venta (V\d+)/.exec(String(pays[j][6] || '')); if (m) out[m[1]] = true; }
  return out;
}

/** Marca una venta fiada como pagada: registra un abono por su valor (sin pasar del saldo). */
function payFiado_(user, req) {
  const ventaId = String(req.venta_id || '');
  if (!/^V\d+$/.test(ventaId)) fail_('Venta inválida.');
  const metodo = PAY_METHODS.indexOf(req.metodo) >= 0 && req.metodo !== FIADO ? req.metodo : 'Efectivo';
  let cid = '';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (paidSales_()[ventaId]) fail_('Esa venta ya estaba pagada.');
    const rows = sheet_(SH.SALES).getDataRange().getValues();
    let total = 0, found = false;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) !== ventaId) continue;
      found = true;
      if (rows[i][9] !== FIADO) fail_('Esa venta no es fiada.');
      if (rows[i][11] === 'anulada') fail_('Esa venta está anulada.');
      total += Number(rows[i][8]) || 0; cid = String(rows[i][12]);
    }
    if (!found) fail_('Venta no encontrada.');
    const client = findClient_(cid);
    if (!client) fail_('Cliente no encontrado.');
    balancesMemo_ = null;
    const saldo = balances_()[cid] || 0;
    const valor = Math.max(0, Math.min(total, saldo));
    sheet_(SH.PAYMENTS).appendRow([new Date(), cid, client.nombre, valor, metodo, user.email, 'Pago venta ' + ventaId]);
  } finally {
    lock.releaseLock();
  }
  const out = clientDetail_({ cliente_id: cid });
  out.clients = clientsWithBalance_();
  return out;
}

/* ─────────────────────────────── Pedidos (entrega) ─────────────────────────────── */

/** Pedidos en proceso (todos) y los últimos entregados. Las ventas viejas sin estado cuentan como entregadas. */
function orders_() {
  const rows = sheet_(SH.SALES).getDataRange().getValues();
  const phones = {};
  readClients_().forEach(function (c) { phones[c.id] = c.celular; });
  const map = {}, order = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || r[11] === 'anulada') continue;
    const id = String(r[0]);
    if (!map[id]) {
      map[id] = { venta_id: id, fecha: Utilities.formatDate(asDate_(r[1]), TZ, 'yyyy-MM-dd HH:mm'), vendedor: String(r[3] || r[2]),
        metodo: String(r[9] || ''), cliente: String(r[10] || ''), cliente_id: String(r[12] || ''), celular: phones[r[12]] || '',
        entrega: String(r[13] || ENTREGADO), entregado_fecha: r[14] ? Utilities.formatDate(asDate_(r[14]), TZ, 'yyyy-MM-dd HH:mm') : '', items: [], total: 0 };
      order.push(id);
    }
    map[id].items.push({ producto: String(r[5]), cantidad: Number(r[6]) });
    map[id].total += Number(r[8]) || 0;
  }
  const all = order.map(function (id) { return map[id]; }).reverse();
  return {
    ok: true,
    enProceso: all.filter(function (o) { return o.entrega === EN_PROCESO; }),
    entregados: all.filter(function (o) { return o.entrega === ENTREGADO && o.entregado_fecha; }).slice(0, 15)
  };
}

function setDelivery_(user, req) {
  const ventaId = String(req.venta_id || '');
  if (!/^V\d+$/.test(ventaId)) fail_('Venta inválida.');
  const estado = req.estado === EN_PROCESO ? EN_PROCESO : ENTREGADO;
  const sh = sheet_(SH.SALES);
  const rows = sh.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== ventaId) continue;
    found = true;
    sh.getRange(i + 1, 14, 1, 2).setValues([[estado, estado === ENTREGADO ? new Date() : '']]);
  }
  if (!found) fail_('Venta no encontrada.');
  return orders_();
}

/* ─────────────────────────────── Utilidades ─────────────────────────────── */

const checkedSheets_ = {};
/** Devuelve la pestaña; si falta (o le faltan columnas nuevas) la crea/completa con sus encabezados. */
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  const head = HEADERS[name];
  if (!sh) {
    if (!head) fail_('Falta la pestaña "' + name + '".');
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    sh.setFrozenRows(1);
    if (name === SH.CLIENTS) sh.getRange(2, 3, 1000, 1).setNumberFormat('@');
  } else if (head && !checkedSheets_[name]) {
    const cur = sh.getRange(1, 1, 1, head.length).getValues()[0];
    if (cur.some(function (v, i) { return String(v) === '' && head[i]; })) sh.getRange(1, 1, 1, head.length).setValues([head]);
  }
  checkedSheets_[name] = true;
  return sh;
}

function addMove_(email, id, nombre, tipo, qty, stock, nota) {
  sheet_(SH.MOVES).appendRow([new Date(), email, id, nombre, tipo, qty, stock, nota || '']);
}

function dayKey_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function asDate_(v) { return v instanceof Date ? v : new Date(v); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'SI' || v === 1; }

/** Evita que un texto escrito por el usuario se interprete como fórmula en la hoja. */
function safeText_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
