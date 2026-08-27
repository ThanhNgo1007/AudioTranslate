# Tự nhận diện ngôn ngữ và chiến lược độ chính xác

Cập nhật: 2026-08-28.

## Trả lời ngắn

Công cụ **đã có tự nhận diện ngôn ngữ đầu vào** qua Gemini Live Translate và nhận 0–8 language hints tùy chọn. Audio ngắn, nhạc nền, accent nặng, hai ngôn ngữ gần nhau hoặc code-switch vẫn có thể làm model cần thêm speech hoặc nhận sai.

Các contract hiện tại:

1. `gemini-auto`: tự nhận diện liên tục; không gợi ý hoặc cung cấp tối đa 8 mã/locale. Gợi ý không khóa ngôn ngữ.
2. `azure-fixed`: người dùng khóa locale để ưu tiên latency/accuracy.
3. `azure-auto-restricted`: chọn trước 2–4 full locale; Azure nhận diện một lần lúc bắt đầu.

Popup chỉ kiểm hình dạng chung và tối đa 8. Gateway đọc capability của provider mới áp min/max, full-locale và unique-base-language. Nhờ đó Gemini có thể chạy với danh sách rỗng, còn Azure auto vẫn fail-closed nếu không có 2–4 candidates hợp lệ.

Trên desktop, chọn **Tự nhận diện** và ngôn ngữ đích trong Control Center; CLI không hỏi hoặc nhận cấu hình ngôn ngữ tương tác. Với headless/automation, đặt `AUDIOTRANSLATE_SOURCE=auto`, `AUDIOTRANSLATE_SOURCE_CANDIDATES` và `AUDIOTRANSLATE_TARGET` qua environment hoặc secret/config injection của runner.

## Vì sao auto không thể bảo đảm caption đầu tiên dưới 1 giây

Gemini tự nhận diện trong cùng phiên dịch trực tiếp, nhưng model vẫn cần đủ speech/context và không công bố SLA cho first translated draft. Azure có contract khác: candidate list 2–4 locale, nhận diện at-start trong vài giây đầu và vẫn chọn một candidate nếu ngôn ngữ thật nằm ngoài danh sách. Continuous LID của JavaScript được tài liệu giới hạn cho STT, nên Azure `TranslationRecognizer` không được quảng bá là đổi ngôn ngữ liên tục. [Gemini Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [Azure Language Identification](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification)

Do đó contract đo lường phải tách:

- fixed: `first_draft_latency` p50/p95, với p95 hướng tới `<1 s`;
- auto: `language_detection_latency` và `first_auto_draft_latency` không có cam kết `<1 s`;
- sau khi lock: `steady_draft_latency_after_detection` dùng cùng target với fixed.

Không thể phát hiện đáng tin cậy từ im lặng, chỉ nhạc, một âm tiết cực ngắn hoặc speech chưa đủ phân biệt. UI cần nói rõ “đang nhận diện” thay vì hiện một locale đoán mò.

## Ma trận provider cần benchmark

| Provider | Auto source | Dịch partial trực tiếp | Vai trò đề xuất |
|---|---|---|---|
| Azure Speech Translation | At-start từ 2–4 candidates | Có | Đã triển khai như provider tùy chọn; fixed cho fast mode, restricted auto khi biết tập ngôn ngữ |
| OpenAI Realtime Translate | Flow chính chỉ cấu hình target | Có source và translated transcript deltas | Ưu tiên adapter/benchmark cloud tiếp theo; WebSocket dùng PCM16 24 kHz |
| Gemini Live Translate preview | Auto liên tục, 0–8 hints tùy chọn | Có live translated output/transcription | Đường ưu tiên đã triển khai; PCM16 16 kHz/100 ms, cần benchmark vì model đang preview |
| Google Chirp 3 + Cloud Translation | Auto/candidates được tài liệu minh họa ở sync Recognize; Chirp 3 streaming là capability riêng | Hai API hop cho route Chirp 3/vi/auto đề xuất | Đối chứng accuracy tiếng Việt; phải xác minh combined streaming-LID support và chống dịch lại partial quá nhiều |
| Together Realtime ASR + MT | Streaming API có source-language hint; khả năng auto phụ thuộc model/adapter và cần benchmark | Hai API hop | Ưu tiên BYOK draft khi source fixed; không quảng bá auto sớm chỉ từ khả năng multilingual của model |
| AWS Transcribe + Translate | Candidate LID, có multi-language segment cho ngôn ngữ hỗ trợ | Hai API hop | LID cần ít nhất khoảng 1 giây speech và hiện không hỗ trợ Vietnamese/Swedish LID; không phải auto-source option cho audio tiếng Việt |
| Deepgram Nova-3 + MT | Tài liệu hiện liệt kê language detection cho streaming Nova và Vietnamese `vi` | Hai API hop | Ứng viên BYOK ASR; benchmark time-to-lock/interim và route MT trước khi dùng auto mặc định |

OpenAI cung cấp endpoint `/v1/realtime/translations`, nhận audio liên tục và phát `session.input_transcript.delta`/`session.output_transcript.delta`; flow WebSocket dùng PCM16 24 kHz. [Realtime Translation guide](https://developers.openai.com/api/docs/guides/realtime-translation) Trang model tại ngày cập nhật ghi USD 0,034/phút và không hỗ trợ free tier; giá và availability cần kiểm tra lại khi triển khai. [GPT-Realtime-Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate)

Với Google, tài liệu Chirp 3 xác nhận riêng StreamingRecognize, `vi-VN` và các ví dụ auto/candidate LID cho synchronous Recognize; chưa nên giả định tổ hợp streaming+auto hoạt động như cùng một documented mode. Route Chirp 3 → Cloud Translation ở đây là đề xuất riêng cho vi/auto, không phải khẳng định mọi Google STT đều cần hai hop. [Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)

AWS streaming LID cần candidate list và tối thiểu khoảng một giây speech, nhưng bảng ngôn ngữ LID hiện loại Vietnamese và Swedish. Vì vậy AWS chỉ là benchmark code-switch cho các ngôn ngữ được hỗ trợ, không phải fallback auto-LID tiếng Việt. [AWS language identification](https://docs.aws.amazon.com/transcribe/latest/dg/lang-id.html), [streaming LID](https://docs.aws.amazon.com/transcribe/latest/dg/lang-id-stream.html)

Gemini Live Translate công bố 70+ ngôn ngữ, input PCM16 mono 16 kHz và khuyến nghị chunk 100 ms. Adapter hiện dùng auto-source, context compression/session resumption và chỉ lấy text output; output audio bị bỏ. Model mang hậu tố `preview`, vì vậy đây là mặc định triển khai hiện tại nhưng chưa nên được coi là production SLA. [Gemini Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate)

Deepgram có WebSocket STT, interim/final và hiện liệt kê Vietnamese cùng language detection cho streaming Nova. Đây là ASR, không phải direct source→Vietnamese translation; kết quả text vẫn phải đi qua MT local hoặc cloud, và cần đo churn/time-to-lock trên audio phim thật. [Live STT](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [language detection](https://developers.deepgram.com/docs/language-detection)

Together có raw WebSocket transcription dùng đúng PCM16 mono 16 kHz và trả delta/final; `language` là source hint. Dùng model đa ngôn ngữ không tự chứng minh language code đến đủ sớm để route MT, nên bản đầu vẫn ưu tiên source fixed/candidate nhỏ. [Together streaming transcription](https://docs.together.ai/docs/inference/transcription/streaming)

## Stack mã nguồn mở/không trả phí API

Không trả phí API không đồng nghĩa miễn chi phí: model local cần CPU/GPU, RAM, dung lượng tải và công sức đóng gói. License của **runtime** và **weights** phải được kiểm tra riêng.

Khuyến nghị production-local đầu tiên:

```text
PCM16 16 kHz
→ VAD
→ sherpa-onnx + Nemotron 3.5 ASR Streaming (auto-LID, chunk 160/320 ms)
→ SpeechBrain VoxLingua107 guard trên voiced window
→ text-LID validator trên stable transcript
→ stable-prefix gate
→ CTranslate2 INT8 + Marian pair-specific / M2M100 fallback
→ draft overlay
→ utterance-end ASR/MT refinement
```

- Nemotron 3.5 ASR Streaming 0.6B có native streaming, auto-LID và tiếng Việt ở tier transcription-ready. Model card báo tại chunk 320 ms, WER vi-VN là 12,29 khi biết trước ngôn ngữ và 12,40 khi auto; đây là WER ASR, không phải LID accuracy độc lập. Language tag được mô tả sau terminal punctuation, nên phải đo time-to-first/stable-tag trước khi dùng nó route MT partial. [Nemotron model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), [sherpa-onnx multilingual integration](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/nemo/nemotron-3.5-asr-streaming-0.6b/README.md)
- Qwen3-ASR 0.6B/1.7B là Apache-2.0, tích hợp language detection và hỗ trợ tiếng Việt; nên benchmark như accuracy/GPU profile. [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
- SpeechBrain VoxLingua107 ECAPA là LID guard 107 ngôn ngữ, Apache-2.0; model card cảnh báo domain/accent có thể ảnh hưởng, và score cần hiệu chuẩn trên audio thật. [VoxLingua107 model card](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa)
- Whisper/faster-whisper có LID tốt nhưng không phải stateful streaming gốc; dùng làm final/refinement hợp lý hơn fast path. [Whisper](https://github.com/openai/whisper), [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- CTranslate2 là runtime MIT; Marian en↔vi thích hợp cặp phổ biến, M2M100-418M MIT là fallback rộng. Metadata license Marian hiện không nhất quán giữa artifact card (Apache-2.0) và upstream pretrained-model terms (CC-BY-4.0), nên phải xác minh đúng artifact/attribution trước packaging. [CTranslate2](https://github.com/OpenNMT/CTranslate2), [Marian en→vi](https://huggingface.co/Helsinki-NLP/opus-mt-en-vi), [OPUS-MT upstream](https://github.com/Helsinki-NLP/OPUS-MT-train#pre-trained-models), [M2M100](https://huggingface.co/facebook/m2m100_418M)
- MMS-LID và NLLB distilled có độ phủ nghiên cứu tốt nhưng weights CC-BY-NC; không đóng gói làm production default. [MMS-LID](https://huggingface.co/facebook/mms-lid-1024), [NLLB](https://huggingface.co/facebook/nllb-200-distilled-600M)

## Chính sách quyết định ngôn ngữ local

Các threshold dưới đây chỉ là điểm khởi đầu, phải hiệu chuẩn bằng golden set:

- Acoustic LID dùng cửa sổ khoảng 3 giây voiced audio, hop 0,75 giây; có thể hiện provisional sớm hơn nhưng chưa lock.
- Hợp nhất acoustic score, language token của ASR và text-LID trên stable transcript.
- Lock khi top-1 lặp lại hai cửa sổ, confidence hiệu chuẩn `>= 0.80` và margin top-1/top-2 `>= 0.20`.
- Chỉ switch tại utterance boundary khi challenger tồn tại ba cửa sổ với ngưỡng cao hơn; tên riêng/từ vay mượn không được làm đổi language.
- Reset khi đổi tab/video/audio track, seek, reconnect hoặc im lặng dài.
- Confidence thấp: cảnh báo và đề nghị người dùng khóa locale; không âm thầm đổi engine giữa câu.

## Một đường Live Translate duy nhất

Runtime hiện phát partial/final trực tiếp từ Gemini Live Translate. Pipeline hai pass dựa trên model text đã bị gỡ để tránh quota riêng và độ trễ bổ sung; app không còn gửi glossary, ghi chú nhân vật hoặc transcript sang một request dịch văn bản thứ hai. Chất lượng ngữ cảnh vì vậy phải được đánh giá trực tiếp trên output Live Translate và golden set song ngữ.

Các phép đo release bắt buộc: LID macro-F1/time-to-lock/false-switch, ASR WER/CER, MT COMET/chrF cộng review song ngữ, accuracy tên/số/thuật ngữ, p50/p95 draft/stable latency và revision/flicker rate. Golden set phải có phim, YouTube, podcast, nhạc nền, accent, tiếng Việt và code-switch; không xếp hạng engine bằng số benchmark từ các model card khác tập dữ liệu.

Provider/routing rẻ hơn và BYOK không thay đổi tiêu chuẩn LID/accuracy này; xem [PROVIDERS_AND_COST.md](PROVIDERS_AND_COST.md).
