-- Idempotency-Key replay records. Core migrations 001-099; this is 002.
-- Weakened guarantee per spec decision #20: rows are inserted AFTER the
-- handler commits, so a crash between commit and insert leaves a retry
-- window. Failure modes are documented; crash-safe variant is deferred.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,                             -- '' for /signup (pre-auth)
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,                             -- exact path (with :id/:slug substituted)
  request_hash    TEXT NOT NULL,                             -- sha256 over method+path+content-type+sorted-qs+body
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,                             -- serialized JSON response
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, api_key_hash, method, path)
);
