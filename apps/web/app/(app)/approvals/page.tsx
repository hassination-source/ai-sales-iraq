import Link from "next/link";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { integrationStatus } from "@/lib/supabase/service";
import { getLang, fmtDate } from "@/lib/i18n";
import { reviewDraft, saveDraft } from "./actions";

type Grounding = { sources?: string[]; hypotheses?: string[]; website?: string | null; directory?: string | null };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const [{ data: drafts }, { data: docs }, { data: recent }] = await Promise.all([
    sb.from("message_drafts").select("id, subject, body, language, channel, grounding, generated_by, edited, created_at, company:companies(id, name, email, governorate)").eq("tenant_id", ctx.tenant.id).eq("status", "pending_review").order("created_at").limit(30),
    sb.from("knowledge_docs").select("id, title").eq("tenant_id", ctx.tenant.id),
    sb.from("message_drafts").select("id, status, subject, reviewed_at, company:companies(name)").eq("tenant_id", ctx.tenant.id).in("status", ["approved", "rejected", "sent"]).order("reviewed_at", { ascending: false }).limit(8),
  ]);
  const docTitle = new Map((docs ?? []).map((d) => [`kb:${d.id}`, d.title]));
  const canReview = ["owner", "admin", "manager"].includes(ctx.role);
  const emailReady = integrationStatus().email;
  const sourceLabel = (s: string) => (s.startsWith("kb:") ? `${ar ? "قاعدة المعرفة" : "Knowledge base"}: ${docTitle.get(s) ?? s}` : s === "website" ? (ar ? "موقع الشركة" : "Company website") : s === "directory" ? "OpenStreetMap" : s);
  const notes: Record<string, [string, string]> = {
    approved: [emailReady ? "تمت الموافقة. ستُرسل الرسالة." : "تمت الموافقة. ستُرسل عند تفعيل إرسال البريد.", emailReady ? "Approved. The message will be sent." : "Approved. It will be sent once email sending is connected."],
    rejected: ["تم الرفض.", "Rejected."],
    saved: ["تم حفظ التعديلات.", "Changes saved."],
  };
  const errors: Record<string, [string, string]> = { invalid: ["العنوان والنص مطلوبان.", "Subject and text are required."], role: ["فقط المدير أو المسؤول يمكنه الموافقة.", "Only a manager or admin can approve."] };
  const note = ["approved", "rejected", "saved"].find((k) => sp[k]);

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{ar ? "بانتظار موافقتك" : "Waiting for your approval"}</h1>
        <p className="mt-1 text-sm text-muted">
          {ar ? "لا يُرسل الوكيل أي رسالة دون موافقة. راجع النص والمصادر، عدّل ما تريد، ثم وافق أو ارفض." : "The agent never sends anything without approval. Check the text and its sources, edit what you like, then approve or reject."}
        </p>
      </header>

      {note && <p className="note-info">{notes[note]![ar ? 0 : 1]}</p>}
      {sp.error && <p className="note-error">{errors[sp.error]?.[ar ? 0 : 1] ?? sp.error}</p>}

      {(drafts ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
          <p className="font-medium">{ar ? "لا توجد رسائل بانتظارك" : "Nothing waiting for you"}</p>
          <p className="mt-1 text-sm text-muted">{ar ? "عندما يكتب الوكيل رسالة ستظهر هنا." : "When the agent writes a message it shows up here."}</p>
          <Link href="/" className="btn-quiet mt-4">{ar ? "إلى الوكيل" : "Go to the agent"}</Link>
        </div>
      ) : (
        <ul className="space-y-6">
          {drafts!.map((d) => {
            const c = d.company as unknown as { id: string; name: string; email: string | null } | null;
            const g = (d.grounding ?? {}) as Grounding;
            const rtl = d.language.startsWith("ar");
            return (
              <li key={d.id} className="rounded-lg border border-line bg-surface">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
                  <p>
                    <Link href={c ? `/leads/${c.id}` : "#"} className="font-medium hover:text-lapis">{c?.name}</Link>
                    {c?.email && <span className="ms-2 text-sm text-muted" dir="ltr">{c.email}</span>}
                  </p>
                  <p className="text-xs text-muted">{ar ? "كتبها الوكيل" : "Written by the agent"}, {fmtDate(lang, d.created_at)}{d.edited ? (ar ? "، معدّلة" : ", edited") : ""}</p>
                </div>
                <form className="space-y-3 px-5 py-4">
                  <div>
                    <label className="label" htmlFor={`s-${d.id}`}>{ar ? "العنوان" : "Subject"}</label>
                    <input className="field" id={`s-${d.id}`} name="subject" defaultValue={d.subject ?? ""} dir={rtl ? "rtl" : "ltr"} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`b-${d.id}`}>{ar ? "النص" : "Message"}</label>
                    <textarea className="field min-h-48 leading-relaxed" id={`b-${d.id}`} name="body" defaultValue={d.body} dir={rtl ? "rtl" : "ltr"} />
                  </div>

                  <div className="grid gap-4 rounded-md bg-paper p-3 text-sm sm:grid-cols-2">
                    <div>
                      <p className="font-medium">{ar ? "المصادر المستخدمة" : "Sources used"}</p>
                      <ul className="mt-1 space-y-0.5 text-muted">
                        {(g.sources ?? []).map((s) => (
                          <li key={s}>
                            {s === "website" && g.website ? <a className="text-lapis hover:underline" href={g.website} target="_blank" rel="noreferrer">{sourceLabel(s)}</a>
                              : s === "directory" && g.directory ? <a className="text-lapis hover:underline" href={g.directory} target="_blank" rel="noreferrer">{sourceLabel(s)}</a>
                              : sourceLabel(s)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium">{ar ? "افتراضات يجب التحقق منها" : "Assumptions to check"}</p>
                      {(g.hypotheses ?? []).length ? (
                        <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted">{g.hypotheses!.map((h, i) => <li key={i}>{h}</li>)}</ul>
                      ) : (
                        <p className="mt-1 text-muted">{ar ? "لا يوجد" : "None"}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    {canReview && <button formAction={reviewDraft.bind(null, d.id, "approved")} className="btn-primary">{ar ? "موافقة" : "Approve"}</button>}
                    <button formAction={saveDraft.bind(null, d.id)} className="btn-quiet">{ar ? "حفظ التعديلات" : "Save changes"}</button>
                    {canReview && (
                      <span className="ms-auto flex items-center gap-2">
                        <input className="field w-48 py-1.5 text-sm" name="reject_reason" placeholder={ar ? "سبب الرفض (اختياري)" : "Reason (optional)"} aria-label={ar ? "سبب الرفض" : "Reject reason"} />
                        <button formAction={reviewDraft.bind(null, d.id, "rejected")} className="btn text-brick hover:bg-brick-soft">{ar ? "رفض" : "Reject"}</button>
                      </span>
                    )}
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {(recent ?? []).length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">{ar ? "قرارات سابقة" : "Recent decisions"}</h2>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface text-sm">
            {recent!.map((r) => (
              <li key={r.id} className="flex justify-between gap-3 px-4 py-2.5">
                <span>{(r.company as unknown as { name: string } | null)?.name}: <span className="text-muted">{r.subject}</span></span>
                <span className={r.status === "rejected" ? "text-brick" : "text-lapis"}>
                  {r.status === "approved" ? (ar ? "موافق عليها" : "Approved") : r.status === "sent" ? (ar ? "أُرسلت" : "Sent") : ar ? "مرفوضة" : "Rejected"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
