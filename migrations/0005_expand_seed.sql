-- Expand seed dataset to 15–20 items across existing sources.
-- Reinforces: Authentication/Login, Support Delays, Link/Validation, Email Delivery, Documentation Confusion.
-- Schema unchanged.

INSERT INTO feedback (source, sentiment, comment)
VALUES
  ('Customer Support Tickets', 'negative', 'Login page hangs after entering password. Had to try three times.'),
  ('Customer Support Tickets', 'negative', 'Password reset link said it expired in 1 hour but I clicked it in 20 minutes.'),
  ('Discord', 'neutral', 'The invite link for the beta channel returns 404. Can someone fix the link?'),
  ('Discord', 'negative', 'SSO login fails every time; works on the website but not Discord bot.'),
  ('GitHub issues', 'neutral', 'Issue status stuck on "needs info" even after I added the logs. What else is needed?'),
  ('GitHub issues', 'negative', 'Labels and state are confusing. Is "needs info" the same as "waiting on user"?'),
  ('GitHub issues', 'positive', 'Appreciate the clear issue triage workflow once you get past the status labels.'),
  ('email', 'negative', 'Notification emails never arrive. Checked spam; nothing.'),
  ('email', 'neutral', 'Email verification link failed with "invalid or expired token" on first click.'),
  ('email', 'negative', 'Support replied after 5 days. By then I had already fixed the issue myself.'),
  ('X/Twitter', 'negative', 'Login with Google just redirects to homepage. Still not fixed.'),
  ('X/Twitter', 'neutral', 'Docs say to use the blue button but I only see a grey one. Which is correct?'),
  ('community forums', 'negative', 'Validation error when submitting the form: "Invalid format" but I followed the docs.'),
  ('community forums', 'neutral', 'Documentation is scattered. Hard to find the right page for API auth.'),
  ('Customer Support Tickets', 'negative', 'No response to my ticket for a week. Is anyone reading these?'),
  ('Discord', 'positive', 'Link to the new docs worked after they fixed the redirect. Thanks.');
