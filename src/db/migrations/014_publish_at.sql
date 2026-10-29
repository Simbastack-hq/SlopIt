-- 014_publish_at.sql
-- Scheduled publishing: a draft with publish_at set goes live by itself
-- once that time passes (the host calls publishDuePosts on a timer; see
-- src/schedule.ts). ISO 8601 UTC, NULL = not scheduled. Only drafts carry
-- it: publishing (by schedule or by hand) clears it.

ALTER TABLE posts ADD COLUMN publish_at TEXT;
CREATE INDEX idx_posts_publish_at ON posts(publish_at) WHERE publish_at IS NOT NULL;
