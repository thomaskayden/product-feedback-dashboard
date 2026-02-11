-- Update seeded feedback comments to be in the user's voice.

UPDATE feedback
SET comment = 'I reported this twice and it still feels like it disappears into a black hole. I need faster follow-up.'
WHERE source = 'Customer Support Tickets';

UPDATE feedback
SET comment = 'I shared this in Discord and got +1s, but I have no idea if anyone from the team actually saw it.'
WHERE source = 'Discord';

UPDATE feedback
SET comment = 'I opened a GitHub issue for this and would love a clearer status (triaged / in progress / won’t fix).'
WHERE source = 'GitHub issues';

UPDATE feedback
SET comment = 'I emailed support about this last week—can you please confirm you received it and what the next step is?'
WHERE source = 'email';

UPDATE feedback
SET comment = 'I tweeted about the bug because it was blocking me. It’d be great if someone could acknowledge it publicly.'
WHERE source = 'X/Twitter';

UPDATE feedback
SET comment = 'I posted this on the community forum and others agreed. Please let us know if it’s on the roadmap.'
WHERE source = 'community forums';

