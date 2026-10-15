import { redirect } from "next/navigation";
import { GOVERNORATES, PACKS, t as tx } from "@ais/core";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, translator } from "@/lib/i18n";
import { LangSwitch } from "@/components/lang-switch";
import { createCompany } from "./actions";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sb = await supabaseServer();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) redirect("/login");
  const { count } = await sb.from("tenant_members").select("*", { count: "exact", head: true }).eq("user_id", auth.user.id);
  if (count) redirect("/");

  const { error } = await searchParams;
  const lang = await getLang();
  const t = translator(lang);
  const loc = lang === "ar" ? "ar" : "en";

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-lapis">{t("appName")}</p>
        <LangSwitch lang={lang} />
      </div>
      <h1 className="mt-10 text-3xl font-semibold">{t("onboarding.title")}</h1>
      <p className="mt-2 max-w-prose text-muted">{t("onboarding.intro")}</p>
      {error && <p className="note-error mt-6">{error === "invalid" ? (lang === "ar" ? "تحقق من الحقول." : "Check the fields.") : error}</p>}

      <form action={createCompany} className="mt-8 space-y-8">
        <div>
          <label className="label" htmlFor="name">{t("onboarding.name")}</label>
          <input className="field" id="name" name="name" required minLength={2} maxLength={200} />
        </div>

        <fieldset>
          <legend className="label">{t("onboarding.industry")}</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {Object.values(PACKS).map((p, i) => (
              <label key={p.id} className="cursor-pointer rounded-lg border border-line bg-surface p-4 has-[:checked]:border-lapis has-[:checked]:bg-lapis-soft">
                <input type="radio" name="packId" value={p.id} defaultChecked={i === 0} className="sr-only" />
                <span className="block font-medium">{tx(p.name, loc)}</span>
                <span className="mt-1 block text-sm text-muted">{tx(p.description, loc)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="currency">{t("onboarding.currency")}</label>
          <select className="field max-w-48" id="currency" name="currency" defaultValue="USD">
            <option value="USD">USD</option>
            <option value="IQD">IQD</option>
          </select>
        </div>

        <fieldset>
          <legend className="label">{t("onboarding.territories")}</legend>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {GOVERNORATES.map((g) => (
              <label key={g.code} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="territories" value={g.code} className="accent-lapis" />
                {lang === "ar" ? g.ar : g.en}
              </label>
            ))}
          </div>
        </fieldset>

        <button className="btn-primary">{t("onboarding.create")}</button>
      </form>
    </main>
  );
}
