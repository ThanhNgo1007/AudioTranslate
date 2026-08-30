# AudioTranslate Control Center

Giao diện React + TypeScript độc lập cho cửa sổ cấu hình AudioTranslate. Bản build dùng đường dẫn tương đối nên có thể được Electron tải bằng `loadFile(...)`.

## Chạy riêng để phát triển

```bash
cd src/control-center
npm install
npm run dev
```

Trong Vite dev, nếu preload Electron chưa tồn tại, giao diện dùng mock trong bộ nhớ để có thể kiểm thử toàn bộ luồng 3 bước. Bản production **không** dùng mock: nếu thiếu preload bridge, giao diện khoá thao tác và báo lỗi.

```bash
npm run build
```

Kết quả nằm tại `src/control-center/dist/`.

## Hợp đồng preload / IPC cần triển khai

Expose đúng một namespace `window.audioTranslateControl`. Adapter renderer nằm trong [`src/bridge.ts`](./src/bridge.ts), còn kiểu state dùng bởi UI nằm trong [`src/types.ts`](./src/types.ts). Renderer chỉ nhận metadata, trạng thái và phụ đề; không nhận đường dẫn tệp thật, pairing token hay API key đã lưu. Với nguồn file, renderer chuyển từng chunk có giới hạn qua IPC vì đây là contract hiện tại; mỗi buffer tạm được ghi đè ngay sau khi main xác nhận đã nhận.

```ts
interface AudioTranslateControl {
  getSnapshot(): Promise<ControlCenterSnapshot>;
  updateSettings(patch: Record<string, unknown>): Promise<ControlCenterSnapshot | void>;
  saveSecret(provider: "gemini", key: string): Promise<ControlCenterSnapshot | void>;
  deleteSecret(provider: "gemini"): Promise<ControlCenterSnapshot | void>;
  testProvider(provider: "gemini"): Promise<ControlCenterSnapshot | void>;
  startRuntime(): Promise<ControlCenterSnapshot | void>;
  stopRuntime(): Promise<ControlCenterSnapshot | void>;
  runDiagnostics(): Promise<DiagnosticsReport>;
  exportRuntimeReport(): Promise<{ outcome: "saved" | "cancelled" | "failed" }>;
  setOverlayLocked(locked: boolean): Promise<ControlCenterSnapshot | void>;
  resetOverlay(): Promise<ControlCenterSnapshot | void>;
  startFileSource(meta: FileSourceMeta): Promise<ControlCenterSnapshot | void>;
  pushFileAudio(chunk: ArrayBuffer, metadata: { sequence: number; capturedAt: number }): boolean;
  stopFileSource(): Promise<ControlCenterSnapshot | void>;
  onSnapshot(callback: (snapshot: ControlCenterSnapshot) => void): () => void;
  onRuntimeStatus(callback: (status: SessionStatus) => void): () => void;
  onCaption(callback: (caption: CaptionPreview) => void): () => void;
}
```

Đề xuất map sang IPC invoke/send:

| Preload method | IPC channel | Yêu cầu bảo mật |
| --- | --- | --- |
| `getSnapshot` | `control:get-snapshot` | Chỉ trả `keyConfigured` và hint đã mask |
| `updateSettings` | `control:update-settings` | Chỉ nhận patch allowlist (`source`, `languages`, `overlay`), validate/range-clamp tại main |
| `saveSecret` | `control:save-secret` | Chuyển một lần tới main; lưu trong Keychain/Credential Manager/libsecret; xoá tham chiếu sớm |
| `deleteSecret` | `control:delete-secret` | Xoá theo service/account cố định, không nhận path từ renderer |
| `testProvider` | `control:test-provider` | Main tự đọc secret; không trả request/response có secret |
| `startRuntime` | `control:start-runtime` | Mở pipeline Gemini sau hành động người dùng; không log payload/header |
| `stopRuntime` | `control:stop-runtime` | Abort upstream, zero buffers, revoke tab/file handle |
| `runDiagnostics` | `control:run-diagnostics` | Main tự thu thập trạng thái đã khử nhạy cảm; renderer không gửi context |
| `exportRuntimeReport` | `control:export-runtime-report` | Không nhận payload/path; main dựng schema allowlist, mở Save Dialog và chỉ trả kết quả tổng quát |
| `setOverlayLocked` | `control:set-overlay-locked` | Nhận boolean duy nhất |
| `resetOverlay` | `control:reset-overlay` | Chỉ reset allowlisted settings |
| `startFileSource` | `control:start-file-source` | Chỉ nhận basename/size/MIME + format PCM đích + consent; tuyệt đối không nhận path |
| `pushFileAudio` | `control:push-file-audio` | Validate session + sequence + giới hạn chunk; zero buffer sau xử lý |
| `stopFileSource` | `control:stop-file-source` | Dừng đọc, huỷ buffer/decoder và handle của phiên |
| `onSnapshot` | `control:snapshot` | Event một chiều; không chứa secret/path/token |
| `onRuntimeStatus` | `control:runtime-status` | Chỉ trạng thái, thông báo đã làm sạch và latency |
| `onCaption` | `control:caption` | Chỉ transcript/translation cần hiển thị |

## Ranh giới bảo mật nguồn audio

- `BrowserWindow`: bật `contextIsolation`, `sandbox`, tắt `nodeIntegration`, CSP chặt; không load nội dung remote trong Control Center.
- Audio từ Chrome/Edge: extension capture đúng tab sau hành động rõ ràng của người dùng. Gateway chỉ bind loopback, bắt buộc pairing token entropy cao, chống replay bằng nonce + TTL, giới hạn một phiên/tab và kiểm tra `Origin`/protocol version.
- File: Chromium file picker chỉ cấp một `File` object sau thao tác rõ ràng của người dùng. Không dùng/lộ absolute path; không copy vào app data. Adapter giữ `File` trong memory và chỉ tạo object URL sau khi người dùng bấm bắt đầu. Web Audio giải mã cục bộ, AudioWorklet (hoặc ScriptProcessor fallback) trộn mono, resample 16 kHz, đóng gói PCM16 đúng 3.200 byte/100 ms rồi mới chuyển qua IPC; không bao giờ gửi byte container nén thô. Buffer PCM tạm bị ghi đè sau IPC, AudioContext đóng và object URL bị revoke khi dừng/kết thúc.
- Gemini: audio buộc phải rời máy để dịch cloud. Kết nối trực tiếp từ main/provider qua TLS; không qua renderer hoặc dịch vụ trung gian của AudioTranslate. Không log payload, transcript, headers hoặc lỗi chứa query/key.
- Báo cáo hiệu năng: main process chỉ xuất provider/model ID đã kiểm soát, trạng thái scalar, sáu nhóm latency và token counter numeric. Không đưa caption/transcript/audio, API key, pairing token, URL, file name hay path vào JSON; file được ghi qua temp cùng thư mục, `fsync`, rename nguyên tử và mode `0600` khi hệ điều hành hỗ trợ.
- API key: gói trả phí ChatGPT/Google AI Pro không đồng nghĩa API credit. Desktop lưu Gemini key qua Electron `safeStorage`; nếu Linux chỉ có backend `basic_text`, key chỉ tồn tại trong phiên. `.env` chỉ dành cho headless/automation, phải bị git-ignore và không được dùng làm luồng cài đặt desktop.
- Không thể hứa “bảo mật tuyệt đối” cho hệ thống có mạng. UI cố ý công khai đường đi của dữ liệu và chỉ khẳng định các kiểm soát kỹ thuật có thể kiểm chứng.

## Dependencies

- React / React DOM
- TypeScript + Vite + React plugin
- Phosphor Icons React (icon UI; không dùng emoji, CSS icon hoặc logo giả)

Không có analytics, font/CDN, ảnh remote hoặc dependency runtime trả phí trong Control Center.
