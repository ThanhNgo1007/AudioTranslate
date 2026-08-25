# Nghiên cứu kỹ thuật (cập nhật 2026-08-24)

## Kết luận

Đường ưu tiên đã triển khai cho MVP hiện tại là:

```text
Chromium tabCapture hoặc Control Center file picker + Web Audio
→ local WebSocket
→ Gemini Live Translate preview (auto source, translated text stream)
→ Electron transparent overlay
```

Azure Speech Translation vẫn là provider tùy chọn cho tab audio; demo local chỉ tạo caption mô phỏng. Gemini adapter dùng SDK chính thức `@google/genai`, PCM16 mono 16 kHz/100 ms, bounded fragment/context, session resumption/context compression và không phát output audio.

Đường sản phẩm ưu tiên tiếp theo là local-first và tách ASR/MT để có thể dùng BYOK:

```text
PCM → local/streaming ASR → stable text prefix
    → local MT hoặc generic text-provider adapter → overlay
```

Gemini là direct path đầu tiên, không phải khóa nền tảng. Cloud chỉ được bật khi người dùng cấu hình key, xác nhận consent và chủ động bắt đầu nguồn; local/demo hỏng không được âm thầm fallback sang cloud. Azure F0/S0 vẫn hữu ích làm baseline đối chứng.

`<1 giây` khả thi như **design target cho translated partial/draft** trong điều kiện tốt, nhưng MVP chưa có benchmark cloud/audio thật để xác nhận và không thể cam kết cho final ổn định của mọi cặp ngôn ngữ. Auto-LID cần nghe đủ speech trước khi quyết định, vì vậy phải đo riêng thời gian nhận diện và không áp SLA `<1 giây` cho caption auto đầu tiên.

## Capture audio tab Chrome/Edge

Chrome `tabCapture` là API đúng nhất vì cô lập được audio của **một tab**, thay vì toàn bộ browser/app:

- Chỉ gọi được sau user gesture (nhấn nút extension).
- Từ Chrome 116, stream ID do service worker tạo có thể được dùng trong offscreen document.
- Khi tab bị capture, audio không tự phát ra loa; phải nối MediaStream vào `AudioContext.destination`.
- Offscreen document cho phép Web Audio/MediaStream tiếp tục chạy khi popup đóng.

Nguồn chính thức: [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [audio/screen capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture).

Không dùng native system capture trong MVP: ScreenCaptureKit, WASAPI loopback và PipeWire thu theo app/output mix, không cô lập tab đáng tin cậy. Native fallback chỉ cần khi sản phẩm mở rộng ngoài Chrome/Edge.

## Audio pipeline

- `AudioWorklet`, không dùng `ScriptProcessorNode` đã deprecated.
- Downmix stereo → mono, low-pass Butterworth bậc 4, rồi resample 44.1/48 kHz → PCM16 16 kHz. Unit test kiểm tra 48 kHz tạo đúng 16.000 sample/s và suppression của tone ngoài dải 12 kHz.
- Chunk 320 samples = 20 ms. Packet nhỏ giảm queueing, phù hợp streaming SDK; packet quá nhỏ làm tăng overhead.
- Nối worklet vào destination để graph tiếp tục render và người dùng vẫn nghe video.
- Binary WebSocket không compression, không base64.

## Streaming ASR / translation

| Phương án | Điểm mạnh | Giới hạn / quyết định |
|---|---|---|
| **Azure Speech Translation** | Một SDK nhận PCM stream và trả interim transcript + translation; hỗ trợ target `vi`; codebase đã có adapter | Provider tùy chọn. Fixed source là fast path. Auto at-start chỉ chọn trong 2–4 candidates, tăng initial latency và luôn chọn một candidate kể cả khi audio là ngôn ngữ khác. JavaScript continuous LID chỉ được tài liệu hỗ trợ cho STT, không dùng cho Speech Translation. |
| **OpenAI Realtime Translate** | Dedicated WebSocket; chỉ cấu hình target trong flow chính; trả source/translated transcript delta trong lúc audio còn tới | Ứng viên cloud cần benchmark đầu tiên vì ít tầng. WebSocket cần PCM16 24 kHz/base64 nên adapter phải resample từ pipeline 16 kHz hiện tại. Chưa có số accuracy Việt ngữ hoặc SLA p95 công khai; giá model page tại ngày cập nhật là USD 0,034/phút và không hỗ trợ free tier. |
| **Gemini Live Translate (preview)** | Direct live translation, auto source liên tục, 0–8 hints, 70+ ngôn ngữ; PCM16 16 kHz/100 ms khớp pipeline | Adapter ưu tiên đã triển khai cho tab/file. Model preview; vẫn cần E2E benchmark transcript event, tiếng Việt, accent/code-switch, latency, quota và availability trước production. |
| **Google Chirp 3 + Cloud Translation** | Chirp 3 hỗ trợ StreamingRecognize và `vi-VN`; tài liệu cũng có auto/dominant và candidate LID ở ví dụ synchronous Recognize | Với Chirp 3/vi/auto, phải xác minh combined streaming-LID support; route đề xuất vẫn dùng hai hop Chirp 3 → Cloud Translation, ổn định partial và đo churn/chi phí. Không suy rộng thành mọi Google STT model. |
| **Together Realtime ASR + MT riêng** | WebSocket nhận PCM16 mono 16 kHz, trả transcript delta/final; Node dùng raw protocol. Có Whisper Large v3 và Nemotron streaming | Ứng viên BYOK cloud-ASR ưu tiên vì pipeline audio hiện tại khớp format và giá công bố thấp; vẫn cần MT text riêng, đo mạng từ Việt Nam và không suy model marketing thành E2E SLA. |
| **NVIDIA Nemotron 3.5 ASR Streaming 0.6B + sherpa-onnx** | Native streaming, auto-LID, chunk 80–1120 ms, tiếng Việt ở tier transcription-ready; local/private và model license cho commercial use | Lựa chọn local/cross-platform ưu tiên. Cần MT riêng và benchmark CPU/GPU. Model card tại chunk 320 ms báo WER vi-VN 12,29 fixed so với 12,40 auto, nhưng language tag được mô tả sau terminal punctuation; chưa có standalone LID accuracy/time-to-lock để chứng minh route MT `<1 s`. |
| **Qwen3-ASR 0.6B/1.7B** | Apache-2.0, tích hợp LID, hỗ trợ 30 ngôn ngữ gồm tiếng Việt và 22 phương ngữ Trung Quốc; có offline/streaming | Ứng viên accuracy local/GPU. Streaming hiện chỉ có qua vLLM; phải benchmark packaging, VRAM và latency desktop. |
| **SpeechBrain VoxLingua107 ECAPA** | LID audio riêng khoảng 86 MB, 107 ngôn ngữ, Apache-2.0 | Hợp làm guard/validator theo cửa sổ voiced audio, không thay ASR. Recipe dùng đoạn khoảng 3 giây và raw score chưa phải confidence đã hiệu chuẩn. |
| **Deepgram Nova-3 + MT riêng** | WebSocket streaming STT có interim/final; tài liệu hiện liệt kê Vietnamese `vi` và language detection cho streaming Nova | Ứng viên BYOK cloud-ASR tốt, nhưng vẫn cần MT text riêng. Phải benchmark thời gian LID/interim tiếng Việt và chất lượng phim; `language=multi` có tập code-switch riêng, không đồng nghĩa mọi locale đơn lẻ đều nằm trong nhóm đó. |
| **NVIDIA Riva ASR + NMT** | Enterprise/self-hosted GPU, streaming pipeline tích hợp, có English↔Vietnamese | Hạ tầng GPU nặng; NMT p90 có thể vượt 1 giây tùy GPU/cặp ngôn ngữ. |
| **Whisper / faster-whisper / whisper.cpp** | Phổ biến, chất lượng tốt, chạy local | Không native streaming. `whisper.cpp` realtime example chạy lại rolling window; phù hợp refinement/final hơn fast partial. |
| **Whisper-Streaming / SimulStreaming** | LocalAgreement/streaming decoding tốt hơn Whisper cơ bản | Các paper đánh giá những regime khác nhau; Whisper-Streaming báo trung bình khoảng 3,3–4,8 giây trên ba ngôn ngữ trong cấu hình thử nghiệm. Không coi đây là SLA chung hoặc đường `<1 s`. |
| **SeamlessStreaming / SeamlessM4T** | Direct speech translation gần 100 ngôn ngữ | Meta công bố latency khoảng 2 giây; weights CC-BY-NC, cần xem license khi thương mại. |

Nguồn:

- [Azure Speech Translation overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation)
- [Azure JavaScript TranslationRecognizer](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/translationrecognizer?view=azure-node-latest)
- [Azure language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)
- [Azure language identification](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification)
- [OpenAI Realtime Translation](https://developers.openai.com/api/docs/guides/realtime-translation)
- [OpenAI GPT-Realtime-Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Gemini Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
- [Google Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
- [Together streaming transcription](https://docs.together.ai/docs/inference/transcription/streaming)
- [Together pricing](https://www.together.ai/pricing)
- [NVIDIA Nemotron Streaming model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
- [sherpa-onnx Nemotron 3.5 multilingual integration](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/nemo/nemotron-3.5-asr-streaming-0.6b/README.md)
- [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
- [SpeechBrain VoxLingua107](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa)
- [Deepgram live WebSocket](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- [Deepgram models/languages](https://developers.deepgram.com/docs/models-languages-overview/)
- [Deepgram language detection](https://developers.deepgram.com/docs/language-detection)
- [NVIDIA Riva ASR performance](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/asr/asr-performance.html)
- [NVIDIA Riva translation overview](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/public/translation/translation-overview.html)
- [whisper.cpp realtime example](https://github.com/ggml-org/whisper.cpp)
- [Whisper-Streaming paper](https://aclanthology.org/2023.ijcnlp-demo.3/)
- [SimulStreaming paper](https://aclanthology.org/2025.iwslt-1.41/)
- [Meta Seamless communication](https://ai.meta.com/blog/seamless-communication/)

## Local/offline roadmap

Pipeline khuyến nghị:

```text
PCM 16 kHz
→ sherpa-onnx + Nemotron 3.5 Streaming (chunk 160/320 ms)
→ stable-prefix gate
→ CTranslate2 beam_size=1 / INT8
→ M2M100 418M hoặc Marian pair-specific
→ overlay
```

Đường accuracy-first có thể thêm SpeechBrain ECAPA làm acoustic-LID guard và fastText `lid.176` kiểm chứng transcript ổn định; [model fastText](https://fasttext.cc/docs/en/language-identification.html) này là CC-BY-SA-3.0. Qwen3-ASR là ứng viên GPU/accuracy; faster-whisper phù hợp second pass sau ranh giới câu hơn là hot path `<1 giây`. Không đóng gói MMS-LID hoặc NLLB làm production default vì weight/license phi thương mại.

Chi tiết đóng gói đã kiểm tra:

- `sherpa-onnx-node` có prebuilt cho macOS x64/arm64, Linux x64/arm64 và Windows x64; macOS/Linux hiện cần xử lý shared-library path khi đóng gói. [Node install](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)
- Nemotron INT8 profile 560 ms giải nén khoảng 650 MB. Node online wrapper hiện chưa expose đầy đủ per-stream language option như một số binding khác; auto tag lại xuất hiện sau terminal punctuation và sherpa strip tag. Bản local đầu nên scope EN→VI/fixed route hoặc dùng LID riêng, không hứa auto-route MT sớm.
- CTranslate2 chỉ có API C++/Python chính thức; dùng sidecar persistent đã preload/warm, không spawn Python cho từng caption. [CTranslate2 installation](https://opennmt.net/CTranslate2/installation.html)
- Transformers.js + Whisper/OPUS-MT có thể làm profile `local-js` nhỏ hơn để benchmark, nhưng token streamer không biến Whisper thành stateful audio streaming. Chỉ tải model khi người dùng opt-in, pin revision/checksum và chạy trong worker. [Transformers.js](https://huggingface.co/docs/transformers.js/en/index), [streamers](https://huggingface.co/docs/transformers.js/en/api/generation/streamers)

- M2M100 418M: 100 ngôn ngữ, license MIT. [Model card](https://huggingface.co/facebook/m2m100_418M)
- Marian OPUS en→vi: nhỏ và pair-specific. Artifact card ghi Apache-2.0, trong khi upstream OPUS-MT mô tả pretrained weights là CC-BY-4.0; phải xác minh provenance/attribution của đúng artifact trước khi đóng gói. [Model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-vi), [upstream OPUS-MT](https://github.com/Helsinki-NLP/OPUS-MT-train#pre-trained-models)
- CTranslate2 có quantization và tối ưu inference. [Performance guide](https://opennmt.net/CTranslate2/performance.html)
- NLLB-200 distilled 600M có độ phủ tốt nhưng model card là CC-BY-NC; không dùng mặc định cho sản phẩm thương mại. [Model card](https://huggingface.co/facebook/nllb-200-distilled-600M)

## Cách ưu tiên độ chính xác

Không có một bảng benchmark chung đủ để tuyên bố provider nào chính xác nhất cho mọi phim/giọng/cặp ngôn ngữ. Quy trình đúng là chạy cùng một golden set audio tab thật và đo:

- LID macro-F1, thời gian tới quyết định đúng, false switch/giờ và coverage theo confidence.
- WER/CER của transcript nguồn, riêng tên người, số, tiền tệ và thuật ngữ.
- COMET/chrF cộng đánh giá song ngữ của người Việt; không dùng BLEU từ các model card khác tập dữ liệu để xếp hạng trực tiếp.
- p50/p95 time-to-first-draft, time-to-stable và capture-to-overlay; thêm revision/flicker rate.

Live path nên dịch **stable prefix** theo cụm/clause, giữ context 1–2 câu. Khi VAD kết thúc utterance, chạy lại toàn câu với ngôn ngữ đã khóa, glossary và decoding chính xác hơn để thay draft bằng final. Chi tiết ở [AUTO_LANGUAGE_AND_ACCURACY.md](AUTO_LANGUAGE_AND_ACCURACY.md).

## Overlay

Electron hỗ trợ `transparent`, frameless, always-on-top, `setIgnoreMouseEvents()` và visible-on-fullscreen workspaces trên macOS. Đây là lựa chọn đa nền tảng thực dụng nhất cho MVP CLI. [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [custom window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).

Giới hạn: transparent window không nên resize liên tục; Wayland hạn chế z-order/position tùy compositor. Tauri nhẹ hơn nhưng transparent webview trên macOS có các lưu ý private API/App Store; chưa đáng đổi ở MVP.

## Latency budget

| Stage | Local target |
|---|---:|
| Capture/downmix/resample | 10–40 ms |
| Native streaming ASR chunk | 160–320 ms local; 20–100 ms cloud packet |
| ASR compute + network | 50–500 ms tùy engine/hardware/region |
| Stable-prefix/debounce | 80–200 ms |
| Incremental MT | 50–350 ms |
| IPC + paint | 8–33 ms |

Đường direct cloud Gemini/Azure không tách riêng ASR/MT nên đo từ audio segment end tới translated partial. Đường local/cascade phải có generation ID, hủy/bỏ MT result cũ và chỉ commit longest-common-prefix.

Thiết kế BYOK, phân loại endpoint streaming/batch và guardrail chi phí nằm tại [PROVIDERS_AND_COST.md](PROVIDERS_AND_COST.md).

Code spike Together ASR, generic MT và cascade đã qua unit test nhưng chưa được nối vào runtime/cloud thật. Đây là bằng chứng contract/lifecycle, không phải benchmark latency/accuracy hoặc quyền gửi dữ liệu.
