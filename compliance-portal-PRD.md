# Compliance Screening Portal — Product Requirements Document

**Version:** 1.0  
**Date:** May 2025  
**Status:** Pre-Development  
**Project Type:** Internal Compliance Tool  
**Planned Deployment:** Local (Phase 1), GCP VM (Phase 2)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Tech Stack](#3-tech-stack)
4. [User Roles](#4-user-roles)
5. [System Architecture](#5-system-architecture)
6. [Database Design](#6-database-design)
7. [Feature Specifications](#7-feature-specifications)
   - 7.1 Authentication
   - 7.2 List Management & Upload
   - 7.3 Version Numbering System
   - 7.4 Screening Engine
   - 7.5 PDF Report Generation
   - 7.6 Screening History
8. [Matching Logic — Detailed](#8-matching-logic--detailed)
9. [Parsing Logic — Detailed](#9-parsing-logic--detailed)
10. [API Endpoints](#10-api-endpoints)
11. [Frontend Pages & UX](#11-frontend-pages--ux)
12. [PDF Report Specification](#12-pdf-report-specification)
13. [Phase 2 Roadmap](#13-phase-2-roadmap)
14. [Open Questions & Decisions Log](#14-open-questions--decisions-log)

---

## 1. Project Overview

The Compliance Screening Portal is an internal web application that allows a compliance officer to screen individuals against two proscribed persons lists:

- **NACTA List** — A locally maintained Excel file containing Pakistani proscribed persons with columns: `NAME`, `FATHER NAME`, `CNIC`.
- **UNSC Consolidated List** — An HTML file published by the United Nations Security Council containing internationally sanctioned individuals and entities.

The officer enters a subject's **Full Name**, **Father's Name**, and **CNIC**, and the system searches both lists, applies fuzzy matching, and generates a structured PDF report indicating whether any records were found.

---

## 2. Goals & Non-Goals

### Goals (Phase 1)
- Secure, single-user login to the portal
- Manual upload of NACTA Excel and UNSC HTML list files
- Automatic parsing and storage of list data into MySQL
- Version-tracked list management with replacement-on-upload behaviour
- Screening form with CNIC (auto-formatted), Full Name, and Father's Name inputs
- Fuzzy matching against both lists with configurable thresholds
- UNSC Pakistan relevance confirmation (nationality + address fields)
- PDF report generation per screening run
- Screening history log

### Non-Goals (Phase 1 — deferred to Phase 2)
- Role-based access control (RBAC)
- Automated list updates via web scraper
- External API endpoint that accepts parameters and returns a PDF response
- Bulk/batch screening
- Email delivery of reports
- Organisation/entity screening (UNSC individual entries only in Phase 1)

---

## 3. Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | React + Vite | Fast builds, component-based UI |
| Styling | TailwindCSS | Utility-first, no separate CSS files |
| Routing | React Router v6 | Standard SPA routing |
| HTTP Client | Axios | Interceptors for JWT injection |
| Backend | Node.js + Express | Same language as frontend, fast I/O |
| Database Driver | `mysql2` (raw queries) | Direct control, no ORM abstraction overhead. Schema is stable so ORM migrations provide no benefit |
| Database | MySQL 8 | Relational, well-supported, familiar |
| File Uploads | `multer` | Multipart form handling, in-memory or disk storage |
| Excel Parsing | `xlsx` (SheetJS) | Industry standard for .xls/.xlsx |
| HTML Parsing | `cheerio` | Server-side jQuery — clean selector-based parsing |
| Fuzzy Matching | `fuse.js` | Lightweight, tunable, no external service needed |
| Text Normalisation | `unidecode` | Strips diacritics for transliterated Arabic names |
| PDF Generation | `pdfkit` | Programmatic PDF creation, no headless browser needed |
| Auth | `jsonwebtoken` + `bcryptjs` | Stateless JWT sessions |
| Environment Config | `dotenv` | Local secrets management |

> **Why `mysql2` over Sequelize:**  
> The schema is small and well-defined. Raw queries are more transparent, easier to debug, and avoid the overhead of ORM migrations, model decorators, and hidden JOIN behaviour. A thin `db.js` query helper is sufficient.

---

## 4. User Roles

**Phase 1 — Single role: Compliance Officer**
- Can log in
- Can upload and replace NACTA and UNSC lists
- Can run screenings
- Can view and download PDF reports
- Can view screening history

**Phase 2 — RBAC to be added:**
- `admin` — manages users, uploads lists
- `officer` — runs screenings only, cannot upload lists

---

## 5. System Architecture

```
┌─────────────────────────────────────────────┐
│              React Frontend                  │
│  Login → Dashboard → Upload → Screen → PDF  │
└────────────────┬────────────────────────────┘
                 │ HTTPS / REST (JSON)
┌────────────────▼────────────────────────────┐
│           Express REST API                   │
│  /auth  /upload  /screening  /history        │
├──────────────────────────────────────────────┤
│  Parsers          Matching Engine            │
│  ├ excelParser    ├ nactaMatcher             │
│  └ htmlParser     └ unscMatcher             │
├──────────────────────────────────────────────┤
│  PDF Service (pdfkit)                        │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│              MySQL 8                         │
│  users / nacta_lists / nacta_records         │
│  unsc_lists / unsc_records / screenings      │
└─────────────────────────────────────────────┘
```

Files uploaded by the user are processed **in memory by multer** — they are parsed immediately and records are inserted into MySQL. No files are persisted to disk.

---

## 6. Database Design

### Table: `users`
```sql
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

### Table: `nacta_lists`
Tracks each uploaded version of the NACTA Excel file.

```sql
CREATE TABLE nacta_lists (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  version_major  TINYINT NOT NULL,        -- 1, 2, 3 ...
  version_minor  TINYINT NOT NULL,        -- 1 through 20
  version_label  VARCHAR(10) NOT NULL,    -- "v1.3", "v2.1"
  filename       VARCHAR(255) NOT NULL,
  uploaded_by    INT NOT NULL REFERENCES users(id),
  record_count   INT NOT NULL DEFAULT 0,
  uploaded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1) NOT NULL DEFAULT 0
);
```

> **`is_active` purpose:** Only the row with `is_active = 1` is queried during screenings. When a new list is uploaded, the previous version's `is_active` is set to `0` and the new version is set to `1`. Old records are retained so that historical screening reports can correctly reference which version they were checked against.

---

### Table: `nacta_records`
```sql
CREATE TABLE nacta_records (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  list_id         INT NOT NULL REFERENCES nacta_lists(id),
  full_name       VARCHAR(500) NOT NULL,        -- Normalised: UPPERCASE, trimmed
  father_name     VARCHAR(500) NOT NULL,
  cnic            VARCHAR(15) NOT NULL,         -- Format: XXXXX-XXXXXXX-X
  raw_full_name   VARCHAR(500),                 -- Original as in file (for report display)
  raw_father_name VARCHAR(500),
  raw_cnic        VARCHAR(50)
);

CREATE INDEX idx_nacta_cnic    ON nacta_records(cnic);
CREATE INDEX idx_nacta_list_id ON nacta_records(list_id);
```

---

### Table: `unsc_lists`
```sql
CREATE TABLE unsc_lists (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  version_major  TINYINT NOT NULL,
  version_minor  TINYINT NOT NULL,
  version_label  VARCHAR(10) NOT NULL,
  filename       VARCHAR(255) NOT NULL,
  uploaded_by    INT NOT NULL REFERENCES users(id),
  record_count   INT NOT NULL DEFAULT 0,
  uploaded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1) NOT NULL DEFAULT 0
);
```

> **`is_active` purpose:** Same as NACTA. The UNSC list is updated independently of the NACTA list. At any point, one version of each is marked active. When screening runs, it reads `WHERE list_id = (SELECT id FROM unsc_lists WHERE is_active = 1)`. Old versions stay in DB so old report audit trails remain accurate.

---

### Table: `unsc_records`
```sql
CREATE TABLE unsc_records (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  list_id               INT NOT NULL REFERENCES unsc_lists(id),
  ref_code              VARCHAR(20) NOT NULL,        -- e.g. "YEi.001"
  primary_name          VARCHAR(500) NOT NULL,       -- Joined name parts: "ABD AL-KHALIQ AL-HOUTHI"
  primary_name_normalised VARCHAR(500) NOT NULL,     -- Lowercased, diacritics removed, prefixes stripped
  name_parts_json       JSON NOT NULL,               -- ["ABD","AL-KHALIQ","AL-HOUTHI","na"]
  aliases_json          JSON NOT NULL,               -- All good + low quality aliases combined
  aliases_normalised_json JSON NOT NULL,             -- Normalised alias strings for matching
  nationality           VARCHAR(255),
  address               TEXT,
  dob                   VARCHAR(100),
  designation           TEXT,
  listed_on             VARCHAR(100),
  original_script_name  VARCHAR(500),               -- Arabic/other script if present
  other_information     TEXT
);

CREATE INDEX idx_unsc_list_id  ON unsc_records(list_id);
CREATE FULLTEXT INDEX idx_unsc_primary_name ON unsc_records(primary_name);
```

---

### Table: `screenings`
```sql
CREATE TABLE screenings (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  screened_by         INT NOT NULL REFERENCES users(id),
  input_cnic          VARCHAR(15),
  input_full_name     VARCHAR(500) NOT NULL,
  input_father_name   VARCHAR(500),
  nacta_result_json   JSON NOT NULL,     -- Full result snapshot (see spec below)
  unsc_result_json    JSON NOT NULL,
  nacta_list_version  VARCHAR(50),       -- e.g. "v1.3 – uploaded 19 May 2025"
  unsc_list_version   VARCHAR(50),
  screened_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**`nacta_result_json` structure:**
```json
{
  "matched": true,
  "match_type": "CNIC_MATCH_NAME_CONFIRMED",
  "records": [
    {
      "full_name": "MUHAMMAD ALI",
      "father_name": "GHULAM HASSAN",
      "cnic": "42101-1234567-1"
    }
  ]
}
```

**`unsc_result_json` structure:**
```json
{
  "matched": true,
  "match_type": "POSSIBLE_MATCH",
  "records": [
    {
      "ref_code": "QDi.192",
      "primary_name": "ABD ALLAH MOHAMED RAGAB ABDEL RAHMAN",
      "aliases": ["Abu Al-Khayr", "Ahmad Hasan", "Abu Jihad"],
      "dob": "3 Nov. 1957",
      "nationality": "Egypt",
      "designation": "...",
      "listed_on": "29 Sep. 2005",
      "pakistan_link": "Address mentions Pakistan",
      "match_score": 0.72
    }
  ]
}
```

---

## 7. Feature Specifications

### 7.1 Authentication

- Login via email + password
- Password stored as bcrypt hash (salt rounds: 12)
- On success: JWT issued (expires 8 hours), stored in `localStorage` on frontend
- All API routes except `/api/auth/login` require `Authorization: Bearer <token>`
- On frontend: Axios interceptor attaches token to every request; 401 response redirects to `/login`

---

### 7.2 List Management & Upload

**NACTA Upload:**
- Accepts `.xlsx` or `.xls`
- Required columns (case-insensitive, order-independent): `NAME`, `FATHER NAME`, `CNIC`
- If required columns are missing → return 400 with descriptive error
- Parse with SheetJS → normalise → bulk insert
- Previous active list's `is_active` set to `0`; new list's `is_active` set to `1`
- Old records are NOT deleted (retained for audit history)

**UNSC Upload:**
- Accepts `.html` or `.htm`
- Parsed with Cheerio using `tr.rowtext` selector
- Each `td` contains one individual entry
- Previous active list's `is_active` set to `0`; new list's `is_active` set to `1`

**Upload Response includes:**
- Version label assigned (e.g., "v1.4")
- Record count parsed
- Upload timestamp
- Any rows that failed to parse (with reason)

---

### 7.3 Version Numbering System

Versions follow the format `vMAJOR.MINOR` where:

- Minor increments from 1 to 20 with each new upload of the same list type
- When minor reaches 20, major increments and minor resets to 1
- NACTA and UNSC versions are tracked independently

**Logic (run separately for nacta_lists and unsc_lists):**
```
SELECT version_major, version_minor
FROM [nacta_lists | unsc_lists]
ORDER BY id DESC LIMIT 1;

IF no rows exist:
  new_major = 1, new_minor = 1  → "v1.1"

ELSE IF version_minor >= 20:
  new_major = version_major + 1
  new_minor = 1                 → e.g. "v2.1"

ELSE:
  new_major = version_major
  new_minor = version_minor + 1 → e.g. "v1.5"
```

---

### 7.4 Screening Engine

**Input fields:**
- `cnic` — user types 13 digits, frontend auto-formats to `XXXXX-XXXXXXX-X` (dashes shown in input, not typed)
- `full_name` — free text
- `father_name` — free text (optional but recommended)

**Validation:**
- CNIC: must be exactly 13 digits once dashes removed. Enforce on frontend; also validate on backend.
- Full Name: required, minimum 2 characters
- Father Name: optional

**Screening runs NACTA and UNSC checks in parallel (Promise.all).**

---

### 7.5 PDF Report Generation

- Generated on demand via `GET /api/screening/:id/pdf`
- Result JSON stored in the `screenings` table is used to build the PDF
- No PDF files stored on disk in Phase 1
- PDF streamed directly in the HTTP response as `application/pdf`
- Frontend opens PDF in a new browser tab

---

### 7.6 Screening History

- Table view of all past screenings
- Columns: Ref #, CNIC, Full Name, Date, NACTA Result, UNSC Result, Action (View Report)
- Sorted by most recent first
- No delete functionality in Phase 1

---

## 8. Matching Logic — Detailed

### 8.1 Input Normalisation (applied to all inputs before matching)

```
1. Trim leading/trailing whitespace
2. Collapse multiple spaces to single space
3. Convert to UPPERCASE
4. Remove diacritics via unidecode (ā → a, é → e, etc.)
5. For UNSC matching only: also strip common Arabic name prefixes
   from the search input: "AL-", "AL ", "ABU ", "BIN ", "BINT ",
   "OULD ", "WULD "
   (These are retained in the stored display names)
```

### 8.2 NACTA Matching

**Step 1 — CNIC Exact Match:**
```sql
SELECT * FROM nacta_records
WHERE list_id = [active_nacta_list_id]
AND cnic = [normalised_input_cnic]
```

If rows returned → proceed to Step 1a.  
If no rows → proceed to Step 2.

**Step 1a — CNIC + Name Confirmation (Fuse.js):**
- Take the matched NACTA record(s)
- Run Fuse.js on `full_name` with input full name (threshold 0.8)
- Run Fuse.js on `father_name` with input father name (threshold 0.8)
- Result types:
  - Both names match → `CNIC_MATCH_NAME_CONFIRMED` 🔴
  - CNIC matches, names do not → `CNIC_MATCH_NAME_UNCONFIRMED` 🔴 (still a hit, but flagged for review)

**Step 2 — Name + Father Name Fuzzy Fallback (no CNIC match):**
- Load all `nacta_records` for active list
- Construct Fuse.js index on combined string: `full_name + " " + father_name`
- Run search with threshold `0.8`
- If results found → `NAME_ONLY_MATCH` 🟡 (possible match, requires manual review)
- If nothing → `NO_MATCH` ✅

> **Threshold note:** 0.8 in Fuse.js means only high-similarity results are returned. This reduces false positives for the NACTA list which is expected to contain Pakistani names with consistent transliteration.

---

### 8.3 UNSC Matching

**Step 1 — Build search corpus per record:**
Each UNSC record's searchable strings = `[primary_name_normalised, ...aliases_normalised_json]`

**Step 2 — Fuse.js search:**
- Load all `unsc_records` for active list
- Fuse.js keys: `primary_name_normalised`, `aliases_normalised_json`
- Threshold: `0.5` (lenient — transliterated Arabic names vary widely across languages)
- Returns all hits with scores

**Step 3 — Score interpretation:**
- Score ≥ 0.85 → `CONFIRMED_MATCH` 🔴
- Score 0.5–0.84 → `POSSIBLE_MATCH` 🟡 (shown in report, flagged for manual review)
- No results → `NO_MATCH` ✅

**Step 4 — Pakistan Relevance Check (applied to all UNSC hits):**

For each hit record, check for Pakistan connection:
```
pakistan_link = null

IF nationality ILIKE '%pakistan%':
  pakistan_link = "Pakistani national"

ELSE IF address ILIKE '%pakistan%':
  pakistan_link = "Address mentions Pakistan: [address value]"

ELSE IF other_information ILIKE '%pakistan%':
  pakistan_link = "Other information mentions Pakistan: [excerpt]"
```

This field is **informational only** — it does not affect match/no-match status. It is displayed in the PDF report as additional context. All UNSC hits are reported regardless of Pakistan connection; the Pakistan link simply adds relevance context.

---

## 9. Parsing Logic — Detailed

### 9.1 Excel Parser (`excelParser.js`)

```
Input:  Buffer (from multer memory storage)
Output: Array of { full_name, father_name, cnic, raw_full_name, raw_father_name, raw_cnic }

Steps:
1. XLSX.read(buffer, { type: 'buffer' })
2. Take first sheet
3. XLSX.utils.sheet_to_json(sheet, { header: 1 }) → rows
4. Find header row (row where cells contain 'NAME', 'FATHER NAME', 'CNIC')
   — case-insensitive, trimmed comparison
5. If header not found → throw error with message
6. Map column indices: nameCol, fatherCol, cnicCol
7. For each data row:
   a. raw_full_name   = row[nameCol]?.toString().trim()
   b. raw_father_name = row[fatherCol]?.toString().trim()
   c. raw_cnic        = row[cnicCol]?.toString().trim()
   d. Normalise full_name: uppercase, collapse spaces, unidecode
   e. Normalise father_name: same
   f. Normalise cnic:
      - Strip all non-digits
      - Must be 13 digits, else skip row and log warning
      - Format: XXXXX-XXXXXXX-X
8. Return valid rows + skipped row count + warnings[]
```

### 9.2 HTML Parser (`htmlParser.js`)

```
Input:  Buffer (from multer memory storage)
Output: Array of parsed UNSC record objects

Steps:
1. const $ = cheerio.load(buffer.toString('utf8'))
2. $('tr.rowtext td').each((i, el) => { ... })
3. For each td:

   a. RAW TEXT extraction:
      rawText = $(el).text()  // full plain text of the td

   b. REF CODE:
      — First <strong> tag text, trimmed, spaces removed
      — e.g. "IRi.032", "YEi.001", "QDi.380"

   c. NAME PARTS:
      — Regex on rawText: /Name:\s*1:\s*(.+?)\s*(?:Name \(original|Title:)/s
      — Then split by pattern: /[1-4]:\s*/
      — Filter out "na" values
      — Join remaining parts with space → primary_name

   d. ORIGINAL SCRIPT NAME:
      — $('span.oscr', el).text().trim() || null

   e. ALIASES:
      Good quality: text between "Good quality a.k.a.:" and "Low quality a.k.a.:"
      Low quality:  text between "Low quality a.k.a.:" and "Nationality:"
      Parse each block: split on /[a-z]\)\s+/ pattern
      Filter out "na"
      Combine all aliases into one flat array

   f. FIELD EXTRACTION via helper extractField(rawText, fieldName, nextFieldName):
      — Regex: new RegExp(fieldName + ':?\\s*(.+?)\\s*' + nextFieldName)
      — Applied to: Title, Designation, DOB, POB, Nationality,
                    Passport no, National identification no, Address,
                    Listed on, Other information

   g. NORMALISE:
      primary_name_normalised = normalise(primary_name)
      aliases_normalised_json = aliases.map(a => normalise(a))

4. Return parsed records array + parse error count
```

---

## 10. API Endpoints

### Auth
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Login with email + password. Returns JWT. |
| GET | `/api/auth/me` | Yes | Returns current user info |

### Upload
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/upload/nacta` | Yes | Upload NACTA Excel file. Parses, versions, inserts. |
| POST | `/api/upload/unsc` | Yes | Upload UNSC HTML file. Parses, versions, inserts. |
| GET | `/api/upload/status` | Yes | Returns active version label, record count, uploaded_at for both lists. |

### Screening
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/screening/run` | Yes | Run screening. Body: `{ cnic, full_name, father_name }`. Returns screening ID + result JSON. |
| GET | `/api/screening/:id/pdf` | Yes | Stream PDF for a completed screening. |
| GET | `/api/screening/history` | Yes | Paginated list of past screenings. |
| GET | `/api/screening/:id` | Yes | Full result JSON for a single screening. |

---

## 11. Frontend Pages & UX

### `/login`
- Email + password form
- JWT stored in localStorage on success
- Redirect to `/dashboard`

### `/dashboard`
- Two status cards: **NACTA List** and **UNSC List**
  - Each shows: version label, upload date, record count, status badge (Active/Not Uploaded)
- Quick action buttons: Upload Lists, Run Screening, View History

### `/upload`
- Two separate upload zones (drag + drop or file picker)
- Left: NACTA Excel (.xlsx / .xls)
- Right: UNSC HTML (.html)
- Each shows: current active version, upload button, upload progress
- On success: show new version number + record count parsed
- On error: show error message (e.g., "Missing required column: FATHER NAME")

### `/screen`
- Form with three fields:
  - **CNIC**: text input, user types digits only, dashes auto-inserted at positions 5 and 13
    - Rendered value: `42101-1234567-1` (dashes shown)
    - Stored/sent value: `42101-1234567-1`
  - **Full Name**: text input
  - **Father's Name**: text input (optional label shown)
- Submit button: "Run Screening"
- On submit: loading spinner, then result summary displayed on screen
- Result summary shows NACTA and UNSC outcomes with colour coding:
  - 🟢 No Record Found
  - 🔴 Record Found
  - 🟡 Possible Match — Manual Review Required
- "Download PDF Report" button appears after successful screening

### `/history`
- Table: Ref #, Subject Name, CNIC, Date/Time, NACTA Result, UNSC Result, Actions
- Each row has "View Report" button → opens PDF in new tab
- Pagination: 20 rows per page

---

## 12. PDF Report Specification

**Generated by:** `pdfkit` on the backend  
**Triggered by:** `GET /api/screening/:id/pdf`  
**Delivery:** Streamed as `application/pdf`, opened in new browser tab

### Report Layout

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          COMPLIANCE SCREENING REPORT
          Report Ref: SCR-000047
          Screened on: 22 May 2025, 14:32 PKT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SUBJECT DETAILS
  Full Name    : MUHAMMAD ALI
  Father's Name: GHULAM HASSAN
  CNIC         : 42101-1234567-1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION A — NACTA PROSCRIBED PERSONS LIST
  Checked against: v1.3 — Uploaded on 19 May 2025
  (Total records in list: 1,240)

  [✅] NO RECORD FOUND IN NACTA

  No entry matching this CNIC or name/father's name combination
  was found in the NACTA proscribed persons list.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION B — UNSC CONSOLIDATED LIST
  Checked against: v1.2 — Uploaded on 12 May 2025
  (Total records in list: 3,872)

  [🔴] RECORD FOUND IN UNSC CONSOLIDATED LIST
  Match Type : POSSIBLE MATCH — Manual Review Required
  Match Score: 72%

  ┌─────────────────────────────────────────────────────┐
  │  Reference      : QDi.192                           │
  │  Primary Name   : ABD ALLAH MOHAMED RAGAB           │
  │                   ABDEL RAHMAN                      │
  │  Aliases        : Abu Al-Khayr; Ahmad Hasan;        │
  │                   Abu Jihad                         │
  │  Date of Birth  : 3 Nov. 1957                       │
  │  Nationality    : Egypt                             │
  │  Designation    : Member of Egyptian Islamic Jihad  │
  │  Listed on      : 29 Sep. 2005                      │
  │  Pakistan Link  : Address mentions Pakistan         │
  └─────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Screened by   : Admin User
  Portal version: 1.0

  DISCLAIMER: Results marked "Possible Match" are generated
  by automated fuzzy matching and require manual verification
  by a qualified compliance officer before any action is taken.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Result status colour indicators in PDF:**
- NO MATCH: Black text with ✅ prefix
- CONFIRMED MATCH: Bold text with ● prefix
- POSSIBLE MATCH: Bold text with ◆ prefix + disclaimer line

*(PDFKit does not support colour in all environments; bold + prefix symbols are used for printer-safe formatting)*

---

## 13. Phase 2 Roadmap

| Feature | Notes |
|---|---|
| External PDF API | `GET /api/v2/screen` accepts params + returns PDF binary. Auth via API key. |
| Role-based access | `admin` vs `officer` roles. Officers cannot upload lists. |
| Automated NACTA update | Scraper replaces manual Excel upload. Same version logic applies. |
| Automated UNSC update | UNSC publishes updated HTML; cron job fetches and triggers re-parse. |
| Bulk screening | Upload a CSV of subjects; system screens all and produces a batch report. |
| GCP VM deployment | Nginx reverse proxy, PM2 process manager, MySQL on same VM or Cloud SQL. |

---

## 14. Open Questions & Decisions Log

| # | Question | Decision |
|---|---|---|
| 1 | Backend framework | Node.js + Express ✅ |
| 2 | ORM vs raw queries | Raw `mysql2` — schema is stable, ORM overhead not justified ✅ |
| 3 | NACTA fuzzy threshold | 0.8 (strict) ✅ |
| 4 | UNSC fuzzy threshold | 0.5 (lenient, accounts for transliteration variance) ✅ |
| 5 | CNIC format in UI | User types digits only; dashes auto-inserted by frontend ✅ |
| 6 | List replacement behaviour | New upload replaces active flag; old records retained for audit ✅ |
| 7 | Version format | v1.1 → v1.20 → v2.1 → v2.20 → v3.1 ... ✅ |
| 8 | PDF storage | Not stored on disk; regenerated from DB on demand in Phase 1 ✅ |
| 9 | Father's Name in NACTA | Column is `FATHER NAME` (not husband) ✅ |
| 10 | UNSC Pakistan relevance | Informational field only; checks nationality + address + other_info fields ✅ |
| 11 | UNSC entities vs individuals | Phase 1: individuals only ✅ |
| 12 | Screening: is CNIC required? | **OPEN** — Can a foreign national (no CNIC) be screened? If so, CNIC should be optional |
| 13 | NACTA file format guarantee | **OPEN** — Can the Excel file have extra columns, merged cells, or blank header rows? Need sample to confirm parser robustness |
| 14 | Report language | English only ✅ (assumed) |
| 15 | Session timeout | JWT expires after 8 hours; no refresh token in Phase 1 ✅ |

---

*End of Document*
