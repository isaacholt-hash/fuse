# FUSE

**F**rontier models, **U**nified, **S**pend-**E**fficient — one desktop app for Claude and ChatGPT models on your own API keys, with routing that matches each request to the model it needs and shows what every answer cost.

Status: **M1 — daily driver** (see `docs/milestones/M1-daily-driver.md`). M0 (thin slice) is done.

## Start building on HULK

```bash
git clone https://github.com/isaacholt-hash/fuse.git
cd fuse
bash scripts/setup-hulk.sh     # one time
gh auth login                  # one time, if not done
claude                         # start Claude Code in the repo
```

Then paste this into Claude Code:

> Read CLAUDE.md and docs/milestones/M1-daily-driver.md. Do the next unchecked step only. Open a PR, merge it once checks pass, tell me how to test it, and stop.

Claude merges each PR itself once checks pass. After each one: look at the screenshot (and try it if you like), then `git switch main && git pull` and send the same prompt again.

## Docs

- `CLAUDE.md` — project brief, decisions, rules for Claude Code
- `docs/requirements.md` — full functional requirements
- `docs/milestones/` — build plan, one milestone at a time
