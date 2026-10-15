import Link from "next/link";
import { getLang, translator } from "@/lib/i18n";
import { LangSwitch } from "@/components/lang-switch";
import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const lang = await getLang();
  const t = translator(lang);
  const signup = sp.mode === "signup";
  const knownErrors = ["badLogin", "weakPassword"];
  const error = sp.error ? (knownErrors.includes(sp.error) ? t(`auth.${sp.error}`) : sp.error) : null;

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-lapis-deep text-white lg:flex lg:flex-col lg:justify-between lg:p-14">
        <Glaze />
        <p className="relative text-lg font-semibold">{t("appName")}</p>
        <div className="relative max-w-md">
          <p className="text-4xl leading-tight font-semibold">
            {lang === "ar" ? "قسم مبيعات رقمي لكل شركة عراقية." : "A digital sales team for every Iraqi business."}
          </p>
          <p className="mt-4 text-white/75">
            {lang === "ar"
              ? "ابحث عن العملاء، رتّبهم حسب ملاءمتهم، وتابع كل صفقة حتى الإغلاق — بالعربي وبلهجتك."
              : "Find customers, rank them by fit, and follow every deal to close — in Arabic and English."}
          </p>
        </div>
      </section>

      <section className="flex flex-col p-6 sm:p-10">
        <div className="flex justify-end"><LangSwitch lang={lang} /></div>
        <div className="m-auto w-full max-w-sm">
          <h1 className="text-2xl font-semibold">{signup ? t("auth.signupTitle") : t("auth.title")}</h1>
          {sp.notice === "checkEmail" && <p className="note-info mt-4">{t("auth.checkEmail")}</p>}
          {error && <p className="note-error mt-4">{error}</p>}
          <form action={signup ? signUp : signIn} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="email">{t("auth.email")}</label>
              <input className="field" id="email" name="email" type="email" autoComplete="email" required dir="ltr" />
            </div>
            <div>
              <label className="label" htmlFor="password">{t("auth.password")}</label>
              <input className="field" id="password" name="password" type="password" minLength={8} autoComplete={signup ? "new-password" : "current-password"} required dir="ltr" />
            </div>
            <button className="btn-primary w-full">{signup ? t("auth.signUp") : t("auth.signIn")}</button>
          </form>
          <Link href={signup ? "/login" : "/login?mode=signup"} className="mt-6 block text-sm text-lapis hover:underline">
            {signup ? t("auth.toSignin") : t("auth.toSignup")}
          </Link>
        </div>
      </section>
    </main>
  );
}

/** Glazed-brick pattern after the Ishtar Gate: offset courses of tiles. */
function Glaze() {
  return (
    <svg className="absolute inset-0 h-full w-full opacity-[0.13]" aria-hidden="true">
      <defs>
        <pattern id="bricks" width="64" height="32" patternUnits="userSpaceOnUse">
          <rect x="1" y="1" width="62" height="14" rx="2" fill="white" />
          <rect x="-31" y="17" width="62" height="14" rx="2" fill="white" />
          <rect x="33" y="17" width="62" height="14" rx="2" fill="white" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#bricks)" />
    </svg>
  );
}
