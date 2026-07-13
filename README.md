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

## External screening API

Two endpoints. The first runs a screening and returns JSON metadata + a public
URL to the PDF report. The second is that URL — it serves the PDF and needs no
API key (the 128-bit token in the URL is the auth).

### `POST /api/v2/screen` — run a screening

Auth: shared `API_KEY` env var. Pass via `X-API-Key` header (preferred) or `key`
query/body param. Both `GET` and `POST` are accepted (POST recommended so CNICs
stay out of access logs).

| Param         | Required | Notes                                  |
| ------------- | -------- | -------------------------------------- |
| `key`         | yes      | Must equal `API_KEY`. May instead be sent as the `X-API-Key` header. |
| `cnic`        | yes      | 13 digits (dashes optional).           |
| `full_name`   | yes      | Min 2 chars. Aliases: `name`, `fullName`. |
| `dob`         | yes      | Date of birth in `dd-MMM-yyyy` form (e.g. `10-JAN-2030`). Case insensitive; spaces or dashes work as separators. Aliases: `date_of_birth`, `dateOfBirth`. **Required for UNSC matching** (strict 3-check: name + year of birth + CNIC). |
| `father_name` | no       | Aliases: `fatherName`.                 |

**Example:**

```bash
curl -X POST https://34-55-250-189.nip.io/api/v2/screen \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY>" \
  -d '{
    "cnic": "44103-5251752-5",
    "full_name": "ABDUR REHMAN",
    "dob": "03-OCT-1965"
  }'
```

**Response shape — same in every case (success, validation error, auth error, rate-limit, server error).** Just the field values change, never the keys. The HTTP status code carries the outcome category; the JSON body lets you parse one consistent shape.

```jsonc
{
  "success": true | false,                // discriminator — easiest field to branch on
  "record_found": "yes" | "no" | null,    // null when success=false
  "file_url": "https://.../reports/<token>.pdf" | null,
  "screening_id": 123 | null,
  "screened_at": "2026-06-29T11:32:00.000Z" | null,
  "nacta_match_type": "NO_MATCH" | "CNIC_MATCH_NAME_CONFIRMED" | "CNIC_MATCH_NAME_UNCONFIRMED" | "NAME_ONLY_MATCH" | "NO_LIST_UPLOADED" | null,
  "unsc_match_type":  "NO_MATCH" | "CONFIRMED_MATCH" | "POSSIBLE_MATCH" | "NO_LIST_UPLOADED" | null,
  "error": "human-readable message" | null  // populated only when success=false
}
```

**Success response (`200`):**

```json
{
  "success": true,
  "record_found": "yes",
  "file_url": "https://34-55-250-189.nip.io/api/v2/reports/8f3c1a7e4b6d8f0a3c5e7090b2d4f6a8.pdf",
  "screening_id": 123,
  "screened_at": "2026-06-29T11:32:00.000Z",
  "nacta_match_type": "NO_MATCH",
  "unsc_match_type": "CONFIRMED_MATCH",
  "error": null
}
```

- `record_found` is `"yes"` when **either** NACTA or UNSC produced a hit, `"no"` when both came back clean.
- `file_url` is publicly downloadable forever — no extra auth needed. Treat the URL itself as sensitive: anyone with it can fetch the report.

**Error responses — same shape, different status code:**

```json
{
  "success": false,
  "record_found": null,
  "file_url": null,
  "screening_id": null,
  "screened_at": null,
  "nacta_match_type": null,
  "unsc_match_type": null,
  "error": "Date of birth is required in the format dd-MMM-yyyy (e.g. 10-JAN-2030)."
}
```

| Status | Common `error` messages | Meaning |
|---|---|---|
| `400` | `"Date of birth is required..."` / `"CNIC is required and must contain exactly 13 digits."` / `"Full name is required (minimum 2 characters)."` | Missing or malformed input |
| `401` | `"Invalid or missing API key."` | Bad/missing key |
| `429` | `"Rate limit exceeded for the external API."` | Currently capped at 60 calls / 5 min / IP |
| `503` | `"External API is not configured (set API_KEY on the server)."` | `API_KEY` env not set |
| `500` | `"Internal server error"` (generic, details in server logs) | Unexpected backend failure |

### `GET /api/v2/reports/<token>.pdf` — the report

Public endpoint. Returns `application/pdf` (Content-Disposition: `inline`). The
token is 32 hex chars (128 bits of entropy) so the URL is unguessable by brute
force. The URL is valid as long as the screening row exists in the DB.

Anything other than a valid 32-hex token returns `404 Report not found.` — same
response as a real-but-missing token, so attackers can't enumerate.

### Notes on matching behaviour

- **NACTA** ignores `dob` — matches on CNIC + name + father per the existing two-level rule.
- **UNSC** uses a scored 3-check (name + year-of-birth + CNIC). Name is mandatory;
  DOB and CNIC each contribute one corroborating point when they positively match
  a UNSC entry. Classification:
    - **Name + DOB + CNIC all match** → `CONFIRMED_MATCH` (`unsc_match_type: "CONFIRMED_MATCH"`)
    - **Name + one of {DOB, CNIC} matches** → `POSSIBLE_MATCH` (partial — needs manual review)
    - **Name only** or **no name** → `NO_MATCH` (not surfaced)
  Nulls on the UNSC record contribute 0 corroborating (neither positive nor negative),
  so a UNSC entry with no stored DOB and no stored CNIC is effectively unmatchable —
  by design, since there's nothing to corroborate a name hit against.
  The generated PDF shows, per record, a `Criteria Matched` line so a compliance
  reviewer sees exactly which of the three signals fired.

### Audit

Every call (including failed validations) is persisted in the `screenings`
table with `screened_by = NULL` (API-driven, no human user). Each screening
gets its own `report_token` so the PDF URL is always retrievable by ID lookup.

## Production (Phase 2 — GCP VM)

- `cd server && npm run start:prod` runs under PM2 (logs to stdout/stderr — no file logging).
- `cd client && npm run build` emits static assets to `client/dist/`, served by Nginx.
- Point `DB_HOST`/`DB_PORT` at Cloud SQL or the on-VM MySQL; set `CORS_ORIGIN` to the public domain.

## Notes

- Uploaded files are parsed **in memory** (multer) and never written to disk.
- PDF reports are generated on demand from stored result JSON — not persisted.
- Old list versions are retained (`is_active=0`) so historical reports stay accurate.
