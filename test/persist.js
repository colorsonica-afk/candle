const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { load } = require('./gas-mock');
const G = load(); G.ctx.setup();
const pin = G.sheets.usuarios.data[1][2];
const ROOT = path.join(__dirname, '../web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => { let f = path.join(ROOT, q.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html';
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }); s.end(fs.readFileSync(f)); }).listen(8767);
const dir = fs.mkdtempSync('/tmp/claude-0/-home-user-candle/a0a80ad1-c764-5d4e-a2a6-0c9c7eac4530/scratchpad/prof-');
let online = true;
async function open() {
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], serviceWorkers: 'block' });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript', body: "window.POS_CONFIG={API_URL:'https://script.google.com/macros/s/TEST/exec'};" }));
  await page.route('https://script.google.com/**', r => online
    ? r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(G.call(JSON.parse(r.request().postData()))) })
    : r.abort('internetdisconnected'));
  await page.goto('http://localhost:8767/');
  return { ctx, page };
}
const state = async p => (await p.isVisible('#app')) ? 'APP' : 'LOGIN';
(async () => {
  let { ctx, page } = await open();
  await page.fill('#email', 'ana@test.co'); for (const d of pin) await page.click(`#keypad button[data-k="${d}"]`);
  await page.waitForSelector('#app:not(.hidden)'); console.log('1. primer ingreso con PIN:', await state(page));
  await ctx.close();                                    // "apagar el celular"
  G.cache.clear();                                      // Google vacía su caché
  ({ ctx, page } = await open()); await page.waitForTimeout(800);
  console.log('2. reabrir (sin PIN):', await state(page)); await ctx.close();
  online = false;
  ({ ctx, page } = await open()); await page.waitForTimeout(800);
  console.log('3. reabrir sin internet:', await state(page), '| producto:', await page.textContent('.prod .name'), '| aviso:', await page.textContent('#toast')); await ctx.close();
  online = true;
  ({ ctx, page } = await open()); await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tabs button[data-v="account"]'); await page.click('#btnLogout'); await page.waitForSelector('#login:not(.hidden)'); await ctx.close();
  ({ ctx, page } = await open()); await page.waitForTimeout(800);
  console.log('4. tras "Cerrar sesión" pide PIN:', await state(page)); await ctx.close();
  srv.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
