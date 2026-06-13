# DEPLOY-NOTES.md — day-to-day update workflow

Quick reference for pushing changes to the live Compliance Portal on the GCP VM.
For the **first-time deployment** walkthrough, see [`deploy/DEPLOY.md`](./deploy/DEPLOY.md).

## Where things live

| | Location |
|---|---|
| **Source of truth (you edit here)** | `D:\compliance_project\` on your Windows laptop |
| **Git remote** | `https://github.com/ktradeproductreal/compliancescreening.git` |
| **Production VM** | `34.55.250.189` (GCP) — Ubuntu 24.04 with aaPanel |
| **VM project folder** | `/www/wwwroot/compliance` |
| **VM SSH access** | GCP Console → VM → click **SSH** (browser-based) |
| **Live portal URL** | <https://34-55-250-189.nip.io> |
| **aaPanel URL** | `https://34.55.250.189:23079/e4637892` (credentials in your password manager) |

> **Never edit files directly on the VM.** Anything you write there gets overwritten on the next `git pull`. Always edit on your laptop, push to GitHub, pull on the VM.

---

## The update flow in one picture

```
    ┌─────────────────────┐                ┌──────────────────┐                 ┌──────────────────┐
    │  D:\compliance_     │   git push     │     GitHub       │   git pull      │   GCP VM         │
    │  project\           │ ──────────────►│ compliancescreen │ ──────────────► │ /www/wwwroot/    │
    │  (edit + test)      │                │      .git        │                 │   compliance/    │
    └─────────────────────┘                └──────────────────┘                 └──────────────────┘
                                                                                       │
                                                                                       ▼
                                                                                pm2 reload / npm run build
```

---

## Common update scenarios

### Scenario 1 — backend code change (most common)

You edited something in `server/src/` (a route, a controller, the matcher logic, etc.).

**On your laptop (PowerShell):**
```powershell
cd D:\compliance_project
git add .
git commit -m "describe what you changed"
git push
```

**On the VM (GCP browser SSH):**
```bash
cd /www/wwwroot/compliance
git pull
pm2 reload compliance-api
```

That's it. The backend restarts with new code in about 1 second; the SPA is untouched.

---

### Scenario 2 — frontend code change (React UI)

You edited something in `client/src/` (a page, a component, styling).

**Laptop:** same `git add / commit / push` as above.

**VM:**
```bash
cd /www/wwwroot/compliance
git pull
cd client
npm run build
```

`npm run build` rewrites `client/dist/`, and Nginx picks it up on the next request — no nginx reload needed. Hard-refresh your browser (Ctrl+Shift+R) to see the change.

---

### Scenario 3 — you changed BOTH backend and frontend

**VM:**
```bash
cd /www/wwwroot/compliance
git pull
( cd client && npm run build )
pm2 reload compliance-api
```

---

### Scenario 4 — you added/removed an npm package

If you ran `npm install <something>` locally and committed the updated `package.json` + `package-lock.json`:

**VM (after `git pull`):**
```bash
# If backend deps changed:
cd /www/wwwroot/compliance/server && npm ci

# If frontend deps changed:
cd /www/wwwroot/compliance/client && npm ci && npm run build

# Then:
pm2 reload compliance-api
```

---

### Scenario 5 — you changed the database schema (`server/src/db/schema.sql`)

**VM:**
```bash
cd /www/wwwroot/compliance/server
npm run db:migrate     # idempotent — safe to re-run
```

> ⚠️ `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so it only adds **new** tables.
> Changing existing columns means a manual `ALTER TABLE` via aaPanel's phpMyAdmin
> or the MySQL CLI — see the "Database access" section at the bottom.

---

### Scenario 6 — you changed `.env` (added a setting, rotated a secret)

`.env` is in `.gitignore` — it does **not** travel through git, on purpose (it has the
JWT secret, API key, DB password, and officer login credentials).

**VM:**
```bash
nano /www/wwwroot/compliance/server/.env
# edit, Ctrl+X, Y, Enter
pm2 reload compliance-api
```

If you change `.env` on the VM, **also update it on your laptop** so the two stay in
sync (rotating `JWT_SECRET` will log everyone out on whichever side you forget).

---

## Local dev workflow (recommended before pushing risky changes)

Before pushing something you're uncertain about, run it on Windows the same way
you have been:

```powershell
# In one PowerShell window — backend
cd D:\compliance_project\server
npm run dev

# In another — frontend
cd D:\compliance_project\client
npm run dev
```

Open <http://localhost:5173>, test it, then `git push` once you're happy.

> MySQL for local dev runs in Docker. Start it once per boot with
> `docker compose up -d` from `D:\compliance_project`.

---

## PM2 commands cheat sheet (on the VM)

| Command | What it does |
|---|---|
| `pm2 list` | Show all running processes + status |
| `pm2 logs compliance-api` | Tail logs live (Ctrl+C to exit) |
| `pm2 logs compliance-api --lines 100 --nostream` | Last 100 lines without following |
| `pm2 reload compliance-api` | Graceful restart (zero downtime) — use after `git pull` |
| `pm2 restart compliance-api` | Hard restart (stop + start) |
| `pm2 stop compliance-api` | Stop the backend (the portal will return 502) |
| `pm2 start compliance-api` | Start it again after a stop |
| `pm2 monit` | Live CPU / memory dashboard |
| `pm2 save` | Persist current process list across reboots |

---

## Database access (when you need to poke at data directly)

Two ways:

**A) aaPanel UI (easiest):**
- aaPanel → Databases → `compliance` → click **phpMyAdmin** (or "Manage")
- Run SQL in the SQL tab

**B) Command line on the VM:**
```bash
mysql -u compliance -p compliance
# password is what's in server/.env DB_PASSWORD
```

Useful queries:

```sql
-- Active list versions
SELECT version_label, record_count, uploaded_at FROM nacta_lists WHERE is_active = 1;
SELECT version_label, record_count, uploaded_at FROM unsc_lists  WHERE is_active = 1;

-- Recent screenings
SELECT id, input_full_name, input_cnic, screened_at
FROM screenings ORDER BY id DESC LIMIT 20;

-- Officer login
SELECT id, email, full_name, created_at FROM users;
```

---

## When something breaks after a deploy

**First** check the backend logs:

```bash
pm2 logs compliance-api --lines 100 --nostream
```

Common errors and what they usually mean:

| Log line | Likely cause |
|---|---|
| `[db] connection failed` | MySQL is down — restart it from aaPanel |
| `ER_ACCESS_DENIED_ERROR` | `DB_PASSWORD` in `.env` doesn't match aaPanel's user password |
| `EADDRINUSE` on port 4000 | Old process didn't shut down — `pm2 delete compliance-api && pm2 start deploy/ecosystem.config.cjs` |
| `404` on every API call from the SPA | `CORS_ORIGIN` in `.env` doesn't match the actual site URL |
| Browser shows `502 Bad Gateway` | Backend is stopped or crashed — `pm2 list` to confirm, `pm2 logs` to see why |
| New code isn't showing in the browser | Browser cache — hard refresh (Ctrl+Shift+R) or test in incognito |

If logs don't show anything obviously wrong, also check Nginx:

```bash
sudo tail -100 /www/wwwlogs/34-55-250-189.nip.io.error.log
sudo tail -100 /www/wwwlogs/34-55-250-189.nip.io.log
```

---

## Three habits worth keeping

1. **Commit messages say what changed** — `fix CNIC validation regex` not `x`. Future you will thank you.
2. **Pull before you push** — `git pull` first avoids merge conflicts.
3. **`pm2 logs` is your first stop** when anything breaks after a deploy.

---

## Quick reference URLs

- Live portal: <https://34-55-250-189.nip.io>
- Health check: <https://34-55-250-189.nip.io/api/health>
- External screening API: `POST https://34-55-250-189.nip.io/api/v2/screen`
  (requires `X-API-Key` header or `key=` parameter — value is in `server/.env`)
- GitHub repo: <https://github.com/ktradeproductreal/compliancescreening>
- GCP Console: <https://console.cloud.google.com> → Compute Engine → VM `compliance-screening`
- aaPanel: `https://34.55.250.189:23079/e4637892` (credentials in password manager)
