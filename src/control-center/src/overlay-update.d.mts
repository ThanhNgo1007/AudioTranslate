import type { OverlaySettings } from "./types";

export interface NativeOverlayPatch {
  translationFontSize?: number;
  backgroundOpacity?: number;
  showSource?: boolean;
  preset?: "bottom" | "top" | "floating";
  normalizedBounds?: { x: number; y: number; width: number; height: number };
}

export function buildNativeOverlayPatch(
  currentOverlay: Pick<OverlaySettings, "maxWidth" | "position">,
  requestedOverlay: Partial<OverlaySettings>,
): NativeOverlayPatch;
