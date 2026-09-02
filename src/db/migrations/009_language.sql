-- 009_language.sql
-- Language tags (BCP-47) for blogs and posts. `blogs.language` is the
-- default for every page and feed on the blog and always has a value;
-- `posts.language` is an optional per-post override (NULL = inherit the
-- blog's). Both are validated and canonicalised at the schema boundary
-- (`languageTag` in src/schema/post-input-base.ts), so stored values are
-- always canonical (`en-US`, not `EN-us`). Existing rows read as `en` /
-- NULL: no data rewrite. Hosted blogs that publish in another language
-- get their default corrected by a PATCH, not by this migration.

ALTER TABLE blogs ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE posts ADD COLUMN language TEXT;
