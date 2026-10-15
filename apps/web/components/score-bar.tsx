import type { Lang } from "@/lib/i18n";

/** 0–100 fit score as a bar; null means not scored yet. */
export function ScoreBar({ value, lang }: { value: number | null; lang: Lang }) {
  if (value === null) return <span className="text-muted">{lang === "ar" ? "لم تُحسب" : "Not scored"}</span>;
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 rounded-full bg-lapis-soft" role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-lapis" style={{ width: `${v}%` }} />
      </div>
      <span className="w-8 text-end tabular-nums">{new Intl.NumberFormat(lang === "ar" ? "ar-IQ" : "en-US").format(v)}</span>
    </div>
  );
}
