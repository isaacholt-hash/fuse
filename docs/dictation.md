# Dictation

Dictation uses the existing OpenAI connection and adds text to the editable composer draft.
It never sends a message, starts a run, or grants file/command access. Existing draft text
is preserved, including edits made while transcription is in progress.

## Update and set up

1. Install the released desktop update through FUSE's updater or its signed GitHub installer.
   Update HULK to the same release using [the existing update procedure](hulk-server.md).
   Schema 63 is forward-only; retain the migration backup. Existing pairing/enrollment stays
   in place. The build does not deploy or enable dictation on an existing installation.
2. Connect OpenAI through Settings → Providers & models → API keys using the existing native
   secret-store flow. Browser use needs the connection on HULK. Credentials never return to
   browser/ordinary UI code.
3. Settings → General → Dictation → Set up dictation explains the audio transfer and asks
   for consent. Alternatively click the composer's microphone to see that explanation.
   Agreeing enables the controls here; it does not start recording. Consent is local to this
   desktop installation or browser origin, outside the portable settings allowlist. Each
   installation/browser asks separately. Policy changes produce redacted audit metadata.
4. Click the microphone to start, then click Stop recording and transcribe. Alternatively
   hold the microphone for push-to-talk and release it; keyboard activation provides the
   same accessible start/stop alternative. The existing global quick-capture shortcut opens
   the same composer and microphone. The OS/browser also requests microphone permission.
5. Review or edit the inserted transcript. Send remains an explicit action. Cancellation
   discards audio/transcripts, not an already-incurred provider charge.

The catalog records `gpt-transcribe` at $0.0045/minute, verified 2026-11-05 against
[OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-transcribe).
The recording line displays duration, the current estimate and the per-minute rate. Quotes
round duration upward to a whole second; actual reported duration settles the receipt.
Budget/provider/project policy is checked before dispatch, including concurrent reservations.
Local-only projects cannot send audio to OpenAI. FUSE does not choose a different provider or
retry an ambiguously charged transcription automatically.

## Privacy, cancellation and errors

Native recording uses the system's default microphone in Rust. Web recording uses the
browser's microphone and sends audio over the authenticated HULK connection; trusted HULK
forwards it to OpenAI. OpenAI's audio data policy applies. Recordings are bounded to two
minutes and 20 MiB. At the limit, FUSE stops capture and transcribes the completed recording.

Cancel, leaving the composer, switching projects/areas, app lock, a hidden browser tab,
window close and page navigation release capture resources. A native page/window lifecycle
handler also cancels capture if JavaScript cleanup cannot run. An abandoned native buffer
expires after stopping. Raw audio remains in transient memory, outside the app file store,
sync, export and backups. There is no offline audio queue.

Transcripts become ordinary saved history only after you explicitly send them. Transcription
receipts store duration, cost and redacted request metadata, without audio or transcript text.
Existing-thread receipts appear in that thread's total. Recording before creating a chat is
charged to the selected project (or global scope), without creating a conversation just for a
fee. Usage and budget totals include these charges even when a draft is discarded.

If microphone access fails, check OS/browser permission and the default input device. If a
transcription is interrupted or usage is missing, request history labels billing unresolved
and retains its conservative reservation. Check that entry before deliberately trying again.
Turning dictation off stops current capture and future transfers; it does not erase receipts.
Deleting all local data also clears local audio consent.

## Verification and owner acceptance

`pnpm dictation:bench` records deterministic capture, cancellation, consent, draft, policy,
format/size and accounting fixtures in `src-tauri/target/dictation-benchmark.json`. CI uploads
the report. Native Rust tests additionally cover one-attempt multipart dispatch, invalid or
missing usage, budgets, policy changes, cancellation and retained costs with in-memory test
credentials. The existing HULK and encrypted-sync benchmarks remain required.

`bash scripts/dictation-web.sh` runs the shared UI against a throwaway server and a separate
scripted build. Set `FUSE_WEB_BROWSER` to the test Chromium executable; optionally set
`FUSE_SERVER_BIN` to the built server. Screenshots/result metadata are under
`e2e/screenshots/dictation/`. Windows click-through also exercises the composer with synthetic
capture. Scripted code is excluded from the release bundle. These tests do not prove real
microphone operation or live OpenAI billing.

Owner acceptance remains pending until recorded against released desktop and HULK builds:
actual microphone capture/permission denial, push-to-talk and keyboard start/stop, cancellation
and lock/navigation, editable text preserving an existing draft, no automatic send, actual
reported costs after discarding text, and the existing quick-capture shortcut. Record the
build IDs, platform/browser, result and any skipped checks in the P2 acceptance record. No
provider-backed check runs unattended and no credential should be pasted into chat/workflows.

Local transcription, read-aloud and realtime voice remain outside P2's finish line.
