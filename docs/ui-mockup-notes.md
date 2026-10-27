# M0 · UI mockup

> **Historical (step 7a).** Isaac approved this mockup on 2026-10-27. In step 8 the fake-data controller and fixtures were replaced by the real app (`src/app/ChatApp.tsx`); the presentational components now live in `src/ui/`. The preview-state footer, the `FUSE_VIEW=dark|picker` startup views and the fixture request log no longer exist. The request log returns in step 9.

Codex (GPT-6 Astra) built it from `docs/ui-brief.md`. Its notes follow.

## Design decisions

- A neutral, 248 px sidebar separates navigation from the conversation. It scrolls independently; collapse it with Ctrl+B to give small windows more room. It starts collapsed below 800 px.
- Conversation content caps at 716 px inside a wider reading column. Long code and tables scroll horizontally within the message. The layout supports 640×480 through 1600 px wide windows.
- Costs stay in muted monospaced text, both in navigation and under completed answers. Hover or focus the answer badge for fresh input, output, cache, reasoning, cost, and latency. Reasoning is already included in output in these fixtures.
- The composer stays visible, grows with text up to 30% of the viewport (leaving room for its controls), and uses Enter / Shift+Enter. Stop preserves the partial answer. There is no cost badge until usage exists.
- The searchable model picker groups providers, shows context and both prices, and supports arrows, Enter, Tab, and Escape. Model changes take effect on the next send, with a history divider.
- Existing shadcn buttons and inputs supply the controls. Installed Radix primitives supply focus management, dialogs, tooltips, menus, and the picker popover. Geist and existing CSS theme tokens are used throughout. No UI library files were edited and no dependencies were added.

## Integration boundary

`src/App.tsx` renders `src/mockup/Mockup.tsx`, the stateful demonstration controller. Sidebar, message view, composer, settings cards, and request log receive typed props and emit callbacks. Fixture data is in `src/mockup/fixtures.ts`; it is explicitly fake and does not use the real catalog.

The controller uses React state and a timer to simulate streaming. Nothing is persisted, no provider request runs, and no Tauri command is invoked by the mockup. Key fields are uncontrolled password inputs; only whether a field has content is tracked. Save/test simulates a successful result and discards the field contents. Do not enter real credentials into the preview.

In step 8, replace the controller with the existing chat/storage/key APIs. Reconnect the key form to `SettingsKeys` and pass its submitted value to the real key-saving callback. The earlier storage, provider, and key modules remain available. The request log here is a presentational preview, not the step 9 implementation.

The small Markdown renderer supports the fixture subset (headings, paragraphs, ordered/unordered lists, tables, emphasis, inline code, links, fenced code), escapes all HTML, and copies raw code without line numbers. A complete Markdown parser such as `react-markdown` would be appropriate in step 8; it was **not added** because this brief prohibits new dependencies. The illustrative highlighter uses neutral type weight rather than introducing syntax colors outside the theme.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| New chat | Ctrl+N |
| Toggle sidebar | Ctrl+B |
| Model picker | Ctrl+K |
| Settings | Ctrl+, |
| Send / newline | Enter / Shift+Enter |
| Stop response / close overlay | Escape |
| Retry an error | Ctrl+R |

The corresponding Command shortcuts also work on macOS. Rename, delete, copy, and appearance controls are reachable with Tab and Enter; destructive actions require a confirmation dialog.

## Screenshots

Captured from the actual Linux Tauri window with Xvfb using `scripts/screenshot.sh` and xdotool. All data shown is illustrative.

- [Main layout · light](screenshots/ui-mockup/main-light.png)
- [Main layout · dark](screenshots/ui-mockup/main-dark.png)
- [Model picker](screenshots/ui-mockup/model-picker.png)
- [Settings · API keys](screenshots/ui-mockup/settings.png)
- [Minimum window · 640×480](screenshots/ui-mockup/minimum.png)
- [Wide window · 1600 px](screenshots/ui-mockup/wide.png)

For a direct screenshot of a particular screen, `FUSE_VIEW=dark`, `FUSE_VIEW=picker`, or `FUSE_VIEW=settings` can be passed to `bash scripts/screenshot.sh /tmp/fuse.png`. These only choose a preview startup screen.

## Brief feedback

No scope changes are needed. The only integration decision left is approving a complete Markdown dependency for step 8. Visual approval of this mockup is still required before starting step 8.
