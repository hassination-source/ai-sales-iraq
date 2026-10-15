import { z } from "zod";

/** Supported content locales. Kurdish (ckb = Sorani, kmr = Kurmanji) are reserved for future localization. */
export const LOCALES = ["ar", "ar-IQ", "en", "ckb", "kmr"] as const;
export type Locale = (typeof LOCALES)[number];

export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ar", "ar-IQ", "ckb"]);
export const isRtl = (l: Locale) => RTL_LOCALES.has(l);

/** A label translated into at least Arabic and English. */
export const LocalizedText = z
  .object({ ar: z.string().min(1), en: z.string().min(1), ckb: z.string().optional(), kmr: z.string().optional() })
  .strict();
export type LocalizedText = z.infer<typeof LocalizedText>;

export function t(text: LocalizedText, locale: Locale): string {
  if (locale === "ar" || locale === "ar-IQ") return text.ar;
  if (locale === "ckb" || locale === "kmr") return text[locale] ?? text.ar;
  return text.en;
}
