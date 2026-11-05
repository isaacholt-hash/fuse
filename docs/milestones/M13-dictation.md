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

- [x] **1. Shared accounting.** Add conservative request-cost reservations and atomic settlement against a run or parent cap, actual-attempt identities, explicit unresolved billing, duration pricing and sanitized audit records. Preserve integer micro-dollars and current rollups. Reserve before dispatch; do not retry an ambiguously billed request automatically.
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
Step 1 adds forward-only migration 0062: request receipts gain billing state, attempt ID,
audio duration and direct project attribution. Owner-local reservations cannot execute on a
replica; SQLite conditions prevent cap oversubscription and duplicate dispatch. Settlement,
actual run spend and unused exposure release commit in one batch. Startup keeps dispatched
work as unknown; it only releases holds proven unsent. Request-log diagnostics distinguish
unknown/estimated charges. Direct project charges participate in rollups and privacy
withdrawal. Credential-use auditing stays in Rust; policy writes generate fixed metadata
atomically, without content or credential values.

Code/Work planning, turns and compaction use the shared boundary. Each tool turn is limited
to 4,000 output tokens for its reservation; long tasks continue through the existing loop.
Text uses a UTF-8-byte input upper estimate plus framing headroom; opaque media reserves the
catalog window. Quotes use the highest applicable input/cache-write/long-context rate and
round upward. Search cannot use this boundary without a separately bounded tool fee (M14).
Known receipts release unused exposure; unknown results remain held and are never replayed
on startup. Paid POST network/5xx failures cannot auto-retry or silently fail over; safe GET
and known non-billable rate-limit retries keep their existing behavior. No model selection
or quality floor changed.

The shared duration-price data is `data/speech.json`, verified against the official model
page on 2026-11-05: 4,500 micro-dollars/minute, integer rounding, 120,000 ms and 20 MiB limits.
There is no capture, audio transfer or dictation UI in step 1. Those remain steps 2 and 3.
No new dependency or production activation is included. The schema is now 62: desktop and
HULK must be updated together through the existing owner-operated deployment procedure;
existing pairing is retained, and incompatible versions pause rather than discard work.

Step-1 local verification (2026-11-05): `pnpm check` passed (167 test files, 988 tests;
13 live/manual tests skipped), Rust clippy and 159 Rust tests passed, all five HULK benchmark
scenarios passed, and the encrypted-sync benchmark passed all 16 scenarios with two native
replicas and a throwaway HULK on schema 62 (28,905 ms). The rebuilt web app passed all nine
Chromium click-through tests, including light/dark layouts. Project-only cost metadata also
round-trips through project export/restore without importing execution reservations.

Reviewed screenshots: [native startup](../screenshots/m13/accounting-native.png),
[web Usage](../screenshots/m13/accounting-web-usage.png),
[dark web Settings](../screenshots/m13/accounting-web-dark.png). The native updater's 9.9.9
banner is the existing scripted screenshot fixture, not a published build. Real provider
charges, Windows installer operation and microphone acceptance were not exercised locally.
The PR requires all five current-commit CI gates, including Windows and both benchmarks.
