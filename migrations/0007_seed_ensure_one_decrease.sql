-- Data-only: move 4 Support Response Delays rows from "today" to "yesterday" so Trend Snapshot shows one red ▼.
-- No schema changes. Safe to run after 0006 (whether 0006 was the original or updated seed).

UPDATE feedback
SET timestamp = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day', '-120 minutes')
WHERE id IN (
  SELECT id FROM feedback
  WHERE date(timestamp) = date('now')
  AND (
    comment LIKE '%Support ticket open%'
    OR comment LIKE '%No response to ticket%'
    OR comment LIKE '%Support reply took%'
    OR comment LIKE '%Waiting 72 hours for support%'
    OR comment LIKE '%Support delay caused%'
    OR comment LIKE '%Ticket response time too long%'
    OR comment LIKE '%No reply from support%'
    OR comment LIKE '%Slow response time on support%'
  )
  LIMIT 4
);
