CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  blog_id      TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_blog ON media(blog_id);
