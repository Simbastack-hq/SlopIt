-- 010_translations.sql
-- Translation groups: posts that are the same text in different
-- languages share one opaque `translation_group` id (NULL = not part of
-- any group). Members always carry an explicit `language` (the write
-- path freezes it when a post joins a group), which is what lets the
-- partial unique index express "one post per language per group". It is
-- the backstop behind the preflight check in src/posts.ts that produces
-- TRANSLATION_CONFLICT with the offending slug. No data rewrite.
-- Spec: docs/superpowers/specs/2026-09-15-translations-design.md

ALTER TABLE posts ADD COLUMN translation_group TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_translation_lang
  ON posts(blog_id, translation_group, language)
  WHERE translation_group IS NOT NULL;
