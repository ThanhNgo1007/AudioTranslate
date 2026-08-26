# AudioTranslate: Low-Latency Gemini Live Captions

Date: 2026-08-26

Status: Approved in chat; ready for implementation planning

## Objective

Make Gemini Live Translate the default lowest-latency path for Chrome and Edge tab audio while presenting translated text like film subtitles: one continuously updated caption block, at most two visual lines, no source transcript in the fastest mode, and no paid-provider fallback.

The warm-session target is a first readable translated partial at p50 <= 650 ms and p95 <= 1,000 ms on a healthy connection. This is an AudioTranslate benchmark target, not a Google SLA. Final-caption latency is measured separately and is not allowed to delay partial rendering.

## Scope

This change covers:

- Gemini Live Translate configuration and response handling.
- Provider readiness before Chrome tab capture begins.
- A two-line live-caption block state machine.
- Runtime latency and usage telemetry.
- Control Center settings and diagnostics for the fastest and bilingual modes.
- Unit and integration tests for the changed lifecycle.

This change does not add Google Cloud Speech-to-Text, automatically fall back to a paid API, expose the Gemini API key to the extension, or replace the Electron overlay with an in-page overlay.

## Current Baseline

The current Gemini adapter already uses the correct model and audio transport baseline:

- `gemini-3.5-live-translate-preview`.
- Raw PCM16, mono, 16 kHz.
- Five 20 ms local frames combined into one 100 ms Gemini message.
- A persistent Live API session, context-window compression, bounded audio buffering, partial output captions, and final-only debounce.

The remaining problems are:

- `inputAudioTranscription` is always enabled.
- `echoTargetLanguage` is always true.
- The cloud provider starts only after the tab has already been captured.
- The overlay replaces the active caption rather than maintaining a committed prefix plus one mutable partial suffix.
- Wrapping is based on a fixed 42-grapheme estimate instead of the actual overlay width and font.
- The displayed latency value is a live-edge estimate and there is no p50/p95 or usage-metadata aggregation.

## Selected Approach

Use the dedicated Live Translate model as a single continuous translation stream. Optimize the existing local bridge instead of introducing a paid ASR-to-MT cascade or moving the API key into the browser extension.

Data flow:

```text
User presses Start
  -> offscreen document opens authenticated local WebSocket
  -> local gateway starts Gemini Live Translate
  -> gateway sends provider-ready acknowledgement
  -> background obtains the one-time tab stream ID
  -> offscreen document attaches the tab MediaStream
  -> AudioWorklet emits PCM16
  -> 100 ms chunks stream to Gemini
  -> outputAudioTranscription partials update one live caption block
  -> overlay commits only authoritative final boundaries
```

No tab audio is captured before the provider is ready. Opening an authenticated Gemini session without audio is permitted only after the user presses Start and has already accepted cloud processing in Control Center.

## Gemini Profiles

### Fastest (default)

- `responseModalities: [AUDIO]`.
- Keep `outputAudioTranscription: {}`.
- Omit `inputAudioTranscription` entirely.
- Set `translationConfig.echoTargetLanguage` to false.
- Do not display the source transcript or detected-language code.
- Emit every changed output transcription partial immediately.
- Debounce only the final state transition.

If the input is already in the target language, the model may intentionally remain silent with `echoTargetLanguage: false`. Control Center must explain this behavior next to the setting.

### Bilingual

- Keep both input and output transcription enabled.
- Display the source transcript and detected-language code when Google returns them.
- Preserve the same partial and final rendering rules.

The provider receives an explicit `enableInputTranscription` option. It must not infer this only from a renderer state. The gateway derives the option from the saved caption profile so file and tab sources behave consistently.

## Session and Capture Lifecycle

The extension lifecycle is split into two authenticated phases:

1. `capture:prepare`
   - Create the offscreen document.
   - Open the local WebSocket and complete HMAC pairing.
   - Start the configured provider.
   - Resolve only after the gateway sends `started`.
   - Do not request or consume a Chrome tab stream ID.

2. `capture:attach`
   - Request the tab stream ID only after prepare succeeds.
   - Consume the stream ID immediately with `getUserMedia`.
   - Create the interactive AudioContext and AudioWorklet.
   - Begin streaming audio on the already-ready provider connection.

Preparation and attachment have independent timeouts and cleanup. Any failure closes the socket, stops the provider session, clears bounded preroll memory, and returns the extension to a non-capturing state.

The existing one-step `capture:start` message remains temporarily as a compatibility wrapper around prepare plus attach. It is removed only after extension lifecycle tests and the installed extension version have migrated.

The application never reconnects per sentence. Planned Live API connection rotation continues to use `GoAway`; fresh-session rotation remains the privacy default. Session resumption remains an explicit opt-in because its handle can restore prior session state.

## Finalization Rules

Partial output is never delayed by an application timer.

The adapter keeps one mutable provider turn:

- Output transcription text changes emit an `isFinal: false` caption immediately.
- `outputTranscription.finished`, `generationComplete`, and `turnComplete` are authoritative boundary evidence.
- If output is marked finished and the full server boundary is already present, finalize immediately after the event loop drains.
- If boundary fields can arrive out of order, use a short 120 ms grace window and extend it only when new text arrives.
- When bilingual mode is enabled, allow the same grace window for a late input transcript.
- A final event never suppresses or delays the partial already on screen.

The 120 ms value is a starting benchmark value. It may be adjusted from measured late-fragment frequency, but cannot exceed 250 ms in the fastest profile without an explicit regression decision.

## Two-Line Caption Block State Machine

The overlay maintains these independent values:

- `committedPrefix`: finalized text retained in the current visual block.
- `mutableSuffix`: the latest partial for the active provider turn.
- `lastFinalAt`: timestamp of the most recent committed boundary.
- `blockGeneration`: increments when the visual block rolls over or resets.
- `sessionId` and `lastSequence`: reject stale events.

### Partial event

- Replace only `mutableSuffix`.
- Render `committedPrefix + separator + mutableSuffix`.
- Never append multiple copies of cumulative partial hypotheses.
- Do not clear the block or start a new line merely because a partial changed.

### Final event

- Replace the mutable suffix with the authoritative final text.
- Commit it once, using sequence and normalized text to reject duplicates.
- Clear `mutableSuffix`.
- Mark the block eligible for a silence-gap reset, but do not hide it immediately.

### Next utterance

- If it starts within 1,100 ms of the previous final and text still fits, append it to the current block.
- If it starts after 1,100 ms, start a fresh block before rendering the new partial.
- If app pause, stop, source change, provider change, or session change occurs, clear immediately.

### Overflow

- The overlay may display at most two measured lines.
- When adding text would create a third line, freeze the largest word-safe prefix that fits two lines and move only the overflow into a new block generation.
- The active partial continues updating in the new block.
- Never use CSS clipping or ellipsis for translated speech.
- CJK and other languages without spaces fall back to grapheme-safe boundaries.

The previous block is not replayed or paged on a timer. Viewers read it as it grows; rollover occurs only when the two-line capacity is exhausted or the silence rule starts a new block.

## Pixel-Aware Line Fitting

The renderer supplies the caption compositor with:

- Current content width in CSS pixels.
- Computed font family, size, weight, letter spacing, and line height.
- A `measureText` implementation backed by an offscreen canvas.

The pure compositor accepts a deterministic measurement callback for tests. It uses `Intl.Segmenter` with word granularity where available and grapheme segmentation as a fallback. It greedily fills the first and second line, preferring sentence punctuation, clause punctuation, then word boundaries.

If browser measurement is temporarily unavailable, the fallback estimate is 52 graphemes per line rather than the current 42. A resize, font change, or display change recomposes the active block without changing its semantic committed/mutable state.

## Context Management

Keep `contextWindowCompression` enabled. The first implementation retains Google SDK defaults for compatibility with the preview translation model. Runtime telemetry records usage metadata so an explicit smaller trigger/target window can be A/B tested later.

An aggressive compression threshold is not hardcoded in this change because compression itself causes a temporary latency spike. Any later tuning must compare first-partial p50/p95, compression-spike p95, and translation revision rate on a full-length film workload.

## Runtime Metrics

Collect bounded, non-audio telemetry only:

- `providerPrepareMs`: Start press to provider-ready acknowledgement.
- `localQueueMs`: capture timestamp to gateway receipt.
- `liveEdgeToPartialMs`: newest captured audio edge to first changed output partial.
- `partialToFinalMs`: first partial for a turn to authoritative final.
- `resultToRafMs`: provider caption event to first browser animation frame.
- `firstReadableMs`: prepared capture start to first non-empty translated partial.
- Latest Live API `usageMetadata` token counts.

Maintain a rolling maximum of 120 samples per latency family and expose count, p50, and p95 in Control Center. Never persist raw audio or transcripts as part of diagnostics. Treat usage metadata as cumulative only while it is monotonic within the same provider session; reset the baseline on session replacement.

The existing `latencyMs` label is renamed internally to `liveEdgeToPartialMs` so it is not mistaken for total speech-onset latency.

## Free-Tier and Error Behavior

- Google AI Studio Free Tier remains the preferred provider path.
- No billing account or Google Cloud Speech-to-Text resource is required.
- A `429 RESOURCE_EXHAUSTED` response becomes a clear Free Tier quota message.
- Audio capture stops safely after a terminal quota error.
- AudioTranslate never switches to Azure, Google Cloud, OpenAI, or another paid provider without an explicit user action.
- Control Center states that Free Tier inputs may be used by Google to improve products, following the current Gemini pricing terms.

## Security

- The Gemini API key remains in the Electron main process and encrypted secret store.
- The extension connects only to the authenticated loopback gateway.
- No direct extension-to-Gemini path is added in this iteration.
- Audio begins only after user action, cloud consent, pairing authentication, and provider readiness.
- All audio buffers remain bounded and are wiped on pause, stop, terminal error, or failed preparation.
- Metrics contain timestamps, counts, and token totals only.

## Rejected Alternatives

### Direct extension-to-Gemini with an ephemeral token

This could remove one loopback hop but would save only a small amount relative to model inference while expanding browser-side credential, reconnection, and caption-routing complexity. It remains a later benchmark candidate, not the first implementation.

### Cloud STT followed by text translation

This adds a paid service and a second inference/network stage. It remains an accuracy-oriented optional provider, not the lowest-latency Free Tier path.

### Gemini Flash-Lite audio requests

Flash-Lite is not a bidirectional Live API model. Repeated overlapping audio requests would add request setup, stitching, and duplicate-work latency.

## Test Strategy

Unit tests must cover:

- Fastest mode omits `inputAudioTranscription` and always keeps `outputAudioTranscription`.
- Bilingual mode enables both transcriptions.
- `echoTargetLanguage` defaults false and remains configurable.
- Output partials emit synchronously without final debounce.
- Ordered and out-of-order boundary events produce exactly one final.
- A late fragment extends only the bounded final grace window.
- Caption partials replace the mutable suffix rather than duplicating it.
- Two visual lines fill before rollover.
- Rollover preserves complete words or graphemes and never clips text.
- A short inter-utterance gap appends; a gap over 1,100 ms starts a new block.
- Pause, stop, and session change clear all live-caption state.
- Prepare completes before `getMediaStreamId` and `getUserMedia`.
- Prepare and attach failures wipe buffers and stop the provider.
- Usage metadata is bounded and does not expose transcripts or secrets.
- p50 and p95 calculations are deterministic.

Integration tests must cover the authenticated extension-to-gateway prepare/attach sequence and a mocked Gemini session producing partial, final, `GoAway`, quota error, and usage events.

## Acceptance Criteria

- No app-side debounce precedes the first translated partial.
- The fastest profile sends no input-transcription request.
- The overlay displays only translated text and never more than two visual lines.
- A growing utterance updates in place without flashing or creating duplicate sentences.
- Closely spaced utterances share the available two-line block.
- Capacity overflow or a gap greater than 1,100 ms starts a clean block.
- Gemini is ready before tab capture begins.
- Free Tier exhaustion stops safely and never activates a paid provider.
- Control Center reports sample counts and p50/p95 for the defined latency stages.
- Existing security, provider, extension, overlay, and lifecycle tests continue to pass.

