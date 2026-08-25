# OpenClaw và AI-agent workflow

Cập nhật: 2026-08-24.

## Kết luận

OpenClaw/AI coding agents có thể giảm thời gian nghiên cứu, viết provider, tạo test và chạy benchmark. Chúng **không phải ASR hay model dịch**, và không nên nằm trong hot path `audio → subtitle`: tool calling, planning và model routing tạo latency/nondeterminism không phù hợp mục tiêu `<1 giây`.

Kiến trúc đúng là:

```text
Runtime realtime (deterministic)
extension → gateway → ASR/translation provider → overlay

Development/operations plane (asynchronous)
OpenClaw/Codex agents → code, tests, benchmark, review, release notes, alerts
```

OpenClaw hỗ trợ nhiều agent/workspace, routing, tools, skills, plugin và automation. Tài liệu cũng lưu ý workspace mặc định không phải hard sandbox nếu chưa bật sandbox; tool policy/approval phải được cấu hình riêng. [OpenClaw multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent), [tools and policy](https://docs.openclaw.ai/tools)

## Nhóm agent đề xuất

| Agent | Phạm vi | Output bắt buộc |
|---|---|---|
| Architect/research | So sánh SDK/model/license/protocol | ADR ngắn, nguồn chính thức, rủi ro và acceptance criteria |
| Provider implementer | Một adapter Azure/OpenAI/Gemini/local/BYOK protocol | Code cô lập sau interface, capability trung thực, fake-provider tests, timeout/cancel/backpressure |
| Evaluation agent | Golden set và benchmark runner | JSON p50/p95, WER/CER, COMET/chrF, revision rate; không chỉ tóm tắt văn xuôi |
| Security/reviewer | Origin/token/secrets/dependencies/privacy | Findings theo severity, test tái hiện, xác nhận không lộ audio/key |
| Release/documentation | Matrix OS/browser, installer, changelog | Artifact checksums, compatibility report, docs khớp runtime |

Mỗi agent dùng branch/worktree hoặc workspace tách biệt, task nhỏ có tiêu chí hoàn thành rõ. Một reviewer độc lập phải kiểm code do agent khác tạo; không merge chỉ vì build chạy.

## Tác vụ nên tự động hóa

- Hằng đêm chạy cùng fixture qua các provider đã cấu hình; lưu latency/accuracy/cost theo model version và region.
- Phát hiện regression p95, WER/CER hoặc flicker; tạo report/issue có sample ID và log đã khử dữ liệu nhạy cảm.
- Sinh adapter boilerplate, mock SDK và contract tests từ `providerCapabilities`.
- Rà release notes/API docs để cảnh báo model deprecated, price/format/language support thay đổi.
- Tạo test cho lifecycle race, reconnect, stale partial, queue/backpressure, invalid candidate và provider cancellation.
- Tổng hợp feedback glossary/tên riêng thành bộ fixture đã ẩn danh; con người duyệt trước khi thêm.

Một OpenClaw skill/plugin tùy chọn về sau có thể đọc **metrics đã tổng hợp** của AudioTranslate, chạy benchmark được allowlist và gửi báo cáo qua kênh chat. Nó không cần quyền đọc raw audio, transcript người dùng hoặc `.env`.

## Model routing

- Model reasoning mạnh: kiến trúc, threat model, review concurrency/lifecycle, thiết kế benchmark và lỗi provider khó.
- Model nhỏ/nhanh hoặc local: scaffold adapter, unit test lặp lại, docs/changelog và phân loại log.
- Model ASR/MT chuyên dụng vẫn xử lý audio realtime; không thay bằng general-purpose coding/chat agent.
- Reviewer dùng context/test evidence độc lập để giảm lỗi đồng thuận giữa các agent.

## Guardrails bắt buộc

- Không cấp `.env`, API key, pairing token, raw user audio/transcript cho agent hoặc plugin.
- Agent không được tự thêm base URL/router rồi suy luận nó hỗ trợ realtime audio; protocol/capability cần tài liệu chính thức và contract test riêng.
- Chỉ cho đọc fixture đã ẩn danh và metrics tổng hợp; secrets lấy ở runtime CI qua scoped secret store.
- Command/tool allowlist; sandbox filesystem/network; human approval cho cài dependency, đổi provider, deploy, publish và chi phí cloud.
- Khóa version model/SDK và ghi model ID, region, commit, hardware vào từng benchmark.
- CI gate: syntax/unit/integration, no-secret scan, dependency audit, latency/accuracy thresholds và license manifest.
- Agent không được tự sửa threshold để làm benchmark “pass”; mọi thay đổi acceptance criteria cần human review.

## Lộ trình áp dụng

1. Giữ OpenClaw ngoài dependency runtime; trước mắt dùng agent theo task để nghiên cứu/review/test.
2. Chuẩn hóa `fixtures/`, schema benchmark JSON và provider contract tests.
3. Thêm automation benchmark read-only trên CI runner tách biệt, không có dữ liệu người dùng.
4. Khi workflow ổn định, mới tạo OpenClaw skill/plugin cho report/triage; không trao quyền deploy mặc định.

OpenClaw chưa được cài hoặc thêm vào dự án ở MVP này vì không cần thiết để chạy phụ đề. Việc cài đặt chỉ nên thực hiện khi đã chốt môi trường CI/ops, policy và kênh nhận báo cáo.
