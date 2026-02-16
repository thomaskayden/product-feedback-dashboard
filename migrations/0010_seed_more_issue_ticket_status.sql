-- Add more today rows for Issue / Ticket Status (positive sentiment → Low Impact) so KPI shows a number (2+) instead of "More".
-- Comments match theme keywords: status, confusion, tracking, state. No schema changes.

INSERT INTO feedback (source, sentiment, comment, timestamp) VALUES
('Customer Support Tickets', 'positive', 'Ticket status tracking is much clearer now, thanks for the update.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-25 minutes')),
('Discord', 'positive', 'Status labels in dashboard make it easier to track our issues.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-35 minutes')),
('GitHub issues', 'positive', 'The new state tracking for tickets is helpful.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-45 minutes')),
('Customer Support Tickets', 'positive', 'Confusion about status updates resolved; docs helped.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-55 minutes')),
('community forums', 'positive', 'Status page and ticket tracking both improved.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-65 minutes'));
