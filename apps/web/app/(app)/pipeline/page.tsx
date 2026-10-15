import Link from "next/link";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtMoney, fmtNumber } from "@/lib/i18n";

export default async function PipelinePage() {
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const { data: deals, error } = await sb
    .from("deals")
    .select("id, title, value_amount, currency, stage_id, updated_at, company:companies(name)")
    .eq("tenant_id", ctx.tenant.id)
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);

  const byStage = new Map<string, typeof deals>();
  for (const d of deals ?? []) byStage.set(d.stage_id, [...(byStage.get(d.stage_id) ?? []), d]);
  const totals = (list: NonNullable<typeof deals>) => {
    const sums = new Map<string, number>();
    for (const d of list) if (d.value_amount !== null && d.currency) sums.set(d.currency, (sums.get(d.currency) ?? 0) + Number(d.value_amount));
    return [...sums].map(([cur, v]) => fmtMoney(lang, v, cur)).join(ar ? " + " : " + ");
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{ar ? "مسار المبيعات" : "Pipeline"}</h1>
          <p className="text-sm text-muted">{ar ? "لبدء صفقة، افتح شركة من قائمة العملاء المحتملين." : "To start a deal, open a company from your leads."}</p>
        </div>
        <Link href="/leads" className="btn-quiet">{ar ? "العملاء المحتملون" : "Leads"}</Link>
      </header>

      <nav aria-label={ar ? "المراحل" : "Stages"} className="flex flex-wrap gap-2 text-sm">
        {ctx.stages.map((s) => {
          const n = byStage.get(s.id)?.length ?? 0;
          return (
            <a key={s.id} href={`#stage-${s.key}`} className={`rounded-full border px-3 py-1 ${n ? "border-lapis bg-lapis-soft text-lapis-deep" : "border-line text-muted hover:text-ink"}`}>
              {s.label[ar ? "ar" : "en"]} <span className="tabular-nums">{fmtNumber(lang, n)}</span>
            </a>
          );
        })}
      </nav>

      <div className="-mx-4 snap-x overflow-x-auto scroll-smooth px-4 pb-4 md:-mx-10 md:px-10">
        <ol className="flex min-w-max gap-3">
          {ctx.stages.map((s) => {
            const list = byStage.get(s.id) ?? [];
            const tone = s.kind === "won" ? "border-t-ochre" : s.kind === "lost" ? "border-t-brick" : "border-t-lapis";
            return (
              <li key={s.id} id={`stage-${s.key}`} className={`flex w-64 snap-start scroll-mx-4 flex-col rounded-lg border border-t-4 border-line bg-surface ${tone}`}>
                <div className="border-b border-line p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="font-medium">{s.label[ar ? "ar" : "en"]}</h2>
                    <span className="text-sm tabular-nums text-muted">{fmtNumber(lang, list.length)}</span>
                  </div>
                  {s.kind === "open" && s.probability !== null && (
                    <div className="mt-2 h-1 rounded-full bg-lapis-soft" title={ar ? `احتمال الفوز ${s.probability}٪` : `${s.probability}% win probability`}>
                      <div className="h-full rounded-full bg-lapis/60" style={{ width: `${s.probability}%` }} />
                    </div>
                  )}
                  {list.length > 0 && <p className="mt-2 text-xs text-muted tabular-nums">{totals(list) || (ar ? "بدون قيمة" : "No value")}</p>}
                </div>
                <ul className="flex flex-col gap-2 p-2">
                  {list.map((d) => (
                    <li key={d.id}>
                      <Link href={`/deals/${d.id}`} className="block rounded-md border border-line p-3 hover:border-lapis">
                        <span className="block text-sm font-medium">{d.title}</span>
                        <span className="block text-xs text-muted">{(d.company as unknown as { name: string } | null)?.name}</span>
                        {d.value_amount !== null && <span className="mt-1 block text-xs tabular-nums">{fmtMoney(lang, Number(d.value_amount), d.currency!)}</span>}
                      </Link>
                    </li>
                  ))}
                  {list.length === 0 && <li className="p-3 text-center text-xs text-muted">{ar ? "لا توجد صفقات" : "No deals"}</li>}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
