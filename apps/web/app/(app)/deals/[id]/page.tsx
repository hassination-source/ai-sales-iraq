import Link from "next/link";
import { notFound } from "next/navigation";
import { t as tx } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtDate, fmtMoney } from "@/lib/i18n";
import { PackFields, QUAL_PREFIX } from "@/components/fields";
import { addTask, completeTask, moveStage, updateQualification } from "./actions";

export default async function DealPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();

  const [{ data: deal }, { data: tasks }] = await Promise.all([
    sb.from("deals").select("*, company:companies(id, name)").eq("id", id).maybeSingle(),
    sb.from("tasks").select("id, title, due_at, status").eq("deal_id", id).order("status").order("due_at", { nullsFirst: false }),
  ]);
  if (!deal) notFound();
  const company = deal.company as unknown as { id: string; name: string };
  const current = ctx.stages.find((s) => s.id === deal.stage_id);
  const qual = (deal.qualification ?? {}) as Record<string, unknown>;
  const qLabel = (key: string) => {
    const f = ctx.config.qualificationFields.find((x) => x.key === key);
    return f ? tx(f.label, lang) : key;
  };
  const target = sp.target ? ctx.stages.find((s) => s.key === sp.target) : null;
  const errors: Record<string, [string, string]> = {
    invalid: ["تحقق من القيم المدخلة.", "Check the values you entered."],
    lost_reason: ["اكتب سبب الخسارة قبل نقل الصفقة إلى خسارة.", "Write a lost reason before moving the deal to Lost."],
  };

  return (
    <div className="max-w-5xl space-y-8">
      <Link href="/pipeline" className="text-sm text-lapis hover:underline">{ar ? "→ مسار المبيعات" : "← Pipeline"}</Link>
      <header>
        <p className="text-sm text-muted"><Link href={`/leads/${company.id}`} className="hover:text-lapis">{company.name}</Link></p>
        <h1 className="text-3xl font-semibold">{deal.title}</h1>
        <p className="mt-2 text-sm">
          <span className={`rounded-full px-3 py-1 ${current?.kind === "won" ? "bg-ochre-soft text-ochre" : current?.kind === "lost" ? "bg-brick-soft text-brick" : "bg-lapis-soft text-lapis-deep"}`}>
            {current?.label[ar ? "ar" : "en"]}
          </span>
          <span className="ms-3 tabular-nums">{deal.value_amount !== null ? fmtMoney(lang, Number(deal.value_amount), deal.currency!) : ar ? "القيمة غير معروفة" : "Value unknown"}</span>
        </p>
      </header>

      {sp.error && <p className="note-error">{errors[sp.error]?.[ar ? 0 : 1] ?? sp.error}</p>}
      {sp.missing && (
        <div className="note-error">
          {ar ? `لا يمكن نقل الصفقة إلى «${target?.label.ar}» قبل معرفة:` : `This deal can't move to “${target?.label.en}” until you know:`}
          <ul className="mt-1 list-disc ps-5">{sp.missing.split(",").map((k) => <li key={k}>{qLabel(k)}</li>)}</ul>
        </div>
      )}
      {sp.saved && <p className="note-info">{ar ? "تم حفظ معلومات التأهيل." : "Qualification saved."}</p>}
      {sp.moved && <p className="note-info">{ar ? "تم نقل الصفقة." : "Deal moved."}</p>}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{ar ? "التأهيل" : "Qualification"}</h2>
          <form action={updateQualification.bind(null, id)} className="space-y-4 rounded-lg border border-line bg-surface p-5">
            <PackFields fields={ctx.config.qualificationFields} values={qual} lang={lang} prefix={QUAL_PREFIX} />
            <button className="btn-primary">{ar ? "حفظ" : "Save"}</button>
          </form>
        </section>

        <aside className="space-y-6">
          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="font-semibold">{ar ? "نقل إلى مرحلة" : "Move to stage"}</h2>
            <form action={moveStage.bind(null, id)} className="mt-3 space-y-3">
              <select className="field" name="stage_id" defaultValue={deal.stage_id} aria-label={ar ? "المرحلة" : "Stage"}>
                {ctx.stages.map((s) => {
                  const req = ctx.config.stages.find((x) => x.key === s.key)?.requires ?? [];
                  return <option key={s.id} value={s.id}>{s.label[ar ? "ar" : "en"]}{req.length ? (ar ? " (تحتاج معلومات)" : " (needs info)") : ""}</option>;
                })}
              </select>
              <input className="field" name="lost_reason" defaultValue={deal.lost_reason ?? ""} placeholder={ar ? "سبب الخسارة (عند اختيار خسارة)" : "Lost reason (when choosing Lost)"} />
              <button className="btn-quiet w-full">{ar ? "نقل" : "Move"}</button>
            </form>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="font-semibold">{ar ? "المتابعات" : "Follow-ups"}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {(tasks ?? []).map((tk) => (
                <li key={tk.id} className="flex items-start gap-2">
                  {tk.status === "open" ? (
                    <form action={completeTask.bind(null, id, tk.id)}>
                      <button className="mt-0.5 size-4 rounded border border-line hover:border-lapis" aria-label={ar ? "إنهاء" : "Mark done"} />
                    </form>
                  ) : (
                    <span className="mt-0.5 size-4 rounded bg-lapis" aria-hidden="true" />
                  )}
                  <span className={tk.status === "done" ? "text-muted line-through" : ""}>
                    {tk.title}
                    {tk.due_at && (
                      <span className={`ms-2 text-xs ${tk.status === "open" && new Date(tk.due_at) < new Date() ? "text-brick" : "text-muted"}`}>{fmtDate(lang, tk.due_at)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <form action={addTask.bind(null, id)} className="mt-4 space-y-2">
              <input className="field" name="title" required minLength={2} placeholder={ar ? "مثال: الاتصال لتحديد موعد الكشف" : "e.g. Call to book the site survey"} aria-label={ar ? "المتابعة" : "Follow-up"} />
              <div className="flex gap-2">
                <input className="field" type="date" name="due" aria-label={ar ? "الموعد" : "Due date"} />
                <button className="btn-quiet">{ar ? "إضافة" : "Add"}</button>
              </div>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
