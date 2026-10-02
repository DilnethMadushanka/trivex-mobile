# xMobile

Phone & electronics shop: storefront, POS and admin, with a zero-dependency Node backend (SQLite).

## Run
```
node server.js        # Node 22.5+; open http://localhost:3000  (PORT=3001 node server.js to change)
```
First run creates an `admin` user and prints its password in the console (or set `ADMIN_PASSWORD`).

- `/` store · `/pos.html` POS · `/admin.html` admin
- Data lives in `data/xmobile.db` (git-ignored). Back it up.
- Edit shop details in `public/data.js` (`SHOP`), sample products in `seed.js`.
