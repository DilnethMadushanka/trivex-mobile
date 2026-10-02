/* xMobile shared client helpers. Shop details below are shown on the storefront and receipts. */
const SHOP = { name: "xMobile", phone: "94771234567", display: "077 123 4567", address: "No. 00, Main Street, Colombo", hours: "Mon–Sat 9:00–19:00" };
const CATS = [
  { id: "phones", label: "Phones", icon: "ph-device-mobile" },
  { id: "audio", label: "Audio", icon: "ph-headphones" },
  { id: "wearables", label: "Wearables", icon: "ph-watch" },
  { id: "power", label: "Power", icon: "ph-battery-charging" },
  { id: "tablets", label: "Tablets", icon: "ph-device-tablet" },
  { id: "accessories", label: "Accessories", icon: "ph-plugs" },
];
let PRODUCTS = []; // loaded from the server by loadProducts()

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const fmt = n => "Rs. " + Number(n).toLocaleString("en-LK");
const catIcon = id => (CATS.find(c => c.id === id) || {}).icon || "ph-package";
function visual(p, cls = "") {
  if (p.img) return `<img class="pv ${cls}" src="${p.img}" alt="${p.name}" loading="lazy">`;
  return `<div class="pv ph ${cls}"><i class="ph-duotone ${catIcon(p.cat)}"></i><span>${p.brand}</span></div>`;
}
