export interface StoppableFileStreamer {
  stop(): Promise<void>;
}

export function stopOwnedFileStreamer(
  readActive: () => StoppableFileStreamer | null,
  writeActive: (streamer: null) => void,
): Promise<void>;
