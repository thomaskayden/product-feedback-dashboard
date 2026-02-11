-- Make seeded comments specific and realistic (user perspective).

UPDATE feedback
SET comment = 'My support ticket #18427 has been “Open” for 6 days with no reply. I also never got a confirmation email after submitting it.'
WHERE source = 'Customer Support Tickets';

UPDATE feedback
SET comment = 'In Discord, I pasted a feedback link (https://example.com) and the bot replied “Invalid URL” even though the link opens fine.'
WHERE source = 'Discord';

UPDATE feedback
SET comment = 'On GitHub, issue #312 is marked “needs info” but I already added logs. Can you tell me exactly what you still need?'
WHERE source = 'GitHub issues';

UPDATE feedback
SET comment = 'I emailed feedback@company.com yesterday and got a bounce: “550 5.1.1 user unknown”. Is that address correct?'
WHERE source = 'email';

UPDATE feedback
SET comment = 'I posted on X about a login bug: clicking “Continue with Google” returns me to the homepage and I’m still logged out.'
WHERE source = 'X/Twitter';

UPDATE feedback
SET comment = 'On the community forum, my post keeps getting flagged as spam the moment I include a screenshot. Can you fix the false positive?'
WHERE source = 'community forums';

