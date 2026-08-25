import type { SessionStatus } from "./types";

export function describeTransportControls(session?: Partial<SessionStatus>): {
  canTogglePause: boolean;
  paused: boolean;
  pauseLabel: string;
  pauseHint: string;
  canStop: boolean;
};
