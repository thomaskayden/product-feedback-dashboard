-- Data-only: add 2 "yesterday" rows for Issue Status Confusion so the 3rd slot shows a decrease (yesterday > 1, today < yesterday).
-- Comments match theme keywords: status, confusion, tracking, state. No schema changes.

INSERT INTO feedback (source, sentiment, comment, timestamp) VALUES
('Discord', 'neutral', 'Status and state confusion in dashboard.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day', '-100 minutes')),
('GitHub issues', 'neutral', 'Confusion about status updates and tracking.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day', '-110 minutes'));
