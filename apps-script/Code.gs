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
const SESSION_SECONDS = 21600;   // 6 h sin actividad cierra la sesión
const MAX_FAILS = 5;             // intentos fallidos antes de bloquear
const LOCK_SECONDS = 900;        // 15 min de bloqueo

const SH = {
  USERS: 'usuarios',
  PRODUCTS: 'productos',
  SALES: 'ventas',
  MOVES: 'movimientos',
  LOG: 'accesos'
};

const HEADERS = {
  usuarios: ['email', 'nombre', 'pin', 'rol', 'activo'],
  productos: ['id', 'nombre', 'precio', 'stock', 'stock_minimo', 'activo', 'actualizado'],
  ventas: ['venta_id', 'fecha', 'email', 'vendedor', 'producto_id', 'producto', 'cantidad', 'precio_unit', 'total', 'metodo_pago', 'cliente', 'estado'],
  movimientos: ['fecha', 'email', 'producto_id', 'producto', 'tipo', 'cantidad', 'stock_resultante', 'nota'],
  accesos: ['fecha', 'email', 'resultado']
};

/** Correos y nombres de quienes pueden entrar. Llénalo ANTES de ejecutar setup() (no se guarda en el repositorio). */
const USUARIOS_INICIALES = [
  // ['correo@gmail.com', 'Nombre'],
];

const PAY_METHODS = ['Efectivo', 'Transferencia', 'Nequi', 'Daviplata', 'Tarjeta'];

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
      case 'logout': CacheService.getScriptCache().remove('s:' + req.token); return json_({ ok: true });
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
  cache.put('s:' + token, JSON.stringify(user), SESSION_SECONDS);
  logAccess_(email, 'ok');
  return { ok: true, token: token, user: user };
}

function auth_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('s:' + token);
  if (!raw) return null;
  cache.put('s:' + token, raw, SESSION_SECONDS); // renovar por actividad
  return JSON.parse(raw);
}

function requireAdmin_(user) {
  if (user.rol !== 'admin') fail_('No tienes permiso para esta acción.');
}

function hashPin_(email, pin) {
  const salt = PropertiesService.getScriptProperties().getProperty('PIN_SALT') || '';
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
  return { ok: true, user: user, products: products, payMethods: PAY_METHODS };
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
  const cliente = safeText_(String(req.cliente || '').trim()).slice(0, 80);

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
      rows.push([ventaId, now, user.email, safeText_(user.nombre), l.p.id, l.p.nombre, l.qty, l.price, t, metodo, cliente, 'ok']);
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
    result = { ok: true, venta_id: ventaId, total: total, unidades: unidades, products: products.map(publicProduct_) };
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
      subject: 'Stock bajo — ' + alerts.map(function (a) { return a.nombre; }).join(', '),
      body: 'Aviso del POS de velas:\n\n' + lines.join('\n') + '\n\nEs momento de reponer inventario.'
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
      items: [],
      total: 0
    };
  }
  map[id].items.push({ producto: String(r[5]), cantidad: Number(r[6]), precio: Number(r[7]) });
  map[id].total += Number(r[8]) || 0;
}

/* ─────────────────────────────── Utilidades ─────────────────────────────── */

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) fail_('Falta la pestaña "' + name + '". Ejecuta setup().');
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
