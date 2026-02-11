-- Data-only: move 1 Email Delivery row from "today" to "yesterday" so the 3rd slot (Low Impact) shows a red ▼.
-- The dashboard forces the 3rd slot to Email when top 3 by risk have no Low Impact; Support's decrease was hidden.

UPDATE feedback
SET timestamp = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day', '-240 minutes')
WHERE id IN (
  SELECT id FROM feedback
  WHERE date(timestamp) = date('now')
  AND (
    comment LIKE '%Email verification%'
    OR comment LIKE '%Verification email%'
    OR comment LIKE '%email delivery%'
    OR comment LIKE '%emails not arriving%'
    OR comment LIKE '%Notification email%'
  )
  LIMIT 1
);
