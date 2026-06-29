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
| `full_name`   | yes      | Min 2 chars. Aliases: `name`, `fullName`. |
| `dob`         | yes      | Date of birth in `dd-MMM-yyyy` form (e.g. `10-JAN-2030`). Case insensitive; spaces or dashes work as separators. Aliases: `date_of_birth`, `dateOfBirth`. **Required for UNSC matching** (strict 3-check: name + year of birth + CNIC). |
| `father_name` | no       | Aliases: `fatherName`.                 |

### Example calls

```bash
# POST (recommended — keeps CNIC/key out of URLs and logs)
curl -X POST https://34-55-250-189.nip.io/api/v2/screen \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY>" \
  -d '{
    "cnic": "44103-5251752-5",
    "full_name": "ABDUR REHMAN",
    "father_name": "",
    "dob": "03-OCT-1965"
  }' \
  -o report.pdf

# GET (convenient for quick tests; params land in server/proxy access logs)
curl "https://34-55-250-189.nip.io/api/v2/screen?\
key=<API_KEY>&cnic=4410352517525&full_name=ABDUR%20REHMAN&dob=03-OCT-1965" \
  -o report.pdf
```

### Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | PDF (`Content-Disposition: attachment; filename="SCR-NNNNNN.pdf"`) | Screening ran; PDF includes both NACTA and UNSC outcomes |
| `400` | JSON `{ "error": "Date of birth is required in the format dd-MMM-yyyy (e.g. 10-JAN-2030)." }` | Missing or malformed input |
| `401` | JSON `{ "error": "Invalid or missing API key." }` | Bad/missing key |
| `503` | JSON `{ "error": "External API is not configured (set API_KEY on the server)." }` | `API_KEY` env not set |

Every call (including failed validations) is persisted in the `screenings` table
for audit with `screened_by = NULL` so cron-driven or API-driven screenings are
distinguishable from UI screenings.

### Notes on matching behaviour

- **NACTA** ignores `dob` — matches on CNIC + name + father per the existing two-level rule.
- **UNSC** uses the strict 3-check (name + year-of-birth + CNIC). All three must
  match positively or the report says NO RECORD FOUND. UNSC records without a
  CNIC stored never match (most don't — the customer base is Pakistani only).

## Production (Phase 2 — GCP VM)

- `cd server && npm run start:prod` runs under PM2 (logs to stdout/stderr — no file logging).
- `cd client && npm run build` emits static assets to `client/dist/`, served by Nginx.
- Point `DB_HOST`/`DB_PORT` at Cloud SQL or the on-VM MySQL; set `CORS_ORIGIN` to the public domain.

## Notes

- Uploaded files are parsed **in memory** (multer) and never written to disk.
- PDF reports are generated on demand from stored result JSON — not persisted.
- Old list versions are retained (`is_active=0`) so historical reports stay accurate.
