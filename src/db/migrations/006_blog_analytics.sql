-- 006_blog_analytics.sql
-- Phase 3c — adds a single nullable JSON column on blogs for per-blog
-- analytics configuration. NULL = no third-party analytics. Object =
-- { umami?: {...}, plausible?: {...}, googleAnalytics?: {...} }, validated
-- by BlogAnalyticsSchema at the boundary. Single column instead of a
-- sibling table (Phase 3 design row #8) — schema is small enough that
-- migration churn outweighs normalization benefit.

ALTER TABLE blogs ADD COLUMN analytics_json TEXT;
