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
  list_id         INT NOT NULL,
  full_name       VARCHAR(500) NOT NULL,        -- Normalised: UPPERCASE, trimmed
  father_name     VARCHAR(500) NOT NULL,
  cnic            VARCHAR(15) NULL,             -- Format: XXXXX-XXXXXXX-X; NULL = name-only record (no CNIC)
  raw_full_name   VARCHAR(500),                 -- Original as in file (for report display)
  raw_father_name VARCHAR(500),
  raw_cnic        VARCHAR(50),
  CONSTRAINT fk_nacta_records_list FOREIGN KEY (list_id) REFERENCES nacta_lists(id),
  INDEX idx_nacta_cnic (cnic),
  INDEX idx_nacta_list_id (list_id)
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
  CONSTRAINT fk_unsc_records_list FOREIGN KEY (list_id) REFERENCES unsc_lists(id),
  INDEX idx_unsc_list_id (list_id),
  FULLTEXT INDEX idx_unsc_primary_name (primary_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS screenings (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  screened_by         INT NULL,                  -- NULL = external API screening (no human user)
  input_cnic          VARCHAR(15),
  input_full_name     VARCHAR(500) NOT NULL,
  input_father_name   VARCHAR(500),
  nacta_result_json   JSON NOT NULL,
  unsc_result_json    JSON NOT NULL,
  nacta_list_version  VARCHAR(50),
  unsc_list_version   VARCHAR(50),
  screened_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_screenings_user FOREIGN KEY (screened_by) REFERENCES users(id),
  INDEX idx_screenings_date (screened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
