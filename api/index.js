// Vercel serverless entry. vercel.json rewrites every /api/* request here.
// Needs env vars:  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ADMIN_PASSWORD
const { open } = require("../lib/db");
const { createApp } = require("../lib/app");

let app;
module.exports = async (req, res) => {
  try {
    app = app || createApp(open());
    if (!(await app.handle(req, res))) { res.statusCode = 404; res.end("Not found"); }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); }
    res.end(JSON.stringify({ error: "Server error" }));
  }
};
