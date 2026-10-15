import Link from "next/link";
import { notFound } from "next/navigation";
import { GOVERNORATES, scoreCompany, t as tx } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtDate, fmtNumber } from "@/lib/i18n";
import { PackFields } from "@/components/fields";
import { ScoreBar } from "@/components/score-bar";
import { createDeal, updateLeadFacts } from "./actions";

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();

  const [{ data: c }, { data: deals }, { data: contacts }] = await Promise.all([
    sb.from("companies").select("*").eq("id", id).maybeSingle(),
    sb.from("deals").select("id, title, value_amount, currency, stage_id").eq("company_id", id).order("created_at", { ascending: false }),
    sb.from("contacts").select("id, full_name, job_title, phone, email").eq("company_id", id),
  ]);
  if (!c) notFound();

  const score = scoreCompany(ctx.config, c);
  const gov = GOVERNORATES.find((g) => g.code === c.governorate);
  const fieldLabel = (field: string) => {
    if (field.startsWith("attributes.")) {
      const f = ctx.config.companyFields.find((x) => x.key === field.slice(11));
      return f ? tx(f.label, lang) : field;
    }
    const core: Record<string, [string, string]> = { governorate: ["المحافظة", "Governorate"], phone: ["الهاتف", "Phone"], website: ["الموقع", "Website"], verification_status: ["التوثيق", "Verification"] };
    return core[field]?.[ar ? 0 : 1] ?? field;
  };
  const stageName = (sid: string) => {
    const s = ctx.stages.find((x) => x.id === sid);
    return s ? s.label[ar ? "ar" : "en"] : "";
  };

  return (
    <div className="max-w-5xl space-y-8">
      <Link href="/leads" className="text-sm text-lapis hover:underline">{ar ? "→ كل العملاء" : "← All leads"}</Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">{c.name}</h1>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            <span>{gov ? (ar ? gov.ar : gov.en) : ar ? "المحافظة غير معروفة" : "Governorate unknown"}</span>
            {c.phone && <span dir="ltr">{c.phone}</span>}
            {c.website && <a className="text-lapis hover:underline" href={c.website} target="_blank" rel="noreferrer" dir="ltr">{c.website.replace("https://", "")}</a>}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${c.verification_status === "verified" ? "bg-lapis-soft text-lapis-deep" : "bg-paper text-muted ring-1 ring-line"}`}>
          {c.verification_status === "verified" ? (ar ? "موثّق" : "Verified") : ar ? "غير موثّق" : "Unverified"}
        </span>
      </header>

      {sp.error && <p className="note-error">{sp.error === "invalid" ? (ar ? "تحقق من القيم المدخلة." : "Check the values you entered.") : sp.error}</p>}
      {sp.saved && <p className="note-info">{ar ? "تم الحفظ وإعادة حساب الملاءمة." : "Saved. Fit score recalculated."}</p>}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{ar ? "معلومات عن الشركة" : "What we know"}</h2>
          <p className="text-sm text-muted">{ar ? "اترك الحقل فارغاً إذا لم تتأكد منه — المجهول يبقى مجهولاً ولا يُحسب ضد الشركة." : "Leave a field empty if you haven't confirmed it. Unknown stays unknown and never counts against the company."}</p>
          <form action={updateLeadFacts.bind(null, id)} className="space-y-4 rounded-lg border border-line bg-surface p-5">
            <div className="max-w-sm">
              <label className="label" htmlFor="governorate">{ar ? "المحافظة" : "Governorate"}</label>
              <select className="field" id="governorate" name="governorate" defaultValue={c.governorate ?? ""}>
                <option value="">{ar ? "غير معروف" : "Unknown"}</option>
                {GOVERNORATES.map((g) => <option key={g.code} value={g.code}>{ar ? g.ar : g.en}</option>)}
              </select>
            </div>
            <PackFields fields={ctx.config.companyFields} values={(c.attributes ?? {}) as Record<string, unknown>} lang={lang} />
            <button className="btn-primary">{ar ? "حفظ" : "Save"}</button>
          </form>

          {contacts && contacts.length > 0 && (
            <div>
              <h2 className="mt-6 text-lg font-semibold">{ar ? "جهات الاتصال" : "Contacts"}</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {contacts.map((p) => <li key={p.id}>{p.full_name}{p.job_title && <span className="text-muted">، {p.job_title}</span>}</li>)}
              </ul>
            </div>
          )}

          <p className="pt-4 text-xs text-muted">
            {ar ? "المصدر" : "Source"}: {c.source_type === "csv_import" ? (ar ? "استيراد ملف" : "File import") : c.source_type} {c.source_ref && <span dir="ltr">({c.source_ref})</span>}, {fmtDate(lang, c.discovered_at)}
          </p>
        </section>

        <aside className="space-y-6">
          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="font-semibold">{ar ? "درجة الملاءمة" : "Fit score"}</h2>
            <div className="mt-3"><ScoreBar value={score.normalized} lang={lang} /></div>
            <p className="mt-2 text-xs text-muted">
              {ar ? `مبنية على ${fmtNumber(lang, Math.round(score.coverage * 100))}٪ من المعايير المعروفة` : `Based on ${Math.round(score.coverage * 100)}% of criteria known`}
            </p>
            {score.matched.length > 0 && (
              <ul className="mt-4 space-y-1 text-sm">
                {score.matched.map((m) => <li key={m.key} className="flex justify-between gap-2"><span>{tx(m.reason, lang)}</span><span className="tabular-nums text-lapis">+{m.points}</span></li>)}
              </ul>
            )}
            {score.unknown.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium">{ar ? "للبحث والتأكد" : "To find out"}</p>
                <ul className="mt-1 list-disc ps-5 text-sm text-muted">
                  {[...new Set(score.unknown.map((u) => u.field))].map((f) => <li key={f}>{fieldLabel(f)}</li>)}
                </ul>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="font-semibold">{ar ? "الصفقات" : "Deals"}</h2>
            {deals && deals.length > 0 && (
              <ul className="mt-3 space-y-2 text-sm">
                {deals.map((d) => (
                  <li key={d.id}><Link className="text-lapis hover:underline" href={`/deals/${d.id}`}>{d.title}</Link> <span className="text-muted">({stageName(d.stage_id)})</span></li>
                ))}
              </ul>
            )}
            <form action={createDeal.bind(null, id)} className="mt-4 space-y-3">
              <div>
                <label className="label" htmlFor="title">{ar ? "عنوان الصفقة" : "Deal title"}</label>
                <input className="field" id="title" name="title" required minLength={2} placeholder={ar ? "مثال: منظومة هجينة للمعمل" : "e.g. Hybrid system for the factory"} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="value">{ar ? "القيمة التقديرية" : "Estimated value"}</label>
                  <input className="field" id="value" name="value" type="number" min={0} step="any" placeholder={ar ? "غير معروفة" : "Unknown"} />
                </div>
                <div>
                  <label className="label" htmlFor="currency">{ar ? "العملة" : "Currency"}</label>
                  <select className="field" id="currency" name="currency" defaultValue={ctx.tenant.default_currency}>
                    <option>USD</option><option>IQD</option>
                  </select>
                </div>
              </div>
              <button className="btn-quiet w-full">{ar ? "بدء صفقة" : "Start a deal"}</button>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
