# Python artifacts (M17.3)

A Python code artifact has a **Run** button. It runs the version on screen, not necessarily
the latest.

1. **Approve.** The approval shows the version, the SHA-256 of its source and the limits: no
   network, up to 120 s, 512 MB memory, up to 50 output files (20 MB). Pick optional input
   files; they're stored locally and appear read-only as `inputs/<name>`. **Allow once**
   approves one attempt.
2. **Run.** The native side reads the version and the inputs from this device's database and
   file store, checks each against the approved hashes, and runs it in the same sandbox as
   skill scripts: private scratch, no network, no child processes, read-only inputs, writable
   only `$FUSE_OUT`. If the source changed after approval, it refuses.
3. **Output** appears under the code: printed output, images and other files from
   `$FUSE_OUT`. Every attempt keeps its version, attempt number, input hashes and results;
   pick earlier attempts from the list. **Stop** ends a running attempt.

It needs FUSE's Python runtime (Settings → Code & tools → Python for data work) and the OS
sandbox (bubblewrap on Linux, AppContainer on Windows). Without them, the Run button says
what's missing. In the browser, runs execute on HULK with HULK's runtime. Runs and their
outputs stay on the device that ran them; they don't sync.

Storage: [data-model.md](data-model.md#m173-python-artifact-runs-schema-75).
