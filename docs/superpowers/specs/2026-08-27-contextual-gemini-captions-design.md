# Contextual Gemini Captions Design

Date: 2026-08-27

## Goal

Improve live subtitle meaning, pronoun choice, gender handling, names, register, and scene continuity without removing the existing lowest-latency Gemini Live Translate route.

## User-facing modes

- `fastest`: keep `gemini-3.5-live-translate-preview` as the direct audio-to-translated-audio route and display its output transcription. This remains the lowest-latency option and does not accept contextual instructions.
- `balanced`: stream audio to `gemini-3.5-transcribe-live`, translate bounded stable hypotheses with `gemini-3.5-flash-lite`, and retranslate the complete utterance on the authoritative final transcript. This is the recommended default for new installations.
- `accurate`: use the same transcription and contextual translation components but translate only finalized utterances. It may exceed one second after a pause and explicitly prioritizes meaning over live draft speed.

Caption display mode (`fastest`/`bilingual` in the existing settings schema) remains independent from translation quality mode. Users may hide the source transcript in every quality mode.

## Runtime architecture

```text
PCM16 mono 16 kHz / 100 ms
  -> Gemini Live Transcribe WebSocket
  -> speculative interim + authoritative final transcript
  -> bounded partial scheduler / stale-generation cancellation
  -> Gemini Flash-Lite text translation with bounded context
  -> phrase-sized mutable caption updates
  -> complete-utterance final translation and history commit
```

The direct Live Translate provider remains unchanged for `fastest`.

## Transcription contract

- Use `gemini-3.5-transcribe-live` with `responseModalities: [TEXT]`.
- Omit `languageCodes` for automatic detection; otherwise pass selected source hints.
- Pass at most 100 source terms derived from the user's glossary and character notes as `customVocabulary`.
- Default to `VERBATIM` because film hesitation and repetitions may carry meaning. Do not silently use Smart mode for film dialogue.
- Forward interim hypotheses as replaceable partials and `inputTranscription` as authoritative finals.
- Send PCM in 100 ms frames, bound queued audio in RAM, rotate a live session before the documented ten-minute limit, and keep the API key non-enumerable.
- Use server VAD by default. Accept privacy-safe audio activity notifications so a hybrid end-of-utterance signal can be enabled without exposing audio content.

## Contextual translation contract

Each request contains only:

- source and target language;
- the current source utterance;
- at most the configured number of previously finalized source/target pairs;
- bounded user-authored glossary and character/relationship notes;
- whether the request is a mutable draft or authoritative final.

The system instruction requires professional audiovisual subtitle translation, natural target-language word order, idiom and subtext preservation, consistent terminology and social register, and translation-only output. Character facts are authoritative only when supplied by the user. When gender or relationship is not supported by current or prior context, the model must prefer a natural neutral construction or omit a pronoun rather than invent a permanent fact.

The translator uses minimal thinking for latency, streams model output, normalizes the result, and forwards usage metadata through the existing numeric allowlist.

## Partial and final policy

- Do not call text MT for every ASR token. Start a partial after a readable minimum and require meaningful growth or a changed hypothesis before another call.
- Keep MT requests serial. A newer hypothesis invalidates and aborts an older partial.
- Buffer streamed model tokens until a phrase-sized threshold or punctuation boundary before rendering. Never expose one-character or one-token flicker.
- A final transcript cancels its partial, translates the full utterance, emits exactly one final caption, and appends the finalized source/target pair to bounded memory.
- Previously finalized subtitles never change. Only the current mutable subtitle may be replaced.
- Pause clears mutable work. Stop clears all transcript history, glossary copies held by providers, queued audio, sessions, and API-key references.

## Privacy and security

- Both cloud hops use the same user-provided Gemini API key and the existing Google cloud consent. No third-party provider is introduced.
- Context is bounded and held in main-process RAM only while a session runs. Caption content, glossary content, character notes, and audio are not logged or included in diagnostics.
- User-authored glossary and character notes may be persisted locally in the existing mode-0600 settings file; UI copy must say they are sent to Google only while contextual translation is active.
- Free Tier privacy cannot be described as absolute: Google currently states Free Tier content may be used to improve products. The existing disclosure remains visible.
- No automatic fallback to a paid provider or a different provider is allowed.

## Control Center

Add a quality selector with three cards and concise trade-offs. When `balanced` or `accurate` is selected, expose an optional advanced context section:

- glossary, one entry per line (`source = preferred target` is recommended);
- character and relationship notes;
- context length, clamped to 0-6 finalized turns.

Changing translation mode or context while audio is active stops the current runtime before persisting the new setting. The current model/path appears in the provider snapshot and status copy.

## Measurement and acceptance

- Existing fastest behavior and tests remain unchanged.
- Focused unit tests cover API config, auto language, 100 ms audio batching, partial/final semantics, session rotation, key redaction, prompt/context bounds, neutral ambiguity policy, phrase coalescing, stale cancellation, final history, pause, and stop.
- Settings, provider factory, desktop config, gateway callbacks, Control Center bridge, and production build have contract tests.
- Release telemetry remains numeric only. Add no transcript-shaped field.
- Benchmark targets are measurements, not guarantees: record p50/p95 first partial, final stabilization, revision rate, ASR WER/CER, pronoun/reference accuracy, name consistency, and bilingual review on real film audio.

## Non-goals

- Automatic live speaker diarization or automatic permanent gender assignment.
- Persisting inferred character profiles.
- Rewriting already committed subtitles.
- Claiming sub-one-second p95 for the two-hop route before real API benchmarking.
- Replacing the local/offline roadmap.
