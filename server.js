// xMobile local server. Run:  node server.js   then open http://localhost:3000
// Needs Node 22.5+ (built-in SQLite). Set TURSO_DATABASE_URL to use a hosted Turso database instead.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./lib/db");
const { createApp } = require("./lib/app");

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const app = createApp(open());

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" };
const SEC = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin-when-cross-origin" };

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  try {
    if (await app.handle(req, res)) return;
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("Not found"); }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream", size = fs.statSync(file).size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) { // Range support (video seeking, Safari)
      const st = m[1] ? +m[1] : size - +m[2], en = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      if (st > en || st >= size) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${st}-${en}/${size}`, "Accept-Ranges": "bytes", "Content-Length": en - st + 1 });
      return fs.createReadStream(file, { start: st, end: en }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server error" }));
  }
}).listen(PORT, () => console.log(`xMobile running → http://localhost:${PORT}   (POS: /pos.html   Admin: /admin.html)`));
app.ready().catch(e => console.error("Database setup failed:", e));
