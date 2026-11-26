// Pruebas de las correcciones de la revisión independiente (un escenario por error encontrado).
const assert = require('assert');
const { load } = require('./gas-mock');
const G = load();
G.ctx.setup();
const pin = G.sheets.usuarios.data[1][2];
const T = G.call({ action: 'login', email: 'ana@test.co', pin: pin }).token;
const call = (action, data) => G.call(Object.assign({ action: action, token: T }, data || {}));
const ok = (r) => { assert.ok(r.ok, r.msg); return r; };

ok(call('saveProduct', { product: { id: 'P001', nombre: 'Kit', precio: 10000, stock_minimo: 0 } }));
const C = ok(call('saveClient', { client: { nombre: 'Rosa', celular: '3001112233' } })).id;
const fiar = (valor) => ok(call('sell', { items: [{ id: 'P001', qty: valor / 10000 }], metodo: 'Fiado', cliente_id: C })).venta_id;
const hist = () => ok(call('clientDetail', { cliente_id: C })).historial;

// 1) Abono parcial: "Marcar pagado" cobra solo lo que falta
const A = fiar(10000);
ok(call('addPayment', { cliente_id: C, valor: 4000, metodo: 'Efectivo' }));
assert.strictEqual(hist().find((h) => h.venta_id === A).pendiente, 6000);
let r = ok(call('payFiado', { venta_id: A, metodo: 'Nequi' }));
assert.strictEqual(r.valor, 6000, 'cobra 6.000, no 10.000');
assert.strictEqual(r.cliente.saldo, 0);
assert.ok(r.historial.find((h) => h.venta_id === A).pagada);

// 2) Marcar pagado el fiado NUEVO deja pagado ese, no el viejo
const B = fiar(10000);              // viejo
const D = fiar(20000);              // nuevo
r = ok(call('payFiado', { venta_id: D, metodo: 'Llave' }));
assert.strictEqual(r.valor, 20000);
assert.ok(r.historial.find((h) => h.venta_id === D).pagada, 'el nuevo queda pagado');
assert.ok(!r.historial.find((h) => h.venta_id === B).pagada, 'el viejo sigue pendiente');
assert.strictEqual(r.cliente.saldo, 10000);
assert.match(call('payFiado', { venta_id: D }).msg, /ya estaba pagada/);
r = ok(call('payFiado', { venta_id: B, metodo: 'Efectivo' }));
assert.strictEqual(r.valor, 10000); assert.strictEqual(r.cliente.saldo, 0);

// 3) Un producto quitado no le presta su código a uno nuevo
let p = ok(call('saveProduct', { product: { nombre: 'Temporal', precio: 1000, stock: 5, stock_minimo: 0 } }));
const tmp = p.products.find((x) => x.nombre === 'Temporal').id;
const vt = ok(call('sell', { items: [{ id: tmp, qty: 2 }], metodo: 'Efectivo' })).venta_id;
ok(call('deleteProduct', { id: tmp }));
p = ok(call('saveProduct', { product: { nombre: 'Nueva', precio: 2000, stock: 7, stock_minimo: 0 } }));
const nueva = p.products.find((x) => x.nombre === 'Nueva');
assert.notStrictEqual(nueva.id, tmp, 'código nuevo distinto');
p = ok(call('void', { venta_id: vt }));
assert.strictEqual(p.products.find((x) => x.nombre === 'Nueva').stock, 7, 'anular no suma unidades a otro producto');

// 4) Precio viejo en el celular: no se cobra distinto a lo que vio el cliente
ok(call('saveProduct', { product: { id: 'P001', nombre: 'Kit', precio: 12000, stock_minimo: 0 } }));
r = call('sell', { items: [{ id: 'P001', qty: 1, esperado: 10000 }], metodo: 'Efectivo' });
assert.strictEqual(r.ok, false); assert.match(r.msg, /cambió a \$12\.000/);
ok(call('sell', { items: [{ id: 'P001', qty: 1, esperado: 12000 }], metodo: 'Efectivo' }));
ok(call('sell', { items: [{ id: 'P001', qty: 1, esperado: 10000, precio: 9000 }], metodo: 'Efectivo' })); // precio ajustado a mano por admin

// 5) Reintento tras corte de internet: no duplica la venta
const filas = G.sheets.ventas.data.length;
const stock0 = ok(call('bootstrap')).products.find((x) => x.id === 'P001').stock;
const r1 = ok(call('sell', { items: [{ id: 'P001', qty: 3, esperado: 12000 }], metodo: 'Efectivo', key: 'abc12345xyz' }));
const r2 = ok(call('sell', { items: [{ id: 'P001', qty: 3, esperado: 12000 }], metodo: 'Efectivo', key: 'abc12345xyz' }));
assert.strictEqual(r1.venta_id, r2.venta_id); assert.ok(r2.repetida);
assert.strictEqual(G.sheets.ventas.data.length, filas + 1, 'una sola fila');
assert.strictEqual(r2.products.find((x) => x.id === 'P001').stock, stock0 - 3, 'stock descontado una vez');

// 8) Abono suelto y "Marcar pagado" (secuenciales con candado) nunca pasan del saldo
const E = fiar(10000);              // 1 unidad, ya a $12.000
ok(call('addPayment', { cliente_id: C, valor: 12000, metodo: 'Efectivo' }));
assert.match(call('payFiado', { venta_id: E }).msg, /ya estaba pagada/);

// 9) Nombres raros no se vuelven fórmula al copiarlos a ventas/movimientos/abonos
const C2 = ok(call('saveClient', { client: { nombre: '=SUMA(1)' } })).id;
G.sheets.clientes.data.forEach((row) => { if (row[0] === C2) row[1] = '=SUMA(1)'; }); // Sheets devuelve el texto sin apóstrofo
ok(call('sell', { items: [{ id: 'P001', qty: 1, esperado: 12000 }], metodo: 'Fiado', cliente_id: C2 }));
ok(call('addPayment', { cliente_id: C2, valor: 1000 }));
const ult = G.sheets.ventas.data[G.sheets.ventas.data.length - 1];
assert.ok(String(ult[10]).startsWith("'="), 'cliente en ventas protegido');
assert.ok(String(G.sheets.abonos.data[G.sheets.abonos.data.length - 1][2]).startsWith("'="), 'cliente en abonos protegido');

console.log('Correcciones OK — 7 escenarios de la revisión verificados');
