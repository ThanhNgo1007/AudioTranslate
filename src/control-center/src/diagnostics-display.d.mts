import type { DiagnosticsReport } from "./types";

export function normalizeDiagnosticsReport(value?: unknown): DiagnosticsReport;
export function describeDiagnosticsOverall(overall: DiagnosticsReport["overall"]): {
  label: string;
  tone: "good" | "warning" | "error";
};
export function diagnosticActionTarget(actionId: string | null): "providers" | "privacy" | "translate" | null;
