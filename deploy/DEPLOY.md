# Deploying to GCP + aaPanel

This walks through a clean install on a GCP VM that already has aaPanel,
making the portal and aaPanel publicly reachable. Security comes from layered
defenses (HTTPS, strong auth, rate limiting, hardened aaPanel), not IP restriction.

> **Hostname.** No domain was purchased, so we use **`34-55-250-189.nip.io`** —
> a free wildcard-DNS service that resolves `<ip-with-dashes>.nip.io` to your IP
> (`34.55.250.189`). It needs no signup, no DNS panel, and Let's Encrypt issues
> certificates for it normally — so the portal gets real HTTPS, no browser
> warnings. If you later buy a domain, the swap is just two lines (`server_name`
> in Nginx + `CORS_ORIGIN` in `.env`) and reissue the cert.
>
> **aaPanel port.** Set to `27113` (any random 5-digit number works; keep it secret).
> All commands run as the SSH user with `sudo` access.

---

## 0. Prerequisites

- GCP VM running, you can SSH in with your key.
- A domain (or subdomain) DNS-pointed at the VM's external IP — needed for Let's Encrypt.
- aaPanel installed (you already have it for other portals).

## 1. GCP firewall

In GCP Console → VPC network → Firewall, allow inbound **only**:

| Port | Purpose |
| ---- | ------- |
| 22   | SSH |
| 80   | HTTP (Let's Encrypt + redirect) |
| 443  | HTTPS (portal + external API) |
| **27113** (your custom aaPanel port) | aaPanel UI |

Do **not** open 3306, 4000, 5173, 8888 to the internet.

## 2. Harden aaPanel (essential when it's public)

In the aaPanel UI → Settings (Panel settings):

- **Panel port** → change from `8888` to a random 5-digit port (`27113` etc.). Update the GCP firewall rule above.
- **Safe entrance** → set to `/an27nov03`. The login page is unreachable without that path in the URL — aaPanel returns 404 on the bare host:port. Treat this string like a password: keep it out of screenshots, chat history, and commits.
- **Panel SSL** → ON (aaPanel can self-sign; or use your domain cert).
- **Authorization IP** → leave blank (per your requirement: accessible from anywhere). Compensate with the items above + 2FA.
- **Two-factor authentication (2FA)** → enable for the aaPanel login (Security tab → Google Authenticator).
- **Panel password** → 20+ chars, password manager only.
- **Login alarm** → ON (email/Telegram alerts on every login).
- **System firewall** → ON (aaPanel's firewall tab; mirrors GCP-level rules locally).

### Lock down SSH (one-time on the VM)

Edit `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Then `sudo systemctl reload sshd`. Keep your private key safe — that's now the only door.

## 3. Install MySQL + Node + PM2 via aaPanel

In the aaPanel App Store install:

- **MySQL 8.0** (or 8.x)
- **PM2 Manager** (Node app supervisor)
- **Node.js Version Manager** → install Node 20 LTS (or 18 LTS)
- **Nginx** (usually already on)

## 4. Create the database via aaPanel

aaPanel → Database → **Add database**:

- Database name: `compliance`
- Username: `compliance`
- Password: 24+ random chars — **save in your password manager**
- Access: `127.0.0.1` (default — DO NOT enable remote access)

## 5. Clone the project

```bash
sudo mkdir -p /www/wwwroot/compliance
sudo chown -R $USER:$USER /www/wwwroot/compliance
cd /www/wwwroot/compliance
git clone <your-git-url> .   # or: scp the project up; .env is in .gitignore
```

## 6. Production env file

Create `server/.env` with **fresh** secrets (do NOT copy the dev `.env`):

```bash
cd /www/wwwroot/compliance/server
cat > .env <<EOF
NODE_ENV=production
PORT=4000
CORS_ORIGIN=https://34-55-250-189.nip.io

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=compliance
DB_USER=compliance
DB_PASSWORD=<the password you set in step 4>

# Generate with: openssl rand -hex 32
JWT_SECRET=<long random hex>
JWT_EXPIRES_IN=8h

# Generate with: openssl rand -hex 32
API_KEY=<long random hex>

SEED_USER_EMAIL=ktradeproduct@gmail.com
SEED_USER_PASSWORD=<a strong password for the officer login>
SEED_USER_NAME=Compliance Officer

# Tuning (already the defaults; uncomment to override)
# NACTA_FUZZY_THRESHOLD=0.8
# UNSC_FUZZY_THRESHOLD=0.65
# UNSC_TOKEN_THRESHOLD=0.8
EOF
chmod 600 .env
```

Generate the secrets locally:
```bash
openssl rand -hex 32   # use one output for JWT_SECRET
openssl rand -hex 32   # and another for API_KEY
```

## 7. Install deps + initialise DB + build frontend

```bash
cd /www/wwwroot/compliance/server
npm ci --omit=dev
npm run db:migrate     # applies schema.sql (idempotent)
npm run db:seed        # creates the officer login

cd ../client
npm ci
npm run build          # → client/dist/
```

## 8. Add rate-limit zones to Nginx

Edit `/www/server/nginx/conf/nginx.conf` and add inside the existing `http { }`
block (anywhere is fine, but near the top is clean):

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=apiv2:10m rate=120r/m;
limit_req_zone $binary_remote_addr zone=api:10m   rate=600r/m;
```

Test and reload:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 9. Create the website in aaPanel

aaPanel → Website → **Add site**:

- Domain: `34-55-250-189.nip.io`
- Document root: `/www/wwwroot/compliance/client/dist`
- PHP version: **Pure static** (no PHP)
- Database: skip (already created in step 4)

Then **Settings → Config (Nginx) → replace the file's contents** with
`deploy/nginx.conf` from the repo (update the `34-55-250-189.nip.io` placeholders).
Save → aaPanel reloads Nginx.

## 10. SSL via Let's Encrypt

aaPanel → your site → **SSL → Let's Encrypt → Apply**. Tick "Force HTTPS".
aaPanel writes the cert under
`/www/server/panel/vhost/cert/34-55-250-189.nip.io/{fullchain,privkey}.pem` — those
paths are what the site config already references.

## 11. Start the API with PM2

```bash
cd /www/wwwroot/compliance
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup       # run the printed `sudo env PATH=...` command
```

Logs:
```bash
pm2 logs compliance-api
```

## 12. Verify

```bash
# Health (public)
curl -i https://34-55-250-189.nip.io/api/health
# → 200 {"status":"ok",...}

# Login (returns JWT)
curl -i -X POST https://34-55-250-189.nip.io/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ktradeproduct@gmail.com","password":"<the SEED_USER_PASSWORD>"}'

# External API smoke test
curl -i -X POST https://34-55-250-189.nip.io/api/v2/screen \
  -H "Content-Type: application/json" -H "X-API-Key: <API_KEY>" \
  -d '{"cnic":"42101-1234567-1","full_name":"TEST","father_name":"TEST"}' \
  -o /tmp/test.pdf
```

In the browser: open `https://34-55-250-189.nip.io` → log in with the officer
credentials → upload your NACTA and UNSC files → run a screening.

## 13. Backups (set up before forgetting)

aaPanel → Database → **Backup** on your `compliance` DB:

- Frequency: **daily** at 03:00
- Retention: 14 days
- Destination: Google Drive / S3 / aaPanel Cloud — anywhere off the VM

Old list versions stay in the DB (`is_active=0`), so screening history remains
reproducible. Backups protect against accidental table drops and VM loss.

---

## Cheat sheet — common ops

```bash
# Deploy a new build
cd /www/wwwroot/compliance
git pull
( cd server && npm ci --omit=dev )
( cd client && npm ci && npm run build )
pm2 reload compliance-api

# Tail API logs
pm2 logs compliance-api --lines 200

# Restart MySQL (aaPanel)
aaPanel → MySQL → Restart

# DB shell
mysql -u compliance -p compliance        # or via aaPanel phpMyAdmin

# Rotate API key
# 1) edit server/.env, change API_KEY
# 2) pm2 reload compliance-api
```

## When something goes wrong

| Symptom | First thing to check |
|---|---|
| `502 Bad Gateway` on /api | `pm2 logs compliance-api` — backend crashed or not running |
| `401` on every API call from the SPA | `CORS_ORIGIN` in `.env` doesn't match the actual site URL |
| `429 Too Many Requests` | Rate limit hit. Tune zones in `nginx.conf` or limits in `app.js`. |
| Login works but PDFs won't open | Browser blocked the blob URL. Try a different browser. |
| Reports show wrong time | `timezone: 'Z'` in `db.js` is set — check the host's timezone. |
| aaPanel login page is "Not Found" | You set a Safe Entrance path — append it to the URL. |
