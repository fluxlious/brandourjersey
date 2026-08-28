/* One row per counter. Only 'views' so far. */
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

/* Deduplication only, and deliberately unable to identify anyone: the visitor
   column is a salted hash that changes every day, and rows are deleted after
   two days. No IP address, no cookie, nothing that survives the week. */
CREATE TABLE IF NOT EXISTS seen (
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (day, visitor)
);

CREATE TABLE IF NOT EXISTS claims (
  spot_id      INTEGER PRIMARY KEY,
  -- 'reserved' while a checkout is open, 'paid' once the webhook confirms.
  status       TEXT NOT NULL DEFAULT 'reserved',
  name         TEXT NOT NULL,
  url          TEXT,
  logo         TEXT,          -- external logo URL, if one was ever set by hand
  logo_mime    TEXT,          -- content type of an uploaded logo
  logo_b64     TEXT,          -- the uploaded logo itself, base64
  upload_token TEXT,          -- lets only the buyer upload for their spot
  payment_id   TEXT,
  expires_at   TEXT,          -- when a reservation lapses; NULL once paid
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
