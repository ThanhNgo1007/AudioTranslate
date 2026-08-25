export async function stopOwnedFileStreamer(readActive, writeActive) {
  const streamer = readActive();
  writeActive(null);
  if (streamer) await streamer.stop();
}
