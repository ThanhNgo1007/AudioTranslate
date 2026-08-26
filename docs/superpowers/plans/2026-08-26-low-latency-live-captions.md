# Low-Latency Gemini Live Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini Live Translate start before Chrome/Edge tab capture, stream translated partials immediately, and render them as one stable two-line film-style subtitle block while exposing privacy-safe p50/p95 and usage diagnostics.

**Architecture:** Keep the existing Electron main-process gateway as the only holder of the Gemini key. Split browser capture into prepare and attach phases, add explicit Gemini Fastest/Bilingual profiles, feed caption events into a deterministic committed-prefix/mutable-suffix state machine, and aggregate bounded runtime measurements without storing audio or transcript text.

**Tech Stack:** Node.js 22+, Electron 43, Chrome/Edge Manifest V3, `@google/genai`, WebSocket, React 19, TypeScript, Vite, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-low-latency-live-captions-design.md`

## Global constraints

- The default profile is `fastest`: omit `inputAudioTranscription`, retain `outputAudioTranscription`, and set `echoTargetLanguage: false`.
- Never expose a cloud API key to the extension and never add an automatic paid fallback.
- Capture tab audio only after the local gateway has acknowledged that Gemini is ready.
- Render changed partials immediately; debounce only uncertain final boundaries.
- Keep at most two visible lines. Preserve all currently useful text by moving overflow to a new page/block, never by clipping it.
- Telemetry may contain timestamps, counts, percentiles, token usage, model/provider names, and error categories; it must not contain audio bytes, source text, or translated text.
- Preserve compatibility for existing settings and the current gateway protocol while adding the new fields.

---

## Task 1: Add explicit caption profiles and safe settings migration

**Files:**

- Modify: `src/settings-store.js`
- Modify: `src/desktop-control-policy.js`
- Modify: `src/main-app.js`
- Modify: `src/provider-factory.js`
- Test: `tests/settings-store.test.js`
- Test: `tests/desktop-control-policy.test.js`
- Test: `tests/main-app-lifecycle-contract.test.js`
- Test: `tests/provider-factory.test.js`

- [x] **Step 1: Write failing settings tests**

Add assertions that fresh settings use the low-latency profile and that a saved legacy source toggle migrates without silently changing the user's preference:

```js
assert.deepEqual(settings.captions, {
  mode: "fastest",
  echoTargetLanguage: false,
  resetGapMs: 1100,
  finalDebounceMs: 120,
});
assert.equal(settings.overlay.showSource, false);

const migrated = sanitizeSettings({ overlay: { showSource: true } });
assert.equal(migrated.captions.mode, "bilingual");
assert.equal(migrated.overlay.showSource, true);
```

Also test clamping of `resetGapMs` and `finalDebounceMs`, rejection of unknown modes, and that an explicit `captions.mode` wins over the legacy flag.

- [x] **Step 2: Run the settings test and confirm it fails**

Run: `node --test tests/settings-store.test.js`

Expected: FAIL because `captions` does not exist and `overlay.showSource` still defaults to true.

- [x] **Step 3: Implement settings version 2**

Add defaults:

```js
captions: {
  mode: "fastest",
  echoTargetLanguage: false,
  resetGapMs: 1100,
  finalDebounceMs: 120,
},
overlay: {
  showSource: false,
}
```

During sanitization, detect whether the raw input actually contains the legacy `overlay.showSource` property. If there is no valid explicit mode, map legacy `true` to `bilingual`; otherwise use `fastest`. Derive the sanitized `overlay.showSource` value from the selected mode so the old renderer contract remains coherent.

- [x] **Step 4: Write failing configuration/factory tests**

Add a pure `configFromDesktopSettings(cliConfig, settings, secrets)` helper to `desktop-control-policy.js`. Assert that it and the Gemini factory pass these explicit fields:

```js
{
  enableInputTranscription: false,
  echoTargetLanguage: false,
  finalDebounceMs: 120,
}
```

For `bilingual`, assert `enableInputTranscription: true` and source display enabled. Add normalization tests for a Control Center patch under `captions`, and confirm profile-affecting changes require a runtime stop/restart. Keep `main-app.js` as wiring only and extend its source-contract test to ensure it calls the pure helper.

- [x] **Step 5: Run the focused tests and confirm they fail**

Run: `node --test tests/desktop-control-policy.test.js tests/main-app-lifecycle-contract.test.js tests/provider-factory.test.js tests/settings-store.test.js`

Expected: FAIL on the new profile fields.

- [x] **Step 6: Thread the profile through the application**

Implement and export the pure helper from `desktop-control-policy.js`, then call it from the existing `configFromSettings()` wrapper in `main-app.js`. Pass the settings as:

```js
geminiInputTranscription: settings.captions.mode === "bilingual",
geminiEchoTargetLanguage: settings.captions.echoTargetLanguage,
geminiFinalDebounceMs: settings.captions.finalDebounceMs,
captionResetGapMs: settings.captions.resetGapMs,
```

Update `settingsPatchRequiresRuntimeStop()` so changes to `captions.mode` or `captions.echoTargetLanguage` stop the current session safely. Do not restart automatically; retain the existing explicit Start flow.

- [x] **Step 7: Run focused tests**

Run: `node --test tests/desktop-control-policy.test.js tests/main-app-lifecycle-contract.test.js tests/provider-factory.test.js tests/settings-store.test.js`

Expected: PASS.

- [x] **Step 8: Commit the settings slice**

```bash
git add src/settings-store.js src/desktop-control-policy.js src/main-app.js src/provider-factory.js tests/settings-store.test.js tests/desktop-control-policy.test.js tests/main-app-lifecycle-contract.test.js tests/provider-factory.test.js
git commit -m "feat: add low-latency caption profiles"
```

---

## Task 2: Make Gemini Fastest truly output-only and expose provider timing

**Files:**

- Modify: `src/providers/gemini-live-translate.js`
- Modify: `src/provider-factory.js`
- Test: `tests/gemini-live-translate.test.js`
- Test: `tests/provider-factory.test.js`

- [ ] **Step 1: Write failing Gemini configuration tests**

Capture the config sent to `client.live.connect()` and assert:

```js
assert.equal("inputAudioTranscription" in config, false);
assert.deepEqual(config.outputAudioTranscription, {});
assert.equal(config.translationConfig.echoTargetLanguage, false);
```

Add the inverse bilingual test, where `inputAudioTranscription` exists and contains a fixed source language only when one was explicitly selected. Auto-detect must not be simulated by sending a broad `languageCodes` list in Fastest mode.

- [ ] **Step 2: Write failing event/error tests**

Cover all of the following:

- a changed output partial emits without a timer;
- a final transition uses the configured 120 ms debounce only when no authoritative completion marker is present;
- `generationComplete` or `turnComplete` finalizes immediately;
- the first changed partial contains `liveEdgeToPartialMs` while retaining `latencyMs` as a compatibility alias;
- the final contains `partialToFinalMs`;
- `usageMetadata` is forwarded through an `onUsage` callback after allow-list normalization;
- errors containing HTTP 429 or `RESOURCE_EXHAUSTED` map to a clear Free Tier quota message and do not select another provider.

- [ ] **Step 3: Run the provider tests and confirm they fail**

Run: `node --test tests/gemini-live-translate.test.js tests/provider-factory.test.js`

Expected: FAIL for conditional transcription, usage metadata, timing fields, and quota mapping.

- [ ] **Step 4: Implement conditional Gemini configuration**

Build the Live config without an `inputAudioTranscription` key unless `enableInputTranscription` is true:

```js
const config = {
  responseModalities: [Modality.AUDIO],
  ...(enableInputTranscription
    ? { inputAudioTranscription: languageCodes.length ? { languageCodes } : {} }
    : {}),
  outputAudioTranscription: {},
  translationConfig: { targetLanguageCode, echoTargetLanguage },
  contextWindowCompression: { slidingWindow: {} },
};
```

Keep SDK-default compression behavior beyond the existing sliding-window opt-in; do not add speculative trigger-token tuning.

- [ ] **Step 5: Implement timing, finalization, usage, and quota handling**

Track `firstPartialEmittedAt` per turn. Emit partials synchronously from the message handler. If the server supplies an authoritative completion marker, cancel the final timer and emit final now; otherwise schedule only the final state change using `finalDebounceMs`.

Normalize usage to numeric allow-listed fields such as prompt/input, response/output, total, and cached token counts. Never forward response bodies or transcript-bearing message objects.

Add an error helper that recognizes numeric/string 429 and `RESOURCE_EXHAUSTED`, returning a Vietnamese message that tells Free Tier users to wait or inspect AI Studio quota. Leave provider selection unchanged.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/gemini-live-translate.test.js tests/provider-factory.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the provider slice**

```bash
git add src/providers/gemini-live-translate.js src/provider-factory.js tests/gemini-live-translate.test.js tests/provider-factory.test.js
git commit -m "feat: optimize Gemini Live output transcription"
```

---

## Task 3: Warm Gemini before acquiring the tab stream

**Files:**

- Create: `extension/capture-lifecycle.js`
- Modify: `extension/background.js`
- Modify: `extension/offscreen.js`
- Modify: `extension/manifest.json`
- Modify: `src/gateway.js`
- Test: `tests/capture-lifecycle.test.js`
- Test: `tests/extension-security.test.js`
- Test: `tests/gateway-lifecycle.test.js`
- Test: `tests/gateway.integration.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

Test a small dependency-injected coordinator with this exact order:

```js
assert.deepEqual(events, [
  "prepare-local-session",
  "provider-ready",
  "get-tab-stream-id",
  "attach-tab-stream",
]);
```

Also assert that `get-tab-stream-id` is never called when preparation fails, and that a failure after preparation invokes `cancelPreparedSession()` exactly once.

- [ ] **Step 2: Strengthen security regression tests**

Extend the offscreen VM test to prove:

- the prepare message contains only local protocol/auth/settings data, never a cloud API key;
- no `getUserMedia()` call occurs before the authenticated local socket receives `started`;
- PCM remains bounded and cannot be sent before readiness;
- Stop closes both a prepared-only session and an attached capture session.

- [ ] **Step 3: Run focused tests and confirm they fail**

Run: `node --test tests/capture-lifecycle.test.js tests/extension-security.test.js tests/gateway-lifecycle.test.js tests/gateway.integration.test.js`

Expected: FAIL because capture currently starts before the local WebSocket/provider connection.

- [ ] **Step 4: Add the prepare/attach coordinator**

Expose a browser/global helper with an injectable function interface:

```js
prepareThenAttach({
  prepareLocalSession,
  getTabStreamId,
  attachTabStream,
  cancelPreparedSession,
})
```

Load it before `background.js` in the MV3 service worker. In `background.js`, send `capture:prepare`, await provider-ready, only then call `chrome.tabCapture.getMediaStreamId()`, and finally send `capture:attach` with the one-time stream ID.

- [ ] **Step 5: Split offscreen capture into two phases**

`prepareCapture(settings)` must authenticate the local WebSocket, send `start`, and resolve only on gateway `started`. `attachCapture(streamId)` must then call `getUserMedia()`, build the audio graph, and begin PCM flow. Keep `capture:start` as a compatibility wrapper that calls both phases for older callers/tests.

Use a single pending preparation promise, reject it on socket close/error/timeout, and make Stop idempotent. Do not reconnect per utterance.

- [ ] **Step 6: Report provider preparation time in the gateway**

Measure from immediately before `provider.start()` to its resolution. Include `providerPrepareMs` in the `started` acknowledgement and emit it as a metrics event. This is provider preparation latency, not a network SLA.

- [ ] **Step 7: Run focused tests**

Run: `node --test tests/capture-lifecycle.test.js tests/extension-security.test.js tests/gateway-lifecycle.test.js tests/gateway.integration.test.js`

Expected: PASS.

- [ ] **Step 8: Commit the warm-start slice**

```bash
git add extension/capture-lifecycle.js extension/background.js extension/offscreen.js extension/manifest.json src/gateway.js tests/capture-lifecycle.test.js tests/extension-security.test.js tests/gateway-lifecycle.test.js tests/gateway.integration.test.js
git commit -m "feat: warm Gemini before tab capture"
```

---

## Task 4: Build the committed-prefix/mutable-suffix caption state machine

**Files:**

- Create: `src/overlay/live-caption-block.js`
- Modify: `src/overlay/index.html`
- Test: `tests/live-caption-block.test.js`

- [ ] **Step 1: Write failing deterministic state tests**

Instantiate the state machine with an injected clock and paginator. Cover:

1. First partial creates only a mutable suffix.
2. A revised partial replaces the suffix instead of duplicating words.
3. Final moves the current suffix into the committed prefix.
4. A new utterance within 1100 ms appends naturally to the same visible block.
5. A gap greater than 1100 ms starts a new block.
6. Overflow beyond two lines/pages starts a new visible page containing the newest useful text, without slicing grapheme clusters.
7. A session/generation change clears stale text.
8. Duplicate/out-of-order sequence numbers are ignored.
9. `reflow()` preserves semantic text while recalculating pages for a changed width/font.

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `node --test tests/live-caption-block.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a pure UMD/CommonJS-compatible module**

Export:

```js
createLiveCaptionBlock({ resetGapMs = 1100, now = Date.now })
// -> { apply(caption, paginate), snapshot(), reflow(paginate), clear() }
```

Maintain `committedPrefix`, `mutableSuffix`, `lastFinalAt`, `sessionId`, `generation`, and `lastSequence`. `snapshot()` returns only render-ready state and metadata; it does not expose internal mutable objects.

Use the provided paginator as the sole overflow authority. If combined text spans multiple two-line pages, show the last complete page and retain only the text necessary for future continuation. Do not use CSS clipping as data loss control.

- [ ] **Step 4: Load the module before the overlay renderer**

Add `live-caption-block.js` to `src/overlay/index.html` before `renderer.js`, preserving the current no-bundler overlay startup.

- [ ] **Step 5: Run the state tests**

Run: `node --test tests/live-caption-block.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the state-machine slice**

```bash
git add src/overlay/live-caption-block.js src/overlay/index.html tests/live-caption-block.test.js
git commit -m "feat: add continuous live caption state"
```

---

## Task 5: Wrap by actual overlay width and render one stable two-line block

**Files:**

- Modify: `src/overlay/caption-composer.js`
- Modify: `src/overlay/renderer.js`
- Modify: `src/overlay/styles.css`
- Test: `tests/caption-composer.test.js`
- Test: `tests/overlay-renderer.test.js`

- [ ] **Step 1: Write failing measured-wrap tests**

Add `composeMeasuredText(text, options)` tests using a deterministic fake `measureText` function. Cover Vietnamese whitespace, long English words, CJK text without spaces, emoji/grapheme clusters, punctuation attachment, and exactly two lines per page.

Assert the fallback path uses 52 graphemes per line when no valid pixel width or measurement function is available.

- [ ] **Step 2: Write failing renderer integration tests**

With a minimal fake DOM/canvas, assert:

- consecutive partials update the same caption node;
- a final followed by a close partial appends instead of replacing the whole sentence;
- only one translated caption block is visible in Fastest mode;
- resize/font changes trigger `reflow()`;
- a render report includes `sessionId`, `sequence`, `isFinal`, `rafAt`, and `resultToRafMs` but no caption text.

- [ ] **Step 3: Run focused tests and confirm they fail**

Run: `node --test tests/caption-composer.test.js tests/overlay-renderer.test.js`

Expected: FAIL because wrapping is fixed at 42 graphemes and the renderer replaces each result.

- [ ] **Step 4: Implement pixel-aware composition**

Use `Intl.Segmenter` for word segmentation when available and grapheme segmentation as the safe fallback. Accumulate tokens while `measureText(candidate).width <= maxWidth`; split an overlong token only at grapheme boundaries. Return pages containing at most two lines.

Keep the current grapheme composer as a fallback, but change its default to 52 graphemes per line. Do not count UTF-16 code units.

- [ ] **Step 5: Integrate the live caption state in the renderer**

Create one offscreen canvas context and derive its font from the computed caption style. The paginator must use the actual caption container width after horizontal padding. Feed every caption event to `liveCaptionBlock.apply()` and render its snapshot immediately.

On resize or relevant overlay settings changes, update the measurement font/width and call `reflow()`. Keep CSS to two visible lines as a defensive presentation bound, not as the primary truncation mechanism.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/caption-composer.test.js tests/live-caption-block.test.js tests/overlay-renderer.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the overlay slice**

```bash
git add src/overlay/caption-composer.js src/overlay/renderer.js src/overlay/styles.css tests/caption-composer.test.js tests/overlay-renderer.test.js
git commit -m "feat: render stable two-line live subtitles"
```

---

## Task 6: Aggregate privacy-safe latency percentiles and Gemini usage

**Files:**

- Create: `src/runtime-metrics.js`
- Modify: `src/gateway.js`
- Modify: `src/main-app.js`
- Modify: `src/desktop-runtime-signals.js`
- Modify: `src/control-center/src/types.ts`
- Modify: `src/control-center/src/bridge.ts`
- Modify: `src/control-center/src/FidelityApp.tsx`
- Modify: `src/control-center/src/index.css`
- Test: `tests/runtime-metrics.test.js`
- Test: `tests/desktop-runtime-signals.test.js`
- Test: `tests/gateway-lifecycle.test.js`
- Test: `tests/gateway.integration.test.js`

- [ ] **Step 1: Write failing metrics unit tests**

Define a bounded aggregator with a maximum of 120 samples. Assert nearest-rank p50/p95 for `providerPrepareMs`, `localQueueMs`, `liveEdgeToPartialMs`, `partialToFinalMs`, `resultToRafMs`, and `firstReadableMs`. Assert invalid/negative/non-finite measurements are ignored.

For usage, assert monotonically increasing session totals are replaced, while independent per-turn deltas can be accumulated only when explicitly marked as deltas. Assert the public snapshot contains no keys named `text`, `caption`, `transcript`, `audio`, `data`, or `bytes`.

- [ ] **Step 2: Run the metrics test and confirm it fails**

Run: `node --test tests/runtime-metrics.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `RollingRuntimeMetrics`**

Expose:

```js
const metrics = new RollingRuntimeMetrics({ maxSamples: 120 });
metrics.record("liveEdgeToPartialMs", value);
metrics.recordUsage(normalizedUsage, { mode: "session-total" });
metrics.snapshot();
metrics.reset();
```

Return `{ latest, p50, p95, count }` for each metric and allow-listed numeric usage counters. Use bounded arrays; no transcript/audio payload is accepted by the API.

- [ ] **Step 4: Write failing propagation tests**

Assert this event flow:

```text
Gemini onUsage/onCaption
  -> gateway metrics/usage event
  -> main process RollingRuntimeMetrics
  -> DesktopRuntimeSignals snapshot
  -> Control Center bridge
```

On the first readable non-empty translated caption, compute `firstReadableMs` from the first accepted audio frame's capture timestamp. Record only once per session. Use the renderer IPC report for `resultToRafMs`.

- [ ] **Step 5: Implement gateway and main-process propagation**

Add optional `onUsage` and `onMetrics` callbacks without breaking providers that omit them. Emit only normalized numeric objects. Reset rolling session metrics on each explicit Start; retain the latest completed snapshot long enough for diagnostics after Stop.

Treat the existing provider `latencyMs` as a compatibility alias for `liveEdgeToPartialMs` and label it correctly in the UI.

- [ ] **Step 6: Extend runtime snapshots and Control Center**

Add typed diagnostics for:

- provider preparation;
- local audio queue;
- live audio edge to first partial;
- partial to final;
- result to animation frame;
- first readable session caption;
- Gemini input/output/total token usage when supplied.

Show latest/p50/p95/count compactly under an expandable “Chẩn đoán độ trễ” section. Explain that p50/p95 are measurements of this device/session and not Google guarantees. Do not show source transcript in Fastest mode.

- [ ] **Step 7: Run focused tests and Control Center checks**

Run: `node --test tests/runtime-metrics.test.js tests/desktop-runtime-signals.test.js tests/gateway-lifecycle.test.js tests/gateway.integration.test.js`

Run: `npm run check:control-center`

Expected: all PASS.

- [ ] **Step 8: Commit the diagnostics slice**

```bash
git add src/runtime-metrics.js src/gateway.js src/main-app.js src/desktop-runtime-signals.js src/control-center/src/types.ts src/control-center/src/bridge.ts src/control-center/src/FidelityApp.tsx src/control-center/src/index.css tests/runtime-metrics.test.js tests/desktop-runtime-signals.test.js tests/gateway-lifecycle.test.js tests/gateway.integration.test.js
git commit -m "feat: add live latency and usage diagnostics"
```

---

## Task 7: Expose user-friendly profile controls and finish documentation

**Files:**

- Modify: `src/control-center/src/FidelityApp.tsx`
- Modify: `src/control-center/src/types.ts`
- Modify: `src/control-center/src/bridge.ts`
- Modify: `README.md`
- Modify: `docs/TECHNICAL_RESEARCH.md`
- Create: `docs/DEVELOPMENT_PLAN.md`
- Test: `src/control-center/tests/control-center-copy.test.mjs`

- [ ] **Step 1: Write failing UI-copy tests**

Assert that the built source contains user-facing labels/descriptions for:

- `Nhanh nhất` as the default profile;
- `Song ngữ` as the opt-in source-transcription profile;
- same-language silence when “Lặp lại tiếng đích” is disabled;
- Free Tier quota exhaustion with no paid fallback;
- local-only API-key ownership and cloud audio processing consent.

- [ ] **Step 2: Run the copy test and confirm it fails**

Run: `node --test src/control-center/tests/control-center-copy.test.mjs`

Expected: FAIL because these explicit profile controls do not exist.

- [ ] **Step 3: Replace the raw source toggle with profile controls**

Use a two-option segmented/radio control. `Nhanh nhất` sets `captions.mode: "fastest"`; `Song ngữ` sets `captions.mode: "bilingual"`. Keep the advanced `echoTargetLanguage` control next to an explanation rather than exposing raw Gemini terminology.

Do not move provider/API setup back into CLI. CLI remains limited to connecting/opening the Control Center and clean shutdown.

- [ ] **Step 4: Update documentation**

Document:

- the warm-start data flow and local authentication boundary;
- Fastest versus Bilingual behavior;
- Gemini AI Studio Free Tier caveats and 429 behavior;
- how to interpret p50/p95 and token usage;
- the fact that Google AI Pro and ChatGPT Plus subscriptions do not automatically grant API quota;
- the runtime verification command and optional real-key benchmark checklist.

Record deferred work in `docs/DEVELOPMENT_PLAN.md`: real-world multi-network benchmarking, Google API evolution monitoring, optional fully local ASR+MT, subtitle file/video batch export enhancements, and accessibility customization not included here.

- [ ] **Step 5: Run focused UI and documentation checks**

Run: `node --test src/control-center/tests/control-center-copy.test.mjs`

Run: `npm run check:control-center`

Expected: PASS.

- [ ] **Step 6: Commit the UX/documentation slice**

```bash
git add src/control-center/src/FidelityApp.tsx src/control-center/src/types.ts src/control-center/src/bridge.ts README.md docs/TECHNICAL_RESEARCH.md docs/DEVELOPMENT_PLAN.md src/control-center/tests/control-center-copy.test.mjs
git commit -m "docs: explain low-latency Gemini caption modes"
```

---

## Task 8: End-to-end verification and measured acceptance

**Files:**

- Modify if needed: `package.json`
- Create if absent: `scripts/benchmark-live-captions.js`
- Create: `docs/BENCHMARKING.md`
- Test: all tests and production builds

- [ ] **Step 1: Add an offline deterministic benchmark harness**

Feed timestamped synthetic caption events through the caption state and metrics aggregator. Print JSON containing latest/p50/p95/count and the final two-line page. The harness must not require a cloud key and must fail if any sample is unbounded, negative, or transcript text leaks into the metrics object.

Expose it as:

```json
"benchmark:captions": "node scripts/benchmark-live-captions.js"
```

- [ ] **Step 2: Run static checks and the full test suite**

Run: `npm run check`

Run: `npm test`

Expected: PASS with no skipped new tests.

- [ ] **Step 3: Build the Control Center**

Run: `npm run build:control-center`

Expected: Vite production build succeeds.

- [ ] **Step 4: Run the offline benchmark**

Run: `npm run benchmark:captions`

Expected: exit 0; output includes all six metric groups and no audio/transcript fields.

- [ ] **Step 5: Run the repository verification command**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 6: Perform the optional real Gemini smoke test only when the user supplies a key**

Using Control Center, start Fastest mode on a Chrome/Edge tab and verify:

- provider-ready arrives before the browser capture indicator;
- first changed partial appears without waiting for final;
- two lines remain stable through partial revisions;
- a gap over 1100 ms starts a fresh block;
- Control Center reports p50/p95 and usage metadata when Google supplies it;
- stopping closes capture, socket, and overlay state cleanly;
- a deliberate quota failure displays the Free Tier message and does not switch providers.

Do not claim the p50 <= 650 ms / p95 <= 1000 ms target from offline tests. Record real device, browser, network, model, sample count, p50, and p95 in `docs/BENCHMARKING.md` before making a performance claim.

- [ ] **Step 7: Review the diff and commit verification artifacts**

Run: `git diff --check`

Run: `git status --short`

Confirm that no `.env`, API key, audio sample, generated Control Center bundle, or unrelated user file is staged.

```bash
git add package.json scripts/benchmark-live-captions.js docs/BENCHMARKING.md
git commit -m "test: add live caption benchmark harness"
```

---

## Acceptance checklist

- [ ] Fresh installs default to Fastest and do not request source transcription.
- [ ] Existing explicit source-caption users migrate to Bilingual.
- [ ] Gemini is ready before Chrome/Edge grants/attaches the tab audio stream.
- [ ] The WebSocket remains open across utterances.
- [ ] Output partials render immediately; final debounce never blocks a partial.
- [ ] Captions use one continuous block, at most two pixel-measured lines, with safe overflow and pause reset.
- [ ] Fastest mode shows translated text only.
- [ ] Runtime diagnostics expose bounded latest/p50/p95/count and usage metadata without content.
- [ ] 429/`RESOURCE_EXHAUSTED` stops safely with no paid fallback.
- [ ] API keys remain in the Electron main process and never appear in extension messages/logs.
- [ ] `npm run verify` passes.
- [ ] Any performance claim is backed by a documented real-key run, not synthetic data.
