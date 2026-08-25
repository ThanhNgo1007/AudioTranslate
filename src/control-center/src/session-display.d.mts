import type { ProviderId, SessionState } from "./types";

export interface SessionDisplay {
  hasLiveAudio: boolean;
  canStop: boolean;
  sceneLabel: string;
  primaryActionLabel: string;
  audioMeterLabel: string;
}

export function describeSessionDisplay(
  provider: ProviderId,
  sessionState: SessionState,
  runtimeActive?: boolean,
): SessionDisplay;
