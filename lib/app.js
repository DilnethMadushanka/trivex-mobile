// xMobile API: shared by the local server (server.js) and the Vercel function (api/index.js).
const crypto = require("node:crypto");

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const now = () => Date.now();
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString("hex") + ":" + crypto.scryptSync(pw, s, 64).toString("hex"); };
const checkPw = (pw, stored) => { const [s, h] = stored.split(":"); const a = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64), b = Buffer.from(h, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const int = (v, min = 0) => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new HttpError(400, "Invalid number"); return n; };
const str = (v, max = 120) => { if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "Invalid text"); return v.trim(); };
// "today" for the shop (Sri Lanka = UTC+5:30, no DST). Override with TZ_OFFSET_MIN. Vercel runs in UTC so we never rely on the server clock zone.
const TZ = Number.isFinite(+process.env.TZ_OFFSET_MIN) && process.env.TZ_OFFSET_MIN !== undefined ? +process.env.TZ_OFFSET_MIN : 330;
const startOfDay = (ts = now()) => Math.floor((ts + TZ * 60000) / 864e5) * 864e5 - TZ * 60000;
const CATS = ["phones", "audio", "wearables", "power", "tablets", "accessories"];

function createApp(db) {
  let readyP;
  const ready = () => readyP || (readyP = (async () => {
    await db.exec(require("./db").SCHEMA);
    if (!(await db.get("SELECT 1 AS x FROM products LIMIT 1"))) {
      for (const p of require("../seed.js"))
        await db.run("INSERT INTO products(sku,name,brand,cat,price,old,stock,badge,spec) VALUES(?,?,?,?,?,?,?,?,?)", [p.sku, p.name, p.brand, p.cat, p.price, p.old, p.stock, p.badge, p.spec]);
    }
    if (!(await db.get("SELECT 1 AS x FROM users LIMIT 1"))) {
      const given = process.env.ADMIN_PASSWORD, pw = given || crypto.randomBytes(5).toString("hex");
      await db.run("INSERT INTO users(username,name,role,pass) VALUES('admin','Owner','admin',?)", [hashPw(pw)]);
      console.log(given ? "\n  First run: admin account created (password from ADMIN_PASSWORD)\n" : "\n  First run: admin account created\n  username: admin\n  password: " + pw + "\n  (change it in Admin > Password)\n");
    }
  })().catch(e => { readyP = null; throw e; }));

  const fails = new Map(); // login throttling (per server instance)
  const parseCookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(c => c[0]));
  const ipOf = req => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?";
  const cookie = (req, v, maxAge) => `sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;
  async function currentUser(req) {
    const t = parseCookies(req).sid; if (!t) return null;
    const row = await db.get("SELECT u.id,u.username,u.name,u.role,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1", [sha(t)]);
    return !row || row.expires < now() ? null : row;
  }
  const need = (u, ...roles) => { if (!u) throw new HttpError(401, "Please log in"); if (roles.length && !roles.includes(u.role)) throw new HttpError(403, "Not allowed"); };

  const listProducts = async all => (await db.all(`SELECT id,sku,name,brand,cat,price,old,stock,badge,spec,img,active FROM products ${all ? "" : "WHERE active=1"} ORDER BY id`)).map(r => ({ ...r, old: r.old ?? null }));
  async function withItems(rows) { // one query for all line items (avoids N+1 round trips on a hosted DB)
    if (!rows.length) return [];
    const items = await db.all(`SELECT sale_id,product_id AS id,sku,name,qty,price FROM sale_items WHERE sale_id IN (${rows.map(() => "?").join(",")})`, rows.map(r => r.id));
    const by = {}; for (const i of items) (by[i.sale_id] ||= []).push({ id: i.id, sku: i.sku, name: i.name, qty: i.qty, price: i.price });
    return rows.map(s => ({ ...s, inv: "XM-" + String(s.id).padStart(5, "0"), items: by[s.id] || [] }));
  }
  function productBody(b) {
    if (!CATS.includes(b.cat)) throw new HttpError(400, "Bad category");
    const price = int(b.price), old = b.old ? int(b.old) : null;
    const img = b.img ? String(b.img).slice(0, 500) : null;
    if (img && !/^(https?:\/\/|\/?[\w./-]+$)/.test(img)) throw new HttpError(400, "Bad image URL");
    return { sku: str(b.sku, 30), name: str(b.name), brand: String(b.brand || "").slice(0, 40), cat: b.cat, price, old, stock: int(b.stock ?? 0), badge: String(b.badge || "").slice(0, 12), spec: String(b.spec || "").slice(0, 120), img };
  }
  const unique = e => /UNIQUE/i.test(String(e && e.message));

  const routes = {
    "GET /api/health": async () => { await ready(); return { ok: true, db: db.kind }; },
    "GET /api/products": async (req, body, u, res) => {
      const all = u && u.role === "admin" && req.query.all === "1";
      if (!all && !req.headers.cookie) res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30"); // anonymous store visitors: tiny edge cache
      return listProducts(all);
    },
    "GET /api/me": async (req, body, u) => ({ user: u ? { username: u.username, name: u.name, role: u.role } : null }),

    "POST /api/login": async (req, body, u, res) => {
      const ip = ipOf(req), f = fails.get(ip);
      if (f && f.until > now()) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
      const row = await db.get("SELECT * FROM users WHERE username=? AND active=1", [String(body.username || "").toLowerCase()]);
      if (!row || !checkPw(String(body.password || ""), row.pass)) {
        const n = (f?.n || 0) + 1; fails.set(ip, { n, until: n >= 5 ? now() + 5 * 60e3 : 0 });
        throw new HttpError(401, "Wrong username or password");
      }
      fails.delete(ip);
      const t = crypto.randomBytes(32).toString("hex"), exp = now() + 12 * 3600e3;
      await db.run("DELETE FROM sessions WHERE expires<?", [now()]);
      await db.run("INSERT INTO sessions VALUES(?,?,?)", [sha(t), row.id, exp]);
      res.setHeader("Set-Cookie", cookie(req, t, 12 * 3600));
      return { user: { username: row.username, name: row.name, role: row.role } };
    },
    "POST /api/logout": async (req, body, u, res) => {
      const t = parseCookies(req).sid; if (t) await db.run("DELETE FROM sessions WHERE token=?", [sha(t)]);
      res.setHeader("Set-Cookie", cookie(req, "", 0)); return { ok: true };
    },
    "POST /api/password": async (req, body, u) => {
      need(u); const row = await db.get("SELECT pass FROM users WHERE id=?", [u.id]);
      if (!checkPw(String(body.current || ""), row.pass)) throw new HttpError(400, "Current password is wrong");
      const np = String(body.password || ""); if (np.length < 6) throw new HttpError(400, "New password must be at least 6 characters");
      await db.run("UPDATE users SET pass=? WHERE id=?", [hashPw(np), u.id]); return { ok: true };
    },

    // --- POS ---
    "POST /api/sales": async (req, body, u) => {
      need(u, "admin", "cashier");
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw new HttpError(400, "Sale is empty");
      if (!["Cash", "Card", "Transfer"].includes(body.method)) throw new HttpError(400, "Bad payment method");
      const method = body.method;
      const sid = await db.tx(async t => {
        let sub = 0; const lines = [];
        for (const it of body.items) {
          const qty = int(it.qty, 1), p = await t.get("SELECT * FROM products WHERE id=? AND active=1", [int(it.id, 1)]);
          if (!p) throw new HttpError(400, "Product not found");
          if (p.stock < qty) throw new HttpError(409, `Only ${p.stock} left of ${p.name}`);
          lines.push({ p, qty }); sub += p.price * qty;
        }
        const disc = Math.min(int(body.discount ?? 0), sub), total = sub - disc;
        const tendered = method === "Cash" ? int(body.tendered ?? total) : total;
        if (tendered < total) throw new HttpError(400, "Cash received is less than the total");
        const id = (await t.run("INSERT INTO sales(time,user_id,sub,disc,total,method,tendered,cust) VALUES(?,?,?,?,?,?,?,?)", [now(), u.id, sub, disc, total, method, tendered, String(body.cust || "").slice(0, 30)])).lastInsertRowid;
        for (const { p, qty } of lines) {
          await t.run("INSERT INTO sale_items(sale_id,product_id,sku,name,qty,price) VALUES(?,?,?,?,?,?)", [id, p.id, p.sku, p.name, qty, p.price]);
          await t.run("UPDATE products SET stock=stock-? WHERE id=?", [qty, p.id]);
          await t.run("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)", [p.id, -qty, "sale " + id, u.id, now()]);
        }
        return id;
      });
      return (await withItems(await db.all("SELECT * FROM sales WHERE id=?", [sid])))[0];
    },
    "GET /api/sales": async (req, body, u) => {
      need(u, "admin", "cashier");
      const days = Math.min(+req.query.days || 1, 90), from = u.role === "admin" ? startOfDay(now() - (days - 1) * 864e5) : startOfDay(); // cashiers only see today
      return withItems(await db.all("SELECT s.*,u.name AS cashier FROM sales s JOIN users u ON u.id=s.user_id WHERE s.time>=? ORDER BY s.id DESC LIMIT 500", [from]));
    },
    "POST /api/sales/void": async (req, body, u) => {
      need(u, "admin");
      return db.tx(async t => {
        const s = await t.get("SELECT * FROM sales WHERE id=?", [int(body.id, 1)]);
        if (!s || s.voided) throw new HttpError(400, "Sale not found or already voided");
        for (const it of await t.all("SELECT * FROM sale_items WHERE sale_id=?", [s.id])) {
          await t.run("UPDATE products SET stock=stock+? WHERE id=?", [it.qty, it.product_id]);
          await t.run("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)", [it.product_id, it.qty, "void " + s.id, u.id, now()]);
        }
        await t.run("UPDATE sales SET voided=1 WHERE id=?", [s.id]); return { ok: true };
      });
    },

    // --- Admin: products ---
    "POST /api/products": async (req, body, u) => {
      need(u, "admin"); const b = productBody(body);
      try { return { id: (await db.run("INSERT INTO products(sku,name,brand,cat,price,old,stock,badge,spec,img) VALUES(?,?,?,?,?,?,?,?,?,?)", [b.sku, b.name, b.brand, b.cat, b.price, b.old, b.stock, b.badge, b.spec, b.img])).lastInsertRowid }; }
      catch (e) { if (unique(e)) throw new HttpError(409, "SKU already exists"); throw e; }
    },
    "PUT /api/products": async (req, body, u) => {
      need(u, "admin"); const b = productBody(body), id = int(body.id, 1);
      const cur = await db.get("SELECT stock FROM products WHERE id=?", [id]); if (!cur) throw new HttpError(404, "Not found");
      try { await db.run("UPDATE products SET sku=?,name=?,brand=?,cat=?,price=?,old=?,stock=?,badge=?,spec=?,img=?,active=? WHERE id=?", [b.sku, b.name, b.brand, b.cat, b.price, b.old, b.stock, b.badge, b.spec, b.img, body.active === 0 ? 0 : 1, id]); }
      catch (e) { if (unique(e)) throw new HttpError(409, "SKU already exists"); throw e; }
      if (b.stock !== cur.stock) await db.run("INSERT INTO stock_log(product_id,delta,reason,user_id,time) VALUES(?,?,?,?,?)", [id, b.stock - cur.stock, "manual edit", u.id, now()]);
      return { ok: true };
    },
    "DELETE /api/products": async (req, body, u) => { need(u, "admin"); await db.run("UPDATE products SET active=0 WHERE id=?", [int(req.query.id, 1)]); return { ok: true }; }, // soft delete keeps history

    // --- Admin: staff ---
    "GET /api/users": async (req, body, u) => { need(u, "admin"); return db.all("SELECT id,username,name,role,active FROM users ORDER BY id"); },
    "POST /api/users": async (req, body, u) => {
      need(u, "admin"); const un = str(body.username, 30).toLowerCase(), pw = String(body.password || "");
      if (!/^[a-z0-9_.-]+$/.test(un)) throw new HttpError(400, "Username: letters, numbers, . _ - only");
      if (pw.length < 6) throw new HttpError(400, "Password must be at least 6 characters");
      if (!["admin", "cashier"].includes(body.role)) throw new HttpError(400, "Bad role");
      try { await db.run("INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)", [un, str(body.name, 60), body.role, hashPw(pw)]); }
      catch (e) { if (unique(e)) throw new HttpError(409, "Username taken"); throw e; }
      return { ok: true };
    },
    "PUT /api/users": async (req, body, u) => {
      need(u, "admin"); const id = int(body.id, 1);
      if (id === u.id && body.active === 0) throw new HttpError(400, "You can't disable your own account");
      if (body.active !== undefined) { await db.run("UPDATE users SET active=? WHERE id=?", [body.active ? 1 : 0, id]); await db.run("DELETE FROM sessions WHERE user_id=?", [id]); }
      if (body.password) { if (String(body.password).length < 6) throw new HttpError(400, "Password must be at least 6 characters"); await db.run("UPDATE users SET pass=? WHERE id=?", [hashPw(String(body.password)), id]); await db.run("DELETE FROM sessions WHERE user_id=?", [id]); }
      return { ok: true };
    },

    // --- Admin: report ---
    "GET /api/report": async (req, body, u) => {
      need(u, "admin"); const d0 = startOfDay();
      const sum = since => db.get("SELECT COALESCE(SUM(total),0) AS t, COUNT(*) AS n FROM sales WHERE voided=0 AND time>=?", [since]);
      const [today, week, month, top, low] = await Promise.all([
        sum(d0), sum(d0 - 6 * 864e5), sum(d0 - 29 * 864e5),
        db.all("SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty*i.price) AS rev FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.voided=0 AND s.time>=? GROUP BY i.product_id ORDER BY qty DESC LIMIT 5", [d0 - 29 * 864e5]),
        db.all("SELECT id,sku,name,stock FROM products WHERE active=1 AND stock<=5 ORDER BY stock LIMIT 20"),
      ]);
      return { today, week, month, top, low };
    },
  };

  async function readBody(req) {
    if (req.body !== undefined && req.body !== null) { // Vercel already parsed it
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
      const t = Buffer.isBuffer(req.body) ? req.body.toString() : String(req.body);
      try { return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, "Bad JSON"); }
    }
    let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, "Too large"); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "Bad JSON"); }
  }

  // returns true when the request was an /api/* call and has been answered
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return false;
    req.query = Object.fromEntries(url.searchParams);
    try {
      const h = routes[req.method + " " + url.pathname.replace(/\/+$/, "")];
      if (!h) throw new HttpError(404, "Not found");
      if (req.method !== "GET") { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) throw new HttpError(403, "Bad origin"); }
      await ready();
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
      const out = await h(req, body, await currentUser(req), res);
      if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out));
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: code === 500 ? "Server error" : e.message }));
    }
    return true;
  }
  return { handle, ready };
}

module.exports = { createApp };
