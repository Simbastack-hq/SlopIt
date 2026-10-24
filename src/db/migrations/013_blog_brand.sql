-- 013_blog_brand.sql
-- A blog's brand, so a blog on a company's domain looks like the company's:
--   accent_color  `#rrggbb`, lowercase. Replaces the theme's accent (links,
--                 parent-site pill, contents marker) and recolors the
--                 default favicon. Readable on the page background or
--                 refused at the write boundary.
--   logo_url      http(s) image shown in the masthead in place of the name.
--   favicon_url   http(s) image used as the browser-tab icon.
-- NULL = the theme's default for that piece. A host may restrict setting
-- them (core's brandPolicy hook); clearing is always allowed.

ALTER TABLE blogs ADD COLUMN accent_color TEXT;
ALTER TABLE blogs ADD COLUMN logo_url TEXT;
ALTER TABLE blogs ADD COLUMN favicon_url TEXT;
