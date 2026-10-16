import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtDate } from "@/lib/i18n";
import { saveDoc, setDocStatus } from "./actions";

const KINDS: Record<string, [string, string]> = {
  company: ["تعريف بالشركة", "Company profile"],
  product: ["منتجات وخدمات", "Products & services"],
  pricing: ["أسعار (يُسمح بذكرها)", "Pricing (may be quoted)"],
  faq: ["أسئلة شائعة", "FAQ"],
  policy: ["سياسات وشروط", "Policies & terms"],
  case_study: ["مشاريع منفذة معتمدة", "Approved case studies"],
  other: ["أخرى", "Other"],
};

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; edit?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const { data: docs } = await sb.from("knowledge_docs").select("id, kind, title, body, status, version, updated_at").eq("tenant_id", ctx.tenant.id).order("status").order("updated_at", { ascending: false });
  const canEdit = ["owner", "admin", "manager"].includes(ctx.role);
  const editing = sp.edit ? docs?.find((d) => d.id === sp.edit) : null;
  const errors: Record<string, [string, string]> = { invalid: ["العنوان (حرفان على الأقل) والنص (10 أحرف على الأقل) مطلوبان.", "A title (2+ characters) and text (10+ characters) are required."], role: ["فقط المدير أو المسؤول يمكنه التعديل.", "Only a manager or admin can edit."] };

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{ar ? "قاعدة المعرفة" : "Knowledge base"}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          {ar
            ? "هذا كل ما يعرفه الوكيل عن شركتك. لا يذكر في رسائله أي منتج أو سعر أو ضمان أو مشروع سابق إلا إذا كان مكتوباً هنا. الأسعار لا تُذكر إلا من مستند من نوع «أسعار»."
            : "This is everything the agent knows about your company. It never mentions a product, price, warranty or past project unless it is written here. Prices are only quoted from a “Pricing” document."}
        </p>
      </header>
      {sp.saved && <p className="note-info">{ar ? "تم الحفظ." : "Saved."}</p>}
      {sp.error && <p className="note-error">{errors[sp.error]?.[ar ? 0 : 1] ?? sp.error}</p>}

      {canEdit && (
        <form action={saveDoc.bind(null, editing?.id ?? null)} className="space-y-4 rounded-lg border border-line bg-surface p-5">
          <h2 className="font-semibold">{editing ? (ar ? "تعديل مستند" : "Edit document") : ar ? "إضافة مستند" : "Add a document"}</h2>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <div>
              <label className="label" htmlFor="kind">{ar ? "النوع" : "Type"}</label>
              <select className="field" id="kind" name="kind" defaultValue={editing?.kind ?? "product"}>
                {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v[ar ? 0 : 1]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="title">{ar ? "العنوان" : "Title"}</label>
              <input className="field" id="title" name="title" required minLength={2} defaultValue={editing?.title ?? ""} placeholder={ar ? "مثال: منظومات Sigenergy للتخزين" : "e.g. Sigenergy storage systems"} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="body">{ar ? "النص" : "Text"}</label>
            <textarea className="field min-h-56 leading-relaxed" id="body" name="body" required minLength={10} defaultValue={editing?.body ?? ""}
              placeholder={ar ? "اكتب أو الصق المعلومات كما تريد أن يستخدمها الوكيل: المنتجات، المواصفات المعتمدة، الضمان، المناطق التي تخدمها، طريقة التواصل…" : "Write or paste information the way you want the agent to use it: products, approved specs, warranty, areas you serve, how to get in touch…"} />
          </div>
          <div className="flex gap-3">
            <button className="btn-primary">{ar ? "حفظ" : "Save"}</button>
            {editing && <a href="/knowledge" className="btn-quiet">{ar ? "إلغاء" : "Cancel"}</a>}
          </div>
        </form>
      )}

      {(docs ?? []).length === 0 ? (
        <p className="text-sm text-muted">{ar ? "لا توجد مستندات بعد. ابدأ بتعريف عن الشركة ووصف منتجاتك." : "No documents yet. Start with a company profile and a description of your products."}</p>
      ) : (
        <ul className="space-y-3">
          {docs!.map((d) => (
            <li key={d.id} className={`rounded-lg border border-line bg-surface p-4 ${d.status === "archived" ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{d.title} <span className="ms-2 text-xs font-normal text-muted">{KINDS[d.kind]?.[ar ? 0 : 1]}</span></p>
                <p className="text-xs text-muted">
                  {ar ? `الإصدار ${d.version}، ${fmtDate(lang, d.updated_at)}` : `Version ${d.version}, ${fmtDate(lang, d.updated_at)}`}
                  {d.status === "archived" && (ar ? "، مؤرشف (لا يستخدمه الوكيل)" : ", archived (not used by the agent)")}
                </p>
              </div>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm text-muted">{d.body}</p>
              {canEdit && (
                <div className="mt-3 flex gap-4 text-sm">
                  <a href={`/knowledge?edit=${d.id}`} className="text-lapis hover:underline">{ar ? "تعديل" : "Edit"}</a>
                  <form action={setDocStatus.bind(null, d.id, d.status === "active" ? "archived" : "active")}>
                    <button className="text-muted hover:text-ink">{d.status === "active" ? (ar ? "أرشفة" : "Archive") : ar ? "تفعيل" : "Restore"}</button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
