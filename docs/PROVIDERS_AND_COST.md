# Provider linh hoạt, BYOK và kiểm soát chi phí

Cập nhật: 2026-08-24.

## Trả lời ngắn

Công cụ hỗ trợ **BYOK** (Bring Your Own Key) cho provider đã có adapter kiểm chứng. Gemini, Azure và demo hiện được nối runtime; profile generic `protocol`/`baseUrl`/`model` là hướng mở rộng. “OpenAI-compatible” chỉ mô tả một schema HTTP, **không bảo đảm** endpoint có audio streaming, interim transcript, auto-LID hay latency dưới một giây.

Runtime hiện ưu tiên Gemini Live Translate cho tab/file, đồng thời giữ Azure Speech và demo. Codebase còn có BYOK registry fail-closed, Together WebSocket ASR, OpenAI-compatible text translator và cascade orchestration với fake-provider tests; các module này chưa được factory/nút Start gọi vì sẽ gửi dữ liệu tới thêm endpoint và cần consent + E2E benchmark riêng. Không được quảng bá một endpoint generic là realtime chỉ vì unit test pass.

Control Center là nguồn cấu hình cho desktop: Demo và Gemini có thể chọn/chạy; OpenAI và Local được hiển thị nhưng bị vô hiệu hóa. Gemini key, ngôn ngữ và consent được nhập trong UI; key đi vào `safeStorage` thay vì `.env`. Azure vẫn có adapter nâng cao cho headless/environment nhưng không nằm trong provider picker desktop. CLI chỉ mở Control Center hoặc chạy các lệnh vận hành như `doctor`, `providers`, `preview` và `--headless`; nó không hỏi provider/API/ngôn ngữ/token. Xem [hướng dẫn onboarding](CLI_ONBOARDING.md).

## Tách hai lớp để có nhiều lựa chọn rẻ hơn

```text
tab/file audio
  → ASR/direct translate: PCM streaming → transcript partial/final
  → MT: stable text prefix → translated partial/final
  → overlay
```

Ba loại adapter không được trộn lẫn:

| Loại | Giao thức | Vai trò |
|---|---|---|
| Direct speech translation | WebSocket/session nhận PCM liên tục | Ít tầng nhất; Azure, OpenAI Realtime Translate, Gemini Live Translate |
| Streaming ASR + text MT | WebSocket ASR thật, sau đó endpoint MT local/cloud | Linh hoạt và thường rẻ hơn; ưu tiên cho BYOK |
| Chunked/batch ASR + text MT | Upload WAV/FLAC/base64 từng đoạn | Final/refinement; không mặc định cho mục tiêu `<1 s` |

Hướng BYOK ưu tiên là **streaming ASR chuyên dụng hoặc local ASR + generic text MT**. Text MT có thể dùng endpoint `/chat/completions` tương thích OpenAI của nhiều nhà cung cấp, nhưng phải giữ một request tại một thời điểm, gắn generation ID và bỏ kết quả cũ khi ASR sửa hypothesis.

## Các lựa chọn đã kiểm tra

| Lựa chọn | Khả năng thực tế | Quyết định |
|---|---|---|
| Gemini Live Translate preview | Direct PCM16 16 kHz realtime, auto source liên tục, 0–8 hints và translated text stream | Adapter ưu tiên đã nối tab/file. Cần key Gemini API project, consent và benchmark vì model preview; output audio bị bỏ. |
| Local sherpa-onnx + Nemotron, CTranslate2/Marian | ASR streaming và MT chạy trên máy; không có phí API | Đích local-first. Bản EN→VI cần khoảng 0,8–1+ GB model/runtime; phải benchmark CPU và đóng gói sidecar. |
| Together Realtime Transcription | WebSocket thật, PCM16 mono 16 kHz, transcript delta/final và VAD; có raw protocol dùng được từ Node | Ưu tiên adapter cloud-ASR đầu tiên. Whisper Large v3 streaming hiện USD 0,0035/phút (~0,21/giờ), Nemotron 3.5 USD 0,0045/phút (~0,27/giờ); vẫn cần MT text riêng. |
| Deepgram Nova-3 | STT WebSocket, interim/final, Vietnamese và language detection; tính phí theo giây | Ứng viên cloud-ASR giá/latency tốt; cần MT text riêng. Trang giá hiện nêu khoảng USD 0,29/giờ monolingual và 0,35/giờ multilingual, phải kiểm tra lại trước release. |
| OpenRouter STT/audio | `/audio/transcriptions` nhận multipart/base64 theo request; audio input cũng có trong `chat/completions` | Không có WebSocket STT được tài liệu hóa; chỉ dùng final/refinement. OpenRouter text models vẫn phù hợp làm MT BYOK sau ASR. |
| Groq Whisper | OpenAI-compatible `/audio/transcriptions`; upload file/URL | Rất nhanh nhưng là request theo file, mỗi request ngắn vẫn bị tính tối thiểu 10 giây; endpoint audio translation chỉ dịch sang English. Không dùng như direct source→Vietnamese live path. |
| Hugging Face Inference Providers | Một token/proxy cho nhiều provider; ASR task nhận bytes/base64 | Hợp benchmark/final hoặc failover; ASR task được tài liệu hóa theo request, không phải stateful audio stream. OpenAI-compatible endpoint của HF hiện chỉ dành cho chat. |
| LiteLLM self-hosted | Proxy OpenAI-compatible, cost tracking/fallback cho audio transcription và text; `/realtime` chỉ hỗ trợ một tập provider cụ thể | Hợp làm control plane/MT/final-ASR. Together Realtime chưa nằm trong danh sách `/realtime`, nên adapter Together vẫn nối trực tiếp. |
| Cloudflare AI Gateway | BYOK/unified gateway; proxy realtime WebSocket cho OpenAI, Google AI Studio, Deepgram và một số provider khác | Hữu ích để quan sát, rate-limit và đổi route. Gateway không biến batch API thành realtime audio và vẫn phát sinh phí provider/Cloudflare tương ứng. |
| Azure Speech Translation F0 | Direct streaming translation; 5 giờ audio miễn phí/tháng, 1 concurrent request | Baseline thử nghiệm hợp lý. S0/vượt quota là trả phí; kiểm tra tier trong Azure Portal. |

Nguồn chính thức: [Gemini Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [Together streaming transcription](https://docs.together.ai/docs/inference/transcription/streaming), [Together pricing](https://www.together.ai/pricing), [Deepgram live WebSocket](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [Deepgram model/language](https://developers.deepgram.com/docs/models-languages-overview/), [Deepgram pricing](https://deepgram.com/pricing), [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt), [Groq Speech-to-Text](https://console.groq.com/docs/speech-to-text), [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/en/index), [HF ASR task](https://huggingface.co/docs/inference-providers/main/tasks/automatic-speech-recognition), [LiteLLM audio transcription](https://docs.litellm.ai/docs/audio_transcription), [LiteLLM realtime](https://docs.litellm.ai/docs/realtime), [Cloudflare realtime gateway](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/), [Azure Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/).

## Provider config đề xuất

Không lưu secret trực tiếp trong profile. Profile chỉ tham chiếu tên biến môi trường hoặc secret-store key:

```yaml
asr:
  protocol: together-transcription-realtime-v1
  baseUrl: wss://api.together.ai/v1/realtime
  model: nvidia/nemotron-3.5-asr-streaming-0.6b
  apiKeyEnv: TOGETHER_API_KEY
  language: en-US

mt:
  protocol: openai-chat-completions
  baseUrl: https://router.example/v1
  model: provider/model-id
  apiKeyEnv: TRANSLATION_API_KEY
  targetLanguage: vi
```

Mỗi protocol adapter phải công bố capability đã kiểm chứng: `audioTransport`, `partialTranscript`, `partialTranslation`, `autoLanguage`, `supportedPairs`, `billingUnit` và `latencyStatus`. Chỉ cho cấu hình URL/model không đủ để suy ra capability.

## Guardrail bảo mật và chi phí

- Cloud provider là explicit opt-in; không tự fallback từ local hỏng sang cloud.
- Key chỉ ở process local; extension và local WebSocket không nhận cloud key. Gemini desktop dùng Electron `safeStorage`; backend Linux `basic_text` bị hạ xuống session-only. `.env` chỉ dành cho headless/automation hoặc adapter Azure nâng cao, không phải luồng cài đặt desktop.
- Chỉ chấp nhận `https:`/`wss:` cho cloud và loopback/stdio cho local. Chặn URL có user-info, redirect khác origin, private-network endpoint trong cloud profile và header tùy ý từ extension.
- Adapter đặt timeout, giới hạn response/event size, bounded queue và log đã redact. Không log Authorization, audio hoặc transcript mặc định.
- Hiện rõ provider thực tế, LOCAL/CLOUD, đơn vị tính phí và thời lượng đã gửi; cho đặt ngân sách/phút tối đa và tự dừng.
- Ghim model/version khi benchmark; router có thể đổi upstream nên phải lưu cả provider/model thực tế từ response nếu có.
- Không gửi chunk 1 giây vào API có minimum billing 10–15 giây mà không tính hệ số đội chi phí.
- Chỉ dùng key do chính tài khoản của người dùng tạo ở provider/router chính thức. Không hỗ trợ key reseller không rõ nguồn gốc hoặc key dùng chung vì có rủi ro vi phạm điều khoản, bị thu hồi và lộ audio/transcript.

Sau Gemini direct path, ưu tiên tiếp theo là local engine và đường cloud chi phí thấp Together WebSocket ASR → MT text BYOK/local. Deepgram Nova-3 là đối chứng realtime thứ hai. Groq/OpenRouter/HF/LiteLLM audio-transcription chỉ làm final/fallback cho tới khi chính endpoint được chọn có contract streaming thật.

Trước khi nối cascade vào runtime, người dùng phải chốt: Together ASR model, MT `baseUrl`/model, nơi lưu key, chính sách retention/ZDR và ngân sách. Sau đó mới thêm provider vào factory/doctor/CLI và chạy audio E2E; không tự kích hoạt từ một profile tài liệu.

## Gói ChatGPT/Gemini và API

AudioTranslate không có gói trả phí riêng. “Trả phí” ở đây là phí API do provider tính cho key BYOK của người dùng.

ChatGPT subscription và OpenAI API được quản lý thanh toán riêng. Gemini API dùng key của project với Free/Paid Tier và quota phụ thuộc model/project; Google AI Pro/Gemini Advanced là gói ứng dụng và không nên được hiểu là API key hoặc API vô hạn. Together là prepaid và không có free trial phổ quát. Kiểm tra trực tiếp [OpenAI API billing](https://help.openai.com/en/articles/9039756), [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key), [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing) và [Together billing](https://docs.together.ai/docs/billing-credits) trước khi bật provider.
