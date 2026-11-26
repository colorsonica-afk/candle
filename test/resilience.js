// Navegador: abrir sin internet (service worker), precio viejo en el celular y reintento tras corte de internet.
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { load } = require('./gas-mock');
const G = load(); G.ctx.setup();
const pin = G.sheets.usuarios.data[1][2];
const ROOT = path.join(__dirname, '../web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  if (f.endsWith('config.js')) { s.writeHead(200, { 'content-type': 'text/javascript' }); return s.end("window.POS_CONFIG={API_URL:'https://script.google.com/x/exec',STORE_NAME:'Sahana'};"); }
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(f)] }); s.end(fs.readFileSync(f)); }).listen(8772);
const dir = fs.mkdtempSync(path.join(process.argv[2] || '/tmp', 'res-'));
let mode = 'ok';           // 'ok' | 'cortar' (procesa la venta pero la respuesta no llega)
async function open() {
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'] });
  const p = ctx.pages()[0] || await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await ctx.route('https://script.google.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    const out = G.call(body);
    if (mode === 'cortar' && body.action === 'sell') { mode = 'ok'; return r.abort('connectionreset'); }
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });
  return { ctx, p, errs };
}
(async () => {
  let { ctx, p, errs } = await open();
  await p.goto('http://localhost:8772/');
  await p.fill('#email', 'ana@test.co'); for (const d of pin) await p.click(`#keypad button[data-k="${d}"]`);
  await p.waitForSelector('#app:not(.hidden)');
  await p.evaluate(() => navigator.serviceWorker.ready); await p.waitForTimeout(800);
  const tok = await p.evaluate(() => localStorage.getItem('pos_token'));
  G.call({ action: 'saveProduct', token: tok, product: { id: 'P001', nombre: 'Kit alumbrado', precio: 35000, stock_minimo: 0 } });
  await p.click('#btnRefresh'); await p.waitForTimeout(500);
  // recarga para que el service worker guarde los archivos con versión (?v=)
  await p.reload(); await p.waitForSelector('#app:not(.hidden)'); await p.waitForTimeout(800);

  // 4) Precio cambió en otro celular: no cobra el precio viejo
  G.call({ action: 'saveProduct', token: tok, product: { id: 'P001', nombre: 'Kit alumbrado', precio: 40000, stock_minimo: 0 } });
  await p.click('.prod'); await p.click('#btnCharge');
  console.log('confirmación con precio viejo:', (await p.textContent('#sheetBody')).includes('35.000'));
  await p.click('#sheetOk'); await p.waitForSelector('#toast.bad');
  console.log('aviso:', await p.textContent('#toast'));
  await p.waitForTimeout(800);
  console.log('carrito actualizado:', await p.textContent('#btnCharge'), '| ventas guardadas:', G.sheets.ventas.data.length - 1);

  // 5) Corte de internet justo al cobrar y reintento: una sola venta
  const filas = G.sheets.ventas.data.length;
  mode = 'cortar';
  await p.click('#btnCharge'); await p.click('#sheetOk'); await p.waitForSelector('#toast.bad');
  console.log('aviso corte:', await p.textContent('#toast'), '| carrito sigue:', await p.textContent('#btnCharge'));
  await p.waitForTimeout(400);
  await p.click('#btnCharge'); await p.click('#sheetOk'); await p.waitForSelector('#sheetBody .wa-btn');
  console.log('filas nuevas en ventas (debe ser 1):', G.sheets.ventas.data.length - filas);
  await p.click('#sheetOk');
  await ctx.close();

  // 7) Abrir la app instalada SIN internet
  ({ ctx, p, errs } = await open());
  await ctx.setOffline(true);
  await p.goto('http://localhost:8772/').catch((e) => console.log('goto offline:', e.message));
  await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 }).catch(() => {});
  console.log('sin internet abre la app:', await p.isVisible('#app'), '| producto:', await p.textContent('.prod .name').catch(() => '-'), '| errores:', errs);
  await ctx.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
