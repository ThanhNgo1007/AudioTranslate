import type { TranslationMode, TranslationSettings } from "./types";

export interface TranslationProfileDescription {
  id: TranslationMode;
  label: string;
  badge: string;
  summary: string;
  contextual: boolean;
  partialTranslation: boolean;
}

export function describeTranslationProfile(value: unknown): TranslationProfileDescription;
export function normalizeTranslationSettings(value?: unknown): TranslationSettings;
