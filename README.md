# Compliance Screening Portal

Internal tool to screen individuals against the **NACTA** proscribed-persons list
(Excel) and the **UNSC Consolidated** list (HTML), with fuzzy matching and PDF
reporting. See [`compliance-portal-PRD.md`](./compliance-portal-PRD.md) for the
full specification.

> **Phase 1:** local development. **Phase 2:** GCP VM (Nginx + PM2 + MySQL/Cloud SQL).
> All configuration is env-driven so the move requires no code changes.

## Stack

| Layer    | Tech                                                              |
| -------- | ----------------------------------------------------------------- |
| Frontend | React + Vite, TailwindCSS, React Router v6, Axios                 |
| Backend  | Node.js + Express, `mysql2` (raw queries, pooled)                 |
| Database | MySQL 8 (Docker locally)                                          |
| Parsing  | `xlsx` (Excel), `cheerio` (HTML)                                  |
| Matching | `fuse.js` + `unidecode`                                           |
| PDF      | `pdfkit`                                                          |
| Auth     | `jsonwebtoken` + `bcryptjs` (stateless JWT, 8h)                   |

## Repository layout

```
compliance_project/
├── docker-compose.yml      # Local MySQL 8
├── .env.example            # Shared DB + backend config (copy to .env)
├── server/                 # Express REST API
│   └── src/
│       ├── config/         # env loader
│       ├── db/             # pool, schema.sql, migrate + seed scripts
│       ├── middleware/     # JWT auth, error handler
│       ├── routes/         # auth, upload, screening
│       ├── controllers/    # request handlers
│       ├── services/       # version, screening, pdf
│       ├── parsers/        # excelParser, htmlParser
│       ├── matching/       # normalise, nactaMatcher, unscMatcher
│       └── utils/          # cnic helpers
└── client/                 # React + Vite SPA
    └── src/
        ├── api/            # axios instance w/ JWT interceptor
        ├── context/        # AuthContext
        ├── components/     # ProtectedRoute, Layout
        └── pages/          # Login, Dashboard, Upload, Screen, History
```

## Local setup

### 1. Configure environment

```powershell
Copy-Item .env.example .env
# Edit .env — at minimum set JWT_SECRET and the SEED_USER_* credentials.
```

### 2. Start MySQL

```powershell
docker compose up -d
```

`schema.sql` runs automatically on first start. To reset the database completely:
`docker compose down -v` then `docker compose up -d`.

### 3. Backend

```powershell
cd server
npm install
npm run db:migrate   # apply schema.sql (idempotent; safe to re-run)
npm run db:seed      # create the first Compliance Officer from SEED_USER_* env
npm run dev          # http://localhost:4000
```

### 4. Frontend

```powershell
cd client
npm install
npm run dev          # http://localhost:5173
```

Log in with the seeded credentials.

## External screening API (`/api/v2/screen`)

Key-authenticated endpoint that runs a screening and returns the PDF report as a
**file download**. No JWT/login — auth is the shared `API_KEY` (set in `.env`).
Available on both `GET` (params in query string) and `POST` (JSON body).

| Param         | Required | Notes                                  |
| ------------- | -------- | -------------------------------------- |
| `key`         | yes      | Must equal `API_KEY`. May instead be sent as the `X-API-Key` header. |
| `cnic`        | yes      | 13 digits (dashes optional).           |
| `full_name`   | yes      | Min 2 chars. (`name` also accepted.)   |
| `father_name` | no       |                                        |

```bash
# POST (recommended — keeps CNIC/key out of URLs and logs)
curl -X POST http://localhost:4000/api/v2/screen \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY>" \
  -d '{"cnic":"42101-1234567-1","full_name":"MUHAMMAD ALI","father_name":"GHULAM HASSAN"}' \
  -o report.pdf

# GET (convenient, but params land in server/proxy logs)
curl "http://localhost:4000/api/v2/screen?key=<API_KEY>&cnic=4210112345671&full_name=MUHAMMAD%20ALI" -o report.pdf
```

Responses: `200` PDF (`Content-Disposition: attachment`); `400` invalid input;
`401` bad/missing key; `503` if `API_KEY` is unset. Each call is persisted to
`screenings` for audit with `screened_by = NULL` (no human user).

## Production (Phase 2 — GCP VM)

- `cd server && npm run start:prod` runs under PM2 (logs to stdout/stderr — no file logging).
- `cd client && npm run build` emits static assets to `client/dist/`, served by Nginx.
- Point `DB_HOST`/`DB_PORT` at Cloud SQL or the on-VM MySQL; set `CORS_ORIGIN` to the public domain.

## Notes

- Uploaded files are parsed **in memory** (multer) and never written to disk.
- PDF reports are generated on demand from stored result JSON — not persisted.
- Old list versions are retained (`is_active=0`) so historical reports stay accurate.
