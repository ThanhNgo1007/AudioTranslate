# Cài đặt bằng Control Center và CLI tối giản

Cập nhật: 2026-08-28.

## Bắt đầu nhanh

```bash
npm install
npm start
```

Desktop tự tạo pairing secret cục bộ ở lần chạy đầu và mở Control Center. Không có wizard terminal; người dùng không phải nhập provider, API key, ngôn ngữ hoặc pairing token vào CLI.

Control Center là nguồn cấu hình desktop:

1. Chọn **Demo** (không cloud, caption mô phỏng) hoặc **Gemini** (dịch audio thật).
2. Với Gemini, nhập, lưu/xóa và kiểm tra API key.
3. Chọn tab/file, ngôn ngữ nguồn/đích và **Tự nhận diện** nếu cần.
4. Chọn profile dịch: **Độ trễ thấp nhất**, **Cân bằng** (khuyên dùng) hoặc **Ưu tiên chính xác**. Hai profile có ngữ cảnh cho phép thêm thuật ngữ và mô tả nhân vật.
5. Đọc đường dữ liệu, xác nhận cloud consent và tinh chỉnh overlay.
6. Bắt đầu/dừng phiên, ẩn xuống tray hoặc thoát ứng dụng.

Demo và Gemini là hai lựa chọn chạy được trong provider picker. OpenAI và Local có thể được hiển thị để định hướng nhưng bị vô hiệu hóa. Azure không nằm trong provider picker desktop; adapter Azure chỉ dành cho workflow headless/environment nâng cao.

Gemini key desktop không được ghi plaintext vào `.env`. Key đi một lần qua IPC cô lập tới Electron main và được lưu bằng `safeStorage`; nếu Linux chỉ có backend `basic_text`, key chỉ được giữ trong phiên.

Không truyền key hoặc pairing secret trên command line và không gửi key, `.env` hoặc pairing secret khi báo lỗi.

## Chọn provider nào?

| Lựa chọn | Trạng thái | Dữ liệu | Chi phí cần hiểu |
|---|---|---|---|
| Gemini ba profile | Chạy được trong Control Center | Audio tab/file đã chọn và context tùy profile gửi tới Google | Free/Paid Tier tùy từng model/project/quota |
| Demo an toàn | Chạy được trong Control Center | Không gửi audio | Miễn phí; caption mô phỏng, không dịch audio thật |
| Azure Speech | Adapter headless/nâng cao; không có trong picker desktop | Audio tab gửi tới Azure | F0 có thể có quota; S0/pay-as-you-go |
| OpenAI Realtime Translate | Hiển thị nhưng chưa bật | Chưa gửi dữ liệu | API billing riêng với ChatGPT |
| Together ASR + text MT | Module thử nghiệm, chưa bật | Chưa gửi dữ liệu | ASR và MT có thể tính riêng |
| Local/offline | Hiển thị nhưng chưa bật | Mục tiêu xử lý trên máy | Không phí API nhưng cần model/tài nguyên |

AudioTranslate không bán gói Premium. BYOK có nghĩa tự cung cấp key hợp lệ; không đồng nghĩa provider miễn phí.

## API key Gemini không phải gói Google AI Pro

Tạo key cho **Gemini API project** trong Google AI Studio/Google Cloud. Thuê bao Google AI Pro/Gemini Advanced là quyền lợi ứng dụng dành cho người dùng cuối, không nên được coi là API key hoặc API credit vô hạn. Project API có quota, Free/Paid Tier và billing riêng. Kiểm tra [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key), [pricing](https://ai.google.dev/gemini-api/docs/pricing) và [billing](https://ai.google.dev/gemini-api/docs/billing).

## Dịch tab Chrome/Edge

1. Load unpacked thư mục `extension` tại `chrome://extensions` hoặc `edge://extensions`.
2. Chạy desktop app, chọn **Browser tab** và ngôn ngữ trong Control Center.
3. Xác nhận quyền riêng tư rồi nhấn **Bắt đầu dịch** trong Control Center; gateway cục bộ chỉ mở sau thao tác này.
4. Mở tab video rồi mở popup extension.
5. Chọn **Sao chép mã ghép nối** trong Control Center (hoặc dùng menu tray), rồi dán token vào **Kết nối nâng cao**. Raw token được Electron main đưa thẳng vào clipboard, không trả vào renderer; extension chỉ giữ secret trong browser session và dùng cho HMAC hai chiều.
6. Nhấn **Bắt đầu dịch tab này** để cấp quyền capture cho đúng tab.

Gemini desktop không bắt buộc danh sách gợi ý source: chọn **Tự nhận diện** trong Control Center là đủ. Headless có thể nhận tối đa 8 gợi ý như `en`, `ja-JP`, `ko-KR` qua cấu hình tiến trình. Popup extension chỉ cấp quyền capture tab và nhập kết nối loopback/pairing; provider, source/target và cách hiển thị phụ đề được quản lý trong Control Center và không thể bị popup ghi đè.

## Dịch file

Trong Control Center, chọn **Audio file** và mở file. File picker không cho app tự quét thư mục. Audio được giải mã/resample trong bộ nhớ, gửi thành PCM theo queue giới hạn và bị xóa khỏi queue khi dừng/lỗi. Codec khả dụng phụ thuộc Electron/OS.

## Azure chỉ dành cho headless/nâng cao

Azure không được cấu hình qua Control Center trong bản này. Nếu chủ động dùng adapter headless, hãy tạo Azure Speech resource, kiểm tra F0/S0 rồi cung cấp `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, provider, source/target, cloud consent, guardrail và pairing secret qua environment hoặc secret manager của runner. Auto source cần 2–4 full locale khác base language.

Không nhập Azure key vào CLI hoặc command history. Guardrail phút của app không phải billing cap ở provider.

## Lệnh hữu ích

```bash
npm start                               # mở Control Center + overlay
npm run providers                       # provider/cost/privacy hiện tại
npm run doctor                          # chẩn đoán dependency/port/profile headless
npm run headless                        # caption trong terminal
npm run preview                         # UI mô phỏng, không cloud
npm run verify                          # syntax + tests + build UI

node bin/audiotranslate.js config show  # cấu hình headless đã che secret
node bin/audiotranslate.js config path  # đường dẫn .env
node bin/audiotranslate.js config edit  # mở Control Center
node bin/audiotranslate.js guide        # hướng dẫn nhanh
```

Sau `npm link`, các lệnh `audiotranslate`, `audiotranslate open`, `audiotranslate start`, `audiotranslate setup` và `audiotranslate config edit` đều mở cùng Control Center ở chế độ desktop. `setup` và `config edit` chỉ là alias tương thích; chúng không mở wizard hoặc sửa `.env`.

## Headless và automation

Headless không có Control Center và không đọc Gemini key từ desktop `safeStorage`. Hãy cung cấp API key, pairing token và cloud consent qua environment, `.env` được bảo vệ hoặc secret injection của CI/runner, rồi chạy:

```bash
npm run headless
```

Tối thiểu, Gemini headless cần provider, Gemini API key, cloud consent và pairing secret mạnh. Source/target, candidate hints và guardrail có thể nằm trong environment. Headless dùng Live Translate trực tiếp; [`.env.example`](../.env.example) chỉ giữ `GEMINI_LIVE_MODEL` làm model override thử nghiệm. `--translation-mode` và các model Transcribe/Text đã bị loại bỏ. Các cờ không nhạy cảm tương ứng chỉ được chấp nhận cho `start --headless`; CLI fail-closed khi thiếu cấu hình bắt buộc và không hỏi secret tương tác trong pipe/CI.

## Cập nhật hoặc xóa key

- Gemini desktop: dùng Control Center để thay/xóa key đã lưu.
- Gemini headless/automation: xóa `GEMINI_API_KEY` khỏi `.env` hoặc secret injection của runner.
- Azure headless/nâng cao: xóa `AZURE_SPEECH_KEY` khỏi environment/secret store, rồi chạy `npm run doctor` với cùng profile headless.

Thay key sẽ làm trạng thái kiểm tra provider hết hiệu lực; cần chọn **Kiểm tra kết nối** lại trước khi bắt đầu.

## Chi phí và giới hạn trung thực

- Gemini Free/Paid Tier phụ thuộc project/model/quota; model Live Translate hiện là preview.
- OpenAI API có billing riêng với ChatGPT Plus/Pro.
- Azure F0/S0, quota và bill thuộc tài khoản Azure.
- Guardrail app chỉ dừng phiên hiện tại; hãy cấu hình budget/quota/alert trực tiếp tại provider.
- Không provider nào trong tài liệu này được xem là có SLA phụ đề `<1 giây`; cần benchmark E2E bằng key, mạng và audio thật.
