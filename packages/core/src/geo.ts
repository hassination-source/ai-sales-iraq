/**
 * Iraq governorates. Codes are ISO 3166-2:IQ, except Halabja which uses an
 * internal code (it was split from Sulaymaniyah after the ISO list was set).
 * Aliases cover common Arabic, Kurdish-romanized and English spellings so
 * imported spreadsheets map reliably.
 */
export interface Governorate {
  code: string;
  ar: string;
  en: string;
  region: "federal" | "kurdistan";
  aliases: string[];
}

export const GOVERNORATES: readonly Governorate[] = [
  { code: "IQ-BG", ar: "بغداد", en: "Baghdad", region: "federal", aliases: ["baghdad", "بغداد"] },
  { code: "IQ-BA", ar: "البصرة", en: "Basra", region: "federal", aliases: ["basra", "basrah", "البصره", "بصرة"] },
  { code: "IQ-NI", ar: "نينوى", en: "Nineveh", region: "federal", aliases: ["nineveh", "ninawa", "mosul", "الموصل", "موصل"] },
  { code: "IQ-AR", ar: "أربيل", en: "Erbil", region: "kurdistan", aliases: ["erbil", "arbil", "irbil", "hawler", "hewler", "اربيل"] },
  { code: "IQ-SU", ar: "السليمانية", en: "Sulaymaniyah", region: "kurdistan", aliases: ["sulaymaniyah", "sulaimani", "slemani", "suleimaniya", "السليمانيه"] },
  { code: "IQ-DA", ar: "دهوك", en: "Duhok", region: "kurdistan", aliases: ["duhok", "dohuk", "dahuk", "دهوك"] },
  { code: "IQ-HAL", ar: "حلبجة", en: "Halabja", region: "kurdistan", aliases: ["halabja", "halabjah", "حلبجه"] },
  { code: "IQ-KI", ar: "كركوك", en: "Kirkuk", region: "federal", aliases: ["kirkuk", "kerkuk"] },
  { code: "IQ-AN", ar: "الأنبار", en: "Anbar", region: "federal", aliases: ["anbar", "al anbar", "ramadi", "الانبار", "الرمادي"] },
  { code: "IQ-BB", ar: "بابل", en: "Babil", region: "federal", aliases: ["babil", "babylon", "hillah", "الحلة"] },
  { code: "IQ-KA", ar: "كربلاء", en: "Karbala", region: "federal", aliases: ["karbala", "kerbala", "كربلا"] },
  { code: "IQ-NA", ar: "النجف", en: "Najaf", region: "federal", aliases: ["najaf", "نجف"] },
  { code: "IQ-QA", ar: "القادسية", en: "Al-Qadisiyyah", region: "federal", aliases: ["qadisiyyah", "qadisiya", "diwaniyah", "الديوانية", "القادسيه"] },
  { code: "IQ-MU", ar: "المثنى", en: "Muthanna", region: "federal", aliases: ["muthanna", "samawah", "السماوة"] },
  { code: "IQ-DQ", ar: "ذي قار", en: "Dhi Qar", region: "federal", aliases: ["dhi qar", "thi qar", "nasiriyah", "الناصرية", "ذيقار"] },
  { code: "IQ-MA", ar: "ميسان", en: "Maysan", region: "federal", aliases: ["maysan", "misan", "amarah", "العمارة"] },
  { code: "IQ-WA", ar: "واسط", en: "Wasit", region: "federal", aliases: ["wasit", "kut", "الكوت"] },
  { code: "IQ-DI", ar: "ديالى", en: "Diyala", region: "federal", aliases: ["diyala", "baqubah", "بعقوبة", "ديالي"] },
  { code: "IQ-SD", ar: "صلاح الدين", en: "Saladin", region: "federal", aliases: ["saladin", "salah al-din", "salahuddin", "tikrit", "تكريت"] },
];

const byKey = new Map<string, string>();
for (const g of GOVERNORATES) {
  for (const k of [g.code, g.ar, g.en, ...g.aliases]) byKey.set(normalizeArabic(k), g.code);
}

/** Map a free-text governorate/city name to a governorate code, or null if unknown. Never guesses. */
export function matchGovernorate(input: string | null | undefined): string | null {
  if (!input) return null;
  const n = normalizeArabic(input).replace(/^(محافظة|محافظه|governorate of)\s+/, "").replace(/\s+governorate$/, "");
  return byKey.get(n) ?? null;
}

/** Arabic-aware normalization for matching and dedupe (not for display). */
export function normalizeArabic(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[ً-ْٰ]/g, "") // tashkeel
    .replace(/ـ/g, "") // tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
