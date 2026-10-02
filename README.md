# xMobile

Phone & electronics shop: storefront, POS and admin, with a small Node backend.

- `/` store · `/pos.html` POS · `/admin.html` admin
- Backend: `lib/app.js` (API) + `lib/db.js` (SQLite locally, Turso when `TURSO_DATABASE_URL` is set)

## Run on your own PC
```
npm install            # only needed if you use Turso
node server.js         # Node 22.5+; http://localhost:3000   (PORT=3001 to change)
```
First run creates an `admin` user and prints its password (or set `ADMIN_PASSWORD`). Data is in `data/xmobile.db` (git-ignored, back it up).

## Deploy on Vercel (+ Turso database)
Vercel functions have no persistent disk, so the data lives in a hosted Turso (libSQL) database.

1. Create a free database at https://turso.tech and note its URL (`libsql://…`).
   Create an auth token for it (dashboard → database → *Create token*).
2. In Vercel → Project → Settings → **Environment Variables**, add (for Production):
   - `TURSO_DATABASE_URL` = `libsql://your-db-name.turso.io`
   - `TURSO_AUTH_TOKEN` = the token
   - `ADMIN_PASSWORD` = the password you want for the `admin` account (used on first run only)
3. Redeploy. Open `/api/health` — it should answer `{"ok":true,"db":"turso"}`. Then sign in at `/admin.html`.

Without `TURSO_DATABASE_URL` the Vercel deploy falls back to a temporary database that is wiped regularly (`/api/health` then shows `"db":"local"`). Fine for a demo, not for the real shop.

"Today" in reports uses Sri Lanka time (UTC+5:30). Change with `TZ_OFFSET_MIN` (minutes).
