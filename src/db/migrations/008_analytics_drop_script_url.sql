-- 008_analytics_drop_script_url.sql
-- Security fix — drops the caller-supplied `scriptUrl` from any stored
-- analytics config. It was an arbitrary-script injection vector: a caller
-- set `umami.scriptUrl` to an attacker-controlled file and the renderer
-- injected it as `<script src>`. The schema no longer accepts the field;
-- the consumer hardcodes the official cloud endpoint per provider.
--
-- json_remove no-ops on absent paths, so this is idempotent and safe for
-- rows that never had analytics or never set scriptUrl. The old strict
-- schema mandated siteId/domain alongside scriptUrl, so stripping
-- scriptUrl always leaves a valid provider object — a row missing
-- siteId/domain was already a corrupt write and parseAnalytics fails
-- loud on it by design; this migration does not mask that.

UPDATE blogs
SET analytics_json = json_remove(analytics_json, '$.umami.scriptUrl', '$.plausible.scriptUrl')
WHERE analytics_json IS NOT NULL;
