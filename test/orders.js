// Recorrido: pedido en proceso -> entregado, y fiado -> marcar pagado.
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { load } = require('./gas-mock');
const G = load(); G.ctx.setup();
const pin = G.sheets.usuarios.data[1][2];
const ROOT = path.join(__dirname, '../web'); const OUT = process.argv[2] || '.';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => { let f = path.join(ROOT, q.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html';
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(f)] }); s.end(fs.readFileSync(f)); }).listen(8769);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript', body: "window.POS_CONFIG={API_URL:'https://script.google.com/x/exec',STORE_NAME:'Sahana'};" }));
  await p.route('https://script.google.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(G.call(JSON.parse(r.request().postData()))) }));
  await p.goto('http://localhost:8769/');
  await p.fill('#email', 'ana@test.co'); for (const d of pin) await p.click(`#keypad button[data-k="${d}"]`);
  await p.waitForSelector('#app:not(.hidden)');
  const tok = await p.evaluate(() => localStorage.getItem('pos_token'));
  G.call({ action: 'saveProduct', token: tok, product: { id: 'P001', nombre: 'Kit alumbrado', precio: 35000, stock_minimo: 20 } });
  await p.click('#btnRefresh'); await p.waitForTimeout(500);

  // 1) Pedido en proceso con cliente nuevo, fiado
  await p.click('.prod'); await p.click('.prod');
  await p.click('#payMethods button[data-m="Fiado"]');
  await p.click('#deliveryOpts button[data-e="en proceso"]');
  await p.click('#btnClient'); await p.fill('#pickSearch', 'Martha'); await p.click('#pickNew');
  await p.fill('#cPhone', '3109876543'); await p.click('#sheetOk'); await p.waitForSelector('#sheet.hidden', { state: 'attached' });
  await p.screenshot({ path: OUT + '/o1-vender-en-proceso.png', fullPage: true });
  await p.click('#btnCharge');
  console.log('confirmar:', (await p.textContent('#sheetBody')).includes('en proceso'));
  await p.click('#sheetOk'); await p.waitForSelector('#sheetBody .wa-btn');
  console.log('recibo dice en proceso:', decodeURIComponent(await p.getAttribute('#sheetBody .wa-btn', 'href')).includes('Tu pedido está *en proceso*'));
  await p.click('#sheetOk');
  await p.waitForSelector('#ordersBadge:not(.hidden)');
  console.log('contador pedidos:', await p.textContent('#ordersBadge'));

  // 2) Pestaña pedidos -> marcar entregado
  await p.click('.tabs button[data-v="orders"]'); await p.waitForSelector('[data-deliver]');
  await p.screenshot({ path: OUT + '/o2-pedidos.png' });
  console.log('aviso listo ->', (await p.getAttribute('.order .wa-btn', 'href')).slice(0, 26));
  await p.click('[data-deliver]'); await p.waitForSelector('[data-undo]');
  console.log('en proceso tras entregar:', await p.textContent('#ordersBody h2'), '| contador oculto:', await p.isHidden('#ordersBadge'));

  // 3) Cliente -> marcar pagado el fiado
  await p.click('.tabs button[data-v="clients"]'); await p.waitForSelector('.client-item');
  await p.click('.client-item'); await p.waitForSelector('[data-paid]');
  await p.screenshot({ path: OUT + '/o3-cliente-marcar-pagado.png' });
  await p.click('[data-paid]'); await p.click('#pMet button[data-m="Llave"]'); await p.click('#sheetOk');
  await p.waitForSelector('.wa-btn');
  console.log('tras pagar:', await p.textContent('.big-total'));
  await p.click('#sheetOk');
  await p.click('.client-item'); await p.waitForSelector('.paid');
  console.log('historial:', await p.textContent('.paid'), '| abono método:', G.sheets.abonos.data[1][4], G.sheets.abonos.data[1][6]);
  await p.screenshot({ path: OUT + '/o4-pagada.png' });
  console.log('ancho:', await p.evaluate(() => document.documentElement.scrollWidth), 'errores:', errs);
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
