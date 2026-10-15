import { t as tx } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { getLang, translator } from "@/lib/i18n";
import { NavLinks } from "@/components/nav-links";
import { LangSwitch } from "@/components/lang-switch";
import { signOut } from "@/app/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const lang = await getLang();
  const t = translator(lang);
  return (
    <div className="md:grid md:min-h-dvh md:grid-cols-[15rem_1fr]">
      <aside className="flex flex-col gap-6 bg-lapis-deep p-4 text-white md:sticky md:top-0 md:h-dvh md:p-5">
        <div>
          <p className="text-sm text-white/60">{t("appName")}</p>
          <p className="mt-1 font-semibold leading-snug">{ctx.tenant.name}</p>
          <p className="text-xs text-white/60">{tx(ctx.config.name, lang)}</p>
        </div>
        <nav className="overflow-x-auto">
          <NavLinks
            items={[
              { href: "/", label: t("nav.dashboard") },
              { href: "/leads", label: t("nav.leads") },
              { href: "/pipeline", label: t("nav.pipeline") },
              { href: "/leads/import", label: t("nav.import") },
            ]}
          />
        </nav>
        <div className="flex flex-wrap items-center gap-4 text-sm md:mt-auto md:block md:space-y-3 [&_button]:text-white/70 [&_button:hover]:text-white">
          <p className="truncate text-xs text-white/50" dir="ltr">{ctx.email}</p>
          <LangSwitch lang={lang} />
          <form action={signOut}><button>{t("nav.signOut")}</button></form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-10 md:py-8">{children}</main>
    </div>
  );
}
