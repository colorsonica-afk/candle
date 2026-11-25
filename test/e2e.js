const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { load } = require('./gas-mock');
const G = load(); G.ctx.setup();
const pin = G.sheets.usuarios.data[1][2];
const ROOT = path.join(__dirname, '../web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const srv = http.createServer((q, s) => {
  let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); s.end(fs.readFileSync(f));
}).listen(8765);
const OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript', body: "window.POS_CONFIG={API_URL:'https://script.google.com/macros/s/TEST/exec',STORE_NAME:'Sahana'};" }));
  await page.route('https://script.google.com/**', async r => {
    const body = JSON.parse(r.request().postData());
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(G.call(body)) });
  });
  await page.goto('http://localhost:8765/');
  await page.screenshot({ path: OUT + '/1-login.png' });
  await page.fill('#email', 'ana@test.co');
  for (const d of pin) await page.click(`#keypad button[data-k="${d}"]`);
  await page.waitForSelector('#app:not(.hidden)');
  // poner precio
  await page.click('.tabs button[data-v="products"]');
  await page.click('.padmin button[data-act="edit"]');
  await page.fill('#fPrice', '35000'); await page.fill('#fMin', '20');
  await page.click('#sheetOk'); await page.waitForSelector('#sheet.hidden', { state: 'attached' });
  await page.click('.tabs button[data-v="sell"]');
  for (let i = 0; i < 3; i++) await page.click('.prod');
  await page.click('#payMethods button[data-m="Nequi"]');
  await page.screenshot({ path: OUT + '/2-vender.png', fullPage: true });
  await page.click('#btnCharge'); await page.click('#sheetOk');
  await page.waitForSelector('.wa-btn');
  console.log('recibo:', await page.textContent('.big-total'), '| wa:', (await page.getAttribute('.wa-btn', 'href')).slice(0, 40));
  await page.click('#sheetOk'); await page.waitForSelector('#sheet.hidden', { state: 'attached' });
  // Fiado sin cliente -> abre selector
  await page.click('.prod'); await page.click('#payMethods button[data-m="Fiado"]'); await page.click('#btnCharge');
  await page.waitForSelector('#pickNew');
  await page.fill('#pickSearch', 'Doña Rosa'); await page.click('#pickNew');
  await page.fill('#cPhone', '300 123 4567'); await page.click('#sheetOk');
  await page.waitForSelector('#sheet.hidden', { state: 'attached' });
  console.log('cliente elegido:', await page.textContent('#btnClient'));
  await page.click('#btnCharge'); await page.screenshot({ path: OUT + '/6-confirmar-fiado.png' }); await page.click('#sheetOk');
  await page.waitForSelector('.wa-btn');
  const href = await page.getAttribute('.wa-btn', 'href');
  console.log('fiado recibo:', await page.textContent('#sheetBody p:nth-child(2)'), '| wa ->', href.slice(0, 30), /Saldo total que debes: \$\s35\.000/.test(decodeURIComponent(href)));
  await page.screenshot({ path: OUT + '/7-recibo-whatsapp.png' });
  await page.click('#sheetOk');
  // Clientes: abono
  await page.click('.tabs button[data-v="clients"]'); await page.waitForSelector('.client-item');
  console.log('por cobrar:', await page.textContent('#debtTotal'));
  await page.screenshot({ path: OUT + '/8-clientes.png' });
  await page.click('.client-item'); await page.waitForSelector('#cPay');
  await page.screenshot({ path: OUT + '/9-cliente-detalle.png' });
  await page.click('#cPay'); await page.fill('#pVal', '20000'); await page.click('#pMet button[data-m="Nequi"]'); await page.click('#sheetOk');
  await page.waitForSelector('.wa-btn');
  console.log('tras abono:', await page.textContent('.big-total'));
  await page.click('#sheetOk');
  await page.click('.tabs button[data-v="sell"]');
  // venta grande que cruza el mínimo
  await page.click('.prod'); await page.fill('.stepper input', '127'); await page.dispatchEvent('.stepper input', 'change');
  await page.click('#payMethods button[data-m="Efectivo"]');
  await page.click('#btnCharge'); await page.click('#sheetOk');
  await page.waitForSelector('#toast.bad');
  console.log('toast:', await page.textContent('#toast'));
  console.log('banner:', await page.textContent('#lowStock'));
  await page.click('#sheetOk');
  await page.click('.tabs button[data-v="report"]');
  await page.waitForSelector('.kpi.main');
  await page.screenshot({ path: OUT + '/3-informe-hoy.png', fullPage: true });
  await page.click('#reportScope button[data-s="semana"]');
  await page.screenshot({ path: OUT + '/4-informe-semana.png', fullPage: true });
  await page.click('.tabs button[data-v="products"]');
  await page.screenshot({ path: OUT + '/5-productos.png', fullPage: true });
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log('scrollWidth', sw, 'mails', G.mails.length, 'errors', errors);
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
