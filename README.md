# FUSE

**F**rontier models, **U**nified, **S**pend-**E**fficient — one desktop app for Claude and ChatGPT models on your own API keys, with routing that matches each request to the model it needs and shows what every answer cost.

Status: **M0–M12 complete.** [Finish FUSE P2](docs/P2-completion.md) is approved for unattended sequential delivery: M13 dictation, M14 research, M15 Microsoft/GitHub connectors, M16 coding completion, M17 writing/artifacts, M18 offline/usage, M19 acceptance. M13 dictation and M14 research builds are delivered with owner acceptance pending; current milestone: [M15](docs/milestones/M15-connectors.md). M10/M11 live acceptance remains recorded separately from automated benchmarks. P2 closure requires released owner-operated checks.

## Start building on HULK

```bash
git clone https://github.com/isaacholt-hash/fuse.git
cd fuse
bash scripts/setup-hulk.sh     # one time
gh auth login                  # one time, if not done
claude                         # start Claude Code in the repo
```

Then paste this into Claude Code:

> Read CLAUDE.md and the milestone it identifies. Follow the approved M13–M19 unattended workflow: implement the next numbered step, verify it, open and merge its PR only after all required checks pass, report evidence and continue. Stop only for an unresolved decision, unavailable required access or an unsafe failure.

Claude merges each PR itself once checks pass. The approved M13–M19 build continues unattended after each verified merge; owner deployment, account setup and live acceptance remain explicit actions.

## Docs

- `CLAUDE.md` — project brief, decisions, rules for Claude Code
- `docs/requirements.md` — full functional requirements
- `docs/milestones/` — build plan, one milestone at a time
