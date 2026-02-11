-- Align feedback sources to the current set used by the prototype.
-- This keeps the schema the same but replaces existing seed data
-- so /api/feedback only returns the desired sources.

DELETE FROM feedback;

INSERT INTO feedback (source, sentiment, comment)
VALUES
  ('Customer Support Tickets', 'negative', 'Common complaint: it takes too long to triage tickets into themes.'),
  ('Discord', 'neutral', 'Users are asking how feedback from Discord gets prioritized versus other channels.'),
  ('GitHub issues', 'positive', 'Maintainers like having all bug reports linked into a single feedback view.'),
  ('email', 'neutral', 'PMs forward customer emails manually and want automatic ingestion into reports.'),
  ('X/Twitter', 'negative', 'Launch posts generate a lot of noisy feedback that is hard to summarize.'),
  ('community forums', 'positive', 'Power users appreciate being able to tag forum threads by product area.');

