export function finishFileSessionWithFreshSnapshot<T>(
  startStreamer: () => Promise<unknown>,
  readSnapshot: () => Promise<T>,
): Promise<T>;
