import { setLanguage } from "@/app/actions";
import type { Lang } from "@/lib/i18n";

export function LangSwitch({ lang }: { lang: Lang }) {
  return (
    <form action={setLanguage}>
      <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
      <button className="text-sm text-muted hover:text-lapis" lang={lang === "ar" ? "en" : "ar"}>
        {lang === "ar" ? "English" : "العربية"}
      </button>
    </form>
  );
}
