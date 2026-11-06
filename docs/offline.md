# Offline sending (M18)

When this desktop is offline, a normal saved Chat (not incognito, not a Code or Work
session, nothing attached, not comparing) shows **You're offline** and its send button
becomes **Queue**. Queued messages appear above the composer, oldest first, with **Edit**
and **Cancel** while they wait. They're stored on this desktop only: they never sync, never
go into an export, and never send from another device or a restored copy.

Drafts, history, search and local housekeeping still work offline. Incognito chats can't
queue because nothing about them is kept. The web app on HULK needs the network to reach
HULK at all, so it doesn't queue.

## Back online (M18.2)

When the desktop is online again, an open chat's queued messages send one at a time, oldest
first, through the same checks as a message you send yourself: the chat's privacy rules,
keys and spending limits, routing, budgets and the large-request cost check. The composer
notes which other chats still have waiting messages; each sends when you open it.

A queued message stops and waits for **Send now** (an ordinary send, with its usual
questions) or **Cancel** when:

- a budget is over its limit, or the message adds a lot to the request;
- a key, spending limit or privacy rule now stops the chat;
- the model it would use, or that model's price, changed since you queued it;
- it was queued on another installation or before a restore.

Messages after a stopped one wait too, so they never overtake it. A message is marked as
dispatching only after every check passed. If the app closes while one is dispatching, it
comes back as **May have been sent**: it is never sent again by itself, because the provider
may already have it (and billed it). Check the chat, then send it again or cancel it.
