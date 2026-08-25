export function describeTransportControls(session = {}) {
  const paused = session.paused === true;
  const canTogglePause = paused ? session.canResume === true : session.canPause === true;
  return {
    canTogglePause,
    paused,
    pauseLabel: paused ? "Tiếp tục dịch" : "Tạm dừng gửi audio",
    pauseHint: paused
      ? "Bắt đầu gửi audio mới; đoạn đã bỏ khi tạm dừng không được phát lại"
      : "Giữ phiên và quyền capture; audio mới sẽ bị bỏ an toàn",
    canStop: session.canStop === true,
  };
}
