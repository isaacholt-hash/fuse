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
- [x] **2. Capture and transcription.** Native Rust capture with pinned `cpal = 0.18.2`, browser microphone capture, and typed bounded Rust binary/multipart transport using the existing OpenAI connection. Two-minute / 20 MiB limits, cancellation and microphone teardown. Raw audio stays transient. Credential values never return from Rust.
- [x] **3. Controls and release.** Push-to-talk plus accessible start/stop in the composer and existing quick-capture flow. Explicit cloud-audio consent, duration/cost display, editable transcript insertion preserving the draft, never automatic send. Settings use M12 search/direct-link metadata. Recorded regression benchmark, desktop/web screenshots and release documentation.

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

Step 1 shipped in [PR #288](https://github.com/isaacholt-hash/fuse/pull/288), merged as
`9dcae566fb10ba3d74b122f76706948849f9f72d` after all five gates passed on `fda23e2` in
[CI 41954892291](https://github.com/isaacholt-hash/fuse/actions/runs/41954892291).
[v0.1.213](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.213) published on
2026-11-05 at 02:54:21 UTC through [release 41957420796](https://github.com/isaacholt-hash/fuse/actions/runs/41957420796).
Windows/Linux installers, signatures and updater manifest were verified. Windows click-through
screenshots were reviewed; its Chat/Code amounts sum to its overall cost. Additional synthetic
receipt checks show unresolved/known-free/reported charges in
[light](../screenshots/m13/accounting-billing-light.png) and
[dark](../screenshots/m13/accounting-billing-dark.png). No provider request was made.

Step 2 adds schema 63 and backend APIs, leaving consent/settings/composer controls to step 3.
Native capture uses the system's default input on a dedicated CPAL thread; the browser uses
an app-owned AudioWorklet and its own microphone permission. Both produce only bounded mono
PCM16 WAV in RAM. Cancel, abort, disconnection, startup failure and size/duration limits release
microphone resources. An abandoned native recording expires after 30 seconds once stopped.
The web binary upload route rejects bodies above 20 MiB before buffering; Rust independently
validates canonical headers, length, sample rate and actual duration before dispatch.

Rust reserves duration rounded upward to a whole second, checks original/current source policy
and budgets again before one multipart POST, and owns receipt settlement after caller loss.
The existing OpenAI secret never returns through these APIs. HTTP retries and redirects are
disabled. Missing/invalid usage remains unresolved with its hold retained. A known charge is
saved even when the transcript is empty, unusable or discarded. Startup recovery runs when
the native owner's database first opens; a browser or runner reconnect cannot interrupt it.
No audio/transcript is stored in the reservation or receipt. An accepted transcript becomes
ordinary history only if the owner later sends it.

Forward migration 0063 preserves existing cost records, circular references, indexes, capture
triggers and pending sync events. Local reservations add source-scope IDs, audio duration and
surface; portable receipts use the fields from 0062. No new table or portable permission is
introduced. Linux builds need `libasound2-dev` (setup, CI and release builds updated).
Real microphone/provider acceptance remains pending on the eventual released dictation UI.

Step-2 local verification (2026-11-05): `pnpm check` passed (172 files / 1,003 tests;
13 live/manual tests skipped). Default Rust clippy and 168 tests passed; server clippy and
all 182 server-feature tests passed. Both preserved benchmarks passed: HULK 5/5, encrypted
sync 16/16 with schema 63, two replicas and one throwaway server (48,013 ms).
The rebuilt web app passed 10 Chromium click-through tests, including a real AudioWorklet
round trip: 4,410 finite mono frames at 44,100 Hz, then its configured limit.
[Recorded worklet result](../screenshots/m13/capture-worklet.json).

Reviewed [native startup](../screenshots/m13/capture-native.png) and
[dark web Settings](../screenshots/m13/capture-web-dark.png). These show startup/regression
verification; the recording UI is step 3. The native updater banner is the scripted 9.9.9
fixture. No physical microphone, provider request, Windows installer or live deployment was
used locally. Windows compatibility/click-through and all other current-commit CI gates are
required before merging this step.


Step 2 shipped in [PR #290](https://github.com/isaacholt-hash/fuse/pull/290), merged as
`ff8da335bf81cb4d62aeb7fad02aa3725be27ce8` after all five gates passed on `5a1e777` in
[CI 41962255756](https://github.com/isaacholt-hash/fuse/actions/runs/41962255756).
Its normal [release workflow](https://github.com/isaacholt-hash/fuse/actions/runs/41964551540)
published [v0.1.214](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.214) on
2026-11-05 at 04:20:57 UTC from that exact merge. Linux/Windows builds and publication passed;
installer/signature assets and the updater manifest's signed asset associations were verified.
Nothing was deployed.

Step 3 adds shared composer controls, push-to-talk and keyboard/click start/stop, bounded
recording state and price, cancellation, and local audio-transfer consent. The same composer
is used by quick capture. Consent explains trusted HULK's web role and never starts capture
by itself. It is local to the installation/browser, with redacted policy audit events.
Settings search/direct links include Dictation in General. Lock/unmount, hidden panels,
changed project/area, page navigation and background tabs cancel audio. Native page/window
handlers also release abandoned capture when JS cleanup is unavailable.

A completed transcription appends once to the current draft, preserving text typed during
upload and never calling Send. No run or permission is created. Incognito audio remains
transient. Existing-thread speech fees join thread totals; draft-only fees remain attributed
to the selected project/global scope without creating an empty conversation. Discarding a
draft cannot remove incurred costs. Unknown billing stays visible and is never auto-retried.
See [setup, updates and owner checks](../dictation.md).

`pnpm dictation:bench` records the deterministic regression suite; CI uploads its JSON report.
The separate web fixture and Windows click-through use synthetic capture and one synthetic
receipt, without physical microphones or provider calls. Production browser verification
remains separate, and release bundles exclude the scripted fixture. Actual microphone,
provider charges and owner-operated quick capture are **pending**, not passed by fixtures.
P2 acceptance remains open under [the completion contract](../P2-completion.md).


Step-3 local evidence (2026-11-05): the recorded dictation regression benchmark passed all
31 scenarios across eight files. Default Rust clippy and 169 tests passed; server clippy
and 183 tests passed. The strengthened native lifecycle test additionally confirms that
its worker actually receives cancellation. The preserved HULK benchmark passed 5/5 and
encrypted sync passed 16/16 (schema 63, two replicas, one throwaway HULK, 30,507 ms).
Production web click-through passed 10/10; the separate scripted dictation browser scenario
passed with one synthetic 75-micro-dollar receipt and zero provider calls. These are fixtures,
not real microphone or provider acceptance. [Recorded results](../screenshots/m13/controls-benchmark.json).

Reviewed native [recording in light](../screenshots/m13/controls-native-recording-light.png)
and [dark](../screenshots/m13/controls-native-recording-dark.png), plus editable transcripts in
[light](../screenshots/m13/controls-native-transcript-light.png) and
[dark](../screenshots/m13/controls-native-transcript-dark.png).
Web [consent](../screenshots/m13/controls-web-consent-light.png),
[recording](../screenshots/m13/controls-web-recording-dark.png) and Settings in
[light](../screenshots/m13/controls-web-settings-light.png) and
[dark](../screenshots/m13/controls-web-settings-dark.png) were reviewed. The 9.9.9 updater
banner is scripted fixture data. Windows click-through and all five current-head CI gates
remain mandatory for this PR; physical devices/provider charges stay owner-operated.

`VITEST_MAX_WORKERS=2 pnpm check` passed on the completed source tree: 175 test files /
1,020 tests passed; 13 live/manual tests skipped. Lint, typecheck and the secret scan passed.
The focused dictation suite passed 31/31, and final clippy checks passed for default and
server features. No new dependency, migration or production activation is part of step 3.

Step 3 shipped in [PR #291](https://github.com/isaacholt-hash/fuse/pull/291), merged
2026-11-05T04:40:47Z as `cdb68ea95e567c133a1ba93039d72fa2ce39aa44`. All five gates
passed on head `1f321705a596d0158ca5e9af4d13cd28baba08db` in
[CI 41968312106](https://github.com/isaacholt-hash/fuse/actions/runs/41968312106).
Windows screenshots and its synthetic recording/transcript scenario passed and were reviewed.
[Release v0.1.215](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.215),
published 2026-11-05T04:47:15Z, contains that merge. Linux and Windows builds and publication
passed in [build 41969294439](https://github.com/isaacholt-hash/fuse/actions/runs/41969294439);
installer, signature and updater assets are present. No HULK deployment or microphone/provider
activation was performed. Released owner microphone/provider acceptance remains pending.
