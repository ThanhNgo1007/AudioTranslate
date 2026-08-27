# AudioTranslate Live

AudioTranslate nhận audio từ **tab Chrome/Edge** hoặc **tệp người dùng chủ động chọn**, dịch trực tiếp bằng Gemini Live Translate và hiển thị phụ đề trên một overlay trong suốt, always-on-top. CLI vẫn tối giản, kèm demo local và adapter Azure cho headless/nâng cao.

> Mốc `<1 giây` là mục tiêu thiết kế cho **bản dịch nháp** trong điều kiện mạng/model thuận lợi, không phải SLA. Bản final cần thêm ngữ cảnh và có thể chậm hơn.

## Những gì đã triển khai

- Control Center bằng React/TypeScript là nơi cấu hình desktop: chọn Demo/Gemini, lưu/kiểm tra Gemini API key, chọn tab hoặc file, chọn ngôn ngữ, trạng thái và overlay.
- Gemini chỉ dùng đường trực tiếp `gemini-3.5-live-translate-preview`; pipeline dịch văn bản contextual đã được gỡ để tránh quota riêng và thêm độ trễ trên Free Tier.
- Capture đúng tab Chrome/Edge bằng Manifest V3 `tabCapture` + offscreen document + `AudioWorklet`; âm thanh video vẫn phát bình thường.
- Đọc file bằng file picker; giải mã trong renderer cô lập, resample thành PCM16 mono 16 kHz và stream theo hàng đợi giới hạn thay vì upload tự động cả thư mục.
- Overlay trong suốt, always-on-top; chọn màn hình/vị trí/preset, khóa hoặc mở chỉnh sửa, chỉnh typography, high contrast, 1–2 dòng, tự ẩn và hiển thị transcript gốc. Các fragment trong cùng lượt nói được nối thành một câu; cửa sổ phụ đề cuộn theo hai dòng mới nhất thay vì phát lại từ đầu hoặc cắt bằng dấu ba chấm.
- Control Center hiển thị tín hiệu audio thật (RMS/peak/speech/silence), queue/gap/drop, ngôn ngữ được nhận diện, thời gian khóa ngôn ngữ và độ trễ caption; cảnh báo khi vượt mục tiêu 1 giây.
- Pause/resume chặn và xóa audio đang chờ trước provider nhưng giữ phiên capture; Diagnostics kiểm provider/key/consent, extension/pairing, privacy, runtime và cổng local mà không trả secret/raw audio.
- Local gateway chỉ bind `127.0.0.1`, kiểm origin và xác thực HMAC hai chiều trước khi chấp nhận audio.
- Gemini API key do người dùng nhập trong Control Center được chuyển một lần qua IPC cô lập tới Electron main, lưu bằng `safeStorage` và không bao giờ được trả ngược trong snapshot hay đưa vào extension.
- Demo local không dùng API; Azure Speech Translation vẫn chạy được nếu người dùng chủ động chọn và cấu hình.
- CLI tối giản để mở Control Center, chạy preview/doctor/provider catalog hoặc headless, cùng unit/integration tests.

OpenAI Realtime Translate, Together cascade và local/offline engine đang ở lộ trình, chưa được nút Start kích hoạt.

## Kiến trúc ngắn

```text
Chrome/Edge tab ── tabCapture + AudioWorklet ─┐
                                              ├─ PCM16 16 kHz
File picker ── decode/resample trong bộ nhớ ──┘
                    ↓
       WebSocket loopback + mutual HMAC
                    ↓
        local gateway → Gemini Live Translate trực tiếp
                    ↓
       Electron main → transparent overlay
```

Audio chỉ được gửi sau khi người dùng bấm bắt đầu, local app và client xác thực lẫn nhau, provider xác nhận phiên và cloud consent đang hợp lệ.

## Cài đặt nhanh

Yêu cầu: Node.js 22.12+; khuyến nghị Node.js 24 LTS, npm, Chrome hoặc Edge 116+.

macOS/Linux:

```bash
cd /path/to/AudioTranslate
nvm use 24
npm install
npm start
```

Windows PowerShell:

```powershell
cd C:\path\to\AudioTranslate
npm install
npm start
```

Lần chạy desktop đầu tiên tự tạo pairing secret cục bộ rồi mở Control Center. Không cần nhập provider, API key, ngôn ngữ hay pairing token trong terminal.

Trong Control Center:

1. Chọn **Demo** để xem thử không cloud hoặc **Gemini** để dịch audio thật. OpenAI và Local chỉ được hiển thị là chưa khả dụng; Azure không nằm trong provider picker desktop.
2. Với Gemini, dán API key và chọn **Lưu an toàn**.
3. Chọn **Kiểm tra kết nối**; thao tác này mở một phiên Live Translate ngắn để kiểm key/model.
4. Chọn nguồn **Browser tab** hoặc **Audio file**, rồi chọn ngôn ngữ nguồn/đích. Có thể để nguồn ở **Tự nhận diện**.
5. Đọc đường dữ liệu, xác nhận gửi audio đã chọn tới Google, chỉnh overlay rồi nhấn bắt đầu.

Nếu chỉ muốn xem giao diện với phụ đề mô phỏng, không gửi audio lên cloud:

```bash
npm run preview
```

## Gemini API key và chi phí

Key dùng cho AudioTranslate phải là **Gemini API key của một Google AI project**, thường được tạo trong Google AI Studio/Google Cloud. Thuê bao ứng dụng Google AI Pro/Gemini Advanced không nên được hiểu là API key hoặc hạn mức API vô hạn; Free/Paid Tier, quota và billing được quyết định riêng theo project/model. Xem [hướng dẫn API key](https://ai.google.dev/gemini-api/docs/api-key) và [bảng giá Gemini API](https://ai.google.dev/gemini-api/docs/pricing).

AudioTranslate không bán gói Premium. Mọi chi phí cloud là chi phí provider của key BYOK:

- Gemini: Free Tier hoặc Paid Tier tùy project/model/quota.
- Azure: có thể có F0 quota; S0/pay-as-you-go tính riêng trong tài khoản Azure.
- OpenAI: API billing tách khỏi ChatGPT Plus/Pro và adapter realtime hiện chưa bật.

Guardrail số phút trong app chỉ tự dừng phiên; nó **không phải** billing cap ở Google/Azure.

Theo bảng giá Google được kiểm tra ngày 24-08-2026, `gemini-3.5-live-translate-preview` có Free Tier theo quota; Paid Tier tương đương khoảng **0,0368 USD/phút** cho cả audio vào và audio dịch ra. Google ghi Free Tier có thể dùng dữ liệu để cải thiện sản phẩm, còn Paid Tier thì không. Giá và quota có thể thay đổi nên Control Center không hard-code chúng thành cam kết.

## Cài extension Chrome/Edge

Chrome:

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `<project>/extension`.

Edge làm tương tự tại `edge://extensions`.

Sau đó:

1. Giữ AudioTranslate desktop đang chạy, chọn nguồn **Browser tab**, provider và ngôn ngữ trong Control Center.
2. Xác nhận quyền riêng tư rồi nhấn **Bắt đầu dịch** trong Control Center. Ứng dụng sẽ mở gateway cục bộ và chờ extension.
3. Mở tab phim/video và bắt đầu phát.
4. Mở popup extension để ghép nối và cấp quyền capture đúng tab. Provider, source/target và cách hiển thị phụ đề chỉ được chọn trong Control Center; popup không thể ghi đè các cấu hình này.
5. Ở **Kết nối nâng cao**, dán mã ghép nối được desktop tự tạo. Chọn **Sao chép mã ghép nối** trong Control Center hoặc dùng menu tray; không cần chạy setup trong terminal. Raw token được sao chép bởi Electron main và không được trả vào renderer UI.
6. Nhấn **Bắt đầu dịch tab này** trong extension.

Với Gemini desktop, chọn **Tự nhận diện** trong Control Center; chế độ này hoạt động không cần danh sách gợi ý. Headless có thể cung cấp tối đa 8 gợi ý như `en`, `ja-JP`, `ko-KR` qua cấu hình tiến trình. Trong profile Azure headless/nâng cao, gateway yêu cầu đúng 2–4 locale đầy đủ và mỗi base language chỉ xuất hiện một lần. Gateway luôn xác thực cấu hình theo provider đang chạy; extension chỉ gửi xác thực pairing và audio của tab do người dùng chọn.

`tabCapture` cần thao tác chủ động của người dùng. Capture tiếp tục khi popup đóng; dừng khi người dùng nhấn Dừng, stream/tab đóng hoặc có lỗi xác thực/provider nghiêm trọng.

## Dùng file audio

Chọn **Audio file** trong Control Center rồi mở một file mà trình duyệt nhúng của Electron giải mã được. Ứng dụng:

- chỉ đọc file do người dùng chọn;
- giải mã và resample trong bộ nhớ;
- giữ queue PCM có giới hạn và xóa buffer khi dừng/lỗi;
- chỉ truyền PCM tới Gemini sau consent và khi route cục bộ đã sẵn sàng;
- không tạo bản sao audio hoặc transcript history trên đĩa.

Định dạng hỗ trợ thực tế phụ thuộc codec mà Electron/Chromium trên hệ điều hành đó cung cấp.

## CLI

```bash
npm start                              # mở Control Center + overlay
npm run providers                      # trạng thái, privacy và mô hình chi phí
npm run doctor                         # kiểm config/dependency/port/provider
npm run headless                       # gateway + caption terminal
npm run preview                        # UI + caption mô phỏng, không cloud
npm run verify                         # syntax, tests và build Control Center

node bin/audiotranslate.js config show
node bin/audiotranslate.js guide
```

Sau `npm link`:

```bash
audiotranslate                         # mở Control Center
audiotranslate open                    # mở Control Center
audiotranslate setup                   # alias tương thích: mở Control Center
audiotranslate providers
audiotranslate start
audiotranslate start --headless
audiotranslate preview
audiotranslate doctor --json
```

`audiotranslate`, `open`, `start`, `setup` và `config edit` đều mở cùng Control Center trong chế độ desktop; chúng không hỏi provider, API key, ngôn ngữ hoặc pairing token trong terminal.

Headless/automation không có Control Center và không đọc secret đã lưu bằng `safeStorage`. API key, pairing token và cloud consent bắt buộc phải đến từ environment/`.env` được bảo vệ hoặc secret injection của runner; các cờ provider/ngôn ngữ chỉ là override nâng cao cho `start --headless`. `GEMINI_API_KEY` trong `.env` chỉ dành cho đường này. Không truyền API key hay pairing token bằng command-line argument.

Headless dùng cùng đường Live Translate trực tiếp. Chỉ `GEMINI_LIVE_MODEL` còn được hỗ trợ để ghi đè model trong thử nghiệm có kiểm soát; CLI không còn nhận `--translation-mode`.

## Overlay

Phím tắt:

- `Ctrl/⌘ + Alt + S`: ẩn/hiện overlay.
- `Ctrl/⌘ + Alt + I`: khóa/mở khóa để kéo và chỉnh cửa sổ.
- `Ctrl/⌘ + Alt + R`: đưa overlay về vị trí mặc định.

Control Center cho chọn màn hình, vị trí/preset, cỡ và độ đậm chữ, line-height, 1–2 dòng, độ mờ nền, chiều rộng tối đa, high contrast, thời gian tự ẩn, hiển thị câu gốc và khóa/mở chỉnh sửa overlay. Trong một lượt nói, draft mới thay thế draft cũ nhưng giữ toàn bộ câu đang tích lũy; khi vượt hai dòng, các từ cũ cuộn ra và hai dòng mới nhất luôn ở lại. Overlay chỉ bắt đầu đếm thời gian tự ẩn sau tín hiệu kết thúc lượt nói/ngắt câu; draft đang nói không tự biến mất và caption final dài không quay lại phát từ trang đầu.

## Bảo mật và riêng tư

- Gateway chỉ nghe ở `127.0.0.1`; extension chỉ chấp nhận `ws://127.0.0.1:<port>`.
- Manifest có key ổn định; `.env.example` ghim extension ID `docfjemeacdakckkamiiopljhmgjgfgl`. Bản build/ký bằng key khác phải cập nhật allowlist.
- Mã ghép nối chỉ lưu trong `chrome.storage.session`. Hai phía chứng minh cùng biết secret bằng nonce + HMAC-SHA-256; secret không được gửi như bearer token qua WebSocket.
- Không gửi PCM trước ACK `started`; pre-roll/backpressure đều có giới hạn và frame cũ bị bỏ để tránh backlog âm thầm.
- Gemini key không đi vào extension hay local WebSocket. Chuỗi người dùng đang nhập tồn tại tạm trong ô key của Control Center; sau khi IPC lưu, app không trả secret về renderer. [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) mã hóa bằng backend hệ điều hành khi khả dụng; nếu Linux chỉ có backend `basic_text`, app giữ key trong phiên thay vì lưu plaintext.
- Electron bật sandbox, context isolation, tắt Node integration và chỉ expose IPC được allowlist.
- Không log Authorization/audio/transcript theo mặc định và không ghi audio/transcript xuống đĩa trong live path.
- Mặc định không bật Gemini session resumption: khi Google xoay kết nối, app mở phiên mới và chấp nhận mất một ít ngữ cảnh thay vì yêu cầu lưu trạng thái phiên có thể khôi phục. Chỉ đặt `GEMINI_SESSION_RESUMPTION=true` sau khi đã đọc chính sách lưu giữ liên quan.
- Cloud luôn cần consent rõ; không tự fallback từ local/demo sang Gemini hay Azure.

Không thể hứa “bảo mật tuyệt đối”. Khi dùng Gemini, PCM của nguồn đã chọn rời thiết bị và được Google xử lý theo điều khoản/chính sách của project. Malware, tài khoản quản trị hoặc công cụ có đặc quyền trên máy vẫn có thể đọc bộ nhớ/âm thanh; nội dung DRM có thể bị trình duyệt chặn capture. Hãy dùng key riêng, giới hạn quota, không chia sẻ `.env`/pairing secret và chỉ chạy extension/binary tin cậy.

## Độ trễ và giới hạn

Ngân sách nháp mục tiêu:

| Thành phần | Mục tiêu |
|---|---:|
| Capture/resample/packet | 20–100 ms |
| Local WebSocket + IPC/paint | 10–40 ms |
| Network + Live Translate draft | 250–850 ms, cần benchmark theo mạng/cặp ngôn ngữ |
| **Draft target** | **p50 350–700 ms; p95 hướng tới <1 s** |

Pipeline **Cân bằng/Ưu tiên chính xác** thêm một lần gọi text model nên không dùng bảng mục tiêu Live Translate làm cam kết. Telemetry đã thu local queue, first-readable, partial-to-final, usage và result-to-RAF, nhưng vẫn cần A/B bằng key/mạng/audio thật để công bố p50/p95 và chi phí. Gemini preview/Free Tier có thể thay đổi availability, quota và event timing; auto detect vẫn cần đủ speech.

Giới hạn khác:

- Một capture session tại một thời điểm.
- Chưa có speaker diarization trực tiếp; công cụ không tự gán lâu dài giới tính hoặc danh tính người nói.
- Chưa có engine local/offline để dịch audio thật không qua cloud.
- File codec phụ thuộc Electron/OS; nội dung DRM/protected có thể không capture được.
- Wayland có thể giới hạn z-order/vị trí của overlay.
- Cần benchmark E2E bằng key, audio và mạng thật trước khi coi p95/accuracy là đạt production.
- Batch Subtitle Studio (dịch SRT/VTT/ASS, tạo phụ đề từ video và soft-mux/burn-in) chưa có trong app; kế hoạch và tiêu chí nghiệm thu nằm trong roadmap.

## Tài liệu

- [Cài đặt bằng Control Center và CLI tối giản](docs/CLI_ONBOARDING.md)
- [Kiến trúc, protocol và security boundary](docs/ARCHITECTURE.md)
- [Tự nhận diện ngôn ngữ và chiến lược độ chính xác](docs/AUTO_LANGUAGE_AND_ACCURACY.md)
- [Provider linh hoạt, BYOK và kiểm soát chi phí](docs/PROVIDERS_AND_COST.md)
- [Nghiên cứu kỹ thuật và lựa chọn engine](docs/TECHNICAL_RESEARCH.md)
- [OpenClaw / AI-agent workflow](docs/AI_AGENT_WORKFLOW.md)
- [Kế hoạch phát triển các chức năng chưa hoàn thiện](docs/ROADMAP.md)
