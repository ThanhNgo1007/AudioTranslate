export async function finishFileSessionWithFreshSnapshot(startStreamer, readSnapshot) {
  await startStreamer();
  return readSnapshot();
}
