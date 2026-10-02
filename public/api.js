/* API client + login gate shared by all pages */
async function api(path, opts = {}) {
  const r = await fetch("/api" + path, { method: opts.method || "GET", headers: opts.body ? { "Content-Type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || "Request failed"); e.status = r.status; throw e; }
  return d;
}
async function loadProducts(all) { PRODUCTS = await api("/products" + (all ? "?all=1" : "")); return PRODUCTS; }

/* requireLogin(["admin"]) -> resolves with the user once logged in with an allowed role */
function requireLogin(roles, onReady) {
  const ov = document.createElement("div");
  ov.className = "login-ov";
  ov.innerHTML = `<form class="login-box" autocomplete="on">
    <div class="logo">x<b>Mobile</b></div><h2>Staff sign in</h2>
    <div><label for="lu">Username</label><input id="lu" name="username" autocomplete="username" required></div>
    <div><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
    <div class="login-err" id="le" role="alert"></div>
    <button class="btn btn-p" style="width:100%">Sign in</button>
    <a href="index.html" class="login-back">← Back to store</a></form>`;
  const show = msg => { document.body.appendChild(ov); ov.querySelector("#le").textContent = msg || ""; ov.querySelector("#lu").focus(); };
  const ok = u => { ov.remove(); onReady(u); };
  const check = u => { if (u && (!roles || roles.includes(u.role))) return ok(u); show(u ? "Your account can't open this page." : ""); };
  ov.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    try { const d = await api("/login", { method: "POST", body: { username: ov.querySelector("#lu").value, password: ov.querySelector("#lp").value } }); ov.querySelector("#lp").value = ""; check(d.user); }
    catch (err) { ov.querySelector("#le").textContent = err.message; }
  };
  api("/me").then(d => check(d.user)).catch(() => show("Can't reach the server. Is it running?"));
}
async function logout() { await api("/logout", { method: "POST" }); location.reload(); }
