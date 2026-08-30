import type {
  AudioTelemetry,
  RuntimeDiagnostics,
  RuntimeMetricName,
} from "./types";

export function normalizeAudioTelemetry(value?: unknown): AudioTelemetry;
export function normalizeRuntimeDiagnostics(value?: unknown): RuntimeDiagnostics | null;
export function describeRuntimeMetrics(value?: unknown): Array<{
  key: RuntimeMetricName;
  label: string;
  detail: string;
  latest: string;
  p50: string;
  p95: string;
  count: number;
  sampleLabel: string;
  state: "empty" | "warming" | "observed";
}>;
export function describeRuntimeUsage(value?: unknown): Array<{
  key: keyof RuntimeDiagnostics["usage"];
  label: string;
  value: number;
  displayValue: string;
}>;
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
