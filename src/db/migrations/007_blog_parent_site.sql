-- 007_blog_parent_site.sql
-- Adds an optional `parent_site_url` column on blogs so a blog can link
-- back to the author's main website (e.g. a custom-domain blog under
-- `blog.example.com` pointing to `example.com`). NULL = no parent link
-- rendered; non-null = absolute URL validated at the boundary by
-- BlogSchema (zod `z.url()`). Stored as text, single column — keeps
-- shape minimal until we have a second site-meta field worth grouping.

ALTER TABLE blogs ADD COLUMN parent_site_url TEXT;
