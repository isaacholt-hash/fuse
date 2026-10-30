# Provider API notes

What the adapters (M0 steps 6–7) and the catalog (step 5) are built from. **Every fact was checked against the official docs on 2026-10-26**, and each section lists its sources. Re-verify before changing an adapter, because providers change monthly. Where the docs and the live API disagree, the live behaviour wins and is noted here.

Docs tip: both providers serve Markdown copies of their docs pages (`<page-url>.md` on platform.claude.com/docs and developers.openai.com). They're easier to read and diff than the HTML.

## Decisions for M0

| Topic | Anthropic | OpenAI |
| --- | --- | --- |
| Endpoint | `POST https://api.anthropic.com/v1/messages` | `POST https://api.openai.com/v1/responses` (Responses API; see why below) |
| Auth | `Authorization: Bearer <key>`, added by the Rust transport, never by adapter code | same |
| Version header | `anthropic-version: 2026-10-21` | — |
| Always send | `stream: true`, `max_tokens` | `stream: true`, **`store: false`**, `service_tier: "default"` |
| Never send | `temperature`, `top_p`, `top_k` (400 on every model under `2026-10-21`) | `temperature` / `top_p` (rejected on GPT-6 models unless effort is `none`) |
| Reasoning | Omit `thinking` and `output_config.effort` (model defaults). Thinking is on by default on 5.x models, hidden, and billed as output. | Omit `reasoning` (model default effort). |
| History | Full history every turn as plain text. Must **end with a user message** (no prefill on 4.6+). | Full history every turn as `input` messages with plain-text content. |
| Caching | None in M0 (no `cache_control`, so nothing is cached). | **Automatic and can't be turned off**: implicit caching writes are billed at 1.25× input, so cost must count them. |
| Request id header | `request-id` | `x-request-id` |
| Key test (step 4) | `GET /v1/models` (free) | `GET /v1/models` (free) |

**Why the OpenAI Responses API over Chat Completions:** OpenAI says "While Chat Completions remains supported, Responses is recommended for all new projects". Tool calling on `gpt-6-astra` and `gpt-6.1-sol` works only through Responses, and we need tools in P1 for native web search. Encrypted reasoning items (keeping reasoning across turns without server state) exist only in Responses, and OpenAI reports better cache use. `store: false` keeps nothing on OpenAI's side, which fits local-first. Sources: [migrate-to-responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [latest-model](https://developers.openai.com/api/docs/guides/latest-model), [conversation-state](https://developers.openai.com/api/docs/guides/conversation-state).

**Deferred to M1:** replaying OpenAI encrypted reasoning items and Anthropic thinking blocks across turns (better reasoning continuity when a thread stays on one provider). M0 sends plain text, which is what a mid-thread model switch needs anyway.

## Normalised usage (what `cost()` expects)

Adapters convert provider usage into `Usage` (`src/storage/usage.ts`). Billing categories never overlap:

| `Usage` field | Anthropic (`message_delta.usage`, last value wins) | OpenAI (`response.completed` → `response.usage`) |
| --- | --- | --- |
| `inputTokens` (base input rate) | `input_tokens` (already excludes cache) | `input_tokens − input_tokens_details.cached_tokens − input_tokens_details.cache_write_tokens` |
| `cachedInputTokens` (cache-read rate) | `cache_read_input_tokens` | `input_tokens_details.cached_tokens` |
| `cacheWriteTokens` (cache-write rate) | `cache_creation_input_tokens` (5-minute writes; we don't use 1 h) | `input_tokens_details.cache_write_tokens` (30-minute default) |
| `outputTokens` (output rate) | `output_tokens` (includes thinking) | `output_tokens` (includes reasoning) |
| `reasoningTokens` (informational) | `output_tokens_details.thinking_tokens` | `output_tokens_details.reasoning_tokens` |

**Long-context price cliffs** (the whole request is repriced; modelled as `long_context_price` in `data/models.json`):
- Claude Haiku 5.5: prompt > 100,000 tokens means 5× every category, and cache reads and writes count toward the threshold.
- GPT-6 / GPT-5.6 models: input > 272K tokens means 2× input and cache rates and 1.5× output.

Sources: [Anthropic messages/create](https://platform.claude.com/docs/en/api/messages/create), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting), [OpenAI gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Anthropic: streaming

Sources: [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [messages/create](https://platform.claude.com/docs/en/api/messages/create).

Events in order:
1. `message_start` (`message.usage` may hold initial counts)
2. For each block:
   - `content_block_start` (types include `text`, `thinking`, `redacted_thinking`, `tool_use`, `server_tool_use`)
   - `content_block_delta`, with `delta.type` one of:
     - `text_delta` → `delta.text`
     - `thinking_delta`
     - `signature_delta`
     - `input_json_delta`
   - `content_block_stop`
3. `message_delta`: `delta.stop_reason`, plus `usage` (**cumulative**, so take the last value per field)
4. `message_stop`

`ping` can appear anywhere. An `event: error` with `{type:"error", error:{type, message}}` can arrive **after HTTP 200**. Unknown event types must be ignored. Usage may be missing from the stream entirely (one official example has none), so treat it as optional and flag the message if no usage arrived.

Stop reasons:
- `end_turn`
- `max_tokens`
- `stop_sequence`
- `tool_use`
- `pause_turn`
- `refusal`
- `model_context_window_exceeded`

## OpenAI: streaming (Responses)

Sources: [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

Plain answer:
1. `response.created`
2. `response.in_progress`
3. Output items (reasoning, then message): `response.output_item.added`, then `response.content_part.added`
4. `response.output_text.delta` many times (text in `delta`)
5. `response.output_text.done`
6. `response.content_part.done`
7. `response.output_item.done`
8. `response.completed` (**final usage** at `response.usage`)

Every event has a `type` and `sequence_number`. Key off the JSON `type`, not the SSE `event:` line.

Terminal alternatives:
- `response.incomplete` (`response.incomplete_details.reason`: `max_output_tokens` / `content_filter` / …). Read usage from it too.
- `response.failed` (`response.error`)
- `error` event (`code`, `message`, `param`)

**Confirmed from recorded fixtures (2026-10-26):** each event has an `event:` line matching its JSON `type`, and there's no `[DONE]` sentinel: the stream simply ends after `response.completed`. HTTP errors are `{error:{message, type, param, code}}` as documented (`invalid_api_key`, `model_not_found`).

**A reasoning model can run out of `max_output_tokens` while still reasoning:** you get `response.incomplete` (`max_output_tokens`), **no text at all**, and the reasoning tokens are still billed. The chat UI must show this as a cut-off answer rather than an empty one.

## Errors and retries (both providers)

Sources: [Anthropic errors](https://platform.claude.com/docs/en/api/errors), [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits), [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes), [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits).

**Retry** (max 3 attempts, and **only before any text has streamed to the UI**):
- network errors
- 429 rate limits
- 500, 503 (OpenAI `server_is_overloaded`), 504
- 529 (Anthropic `overloaded_error`)

Wait at least `retry-after` seconds when present, otherwise use exponential backoff (1 s, 2 s, 4 s) plus jitter.

**Never retry**, and show a clear message instead:
- 400, 401, 403, 404, 413
- Anthropic 402 `billing_error`
- Anthropic 429 with `error.details.error_code: "enforced_spend_limit_reached"` (no `retry-after`)
- Anthropic 400 for a user-set spend limit
- OpenAI 429 with `error.code` in `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` or `organization_usage_limit_exceeded`, or with `error.type` = `insufficient_quota`
- Anthropic 400 "data retention" on Fable 5.x / Mythos 5.x

**Mid-stream errors** (after HTTP 200) end the message as `error`. The partial text is kept, and the UI offers Retry.

Error bodies:
- Anthropic: `{type:"error", error:{type, message}, request_id}`
- OpenAI: `{error:{message, type, param, code}}`

## Gotchas found on 2026-10-26

1. **Anthropic docs disagree with themselves.** Many feature pages still show `anthropic-version: 2023-06-01` + `x-api-key`. The API reference uses `2026-10-21` + `Authorization: Bearer`. A live probe confirmed both auth headers are read as the key.
2. **`anthropic-workspace-id`** is required for an Anthropic key that isn't scoped to a workspace. Create workspace-scoped keys. If a key test passes but chat 400s, check this first.
3. **Anthropic Fable 5.x / Mythos 5.x require 30-day data retention** on the org; without it they return 400. They aren't in the M0 catalog.
4. **Forced tool use** (`tool_choice` any/tool) is rejected on Opus 5.5, Sonnet 5.5 and Fable 5.1. This matters for M1 routing and classification, which should use structured outputs instead.
5. **OpenAI `store` defaults to `true`** (30-day retention). Always send `false`.
6. **OpenAI cache writes are billed** on GPT-5.6+ (1.25×), even though caching is automatic.
7. **Cache-read discounts differ per model** (Anthropic 0.1× / 0.05× / 0.025×; OpenAI 0.1× / 0.05×), so the catalog stores per-model cache prices, not multipliers.
8. **Deprecations ahead:**
   - `claude-sonnet-4-5-20250929` retires 2026-11-30
   - `gpt-5`, `o3` and related snapshots on 2026-12-11
   - `gpt-4o` and `gpt-4.1` snapshots on 2027-01-14

## Data handling

- **Anthropic:** prompts and outputs aren't retained by default, except Fable 5.x and Mythos 5.x (30 days). Never used for training without permission. [api-and-data-retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- **OpenAI:** API data isn't used for training. Abuse-monitoring logs are kept up to 30 days. `store: false` means no application state is kept. [your-data](https://developers.openai.com/api/docs/guides/your-data)

## M1: images, documents, web search, instructions (verified 2026-10-27)

Checked against the live docs on 2026-10-27 (Markdown copies of each page). Where a fact couldn't be confirmed it says so. Decisions for FUSE are in bold.

### Decisions

| Topic | Anthropic | OpenAI | FUSE |
| --- | --- | --- | --- |
| Image block | `{type:"image", source:{type:"base64", media_type, data}}` | `{type:"input_image", image_url:"data:image/…;base64,…", detail}` | **Inline base64 for both; no Files API** (keeps files local, avoids provider-side storage that isn't ZDR-eligible on Anthropic) |
| Image formats | JPEG, PNG, GIF (first frame), WebP | PNG, JPEG, WebP, non-animated GIF | Accept those four |
| Image limits | ≤10 MB base64 each, ≤8000 px; **over 20 images in a request, each ≤2000 px**; ≤600 per request (1M-context models); whole request ≤32 MB | ≤512 MB payload, ≤1,500 images, ≤30,000 patches each (rejected, not resized) | **Resize locally to a long edge of ≤2000 px before storing**: satisfies both, and history resends every image each turn |
| Image tokens | `⌈w/28⌉ × ⌈h/28⌉`, 5.x models cap at long edge 2,576 px / 4,784 tokens | 32×32 patches × multiplier (1.2 on gpt-6-astra); `high` ≤2,500 patches | Estimate with these formulas before sending; the bill comes from `usage` |
| PDF | `{type:"document", source:{type:"base64", media_type:"application/pdf", data}}`; ≤600 pages, 32 MB request; billed as page text (≈1.5–3k tokens/page) **plus** each page as an image | `{type:"input_file", filename, file_data:"data:application/pdf;base64,…"}`; ≤50 MB per request; text + page images; `detail:"auto"` means `high` on GPT-5.6+ | **Native PDF on both** |
| Other documents | Plain text via `{type:"document", source:{type:"text", media_type:"text/plain", data}}`; **DOCX/XLSX not accepted** | DOCX, PPTX, XLSX, CSV, code accepted natively (text only; spreadsheets first 1,000 rows) | **Extract text locally for everything except PDF**, so the same history works on either provider after a model switch |
| Web search tool | `{type:"web_search_20250305", name:"web_search", max_uses, user_location}` (basic version: ZDR-eligible, no code execution) | `{type:"web_search", search_context_size, user_location:{type:"approximate"}}` (`web_search_preview` is legacy) | **Per-message toggle; basic Anthropic version; send an approximate location on OpenAI or it defaults to the US** |
| Search price | $10 / 1,000 searches + tokens; failed searches not billed; `usage.server_tool_use.web_search_requests` | $10 / 1,000 calls + search content tokens; **no usage counter**: count `web_search_call` items with `action.type == "search"` | In `data/models.json` → `tool_prices`; added to the answer's cost |
| System prompt | top-level `system` (string or text blocks) | `instructions`, sent on every request (not carried between turns) | One effective instruction string per request, built by FUSE |

### Streaming shapes to handle

- **Anthropic search:** `content_block_start` with `server_tool_use` (query arrives as `input_json_delta`), a pause while it searches, then `content_block_start` with a complete `web_search_tool_result` block (results: `url`, `title`, `page_age`, `encrypted_content`). Text blocks then carry citations as `content_block_delta` with `delta.type:"citations_delta"` (`web_search_result_location`: `url`, `title`, `cited_text` ≤150 chars).
  - Search errors arrive inside a **200** response as `web_search_tool_result_error`, with codes `too_many_requests`, `max_uses_exceeded`, `query_too_long`, `unavailable`, and others. No results gives an empty list.
  - `stop_reason:"pause_turn"` means send the paused turn back unchanged to continue.
- **OpenAI search:**
  - `response.web_search_call.in_progress` → `.searching` → `.completed`, then text with `response.output_text.annotation.added` (`url_citation`: `url`, `title`, `start_index`, `end_index`).
  - The full source list needs `include: ["web_search_call.action.sources"]`.
  - Search context is capped at 128k tokens.
- **Both providers require citations to be shown to the user** (OpenAI: "clearly visible and clickable").

### Gotchas

1. **History is plain text (M0 decision), so search blocks aren't replayed.** Anthropic needs `encrypted_content` and `encrypted_index` echoed byte for byte if they are, and `2026-10-21` rejects a `text` block with citations in a **user** message and a `document` block in an **assistant** message. FUSE stores citations for display and sends only the answer text back.
2. **Attachments are resent every turn** (stateless on both). Images and PDFs in a long thread add up fast against Anthropic's 32 MB request cap and in cost, so the composer must show it.
3. **Unverified:** the image multiplier and `detail` behaviour for gpt-6.1-sol and gpt-6-luna (the docs list only gpt-6-astra and gpt-5.6). Also which Claude 5.5 models support web search: no page lists them. The web search docs' own examples use `claude-opus-5-5` with `web_search_20250305`, and dynamic filtering is documented for "Claude 4.6 and later", so all three 5.5 models are marked `web_search` in `data/models.json` (2026-10-27). If one ever refuses, the user sees the provider's 400 message. The authoritative per-model flag is `capabilities.server_tools.web_search.supported` from `GET /v1/models`. No per-PDF size limit is published beyond Anthropic's 32 MB request cap.
4. **Anthropic's newer search versions** (`_20260209`+) run through code execution by default and aren't ZDR-eligible unless `allowed_callers:["direct"]`. FUSE uses the basic version.
5. **OpenAI data handling:** image and file inputs are scanned, and flagged items can be retained for review even under ZDR. Inline `file_data` leaves no stored file object (Files API uploads persist until deleted).

Sources:
- Anthropic: [vision](https://platform.claude.com/docs/en/build-with-claude/vision), [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [files](https://platform.claude.com/docs/en/build-with-claude/files), [citations](https://platform.claude.com/docs/en/build-with-claude/citations), [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool), [migration 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21), [data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- OpenAI: [images & vision](https://developers.openai.com/api/docs/guides/images-vision), [file inputs](https://developers.openai.com/api/docs/guides/file-inputs), [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [pricing](https://developers.openai.com/api/docs/pricing), [text / instructions](https://developers.openai.com/api/docs/guides/text), [your data](https://developers.openai.com/api/docs/guides/your-data)

## M2: caching, reasoning effort, embeddings, errors (verified 2026-10-28)

Checked against the Markdown copies of the live docs on 2026-10-28. Decisions for FUSE are in bold.

### Prompt caching (RT-07, step 8)

| Topic | Anthropic | OpenAI |
| --- | --- | --- |
| Turn on | Top-level `cache_control: {type:"ephemeral"}` (**automatic caching**: the breakpoint sits on the last cacheable block and moves forward as the thread grows), or up to 4 explicit `cache_control` breakpoints on blocks. Automatic uses one of the 4 slots. | On by default and can't be turned off. GPT-5.6+ can also take explicit `prompt_cache_breakpoint`s. |
| Minimum | 512 tokens on Opus 5.5, Sonnet 5.5 and Haiku 5.5. Shorter prompts aren't cached (no error). | 1,024 tokens on GPT-5.6+ |
| Lifetime | 5 min by default, refreshed free on every hit (streaming time counts); `ttl:"1h"` optional | 30 min by default (`prompt_cache_options.ttl`), `"12h"` optional |
| Write price | 1.25× input (5 min), 2× (1 h) | 1.25× input (30 min), 2.5× (12 h). A write replaces the input charge rather than adding to it. |
| Read price | 0.05× on Opus 5.5 and Sonnet 5.5; 0.1× on Haiku 5.5 | 0.1×; 0.05× on GPT-6.1 Sol |
| Prefix order | `tools` → `system` → `messages`; a change invalidates that level and everything after | Whole rendered prefix up to a breakpoint must match |
| What breaks it | Web search toggle (system + messages); adding or removing images (messages); thinking or **top-level effort changes** (messages) | Any change before the breakpoint |
| `prompt_cache_key` | — | Optional on GPT-5.6+ (accounting per user); not needed for one user |

**FUSE:**
- **Anthropic gets top-level automatic caching.** One field, no breakpoint bookkeeping.
- **The system prompt carries only stable parts,** in this order: global instructions, project instructions, memory block. Anything that changes per message goes after the history.
- **OpenAI needs no change,** since its caching is already automatic and its costs are already counted (M0).
- **Built in M2 step 8:** every Anthropic request sends the top-level `cache_control`. The thread header shows the share of input read from cache.
- **Known limit:** when there are more memories than fit the budget, the memory block changes with the question, so that turn's history isn't reused from cache.
- **Cache hit rate** = `cachedInputTokens / all input tokens`, read from the usage we already store.

### Reasoning effort (RT-08, step 9)

| Topic | Anthropic | OpenAI |
| --- | --- | --- |
| Parameter | `output_config.effort` | `reasoning.effort` |
| Values | `low`, `medium`, `high`, `xhigh`, `max` (all five on Opus 5.5, Sonnet 5.5, Haiku 5.5) | `low`, `medium`, `high`, `xhigh`, `max` on gpt-6-astra and gpt-6.1-sol; gpt-6-luna also has `none` |
| Default | `medium` on Opus 5.5 and Haiku 5.5, `high` on Sonnet 5.5; sending the default = omitting it | `medium` on gpt-6.1-sol and gpt-6-luna; not stated for gpt-6-astra |
| Thinking | Adaptive thinking is always on with Opus 5.5 (`thinking:{type:"disabled"}` → 400). Sonnet 5.5 rejects `disabled` (use `between_tools`). **Never send `thinking`.** | Reasoning tokens are hidden and billed as output (`output_tokens_details.reasoning_tokens`) |
| Cache effect | A top-level effort change invalidates the cached messages. Per-message effort keeps the cache but is beta (`mid-conversation-output-config-2026-07-01`). | — |

**FUSE:**
- **Effort comes from complexity:** high → `high`. Everything else is omitted and keeps the model's default. Built in M2 step 9.
  - **Why easy questions aren't lowered:** on Anthropic a top-level effort change rewrites the thread's cache, and easy and medium questions alternate constantly. Hard questions mostly go to Best, a different model with its own cache anyway.
- **"Think harder" sends `max`** on both providers.
- **No beta header for per-message effort yet.** A changed effort costs one cache rewrite, which is acceptable.
- **`max_tokens` is the hard cap on thinking plus text,** so at `max` effort send the model's full `max_output`.

### Embeddings (MM-11, step 13)

- **Anthropic has no embeddings API.** It points to Voyage AI, which needs a separate MongoDB Atlas key.
- **OpenAI:** `POST /v1/embeddings` with `{model, input: string | string[], dimensions?, encoding_format:"float"}`. The response is `data[].embedding` and `usage.prompt_tokens`.
  - `text-embedding-3-small`: 1536 dimensions, $0.02 / 1M tokens.
  - `text-embedding-3-large`: 3072 dimensions, $0.13 / 1M tokens.
  - Both take at most 8,192 input tokens.
- **FUSE:**
  - **Default to `text-embedding-3-small` with the OpenAI key** (now in `data/models.json` → `embedding_models`). Indexing a 300-page book (~150k tokens) costs about $0.003.
  - **Step 13 decides local versus provider.** With no OpenAI key, retrieval is unavailable and FUSE says so.

### Errors and overload (MM-06, step 6)

Unchanged from M0 (see "Errors and retries"), with these additions from the 2026-10-28 docs:

- **Anthropic error types:**
  - 409 `conflict_error`
  - 504 `timeout_error`: use streaming for long requests
  - 529 `overloaded_error`: can hit all users at once
  - 429 also covers sudden traffic spikes ("acceleration limits")
  - A tier spend-cap 429 has **no `retry-after`** and keeps failing
- **The SDKs retry twice by default and honour `retry-after`.** That matches our 3 attempts.
- **Failover (FUSE):** once retries are used up on 429 (except spend-cap or quota errors), 500, 503, 504, 529 or a network or timeout error, and before any text has streamed, the answer moves to the cheapest model of the same tier on the other provider. Never fail over on 400, 401, 402, 403, 404, 413 or spend limits: those need the user.

Sources:
- Anthropic: [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings), [errors](https://platform.claude.com/docs/en/api/errors)
- OpenAI: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [embeddings](https://developers.openai.com/api/docs/guides/embeddings), [pricing](https://developers.openai.com/api/docs/pricing), model pages for [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

## M6: tool calling for the coding agent (verified 2026-10-30)

Checked against the live docs on 2026-10-30. Decisions for FUSE are in bold. Where a page didn't say, it's marked unverified.

### Request and response shapes

| Topic | Anthropic (Messages) | OpenAI (Responses) |
| --- | --- | --- |
| Tool definition | `{name, description, input_schema, strict?}`; name matches `^[a-zA-Z0-9_-]{1,128}$` | `{type:"function", name, description, parameters, strict}`; name rules not on the page (unverified) |
| Strict schemas | `strict:true` constrains sampling, so `input` always matches; a JSON Schema subset; optional fields allowed | `strict:true` needs `additionalProperties:false` and every property in `required` (optional = `["type","null"]`); a bad schema is a 400. Omitting `strict` tries strict and silently falls back |
| `tool_choice` | `auto` (default), `any`, `tool`, `none`. **Opus 5.5 and Sonnet 5.5 reject `any` and `tool` (400)**; Haiku 5.5 accepts them but then skips thinking | `auto` (default), `required`, `none`, `{type:"function", name}`, `{type:"allowed_tools", …}`. No model restriction documented |
| Parallel calls | On by default; off with `tool_choice:{type:"auto", disable_parallel_tool_use:true}` | On by default; off with `parallel_tool_calls:false` |
| Model wants tools | `stop_reason:"tool_use"`; done is `"end_turn"` | No stop reason: `output` has `function_call` items; done when it has none. Check `status` and `incomplete_details.reason` |
| Sending results | Next `user` message: one `{type:"tool_result", tool_use_id, content, is_error?}` per call, **all in one message, before any text**. Content can be text, images or documents | Append `{type:"function_call_output", call_id, output}` to `input`; `output` is a string or an array of image/file parts. **No error flag**: the error goes in the text |
| Every call answered | Yes, required | Not stated on the page (unverified); FUSE answers every call anyway |

### Streaming

- **Anthropic:** `content_block_start` with `{type:"tool_use", id, name, input:{}}`, then `content_block_delta` with `input_json_delta.partial_json` (the first can be `""`), then `content_block_stop`. Join the fragments and parse there. Then `message_delta` carries `stop_reason`. Thinking blocks end with a `signature_delta` before their `content_block_stop`. A dropped stream can't resume a partial `tool_use` or thinking block.
- **OpenAI:** `response.output_item.added` with `{type:"function_call", id:"fc_…", call_id:"call_…", name, arguments:""}`, then `response.function_call_arguments.delta` (`item_id`, `output_index`, `delta`), then `.done` with the full `arguments` string, then `response.output_item.done` with the whole item. Accumulate by `output_index`. **Take reasoning items from `output_item.done`**: `encrypted_content` can be incomplete in `added`.

### Replaying a tool loop

This is the main change from M0, where history is plain text.

- **Anthropic:** echo the assistant `content` unchanged, `thinking` and `redacted_thinking` blocks included, in order and with their signatures. On 5.1+ models the signature is checked against everything before it, so the history must stay append-only. Don't change thinking or effort settings inside one tool loop. Sonnet 5.5 and Haiku 5.5 thinking blocks only work in the account that made them. If the model changes, the API drops blocks the new model can't read, silently and unbilled.
- **OpenAI:** with `store:false`, replay every `reasoning`, `function_call` and `function_call_output` item since the last user message, untouched. Reasoning items carry `encrypted_content` by default; `include:["reasoning.encrypted_content"]` is legacy. Round-trip the assistant `phase` (`commentary` / `final_answer`), or a preamble can be taken as the final answer. `reasoning.context:"all_turns"` is supported on gpt-6.1-sol; unverified for gpt-6-astra and gpt-6-luna.

### Cost and caching

- Tool definitions, calls and results are billed as input tokens on both.
- **Anthropic adds a fixed tool system prompt: 286 tokens with `auto` or `none`, 406 with `any` or `tool`,** on all three 5.5 models.
- OpenAI publishes no fixed overhead (unverified).
- Tools sit at the front of the cached prefix on both: tools → system → messages (Anthropic); system → tools → developer → history (OpenAI). Changing a tool's name, description, schema or order invalidates everything after it.
- Changing `tool_choice` or the parallel setting invalidates Anthropic's messages cache; on OpenAI, `parallel_tool_calls` is part of the prefix.

### Decisions for FUSE

- **One tool schema for both providers, written to OpenAI's stricter rules** (every field required, optional ones nullable, `additionalProperties:false`), sent with `strict:true` on both.
- **`tool_choice` is always `auto`.** Forcing a tool is rejected on Opus and Sonnet 5.5, and the agent doesn't need it.
- **Parallel calls stay on.** Anthropic results all go in one user message, in call order.
- **The tool list is fixed for a whole run, in a fixed order,** so the cache prefix holds. Permission modes change what a call is allowed to do, not which tools are sent.
- **A tool loop stays on one model.** Thinking and reasoning items can't move between providers, and on Anthropic not even between models safely. Routing inside a run (step 11) changes model only between loops: the plan and summaries are separate requests with plain-text handoffs.
- **The adapters keep each turn's native items as an opaque, provider-tagged record** and replay it unchanged inside the loop. The chat history stays plain text as before.
- **Tool errors:** Anthropic gets `is_error:true`; OpenAI gets the same text, starting `Error:`.
- **Recorded 2026-10-30:** neither reasoning model (Sonnet 5.5, gpt-6.1-sol) thought before its tool call, so replay of thinking signatures and reasoning items is tested on the final answers of the error scenario instead. Anthropic's `tool_use` blocks carry `caller: {type: "direct"}`, replayed as is.
- **Fixtures for step 2,** recorded with the same allowlist and key check as M0: a single call, the follow-up with its result, two calls in parallel, an error result, and a call on a reasoning model (Sonnet 5.5, gpt-6.1-sol) so thinking and reasoning replay is covered.

Sources:
- Anthropic: [define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [overview and pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- OpenAI: [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
