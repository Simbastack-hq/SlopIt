-- 011_blog_title.sql
-- Optional display title for a blog: the human-readable name shown in the
-- masthead, the page <title>, og:site_name, the RSS channel and the
-- llms.txt heading. NULL = fall back to the blog's URL name, then its id.
-- Validated at the boundary (trimmed, 1–80 chars, one line). No data
-- rewrite: existing blogs keep rendering their URL name until patched.

ALTER TABLE blogs ADD COLUMN title TEXT;
