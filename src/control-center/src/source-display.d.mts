import type { SourceKind } from "./types";

export function rendererOwnedSourceLabel(options?: {
  sourceKind?: SourceKind;
  selectedFileName?: string;
  tabSourceSelected?: boolean;
  mainLabel?: string;
}): string;
