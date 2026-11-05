# M13 — Dictation

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m13-*` branch and PR per numbered step, sequentially from integrated main.
Follow `.claude/skills/ship-step/SKILL.md`: tick the box in its PR, run `pnpm check`, relevant
Rust checks, native startup and reviewed screenshots, web verification and all five CI gates
on the current commit. Attach every PR. Continue unattended after each verified merge.
Stop only for an unresolved product decision, unavailable required access or a failure that
cannot safely be resolved. Preserve other worktrees and the existing HULK/sync benchmarks.

Use fixtures and test secrets. Never read or request provider keys. No automatic production
deployment, device enrollment, account authorization or changes to existing permissions.
New tables/columns need forward-only migrations and explicit sync, deletion, backup and
export classification. Active execution and credentials remain local to their owner.

## Requirement coverage

VI-01, CO-08; shared accounting and SE-10 foundations.

## Steps

- [ ] **1. Shared accounting.** Add conservative request-cost reservations and atomic settlement against a run or parent cap, actual-attempt identities, explicit unresolved billing, duration pricing and sanitized audit records. Preserve integer micro-dollars and current rollups. Reserve before dispatch; do not retry an ambiguously billed request automatically.
- [ ] **2. Capture and transcription.** Native Rust capture with pinned `cpal = 0.18.2`, browser microphone capture, and typed bounded Rust binary/multipart transport using the existing OpenAI connection. Two-minute / 20 MiB limits, cancellation and microphone teardown. Raw audio stays transient. Credential values never return from Rust.
- [ ] **3. Controls and release.** Push-to-talk plus accessible start/stop in the composer and existing quick-capture flow. Explicit cloud-audio consent, duration/cost display, editable transcript insertion preserving the draft, never automatic send. Settings use M12 search/direct-link metadata. Recorded regression benchmark, desktop/web screenshots and release documentation.

## Behavior and boundaries

Use `gpt-transcribe` at the file-transcription endpoint. Model/pricing belongs in dated data,
not routing code. Verify maintainers' documentation before implementing:
[transcription](https://developers.openai.com/api/docs/guides/speech-to-text),
[model](https://developers.openai.com/api/docs/models/gpt-transcribe),
[CPAL](https://docs.rs/cpal/0.18.2/cpal/).
This is the only planned new direct dependency. Add required Linux audio build libraries to
setup/CI when capture lands. Use current OS secret stores on desktop and HULK.

Desktop capture belongs in Rust; browsers record locally and upload through authenticated
HULK. Consent explains that web audio passes through trusted HULK to OpenAI. Apply the same
project/provider policy as text. Local-only projects cannot use cloud transcription.

Stop recording on cancel, app lock or navigation. Clear audio buffers and release tracks;
never save audio to history, sync, exports or backups. Do not queue audio offline. Insert
successful text into the editable draft once, without triggering a model send or execution.
Keep incurred costs if the text is discarded. Local speech engines, TTS and realtime voice
are deferred.

## Acceptance

Denied permission, missing/disconnected device, repeated start/stop, empty/invalid audio,
unsupported format, duration/byte limits, cancellation before/during upload, lock/navigation,
provider failure and unresolved billing. Draft text survives; insertion happens once; no
automatic send. Cost rollups agree even when a transcript is discarded. No raw audio in
storage/export/sync. Windows/native and browser fixtures plus owner-operated real microphone
checks; no live provider call in CI.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
No acceptance evidence has been recorded for this milestone yet.
