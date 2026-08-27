# Kiến trúc AudioTranslate Live

Cập nhật: 2026-08-28.

## Luồng dữ liệu

```text
Chrome/Edge popup ─ user gesture ─ tabCapture stream ID
        ↓
MV3 offscreen document + AudioWorklet ─ PCM16 mono 16 kHz / 20 ms ─┐
                                                                   │
Control Center file picker + Web Audio decode/worklet ─ 100 ms ────┤
                                                                   ▼
                              RealtimeGateway @ 127.0.0.1
                                mutual HMAC + bounded queues
                                           ↓
                      TranslationProvider ─┬─ GeminiLiveTranslator
                                           ├─ AzureSpeechTranslator (tùy chọn)
                                           └─ DemoTranslator
                                           ↓
                         Electron main → isolated preload → overlay
```

Service worker chỉ điều phối capture và trạng thái. Offscreen document giữ Web Audio graph sau khi popup đóng; captured stream được nối lại `AudioContext.destination` để người xem vẫn nghe audio gốc.

File source không nhận đường dẫn tùy ý từ web content. Người dùng phải chọn file qua file picker của Control Center. Renderer giải mã/resample trong bộ nhớ; preload giữ `sessionId` riêng và gửi các chunk PCM đã giới hạn qua IPC được kiểm sender. `FileSourceSessionManager` kiểm thứ tự, queue/backpressure, consent/destination rồi xóa buffer khi dừng hoặc lỗi.

## Handshake và xác thực cục bộ

WebSocket `open` chưa đồng nghĩa provider sẵn sàng. Trình tự tab/file client:

1. Gateway gửi `hello` gồm protocol, provider/capabilities và thử thách HMAC của server.
2. Client dùng pairing secret để xác minh `serverProof`; sai thì chặn gửi audio.
3. Client tạo nonce riêng và gửi `start.authentication.clientProof`.
4. Gateway xác minh proof một lần, kiểm source/target/consent rồi khởi động provider.
5. Chỉ sau ACK `started` client mới flush pre-roll và gửi PCM realtime.

Pairing secret là khóa HMAC cục bộ; nó **không xuất hiện trong control message** và không được gửi như bearer token:

```json
{
  "type": "start",
  "protocolVersion": 1,
  "sourceLanguage": "auto",
  "sourceLanguageCandidates": ["en", "ja-JP"],
  "targetLanguage": "vi",
  "showSource": true,
  "authentication": {
    "scheme": "hmac-sha256-v1",
    "clientNonce": "<random-base64url>",
    "clientProof": "<hmac-base64url>"
  }
}
```

Payload proof được domain-separate bằng chuỗi `ATR1|server|...` và `ATR1|client|...`; nonce mới chống replay cùng challenge. Pairing secret ở extension chỉ nằm trong `chrome.storage.session` và bị xóa khi browser session kết thúc.

## Binary protocol ATR1

Mỗi WebSocket binary message chứa một chunk PCM:

| Offset | Size | Type | Ý nghĩa |
|---:|---:|---|---|
| 0 | 4 | uint32 LE | magic `ATR1` (`0x31525441`) |
| 4 | 4 | uint32 LE | sequence tăng dần |
| 8 | 8 | float64 LE | Unix epoch milliseconds khi frame được đóng gói |
| 16 | N | bytes | PCM16 little-endian, 16 kHz, mono |

Control messages dùng JSON. Gateway trả `hello`, `started`, `language-detected`, `status`, `caption`, `error`, `stopped`. `started`/caption mang `sessionId`; caption có `sequence`, transcript, translation, source/target, `isFinal`, thời điểm và latency nếu provider cung cấp.

`sequence` của audio và caption là hai namespace độc lập. `sessionId` mới reset renderer để caption của phiên trước không ghi đè phiên mới.

## Source language theo provider

Validation không còn áp quy tắc Azure toàn cục:

| Provider | Source mode | Language hints |
|---|---|---|
| Gemini Live Translate | Auto liên tục | 0–8 mã/locale tùy chọn; không khóa ngôn ngữ |
| Azure Speech Translation | Fixed hoặc auto at-start | Auto bắt buộc 2–4 full locale, distinct base language |
| Demo | Fixed | Không hỗ trợ auto |

Extension chỉ kiểm hình dạng chung và tối đa 8; gateway đọc `providerCapabilities` để áp min/max/full-locale/uniqueness tương ứng. Vì vậy một danh sách rỗng hợp lệ với Gemini nhưng bị từ chối rõ ràng nếu runtime là Azure auto.

## Bounded-latency policy

- Extension không gửi PCM trước `started`; pre-roll tối đa khoảng một giây/32 KiB và frame cũ được wipe.
- Khi `WebSocket.bufferedAmount > 16 KiB`, client bỏ backlog/kết nối cũ thay vì phát lại audio đã trễ.
- Gateway bỏ frame có `capturedAt` cũ hơn một giây.
- File route giới hạn queue, sequence và destination; PCM bị xóa khi consume/stop/error.
- Heartbeat 15 giây kết thúc half-open socket; tối đa 4 local client và 10 lần start/phút/client.
- Provider startup/stop/close có timeout; lỗi terminal đóng capture để không tiếp tục đẩy audio vào queue chết.
- Gemini direct đóng gói input thành PCM16 16 kHz/100 ms theo contract Live Translate, giới hạn fragment/context và chỉ render output transcription. Session resumption mặc định tắt để ưu tiên riêng tư.

Các policy ưu tiên phụ đề hiện tại hơn transcript đầy đủ. History/SRT về sau cần recording path và consent riêng.

## Partial/final và overlay

- Draft có thể thay đổi khi model nhận thêm audio; final được đánh dấu riêng. Gemini Live Translate tích lũy output transcription trong một lượt nói rồi phát đúng một final tại ranh giới utterance.
- Caption sequence cũ hoặc khác session bị bỏ.
- Live overlay clamp 1–2 dòng và dựng một cửa sổ rolling theo grapheme/ngữ nghĩa: nội dung mới nối tiếp trong cùng lượt nói, phần cũ cuộn ra khi vượt sức chứa và final không phát lại từ đầu. Partial hủy timer ẩn; chỉ final mới bắt đầu auto-hide. Chỉ final caption đi vào `aria-live` để tránh screen reader đọc lại mọi partial.
- Preferences gồm preset/vị trí normalized theo display, lock/click-through, font, line-height, opacity, max width/lines, high contrast và auto-hide.
- Renderer bị sandbox, context isolation, tắt Node integration và chỉ dùng preload API whitelist.

## Security boundary

- Gateway bind cố định `127.0.0.1`, không expose LAN; extension chỉ chấp nhận `ws://127.0.0.1:<port>`.
- Origin production phải là `chrome-extension://`; manifest key tạo ID ổn định. `.env.example` pin `docfjemeacdakckkamiiopljhmgjgfgl`; build ký bằng key khác phải đổi allowlist.
- Extension và internal file client đều phải vượt mutual HMAC nếu gateway có pairing secret mạnh.
- API key không đi qua extension/local WebSocket. Gemini desktop key nằm trong Electron main và được `safeStorage` mã hóa khi backend hệ điều hành đủ an toàn; Linux `basic_text` fallback chỉ giữ key trong phiên.
- Settings không nhạy cảm được ghi atomically với mode `0600` khi hệ điều hành hỗ trợ; secret record chỉ chứa ciphertext.
- Max WebSocket payload 512 KiB; PCM phải đúng frame/độ dài, sequence và tuổi dữ liệu.
- Cloud provider cần consent token đúng; không tự fallback từ demo/local sang cloud.
- Audio/transcript không được ghi xuống đĩa hoặc log mặc định.

Boundary này giảm đáng kể tấn công từ LAN, extension/web page khác và renderer bị compromise, nhưng không tạo “bảo mật tuyệt đối”. Google/Microsoft vẫn nhận PCM khi provider tương ứng chạy; malware/admin trên cùng máy có thể đọc bộ nhớ hoặc audio; pairing secret/API key bị đánh cắp vẫn phải rotate.

## Đo latency

Các metric cần tách:

1. `transport_latency`: `capturedAt` tới gateway.
2. `draft_translation_latency`: audio tương ứng tới translated partial đầu.
3. `result_to_raf`: provider emit tới animation frame của overlay.
4. `language_detection_latency`: auto detect/time-to-language.
5. `stable/final_latency`: không trộn với draft.

Acceptance criteria thiết kế:

- packet cadence không có gap >100 ms ở p99 khi máy không quá tải;
- local transport p95 <10 ms;
- result-to-RAF p95 <33 ms;
- draft p50 <700 ms, p95 hướng tới <1 giây;
- auto detect và final báo riêng;
- không làm gián đoạn playback khi gateway reconnect.

Các con số này cần benchmark E2E bằng audio/mạng/provider thật và không phải SLA của Gemini/Azure.
