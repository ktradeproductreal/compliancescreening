-- Compliance Screening Portal — schema (PRD §6).
-- Indexes and foreign keys are declared INLINE so the whole file is idempotent
-- under CREATE TABLE IF NOT EXISTS (re-running migrate.js is safe, and Docker's
-- init dir can apply it on first boot). No CREATE DATABASE / USE here — the
-- target schema comes from the connection (DB_NAME) or MYSQL_DATABASE.

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nacta_lists (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  version_major  TINYINT NOT NULL,
  version_minor  TINYINT NOT NULL,
  version_label  VARCHAR(10) NOT NULL,
  filename       VARCHAR(255) NOT NULL,
  uploaded_by    INT NOT NULL,
  record_count   INT NOT NULL DEFAULT 0,
  uploaded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_nacta_lists_user FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_nacta_lists_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nacta_records (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  list_id         INT NOT NULL,                 -- The list version that FIRST introduced this record (audit)
  full_name       VARCHAR(500) NOT NULL,        -- Normalised: UPPERCASE, trimmed
  father_name     VARCHAR(500) NOT NULL,
  cnic            VARCHAR(15) NULL,             -- Format: XXXXX-XXXXXXX-X; NULL = name-only record (no CNIC)
  raw_full_name   VARCHAR(500),                 -- Original as in file (for report display)
  raw_father_name VARCHAR(500),
  raw_cnic        VARCHAR(50),
  is_active       TINYINT(1) NOT NULL DEFAULT 1, -- 1 = present in latest upload; 0 = removed (kept for audit)
  CONSTRAINT fk_nacta_records_list FOREIGN KEY (list_id) REFERENCES nacta_lists(id),
  INDEX idx_nacta_cnic (cnic),
  INDEX idx_nacta_list_id (list_id),
  INDEX idx_nacta_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS unsc_lists (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  version_major  TINYINT NOT NULL,
  version_minor  TINYINT NOT NULL,
  version_label  VARCHAR(10) NOT NULL,
  filename       VARCHAR(255) NOT NULL,
  uploaded_by    INT NOT NULL,
  record_count   INT NOT NULL DEFAULT 0,
  uploaded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_unsc_lists_user FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_unsc_lists_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS unsc_records (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  list_id                 INT NOT NULL,
  ref_code                VARCHAR(50) NOT NULL,        -- e.g. "YEi.001"
  primary_name            VARCHAR(500) NOT NULL,
  primary_name_normalised VARCHAR(500) NOT NULL,
  name_parts_json         JSON NOT NULL,
  aliases_json            JSON NOT NULL,
  aliases_normalised_json JSON NOT NULL,
  nationality             VARCHAR(255),
  address                 TEXT,
  dob                     VARCHAR(255),                -- real entries can list multiple/approx dates
  pob                     TEXT,                        -- place of birth (used for Pakistan-relevance filter)
  designation             TEXT,
  listed_on               VARCHAR(512),                -- includes amendment history, e.g. "29 Sep. 2005 (amended on ...)"
  original_script_name    VARCHAR(500),
  other_information       TEXT,
  identification_numbers_json JSON NULL,        -- array of passport/national-id values used for strict 3-check matching (2026-06-23)
  is_active               TINYINT(1) NOT NULL DEFAULT 1, -- 1 = present in latest upload; 0 = removed (kept for audit)
  CONSTRAINT fk_unsc_records_list FOREIGN KEY (list_id) REFERENCES unsc_lists(id),
  INDEX idx_unsc_list_id (list_id),
  INDEX idx_unsc_active (is_active),
  INDEX idx_unsc_ref_code (ref_code),
  FULLTEXT INDEX idx_unsc_primary_name (primary_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Automated list sync state + audit (added 2026-06-22) ──────────────────
-- Two cron-driven sync scripts (NACTA every 3h, UNSC daily) update these.
-- sync_state holds the change-detection signal per source; sync_log gives a
-- per-run audit trail visible in phpMyAdmin / the Dashboard.

CREATE TABLE IF NOT EXISTS sync_state (
  source          VARCHAR(20) PRIMARY KEY,    -- 'nacta' | 'unsc'
  last_count      INT NULL,                   -- last seen record count (NACTA: scraped from page)
  last_signature  VARCHAR(255) NULL,          -- SHA-256 of last fetched file body (UNSC)
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  source        VARCHAR(20) NOT NULL,         -- 'nacta' | 'unsc'
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at      DATETIME NULL,
  status        VARCHAR(20) NOT NULL,         -- 'success' | 'unchanged' | 'failed' | 'running'
  delta_json    JSON NULL,                    -- dedup delta when status = success
  error         TEXT NULL,                    -- error message when status = failed
  triggered_by  VARCHAR(20) DEFAULT 'cron',   -- 'cron' | 'manual'
  INDEX idx_sync_log_source_started (source, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-record audit trail. One row per action a sync takes (an "added", a
-- "deactivated", a duplicate drop, etc.) so compliance can answer questions
-- like "what CNIC was dropped on YYYY-MM-DD and why?" via a single query.
-- Only CHANGES + DROPS are recorded — never kept rows (would explode volume).
CREATE TABLE IF NOT EXISTS sync_events (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  sync_log_id         INT NULL,               -- link to the sync_log run; NULL for manual UI ingestion
  source              VARCHAR(20) NOT NULL,   -- 'nacta' | 'unsc'
  event_type          VARCHAR(30) NOT NULL,   -- 'added' | 'deactivated' | 'reactivated' | 'duplicate_in_file' | 'warning' | 'skipped'
  `row_number`        INT NULL,               -- row number in the source file (1-based); backticked because MySQL 8 reserves ROW_NUMBER as a window function
  cnic                VARCHAR(15) NULL,       -- normalised CNIC involved (if any)
  full_name           VARCHAR(500) NULL,      -- raw display name
  father_name         VARCHAR(500) NULL,      -- raw father name
  ref_code            VARCHAR(50) NULL,       -- UNSC ref code (if UNSC event)
  existing_record_id  INT NULL,               -- id of the DB record affected (for deactivated/reactivated)
  detail              TEXT NULL,              -- freeform note (e.g. "matches row 47 of this file")
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sync_events_log FOREIGN KEY (sync_log_id) REFERENCES sync_log(id) ON DELETE CASCADE,
  INDEX idx_sync_events_log (sync_log_id),
  INDEX idx_sync_events_source_type (source, event_type),
  INDEX idx_sync_events_cnic (cnic),
  INDEX idx_sync_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS screenings (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  screened_by         INT NULL,                  -- NULL = external API screening (no human user)
  input_cnic          VARCHAR(15),
  input_full_name     VARCHAR(500) NOT NULL,
  input_father_name   VARCHAR(500),
  input_dob           VARCHAR(11),                  -- format dd-MMM-yyyy (e.g. "10-JAN-2030"); used for UNSC year match
  nacta_result_json   JSON NOT NULL,
  unsc_result_json    JSON NOT NULL,
  nacta_list_version  VARCHAR(50),
  unsc_list_version   VARCHAR(50),
  report_token        VARCHAR(64) NULL,           -- 32-hex random; auth for the public /api/v2/reports/<token>.pdf URL
  screened_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_screenings_user FOREIGN KEY (screened_by) REFERENCES users(id),
  UNIQUE KEY uq_screenings_report_token (report_token),
  INDEX idx_screenings_date (screened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
