// Emulador mínimo de Apps Script para probar Code.gs localmente.
const fs = require('fs'), vm = require('vm'), crypto = require('crypto'), path = require('path');

function makeSheet(name) {
  const data = [];
  const sh = {
    name, data,
    getLastRow: () => data.length,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues(v) { for (let i = 0; i < nr; i++) { data[r - 1 + i] = data[r - 1 + i] || []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; } },
      setValue(v) { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = v; },
      getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j])); },
      setNumberFormat() {}
    }),
    appendRow: (row) => data.push(row.slice()),
    setFrozenRows() {}
  };
  return sh;
}

function load() {
  const sheets = {}, cache = new Map(), props = new Map(), mails = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    setSpreadsheetTimeZone() {}
  };
  const fmt = (d, tz, p) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
    const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
    return p.replace('yyyy', parts.year).replace('yy', parts.year.slice(2)).replace('MM', parts.month).replace('dd', parts.day)
      .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second).replace(/^u$/, String(u));
  };
  const ctx = {
    console, Math, JSON, Date, String, Number, Object, Array, Error, isFinite, RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.has(k) ? cache.get(k) : null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate: fmt, getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }
    },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    MailApp: { sendEmail: m => mails.push(m) },
    Logger: { log() {} }
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8')
    .replace("// ['correo@gmail.com', 'Nombre'],", "['ana@test.co','Ana'],['bea@test.co','Bea'],['cata@test.co','Cata'],");
  vm.runInContext(code, ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);
  return { ctx, sheets, mails, call };
}
module.exports = { load };
