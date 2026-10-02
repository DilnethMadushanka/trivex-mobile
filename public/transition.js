/* Page transitions: blue curtain wipes up over the old page, then wipes away on the new one.
   Works in every browser (no View Transitions API needed). Load synchronously in <head>. */
(function () {
  var reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  var KEY = "xm_t";
  var css = "" +
    "#xmt{position:fixed;inset:0;z-index:99999;pointer-events:none;display:grid;place-items:center;background:#1456ff;color:#fff;transform:translateY(101%);transition:transform .55s cubic-bezier(.76,0,.24,1)}" +
    "#xmt.in{transform:none;pointer-events:all}" +
    "#xmt b,html.xm-cover::after{font:800 clamp(2.4rem,9vw,5rem)/1 Outfit,system-ui,sans-serif;letter-spacing:-.06em;color:#fff}" +
    "#xmt b span,html.xm-cover::after span{color:#9db9ff}" +
    "#xmt b{opacity:0;transform:translateY(20px);transition:.4s .25s}#xmt.in b{opacity:1;transform:none}" +
    "html.xm-cover::before{content:'';position:fixed;inset:0;z-index:99998;background:#1456ff;animation:xmOut .65s .3s cubic-bezier(.76,0,.24,1) forwards}" +
    "html.xm-cover::after{content:'xMobile';position:fixed;inset:0;z-index:99999;display:grid;place-items:center;animation:xmLogo .65s .3s forwards;pointer-events:none}" +
    "html.xm-cover body{animation:xmBody .8s .45s both}" +
    "@keyframes xmOut{to{transform:translateY(-101%)}}" +
    "@keyframes xmLogo{to{transform:translateY(-130%);opacity:0}}" +
    "@keyframes xmBody{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}" +
    "@media(prefers-reduced-motion:reduce){#xmt,html.xm-cover::before,html.xm-cover::after{display:none!important}html.xm-cover body{animation:none}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // arriving from a transition: start covered, then reveal
  try {
    if (sessionStorage.getItem(KEY) === "1" && !reduce) {
      sessionStorage.removeItem(KEY);
      var h = document.documentElement; h.classList.add("xm-cover");
      setTimeout(function () { h.classList.remove("xm-cover"); }, 1400);
    } else sessionStorage.removeItem(KEY);
  } catch (e) {}

  var curtain;
  function mk() {
    if (curtain) return curtain;
    curtain = document.createElement("div"); curtain.id = "xmt"; curtain.setAttribute("aria-hidden", "true");
    curtain.innerHTML = "<b>x<span>Mobile</span></b>"; document.body.appendChild(curtain); return curtain;
  }
  document.addEventListener("click", function (e) {
    if (reduce || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    var u; try { u = new URL(a.href, location.href); } catch (x) { return; }
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.search === location.search) return; // same page / #hash
    e.preventDefault();
    try { sessionStorage.setItem(KEY, "1"); } catch (x) {}
    var c = mk(); void c.offsetWidth; c.classList.add("in");
    var go = function () { location.href = u.href; };
    setTimeout(go, 620);
  });
  // coming back via the browser's back button (bfcache): remove any leftover curtain
  addEventListener("pageshow", function (e) { if (e.persisted && curtain) curtain.classList.remove("in"); });
})();
