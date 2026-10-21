-- 012_facts.sql
-- Live facts (docs/specs/2026-10-21-live-facts.md). A blog's named current
-- claims, used in post bodies as {{fact:name}}. Posts store the token, never
-- the value; every render substitutes the value as it stands.
--
-- updated_at:   when the value last changed (moves posts' dateModified).
-- confirmed_at: when the publisher says they last checked it (shown on the
--               page; moving it alone never touches dateModified).

CREATE TABLE IF NOT EXISTS facts (
  blog_id       TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  note          TEXT,
  source_url    TEXT,
  confirmed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (blog_id, name)
);

-- One row per blog whose fact-using pages still need re-rendering. Written
-- in the same transaction as the fact change, deleted once every page is
-- written, so a render that failed (or a crash) is finished by the next
-- facts call, post write, or the host's drainPendingFactRenders at boot.
CREATE TABLE IF NOT EXISTS fact_renders_pending (
  blog_id  TEXT PRIMARY KEY REFERENCES blogs(id) ON DELETE CASCADE,
  since    TEXT NOT NULL
);
