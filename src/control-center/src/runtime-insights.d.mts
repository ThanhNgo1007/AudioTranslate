import type { AudioTelemetry } from "./types";

export function normalizeAudioTelemetry(value?: unknown): AudioTelemetry;
export function meterSegments(rms: number | null | undefined, total?: number): number;
export function describeDetectedLanguage(
  detectedLanguage: string | null | undefined,
  configuredSource: string,
  languageDetectionMs: number | null | undefined,
): { label: string; detail: string; detected: boolean };
export function describeLatency(latencyMs: number | null | undefined): {
  label: string;
  tone: "idle" | "good" | "warning";
  detail: string;
};
