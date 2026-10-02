// Database layer. One small async interface, two backends:
//   - Turso / libSQL (hosted, works on Vercel)  -> set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)
//   - local SQLite file (node:sqlite, Node 22.5+) -> default for `node server.js`
// db.all(sql,args) -> rows[] · db.get -> row|undefined · db.run -> {lastInsertRowid,changes}
// db.tx(async t => { ... }) -> t has the same all/get/run, committed or rolled back as a unit
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','cashier')), pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), old INTEGER, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), badge TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '', img TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), sub INTEGER NOT NULL, disc INTEGER NOT NULL, total INTEGER NOT NULL, method TEXT NOT NULL, tendered INTEGER NOT NULL, cust TEXT NOT NULL DEFAULT '', voided INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stock_log(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, user_id INTEGER, time INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sales_time ON sales(time);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
`;

function localDb(file) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  let lock = Promise.resolve();
  const api = {
    kind: "local",
    async all(sql, args = []) { return d.prepare(sql).all(...args).map(r => ({ ...r })); },
    async get(sql, args = []) { return (await api.all(sql, args))[0]; },
    async run(sql, args = []) { const r = d.prepare(sql).run(...args); return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) }; },
    async exec(sql) { d.exec(sql); },
    async tx(fn) {
      const prev = lock; let release; lock = new Promise(r => (release = r)); await prev;
      try {
        d.exec("BEGIN IMMEDIATE");
        try { const out = await fn(api); d.exec("COMMIT"); return out; }
        catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; }
      } finally { release(); }
    },
  };
  return api;
}

function tursoDb(url, token) {
  const web = /^(libsql|https?|wss?):/.test(url);
  const lib = web ? require("@libsql/client/web") : require("@libsql/client"); // web client = no native code (Vercel)
  const c = lib.createClient({ url, authToken: token });
  const rowsOf = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((col, i) => [col, typeof r[i] === "bigint" ? Number(r[i]) : r[i]])));
  const wrap = x => {
    const o = {
      kind: "turso",
      async all(sql, args = []) { return rowsOf(await x.execute({ sql, args })); },
      async get(sql, args = []) { return (await o.all(sql, args))[0]; },
      async run(sql, args = []) { const r = await x.execute({ sql, args }); return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected }; },
      async exec(sql) { await x.executeMultiple(sql); },
    };
    return o;
  };
  const api = wrap(c);
  api.tx = async fn => {
    const t = await c.transaction("write");
    try { const out = await fn(wrap(t)); await t.commit(); return out; }
    catch (e) { try { await t.rollback(); } catch {} throw e; }
    finally { t.close(); }
  };
  return api;
}

function open() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return tursoDb(url, process.env.TURSO_AUTH_TOKEN);
  // On Vercel the project folder is read-only; /tmp works but is wiped between cold starts (demo only)
  const file = process.env.DB_FILE || (process.env.VERCEL ? "/tmp/xmobile.db" : path.join(__dirname, "..", "data", "xmobile.db"));
  if (process.env.VERCEL) console.warn("[xmobile] TURSO_DATABASE_URL is not set: using a temporary database. Data will be lost. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  return localDb(file);
}

module.exports = { open, SCHEMA };
