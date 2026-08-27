# Contextual Gemini Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selectable Gemini contextual subtitle modes that use Live Transcribe plus Flash-Lite to improve natural phrasing, pronoun/reference handling, names, register, and final-sentence coherence while retaining direct Live Translate as the fastest path.

**Architecture:** Keep `GeminiLiveTranslateTranslator` untouched for `fastest`. Add a dedicated Live Transcribe adapter, a bounded Gemini text translator, and a contextual streaming cascade that owns partial scheduling, phrase coalescing, final retranslation, and in-memory history. Persist only explicit user settings and route the selected mode through the existing provider factory, gateway, and Control Center.

**Tech Stack:** Node.js 22, Electron 43, React/TypeScript/Vite, `@google/genai` 2.x, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-27-contextual-gemini-captions-design.md`

**Implementation status (2026-08-28):** Tasks 1–7 have been implemented with focused RED/GREEN tests, including the headless `--translation-mode` integration and updated onboarding/provider documentation. No selective commit was created because the shared worktree already contains unrelated telemetry work. The current verification passes syntax checks, 125 focused feature tests, 3 targeted integration tests and the production Control Center build; the full 384-test suite retains exactly the three baseline telemetry assertion failures documented in Task 7, with no new failure. Real-provider semantic/latency/cost A/B testing remains a release/benchmark activity in `docs/ROADMAP.md`, not an unimplemented code step in this plan.

## Global Constraints

- Preserve `gemini-3.5-live-translate-preview` behavior and its output-only fastest profile.
- Use `gemini-3.5-transcribe-live` for streaming ASR and `gemini-3.5-flash-lite` for contextual text translation.
- Never log or emit audio, transcript, glossary, character notes, API keys, or resumable handles through diagnostics.
- Keep every buffer, context list, text field, request queue, and timer bounded.
- Do not add a paid fallback or a second provider destination.
- Existing telemetry changes in the worktree are unrelated baseline work; do not revert, overwrite, or stage them accidentally.
- Every production behavior follows RED -> GREEN -> REFACTOR with focused tests.

---

### Task 1: Persist a separate translation-quality profile

**Files:**
- Modify: `src/settings-store.js`
- Modify: `tests/settings-store.test.js`

**Interfaces:**
- Produces: `settings.translation` with `{ mode, transcriptionModel, textModel, contextTurns, partialThrottleMs, glossary, characterContext }`.
- Consumed by: desktop configuration and Control Center tasks.

- [ ] **Step 1: Write failing settings tests**

Add literal assertions that a fresh install defaults to `balanced`, a version-2 setting without `translation` remains `fastest`, invalid modes fail closed, models are bounded, context turns clamp to `0..6`, throttle clamps to `250..2000`, and user text is normalized and bounded to 4,000 characters.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `node --test tests/settings-store.test.js`

Expected: FAIL because `settings.translation` does not exist and settings version is still 2.

- [ ] **Step 3: Implement schema version 3 and sanitization**

Use this public shape:

```js
translation: {
  mode: "balanced",
  transcriptionModel: "gemini-3.5-transcribe-live",
  textModel: "gemini-3.5-flash-lite",
  contextTurns: 4,
  partialThrottleMs: 450,
  glossary: "",
  characterContext: "",
}
```

When `value.version <= 2` and no translation mode exists, migrate to `fastest` to avoid silently changing an existing user's cloud path.

- [ ] **Step 4: Run focused settings tests and observe GREEN**

Run: `node --test tests/settings-store.test.js`

- [ ] **Step 5: Record a selective checkpoint**

Stage only `src/settings-store.js` and `tests/settings-store.test.js` if the worktree allows a clean selective commit; otherwise leave an explicit plan checkpoint without staging unrelated telemetry files.

---

### Task 2: Add the Gemini Live Transcribe adapter

**Files:**
- Create: `src/providers/gemini-live-transcribe.js`
- Create: `tests/gemini-live-transcribe.test.js`

**Interfaces:**
- Constructor: `new GeminiLiveTranscriber(options)`.
- Methods: `start(): Promise<void>`, `write(pcm, timing): boolean`, `setPaused(boolean): boolean`, `setAudioActivity(telemetry): boolean`, `stop(): Promise<void>`.
- Callback: `onTranscript({ text, isFinal, sourceLanguage, capturedAt, provider })`.

- [ ] **Step 1: Write failing adapter contract tests**

Cover the exact config:

```js
{
  responseModalities: ["TEXT"],
  inputAudioTranscription: {
    languageCodes: [],
    customVocabulary: ["Alex", "Stormhold"],
    mode: "VERBATIM",
  },
}
```

Also cover 100 ms PCM batching, interim replacement, authoritative final, language detection, bounded custom vocabulary, rotation before ten minutes, hybrid silence finalization, pause wiping mutable audio, idempotent stop, quota errors, and API-key redaction.

- [ ] **Step 2: Run adapter tests and observe RED**

Run: `node --test tests/gemini-live-transcribe.test.js`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the minimal secure adapter**

Use a WeakMap for the API key, a 3,200-byte PCM frame, a 64 KiB default audio bound, an injected client factory for tests, a 570,000 ms default rotation timer, and epoch checks so callbacks from an old session cannot leak into the replacement.

- [ ] **Step 4: Run adapter tests and observe GREEN**

Run: `node --test tests/gemini-live-transcribe.test.js`

- [ ] **Step 5: Refactor only after GREEN**

Extract small local validation/redaction helpers inside the new module; do not refactor the existing Live Translate provider in this task.

---

### Task 3: Add bounded Gemini contextual text translation

**Files:**
- Create: `src/providers/gemini-text-translation.js`
- Create: `tests/gemini-text-translation.test.js`

**Interfaces:**
- Constructor: `new GeminiContextualTextTranslator(options)`.
- Method:

```js
translate({
  text,
  sourceLanguage,
  targetLanguage,
  previousTurns,
  glossary,
  characterContext,
  isFinal,
  signal,
  onDelta,
}) => Promise<string>
```

- [ ] **Step 1: Write failing request/prompt tests**

Assert that `generateContentStream` receives `gemini-3.5-flash-lite`, minimal thinking, a bounded system instruction, and JSON user data. The instruction must explicitly require natural audiovisual translation, context-only disambiguation, consistent names/register, no invented gender/relationship, neutral wording when uncertain, untrusted source handling, and translation-only output.

- [ ] **Step 2: Run translator tests and observe RED**

Run: `node --test tests/gemini-text-translation.test.js`

- [ ] **Step 3: Implement streaming, cancellation, usage, bounds, and redaction**

Bound current text to 8,000 characters, history to 6 turns/12,000 characters, each context field to 4,000 characters, response to 16,000 characters, and emitted usage to the existing numeric fields. Never serialize the API key into the translator object.

- [ ] **Step 4: Run translator tests and observe GREEN**

Run: `node --test tests/gemini-text-translation.test.js`

---

### Task 4: Orchestrate stable partials, phrase output, and final memory

**Files:**
- Create: `src/providers/gemini-contextual-translate.js`
- Create: `tests/gemini-contextual-translate.test.js`

**Interfaces:**
- Constructor: `new GeminiContextualTranslator(options)`.
- Provider methods match the gateway provider contract: `start`, `write`, `setPaused`, `setAudioActivity`, `stop`.
- Uses injected `createTranscriber` and `createTextTranslator` in tests; defaults construct Tasks 2 and 3.

- [ ] **Step 1: Write failing orchestration tests**

Cover:

- balanced mode waits for readable growth and throttles partial MT;
- accurate mode never sends partial MT;
- a newer ASR hypothesis invalidates stale MT;
- output deltas smaller than 12 new characters remain buffered unless punctuation ends a phrase;
- a final cancels its partial, translates the full utterance, emits one final, and stores one bounded history turn;
- the next request receives prior source/target context plus user glossary and character notes;
- pause clears mutable jobs and stop wipes all history;
- errors and quota exhaustion terminate safely.

- [ ] **Step 2: Run orchestration tests and observe RED**

Run: `node --test tests/gemini-contextual-translate.test.js`

- [ ] **Step 3: Implement a serial generation queue**

Jobs contain `{ generation, kind, text, capturedAt, controller, streamedTranslation }`. Keep only one pending partial, bound pending finals to 8/32,000 characters, use the configured `partialThrottleMs`, require at least 8 readable characters for the first draft and 12 characters of growth for subsequent prefix drafts, and emit provider id `gemini-contextual`.

- [ ] **Step 4: Run orchestration tests and observe GREEN**

Run: `node --test tests/gemini-contextual-translate.test.js`

---

### Task 5: Route the profile through factory, desktop config, and gateway

**Files:**
- Modify: `src/provider-factory.js`
- Modify: `src/config.js`
- Modify: `src/desktop-control-policy.js`
- Modify: `src/gateway.js`
- Modify: `src/main-app.js`
- Modify: `tests/provider-factory.test.js`
- Modify: `tests/config.test.js`
- Modify: `tests/desktop-control-policy.test.js`
- Modify: `tests/gateway-lifecycle.test.js`
- Modify: `tests/main-app-lifecycle-contract.test.js`

**Interfaces:**
- `geminiTranslationMode`: `fastest | balanced | accurate`.
- Factory chooses direct Live Translate only for `fastest`; contextual modes use `GeminiContextualTranslator` with the same Gemini consent/key.
- Gateway calls optional `provider.setAudioActivity(telemetry)` only with numeric/boolean activity data.

- [ ] **Step 1: Add failing routing tests**

Assert fastest still returns `GeminiLiveTranslateTranslator`; balanced/accurate return contextual providers with correct models, context, throttle, and partial policy; desktop config does not include unknown fields; active translation changes require a stop; gateway forwards only sanitized activity and existing usage callbacks.

- [ ] **Step 2: Run focused routing tests and observe RED**

Run:

```bash
node --test tests/provider-factory.test.js tests/config.test.js tests/desktop-control-policy.test.js tests/gateway-lifecycle.test.js tests/main-app-lifecycle-contract.test.js
```

- [ ] **Step 3: Implement minimal routing and status copy**

Keep `GEMINI_LIVE_MODEL` for direct mode and add optional environment overrides `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_TEXT_MODEL`, and `AUDIOTRANSLATE_TRANSLATION_MODE`. The desktop path remains settings-owned.

- [ ] **Step 4: Run focused routing tests and observe GREEN except documented telemetry baseline failures**

Do not change unrelated telemetry expectations merely to make the pre-existing baseline green.

---

### Task 6: Add professional Control Center quality controls

**Files:**
- Modify: `src/control-center/src/types.ts`
- Modify: `src/control-center/src/bridge.ts`
- Modify: `src/control-center/src/FidelityApp.tsx`
- Modify: `src/control-center/src/styles.css`
- Create: `src/control-center/src/translation-profile.mjs`
- Create: `src/control-center/src/translation-profile.d.mts`
- Create: `src/control-center/tests/translation-profile.test.mjs`

**Interfaces:**
- `TranslationSettings` mirrors Task 1's public fields.
- `ControlCenterClient.updateTranslation(payload)` calls native `updateSettings({ translation: payload })`.

- [ ] **Step 1: Write failing pure profile-display tests**

Test literal labels and trade-offs for `fastest`, `balanced`, and `accurate`, plus safe fallback to balanced. Test that contextual controls are visible only for balanced/accurate through the helper's returned contract.

- [ ] **Step 2: Run Control Center test and observe RED**

Run: `node --test src/control-center/tests/translation-profile.test.mjs`

- [ ] **Step 3: Implement types, bridge normalization, mock client, UI cards, and advanced context fields**

Place the selector after language controls. Copy must state that balanced adds one text-model hop and that glossary/character notes are sent to Google only while contextual mode runs. Disable mutation while the runtime is active through the existing stop-before-settings-change policy.

- [ ] **Step 4: Run tests and production build**

Run:

```bash
node --test src/control-center/tests/translation-profile.test.mjs src/control-center/tests/control-center-copy.test.mjs
npm run build:control-center
```

Expected: tests pass and Vite production build completes without type errors.

---

### Task 7: Document, verify, and separate baseline failures

**Files:**
- Modify: `docs/AUTO_LANGUAGE_AND_ACCURACY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`
- Test: all focused files from Tasks 1-6.

**Interfaces:**
- Documentation names the implemented modes without promising measured sub-one-second p95 for contextual mode.

- [ ] **Step 1: Update user and architecture documentation**

Document Control Center selection, exact models, Free/Paid privacy disclosure, no live diarization, ten-minute ASR session rotation, and benchmark requirements. Record real-world semantic/latency A/B evaluation as remaining work.

- [ ] **Step 2: Run focused feature verification**

Run all new provider/settings/factory/Control Center tests plus `npm run build:control-center`.

- [ ] **Step 3: Run repository checks**

Run: `npm run check`

- [ ] **Step 4: Run full tests and classify only known baseline failures**

Run: `npm test`

Compare failures with the captured baseline: the two `desktop-control-policy` diagnostic-shape assertions and the one `gateway-lifecycle` `localQueueMs` assertion were already failing before this feature; no new failure is acceptable.

- [ ] **Step 5: Inspect diff and verify secrets/content cannot leak**

Run:

```bash
git diff --check
git status --short
git diff -- src/providers src/provider-factory.js src/settings-store.js src/control-center docs
```

Confirm no key, transcript fixture from private media, generated build artifact, or telemetry content field appears.
