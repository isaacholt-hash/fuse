# Routing test set (shipped)

Synthetic prompts with the tier each should get, in the same JSON Lines format as the set you import in Settings → Routing test set (RT-16). The 40 prompts cover chat, writing, creative, coding, analysis and reasoning at each complexity, and 5 of them need earlier context. They're written for FUSE, with no personal data.

Two things use it:

- `pnpm local:bench`, which scores the local model's classification on this computer (M7 step 9).
- The P1.5 gate test (M7 step 13).

Your own imported set stays on your computer and is scored the same way.
