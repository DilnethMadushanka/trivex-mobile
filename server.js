// xMobile backend – zero dependencies. Needs Node 22.5+ (uses built-in node:sqlite).
// Run:  node server.js     then open http://localhost:3000
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, "data", "xmobile.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','cashier')), pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), old INTEGER, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), badge TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '', img TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), sub INTEGER NOT NULL, disc INTEGER NOT NULL, total INTEGER NOT NULL, method TEXT NOT NULL, tendered INTEGER NOT NULL, cust TEXT NOT NULL DEFAULT '', voided INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stock_log(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, user_id INTEGER, time INTEGER NOT NULL);
`);

// ---------- helpers ----------
const now = () => Date.now();
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString("hex") + ":" + crypto.scryptSync(pw, s, 64).toString("hex"); };
const checkPw = (pw, stored) => { const [s, h] = stored.split(":"); const a = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64), b = Buffer.from(h, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const int = (v, min = 0) => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new HttpError(400, "Invalid number"); return n; };
const str = (v, max = 120) => { if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "Invalid text"); return v.trim(); };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };

// ---------- seed ----------
if (!db.prepare("SELECT 1 FROM products LIMIT 1").get()) {
  const ins = db.prepare("INSERT INTO products(sku,name,brand,cat,price,old,stock,badge,spec) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const p of require("./seed.js")) ins.run(p.sku, p.name, p.brand, p.cat, p.price, p.old, p.stock, p.badge, p.spec);
}
if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString("hex");
  db.prepare("INSERT INTO users(username,name,role,pass) VALUES('admin','Owner','admin',?)").run(hashPw(pw));
  console.log("\n  First run: admin account created\n  username: admin\n  password: " + pw + "\n  (change it in Admin > Staff)\n");
}

// ---------- auth ----------
const fails = new Map(); // ip -> {n, until}
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(c => c[0])); }
function currentUser(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const row = db.prepare("SELECT u.id,u.username,u.name,u.role,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1").get(sha(t));
  if (!row || row.expires < now()) return null; return row;
}
const need = (u, ...roles) => { if (!u) throw new HttpError(401, "Please log in"); if (roles.length && !roles.includes(u.role)) throw new HttpError(403, "Not allowed"); };

// ---------- data access ----------
const productRow = r => ({ ...r, old: r.old ?? null });
const listProducts = (all) => db.prepare(`SELECT id,sku,name,brand,cat,price,old,stock,badge,spec,img,active FROM products ${all ? "" : "WHERE active=1"} ORDER BY id`).all().map(productRow);
const saleView = s => ({ ...s, inv: "XM-" + String(s.id).padStart(5, "0"), items: db.prepare("SELECT product_id AS id,sku,name,qty,price FROM sale_items WHERE sale_id=?").all(s.id) });
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// ---------- routes ----------
const routes = {
  "GET /api/products": (req, body, u) => listProducts(u && u.role === "admin" && req.query.all === "1"),
  "GET /api/me": (req, body, u) => ({ user: u ? { username: u.username, name: u.name, role: u.role } : null }),

  "POST /api/login": (req, body, u, res) => {
    const ip = req.socket.remoteAddress, f = fails.get(ip);
    if (f && f.until > now()) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    const row = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(String(body.username || "").toLowerCase());
    if (!row || !checkPw(String(body.password || ""), row.pass)) {
      const n = (f?.n || 0) + 1; fails.set(ip, { n, until: n >= 5 ? now() + 5 * 60e3 : 0 });
      throw new HttpError(401, "Wrong username or password");
    }
    fails.delete(ip);
    const t = crypto.randomBytes(32).toString("hex"), exp = now() + 12 * 3600e3;
    db.prepare("DELETE FROM sessions WHERE expires<?").run(now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(t), row.id, exp);
    res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    return { user: { username: row.username, name: row.name, role: row.role } };
  },
  "POST /api/logout": (req, body, u, res) => {
    const t = parseCookies(req).sid; if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(sha(t));
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); return { ok: true };
  },
  "POST /api/password": (req, body, u) => {
    need(u); const row = db.prepare("SELECT pass FROM users WHERE id=?").get(u.id);
    if (!checkPw(String(body.current || ""), row.pass)) throw new HttpError(400, "Current password is wrong");
    const np = String(body.password || ""); if (np.length < 6) throw new HttpError(400, "New password must be at least 6 characters");
    db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPw(np), u.id); return { ok: true };
  },

  // --- POS ---
  "POST /api/sales": (req, body, u) => {
    need(u, "admin", "cashier");
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw new HttpError(400, "Sale is empty");
    const method = ["Cash", "Card", "Transfer"].includes(body.method) ? body.method : (() => { throw new HttpError(400, "Bad payment method"); })();
    return tx(() => {
      let sub = 0; const lines = [];
      for (const it of body.items) {
        const qty = int(it.qty, 1), p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(int(it.id, 1));
        if (!p) throw new HttpError(400, "Product not found");
        if (p.stock < qty) throw new HttpError(409, `Only ${p.stock} left of ${p.name}`);
        lines.push({ p, qty }); sub += p.price * qty;
      }
      const disc = Math.min(int(body.discount ?? 0), sub), total = sub - disc;
      const tendered = method === "Cash" ? int(body.tendered ?? total) : total;
      if (tendered < total) throw new HttpError(400, "Cash received is less than the total");
      const cust = String(body.cust || "").slice(0, 30);
      const sid = db.prepare("INSERT INTO sales(time,user_id,sub,disc,total,method,tendered,cust) VALUES(?,?,?,?,?,?,?,?)").run(now(), u.id, sub, disc, total, method, tendered, cust).lastInsertRowid;
      for (const { p, qty } of lines) {
        db.prepare("INSERT INTO sale_items(sale_id,product_id,sku,name,qty,price) VALUES(?,?,?,?,?,?)").run(sid, p.id, p.sku, p.name, qty, p.price);
        db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(qty, p.id);
        db.prepare("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)").run(p.id, -qty, "sale " + sid, u.id, now());
      }
      return saleView(db.prepare("SELECT * FROM sales WHERE id=?").get(sid));
    });
  },
  "GET /api/sales": (req, body, u) => {
    need(u, "admin", "cashier");
    const days = Math.min(+req.query.days || 1, 90), since = startOfDay(new Date(now() - (days - 1) * 864e5));
    // cashiers only ever see today's sales
    const from = u.role === "admin" ? since : startOfDay();
    const rows = db.prepare("SELECT s.*,u.name AS cashier FROM sales s JOIN users u ON u.id=s.user_id WHERE s.time>=? ORDER BY s.id DESC LIMIT 500").all(from);
    return rows.map(saleView);
  },
  "POST /api/sales/void": (req, body, u) => {
    need(u, "admin");
    return tx(() => {
      const s = db.prepare("SELECT * FROM sales WHERE id=?").get(int(body.id, 1));
      if (!s || s.voided) throw new HttpError(400, "Sale not found or already voided");
      for (const it of db.prepare("SELECT * FROM sale_items WHERE sale_id=?").all(s.id)) {
        db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(it.qty, it.product_id);
        db.prepare("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)").run(it.product_id, it.qty, "void " + s.id, u.id, now());
      }
      db.prepare("UPDATE sales SET voided=1 WHERE id=?").run(s.id); return { ok: true };
    });
  },

  // --- Admin: products ---
  "POST /api/products": (req, body, u) => {
    need(u, "admin"); const b = productBody(body);
    try {
      const id = db.prepare("INSERT INTO products(sku,name,brand,cat,price,old,stock,badge,spec,img) VALUES(?,?,?,?,?,?,?,?,?,?)").run(b.sku, b.name, b.brand, b.cat, b.price, b.old, b.stock, b.badge, b.spec, b.img).lastInsertRowid;
      return { id };
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, "SKU already exists"); throw e; }
  },
  "PUT /api/products": (req, body, u) => {
    need(u, "admin"); const b = productBody(body), id = int(body.id, 1);
    const cur = db.prepare("SELECT stock FROM products WHERE id=?").get(id); if (!cur) throw new HttpError(404, "Not found");
    try {
      db.prepare("UPDATE products SET sku=?,name=?,brand=?,cat=?,price=?,old=?,stock=?,badge=?,spec=?,img=?,active=? WHERE id=?").run(b.sku, b.name, b.brand, b.cat, b.price, b.old, b.stock, b.badge, b.spec, b.img, body.active === 0 ? 0 : 1, id);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, "SKU already exists"); throw e; }
    if (b.stock !== cur.stock) db.prepare("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)").run(id, b.stock - cur.stock, "manual edit", u.id, now());
    return { ok: true };
  },
  "DELETE /api/products": (req, body, u) => { // soft delete keeps sales history intact
    need(u, "admin"); db.prepare("UPDATE products SET active=0 WHERE id=?").run(int(req.query.id, 1)); return { ok: true };
  },

  // --- Admin: staff ---
  "GET /api/users": (req, body, u) => { need(u, "admin"); return db.prepare("SELECT id,username,name,role,active FROM users ORDER BY id").all(); },
  "POST /api/users": (req, body, u) => {
    need(u, "admin"); const un = str(body.username, 30).toLowerCase(), pw = String(body.password || "");
    if (!/^[a-z0-9_.-]+$/.test(un)) throw new HttpError(400, "Username: letters, numbers, . _ - only");
    if (pw.length < 6) throw new HttpError(400, "Password must be at least 6 characters");
    if (!["admin", "cashier"].includes(body.role)) throw new HttpError(400, "Bad role");
    try { db.prepare("INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)").run(un, str(body.name, 60), body.role, hashPw(pw)); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, "Username taken"); throw e; }
    return { ok: true };
  },
  "PUT /api/users": (req, body, u) => { // enable/disable or reset password
    need(u, "admin"); const id = int(body.id, 1);
    if (id === u.id && body.active === 0) throw new HttpError(400, "You can't disable your own account");
    if (body.active !== undefined) { db.prepare("UPDATE users SET active=? WHERE id=?").run(body.active ? 1 : 0, id); db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); }
    if (body.password) { if (String(body.password).length < 6) throw new HttpError(400, "Password must be at least 6 characters"); db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPw(String(body.password)), id); db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); }
    return { ok: true };
  },

  // --- Admin: report ---
  "GET /api/report": (req, body, u) => {
    need(u, "admin"); const d0 = startOfDay(), sum = since => db.prepare("SELECT COALESCE(SUM(total),0) AS t, COUNT(*) AS n FROM sales WHERE voided=0 AND time>=?").get(since);
    return {
      today: sum(d0), week: sum(d0 - 6 * 864e5), month: sum(d0 - 29 * 864e5),
      top: db.prepare("SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty*i.price) AS rev FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.voided=0 AND s.time>=? GROUP BY i.product_id ORDER BY qty DESC LIMIT 5").all(d0 - 29 * 864e5),
      low: db.prepare("SELECT id,sku,name,stock FROM products WHERE active=1 AND stock<=5 ORDER BY stock LIMIT 20").all(),
    };
  },
};
function productBody(b) {
  const cats = ["phones", "audio", "wearables", "power", "tablets", "accessories"];
  if (!cats.includes(b.cat)) throw new HttpError(400, "Bad category");
  const price = int(b.price), old = b.old ? int(b.old) : null;
  const img = b.img ? String(b.img).slice(0, 500) : null;
  if (img && !/^(https?:\/\/|\/?[\w./-]+$)/.test(img)) throw new HttpError(400, "Bad image URL");
  return { sku: str(b.sku, 30), name: str(b.name), brand: String(b.brand || "").slice(0, 40), cat: b.cat, price, old, stock: int(b.stock ?? 0), badge: String(b.badge || "").slice(0, 12), spec: String(b.spec || "").slice(0, 120), img };
}

// ---------- server ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" };
const SEC = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" };

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  const url = new URL(req.url, "http://x"); req.query = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname.startsWith("/api/")) {
      const h = routes[req.method + " " + url.pathname];
      if (!h) throw new HttpError(404, "Not found");
      if (req.method !== "GET") { // CSRF: same-origin only
        const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) throw new HttpError(403, "Bad origin");
      }
      let body = {};
      if (req.method === "POST" || req.method === "PUT") {
        let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, "Too large"); }
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "Bad JSON"); }
      }
      const out = h(req, body, currentUser(req), res);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(out));
    }
    // static files
    let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("Not found"); }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream", size = fs.statSync(file).size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) { // Range support (video seeking, Safari)
      let st = m[1] ? +m[1] : size - +m[2], en = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      if (st > en || st >= size) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${st}-${en}/${size}`, "Accept-Ranges": "bytes", "Content-Length": en - st + 1 });
      return fs.createReadStream(file, { start: st, end: en }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error(e);
    res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: code === 500 ? "Server error" : e.message }));
  }
}).listen(PORT, () => console.log(`xMobile running → http://localhost:${PORT}   (POS: /pos.html   Admin: /admin.html)`));
