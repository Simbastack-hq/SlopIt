-- Optional email per blog. Used for the welcome-email-with-key at signup
-- and for the email-only recovery flow (see migration 004). Stays out of
-- the public Blog shape (BlogSchema in src/schema/index.ts) — only ever
-- read by the signup orchestration and the recovery primitives.

ALTER TABLE blogs ADD COLUMN email TEXT;

-- Recovery looks up blogs by email; index keeps that O(log n).
CREATE INDEX IF NOT EXISTS idx_blogs_email ON blogs(email);
