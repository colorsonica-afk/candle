const assert = require('assert');
const { load } = require('./gas-mock');
const G = load();
G.ctx.setup();
const users = G.sheets.usuarios.data;
assert.strictEqual(users.length, 4);
const vivi = users[1], pinV = vivi[2];
assert.match(pinV, /^\d{4}$/);

// Sin sesión: nada
assert.strictEqual(G.call({ action: 'report' }).code, 'SESSION');
assert.strictEqual(G.call({ action: 'bootstrap', token: 'f'.repeat(64) }).code, 'SESSION');
// Correo no listado / PIN malo
assert.strictEqual(G.call({ action: 'login', email: 'otro@gmail.com', pin: '1234' }).ok, false);
const bad = pinV === '0000' ? '1111' : '0000';
assert.strictEqual(G.call({ action: 'login', email: 'ana@test.co', pin: bad }).ok, false);
// Login OK (mayúsculas en correo) y PIN queda cifrado
let r = G.call({ action: 'login', email: ' ANA@test.co ', pin: pinV });
assert.ok(r.ok, r.msg); const T = r.token;
assert.ok(String(users[1][2]).startsWith('h:'));
assert.ok(G.call({ action: 'login', email: 'ana@test.co', pin: pinV }).ok, 'segundo login con hash');

r = G.call({ action: 'bootstrap', token: T });
assert.strictEqual(r.products[0].stock, 150);

// Precio y venta
r = G.call({ action: 'saveProduct', token: T, product: { id: 'P001', nombre: 'Kit alumbrado', precio: 35000, stock_minimo: 20 } });
assert.strictEqual(r.products[0].precio, 35000);
r = G.call({ action: 'sell', token: T, items: [{ id: 'P001', qty: 3 }], metodo: 'Nequi', cliente: '=HYPERLINK("x")' });
assert.ok(r.ok, r.msg); assert.strictEqual(r.total, 105000); assert.strictEqual(r.products[0].stock, 147);
assert.ok(G.sheets.ventas.data[1][10].startsWith("'="), 'fórmula neutralizada');
// Precio ajustado en la venta
r = G.call({ action: 'sell', token: T, items: [{ id: 'P001', qty: 2, precio: 30000 }], metodo: 'Efectivo' });
assert.strictEqual(r.total, 60000);
// Sin stock suficiente
r = G.call({ action: 'sell', token: T, items: [{ id: 'P001', qty: 1000 }] });
assert.strictEqual(r.ok, false); assert.match(r.msg, /quedan 145/);
// Cruce de stock mínimo -> aviso + correo
r = G.call({ action: 'sell', token: T, items: [{ id: 'P001', qty: 126 }] });
assert.strictEqual(r.products[0].stock, 19); assert.strictEqual(r.alerts.length, 1);
assert.strictEqual(G.mails.length, 1); assert.match(G.mails[0].to, /bea@test/);
// Otra venta ya bajo el mínimo no repite correo
G.call({ action: 'sell', token: T, items: [{ id: 'P001', qty: 1 }] });
assert.strictEqual(G.mails.length, 1);

// Nuevo producto + entrada
r = G.call({ action: 'saveProduct', token: T, product: { nombre: 'Vela aroma canela', precio: 12000, stock: 40, stock_minimo: 5 } });
assert.strictEqual(r.products[1].id, 'P002');
r = G.call({ action: 'adjustStock', token: T, id: 'P001', cantidad: 50, nota: 'pedido' });
assert.strictEqual(r.products[0].stock, 68);
assert.strictEqual(G.call({ action: 'adjustStock', token: T, id: 'P001', cantidad: -999 }).ok, false);

// Informe
r = G.call({ action: 'report', token: T });
assert.ok(r.ok, r.msg);
assert.strictEqual(r.resumen.hoy.unidades, 132); assert.strictEqual(r.resumen.hoy.ventas, 4);
assert.strictEqual(r.resumen.total.total, 105000 + 60000 + 126 * 35000 + 35000);
assert.strictEqual(r.ventasHoy.length, 4);
assert.ok(r.semanaDias.length >= 1);
// Anular
const vid = r.ventasHoy[r.ventasHoy.length - 1].venta_id;
r = G.call({ action: 'void', token: T, venta_id: vid });
assert.strictEqual(r.products[0].stock, 71);
assert.strictEqual(G.call({ action: 'void', token: T, venta_id: vid }).ok, false);
r = G.call({ action: 'report', token: T });
assert.strictEqual(r.resumen.hoy.unidades, 129);

// Rol vendedor no puede administrar
users[2][3] = 'vendedor';
const tJ = G.call({ action: 'login', email: 'bea@test.co', pin: users[2][2] }).token;
assert.strictEqual(G.call({ action: 'saveProduct', token: tJ, product: { nombre: 'x', precio: 1, stock_minimo: 1 } }).ok, false);
r = G.call({ action: 'sell', token: tJ, items: [{ id: 'P001', qty: 1, precio: 1 }] });
assert.strictEqual(r.total, 35000, 'vendedor no cambia precio');

// Cambio de PIN
assert.ok(G.call({ action: 'changePin', token: T, actual: pinV, nueva: '4321' }).ok);
assert.ok(G.call({ action: 'login', email: 'ana@test.co', pin: '4321' }).ok);
// Bloqueo tras 5 intentos
for (let i = 0; i < 5; i++) G.call({ action: 'login', email: 'cata@test.co', pin: '9999' === users[3][2] ? '8888' : '9999' });
r = G.call({ action: 'login', email: 'cata@test.co', pin: users[3][2] });
assert.match(r.msg, /Demasiados/);
// Logout
G.call({ action: 'logout', token: T });
assert.strictEqual(G.call({ action: 'bootstrap', token: T }).code, 'SESSION');
console.log('Backend OK — todas las pruebas pasaron');
