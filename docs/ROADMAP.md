# Kế hoạch phát triển AudioTranslate

Cập nhật: 2026-08-29. Tài liệu này chỉ liệt kê những hạng mục **chưa hoàn thiện** hoặc mới ở mức prototype. Những mục đã chạy được được ghi riêng để tránh người dùng hiểu nhầm là tính năng sẵn sàng.

## Nền tảng đã có

- Control Center React/TypeScript là giao diện chính; CLI chỉ dùng để mở app, preview, doctor và headless.
- Gemini dùng duy nhất Live Translate trực tiếp cho tab/file. Pipeline contextual hai tầng đã được gỡ vì quota riêng trên Free Tier và độ trễ bổ sung. Demo chạy hoàn toàn local; Azure chỉ dành cho headless/nâng cao.
- Tự nhận diện ngôn ngữ nguồn, thời gian khóa ngôn ngữ, độ trễ caption, RMS/peak, speech/silence, queue, packet gap và dropped frame đã được đưa lên Control Center.
- Pause/resume giữ phiên capture nhưng chặn và xóa audio đang chờ trước provider; stop/error đóng phiên và xóa queue.
- Diagnostics trong app kiểm provider, key/consent, extension/pairing, privacy, runtime và cổng local mà không trả secret hoặc raw audio.
- Overlay trong suốt có preset, kéo/khóa, font, weight, line-height, opacity, high contrast, giới hạn 1–2 dòng, tự ẩn và chọn màn hình. Gemini chỉ chốt caption tại ranh giới lượt nói; fragment được nối trong cùng câu, cửa sổ live cuộn theo hai dòng mới nhất và chỉ tự ẩn sau final.
- Gateway chỉ bind loopback, mutual HMAC, bounded queue; API key Gemini lưu qua Electron `safeStorage` khi backend hệ điều hành an toàn.
- Gemini reconnect chỉ gửi lại segment audio còn mới tối đa một giây; backlog cũ bị ghi đè trong RAM. Pairing token trên clipboard tự hết hạn sau 60 giây mà không xóa nội dung người dùng sao chép sau đó.

## Nguyên tắc phát triển

1. Local/free và BYOK được ưu tiên; không tự chuyển sang cloud khi local hoặc provider khác lỗi.
2. Mọi lần gửi audio hoặc subtitle lên cloud phải có consent rõ và hiển thị provider/model đang dùng.
3. Không đưa AI agent vào audio hot path. Agent/OpenClaw chỉ phù hợp với tác vụ batch, QA, tạo glossary hoặc phân tích lỗi không đồng bộ.
4. Không tuyên bố độ trễ `<1 giây` hay độ chính xác production trước khi có benchmark E2E trên cùng golden set.
5. Không ghi đè file nguồn. Mọi export dùng file tạm, rename nguyên tử khi hoàn tất, hỗ trợ hủy và dọn file tạm.

## Sprint 2 — độ tin cậy realtime (P0)

### 2.1 Benchmark và caption ổn định

- Ghi timestamp theo từng tầng: capture, gateway, provider event, Electron IPC và paint.
- Dashboard p50/p95 riêng cho draft, final và time-to-language; export báo cáo JSON đã khử thông tin nhạy cảm.
- Committed-prefix + mutable-tail để giảm nhấp nháy; loại kết quả sai generation hoặc đến trễ.
- History có thể mở lại toàn bộ câu final: live overlay chủ động chỉ giữ hai dòng mới nhất, vì vậy phần đã cuộn ra phải còn trong history/đánh dấu xem lại thay vì biến mất vĩnh viễn.
- Layout tiếp tục thích ứng theo chiều cao cửa sổ, DPI, font và line-height; giới hạn hai dòng đã có nhưng vẫn cần kiểm thử tổ hợp cỡ chữ lớn trên nhiều scale factor.
- Golden set gồm phim, YouTube, podcast, nhạc nền, accent và code-switch; đo WER/CER, chrF/COMET, revision rate và đánh giá song ngữ.

Tiêu chí nghiệm thu:

- Không caption nào quay lùi về generation cũ.
- Không mất nội dung final dài; nội dung không đủ thời gian hiển thị live phải còn trong history/QC.
- Báo cáo phân biệt fixed-language và auto-language; không gộp draft với final.
- Chỉ công bố mục tiêu draft p50 `<700 ms`, p95 hướng tới `<1 s` nếu benchmark thật chứng minh.

### 2.2 Recovery và audio health sâu hơn

- Phân loại lỗi provider transient/permanent, retry có bounded exponential backoff và circuit breaker.
- Phát hiện silent tab, tab mute, capture bị DRM chặn, provider quota/model/key lỗi và đưa hành động sửa đúng vào Diagnostics.
- Đo queue age phía SDK/provider để tìm backlog ẩn; cảnh báo trước khi caption trễ dây chuyền.
- Khi seek/đổi video/audio track/playback rate: flush context, queue và generation cũ.

Tiêu chí nghiệm thu:

- Pause/stop/error không gửi thêm audio; reconnect không phát lại backlog cũ.
- Mỗi lỗi phổ biến có thông báo dễ hiểu, hướng xử lý và log đã khử secret.

### 2.3 Bảo mật và lifecycle secret

- UI xoay/revoke key; migration có kiểm soát khỏi `.env`; khôi phục khi ciphertext không giải mã được.
- Kiểm tra và hiển thị backend keyring Linux; không lưu key nếu Electron chỉ có `basic_text`.
- Threat-model tiến trình local độc hại, extension giả, replay, log/crash dump và installer bị thay thế.
- Tùy chọn privacy nghiêm ngặt giữ Gemini session resumption tắt; profile continuity phải giải thích retention trước khi bật.

## Sprint 3 — Batch Subtitle Studio (P0/P1)

Đây là nhóm chức năng người dùng đã yêu cầu nhưng **chưa được triển khai trong Control Center**.

### 3.1 Dịch file SRT/VTT/ASS có sẵn

- Import kéo-thả hoặc file picker; nhận UTF-8/UTF-8 BOM và phát hiện encoding phổ biến có cảnh báo.
- Parser riêng cho SRT, WebVTT và ASS/SSA; giữ nguyên cue ID, timecode, speaker/style, position và metadata.
- Bảo vệ placeholder, HTML/VTT tag, ASS override tag, karaoke tag và drawing block khỏi model dịch.
- Dịch theo batch có context lân cận, glossary, tên riêng và retry theo cue; hỗ trợ Gemini, OpenAI-compatible text endpoint và local MT.
- Chế độ `Strict`: 1 cue vào = 1 cue ra, không đổi timing. Chế độ `Readable`: cho phép gộp/tách có kiểm soát và ghi audit log.
- QC theo profile mặc định 42 grapheme/dòng, 2 dòng và 17 CPS; đánh dấu `Cần xem lại` thay vì âm thầm cắt nội dung.
- Export SRT/VTT/ASS và bản đối chiếu song ngữ; preview trước/sau ngay trong app.

Tiêu chí nghiệm thu:

- Round-trip không dịch phải bảo toàn timing và cấu trúc có ý nghĩa của fixture SRT/VTT/ASS.
- Không làm hỏng tag/style; không mất cue; lỗi một cue không làm mất toàn bộ job.
- Cancel/restart được; checkpoint không chứa API key hoặc nội dung ngoài file người dùng đã chọn.

### 3.2 Tạo phụ đề từ audio/video

- Chọn file audio/video → trích audio → ASR có word timestamp → ổn định câu → dịch → QC → xuất subtitle.
- Profile nhanh dùng cloud streaming/batch BYOK; profile riêng tư dùng ASR/MT local khi model đã được cài.
- Đồng bộ theo media time, nhận biết silence/scene boundary và cho chỉnh delay/offset trước khi export.

### 3.3 Xuất video đã dịch

- `Soft mux`: nhúng subtitle selectable vào MKV/MP4 khi container/codec hỗ trợ.
- `Burn-in`: render subtitle vào video, luôn re-encode và cảnh báo thời gian/dung lượng/chất lượng.
- Kiểm dung lượng đĩa, progress, cancel, file tạm và tên output; tuyệt đối không ghi đè input.
- Kiểm license/cách phân phối FFmpeg trước khi đóng gói. Hiện môi trường phát triển này chưa phát hiện `ffmpeg`/`ffprobe`, vì vậy chưa thể bật chức năng export video.

Tiêu chí nghiệm thu:

- Output phát được và subtitle đồng bộ trên fixture MP4/MKV/WebM.
- Hủy giữa chừng không làm hỏng input; file tạm được dọn; metadata về provider/job được khử thông tin nhạy cảm.

## Sprint 4 — provider linh hoạt và local/offline (P1)

### 4.1 OpenAI và endpoint tương thích

- Nối adapter OpenAI Realtime Translate vào provider factory/UI sau benchmark PCM 24 kHz, lifecycle, caption events và chi phí.
- Generic OpenAI-compatible chỉ áp dụng cho **text translation** khi endpoint khai báo schema/capability rõ. Không suy luận rằng một base URL tương thích chat cũng nhận audio realtime.
- BYOK profile gồm base URL, model, key reference, retention/ZDR disclosure, timeout và cost guardrail; provider lạ phải fail-closed.
- ChatGPT Plus/Pro và Google AI Pro không được mô tả như quota API; billing API là dịch vụ/project riêng.

### 4.2 Local provider

- ASR realtime ưu tiên benchmark `sherpa-onnx + Nemotron 3.5 Streaming`; accuracy profile benchmark Qwen3-ASR.
- MT dùng sidecar CTranslate2 đã warm với M2M100 418M hoặc Marian pair-specific; không spawn process cho từng caption.
- Model Manager: manifest ký, license, revision/checksum, tải tiếp tục, dung lượng, xóa model và benchmark phần cứng.
- Không chọn NLLB/Seamless weights phi thương mại làm mặc định sản phẩm.
- Local lỗi không bao giờ tự fallback sang cloud.

Tiêu chí nghiệm thu:

- Chế độ private chạy không network sau khi model đã tải; test chặn outbound vẫn dịch được fixture.
- UI báo RAM/VRAM/disk/latency ước tính trước khi tải; checksum sai phải fail-closed.

### 4.3 Provider đối chứng

- Benchmark Together Realtime ASR + MT, Deepgram + MT và Google Chirp 3 + Translation trên cùng golden set tiếng Việt.
- Chỉ đưa provider vào picker chính khi có contract streaming thực, privacy disclosure, test lifecycle và kết quả accuracy/latency đạt ngưỡng.

## Sprint 5 — chất lượng và UX nâng cao (P1/P2)

- Lưu nhiều glossary/profile theo phim/website/cặp ngôn ngữ, import/export và hot reload có kiểm soát. Một glossary/character context cho phiên hiện tại đã có.
- Suppression nhạc/bài hát, confidence gate và cảnh báo câu có độ chắc chắn thấp. Punctuation/phrase buffering và context RAM đã có nhưng cần A/B thực tế.
- Manual subtitle delay ±5 giây; history/export transcript; điều khiển start/stop/clear/pin từ extension.
- Bilingual/original-only/translated-only; dyslexia-friendly font, safe area, screen-reader controls.
- Speaker diarization chỉ cho final/history; faster-whisper refinement không chặn live caption.
- Nhiều session/tab/overlay sau khi lifecycle một phiên đã qua stress test.

## Sprint 6 — phát hành đa nền tảng (P2)

- QA thực tế Chrome/Edge trên macOS, Windows, Linux X11/Wayland; DPI, multi-display, fullscreen và DRM.
- Signed DMG/PKG, MSIX/NSIS, AppImage/deb; ký extension, ghim ID và auto-update có chữ ký.
- Crash reporting opt-in đã khử transcript/audio/key; support bundle từ Diagnostics.
- Cost guardrail theo phút/quota, tự dừng khi im lặng lâu và cảnh báo cloud rõ ràng.

## Thứ tự ưu tiên đề xuất

1. Hoàn tất benchmark/stable-prefix/recovery của Sprint 2 để realtime path đo được và đáng tin.
2. Xây Batch Subtitle Studio 3.1 trước vì nhanh, không cần ASR/FFmpeg và đáp ứng ngay file SRT/VTT/ASS.
3. Thêm pipeline audio/video 3.2, sau đó mới soft-mux/burn-in 3.3.
4. Nối OpenAI/text-compatible và xây Local Model Manager.
5. Chạy quality/accessibility/multi-session rồi mới đóng gói installer production.

## Release gate chung

- Test unit/integration cho parser, lifecycle, queue, cancel và secret redaction; E2E thật tách khỏi test không cần key.
- Không expose gateway ra LAN, không chứa cloud key trong extension/bundle và không log PCM/transcript mặc định.
- UI phân biệt rõ `Đã dùng được`, `Thử nghiệm` và `Chưa khả dụng`; không có nút giả khiến người dùng tưởng tính năng đã hoạt động.
- Accuracy được đánh giá bằng WER/CER + chrF/COMET + human review; latency báo p50/p95 trên cùng fixture/hardware/network.
- Mọi chức năng tạo file phải có preview, đường dẫn output rõ, cancel an toàn và không ghi đè dữ liệu nguồn.
