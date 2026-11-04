# FUSE

**F**rontier models, **U**nified, **S**pend-**E**fficient — one desktop app for Claude and ChatGPT models on your own API keys, with routing that matches each request to the model it needs and shows what every answer cost.

Status: **M0–M12 complete.** M10 includes the F4 file-handoff fix and a passed fresh live handover with verified push and temporary-device cleanup. M11 deployment, enrollment and verification are owner-confirmed, separately from its automated benchmark evidence. See `docs/milestones/M10-runs-on-hulk.md` and `docs/milestones/M11-encrypted-sync.md`. M12 adds searchable Settings categories, direct links and preserved conversation state; see `docs/milestones/M12-settings-navigation.md`. Dictation and deep research need a separately approved plan.

## Start building on HULK

```bash
git clone https://github.com/isaacholt-hash/fuse.git
cd fuse
bash scripts/setup-hulk.sh     # one time
gh auth login                  # one time, if not done
claude                         # start Claude Code in the repo
```

Then paste this into Claude Code:

> Read CLAUDE.md and the milestone it identifies. Work only on the next explicitly approved step; if no step is approved, report the current roadmap status. Open a PR, merge it once checks pass, tell me how to test it, and stop.

Claude merges each PR itself once checks pass. After each one: look at the screenshot (and try it if you like), then `git switch main && git pull` and send the same prompt again.

## Docs

- `CLAUDE.md` — project brief, decisions, rules for Claude Code
- `docs/requirements.md` — full functional requirements
- `docs/milestones/` — build plan, one milestone at a time
