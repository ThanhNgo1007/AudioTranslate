export function describeSessionDisplay(
  provider,
  sessionState,
  runtimeActive = sessionState === "listening" || sessionState === "connecting",
) {
  const isDemo = provider === "demo";
  const isError = sessionState === "error";
  const isListening = sessionState === "listening";
  const isPaused = sessionState === "paused";
  const isConnecting = sessionState === "connecting";
  const isStopping = sessionState === "stopping";
  const active = runtimeActive === true;
  const canStop = active && !isStopping;
  const hasLiveAudio = active && isListening && !isDemo;
  return {
    hasLiveAudio,
    canStop,
    sceneLabel: isError
      ? "Phiên dịch gặp lỗi"
      : isPaused
        ? "Đã tạm dừng"
      : isConnecting
      ? "Đang chờ nguồn audio"
      : isStopping
        ? "Đang dừng phiên"
        : isListening
          ? (isDemo ? "Demo đang chạy" : "Đang dịch trực tiếp")
          : "Bản xem trước",
    primaryActionLabel: isError && active
      ? "Dừng phiên lỗi"
      : isPaused
        ? (isDemo ? "Dừng Demo" : "Dừng phiên dịch")
      : isConnecting
      ? "Hủy kết nối"
      : isStopping
        ? "Đang dừng…"
        : isListening
          ? (isDemo ? "Dừng Demo" : "Dừng phiên dịch")
          : (isDemo ? "Chạy Demo" : "Bắt đầu dịch"),
    audioMeterLabel: isError
      ? "Phiên có lỗi; hãy dừng hoặc thử lại"
      : isPaused
        ? "Đã tạm dừng gửi audio"
      : hasLiveAudio
      ? "Đang nhận tín hiệu audio"
      : isDemo && isListening
        ? "Demo không nhận audio"
        : isConnecting
          ? "Đang chờ nguồn audio"
          : "Chưa nhận audio",
  };
}
