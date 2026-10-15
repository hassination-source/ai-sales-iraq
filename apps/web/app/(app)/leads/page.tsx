import Link from "next/link";
import { GOVERNORATES } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtNumber } from "@/lib/i18n";
import { ScoreBar } from "@/components/score-bar";

const PAGE = 50;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ q?: string; gov?: string; page?: string }> }) {
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const sb = await supabaseServer();
  let query = sb
    .from("companies")
    .select("id, name, governorate, city, phone, website, fit_score, verification_status, source_type", { count: "exact" })
    .eq("tenant_id", ctx.tenant.id)
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (sp.gov) query = query.eq("governorate", sp.gov);
  if (sp.q) query = query.ilike("name", `%${sp.q.replace(/[%_,]/g, "")}%`);
  const { data: rows, count, error } = await query;
  if (error) throw new Error(error.message);

  const govName = (code: string | null) => {
    const g = GOVERNORATES.find((x) => x.code === code);
    return g ? (ar ? g.ar : g.en) : "—";
  };
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const qs = (p: number) => `?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.gov ? { gov: sp.gov } : {}), page: String(p) })}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{ar ? "العملاء المحتملون" : "Leads"}</h1>
          <p className="text-sm text-muted">
            {ar ? `${fmtNumber(lang, count ?? 0)} شركة، مرتبة حسب درجة الملاءمة` : `${fmtNumber(lang, count ?? 0)} companies, ranked by fit`}
          </p>
        </div>
        <Link href="/leads/import" className="btn-primary">{ar ? "استيراد من ملف" : "Import from file"}</Link>
      </header>

      <form className="flex flex-wrap gap-3" role="search">
        <input className="field max-w-xs" name="q" defaultValue={sp.q} placeholder={ar ? "ابحث بالاسم" : "Search by name"} aria-label={ar ? "بحث" : "Search"} />
        <select className="field max-w-52" name="gov" defaultValue={sp.gov ?? ""} aria-label={ar ? "المحافظة" : "Governorate"}>
          <option value="">{ar ? "كل المحافظات" : "All governorates"}</option>
          {GOVERNORATES.map((g) => <option key={g.code} value={g.code}>{ar ? g.ar : g.en}</option>)}
        </select>
        <button className="btn-quiet">{ar ? "تصفية" : "Filter"}</button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
          <p className="font-medium">{sp.q || sp.gov ? (ar ? "لا توجد نتائج لهذا البحث." : "No companies match this search.") : ar ? "لا يوجد عملاء محتملون بعد." : "No leads yet."}</p>
          <p className="mt-1 text-sm text-muted">{ar ? "استورد قائمة شركات من ملف CSV لتبدأ." : "Import a list of companies from a CSV file to start."}</p>
          <Link href="/leads/import" className="btn-primary mt-4">{ar ? "استيراد" : "Import"}</Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-start text-muted">
              <tr>
                <th className="px-4 py-3 text-start font-medium">{ar ? "الشركة" : "Company"}</th>
                <th className="px-4 py-3 text-start font-medium">{ar ? "المحافظة" : "Governorate"}</th>
                <th className="px-4 py-3 text-start font-medium">{ar ? "الهاتف" : "Phone"}</th>
                <th className="w-48 px-4 py-3 text-start font-medium">{ar ? "الملاءمة" : "Fit"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-3">
                    <Link href={`/leads/${r.id}`} className="font-medium text-ink hover:text-lapis">{r.name}</Link>
                    {r.verification_status !== "verified" && <span className="ms-2 text-xs text-muted">{ar ? "غير موثّق" : "unverified"}</span>}
                  </td>
                  <td className="px-4 py-3">{govName(r.governorate)}</td>
                  <td className="px-4 py-3" dir="ltr">{r.phone ?? "—"}</td>
                  <td className="px-4 py-3"><ScoreBar value={r.fit_score === null ? null : Number(r.fit_score)} lang={lang} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label={ar ? "الصفحات" : "Pages"}>
          {page > 1 && <Link className="btn-quiet" href={qs(page - 1)}>{ar ? "السابق" : "Previous"}</Link>}
          <span className="text-muted">{fmtNumber(lang, page)} / {fmtNumber(lang, pages)}</span>
          {page < pages && <Link className="btn-quiet" href={qs(page + 1)}>{ar ? "التالي" : "Next"}</Link>}
        </nav>
      )}
    </div>
  );
}
