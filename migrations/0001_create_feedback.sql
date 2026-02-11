-- D1 schema for storing product feedback

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  comment TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Seed data so the /api/feedback endpoint returns rows immediately
INSERT INTO feedback (source, sentiment, comment)
VALUES
  ('NPS Survey', 'positive', 'Love the consolidated feedback view, makes prioritization easier.'),
  ('Zendesk', 'neutral', 'It would be great to filter feedback by customer segment.'),
  ('App Store Reviews', 'negative', 'The feedback report loads slowly on mobile.');

