import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { integrationStatus, supabaseService } from "@/lib/supabase/service";
import { composeEmailHtml, composeEmailText, senderFor, sendViaResend, unsubscribeToken } from "@ais/agent";
import { emailConfig } from "@/lib/email";
import { getLang } from "@/lib/i18n";

async function saveSettings(formData: FormData) {
  "use server";
  const ctx = await getContext();
  if (!["owner", "admin"].includes(ctx.role)) redirect("/settings?error=role");
  const parsed = z
    .object({
      paused: z.boolean(),
      daily_draft_limit: z.coerce.number().int().min(0).max(200),
      draft_language: z.enum(["ar-IQ", "ar", "en"]),
      sender_name: z.string().trim().max(120),
      signature: z.string().trim().max(600),
      from_email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]),
    })
    .safeParse({ paused: formData.get("paused") === "on", daily_draft_limit: formData.get("daily_draft_limit"), draft_language: formData.get("draft_language"), sender_name: formData.get("sender_name") ?? "", signature: String(formData.get("signature") ?? "").replace(/\r\n/g, "\n"), from_email: String(formData.get("from_email") ?? "").trim() });
  if (!parsed.success) redirect("/settings?error=invalid");
  const sb = await supabaseServer();
  const { error } = await sb.from("agent_settings").upsert({ tenant_id: ctx.tenant.id, ...parsed.data, sender_name: parsed.data.sender_name || null, signature: parsed.data.signature || null, from_email: parsed.data.from_email || null, updated_by: ctx.userId });
  if (error) redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  redirect("/settings?saved=1");
}

/** Sends a sample outreach email (with the saved signature) to the signed-in user, to check delivery end to end. */
async function sendTestEmail() {
  "use server";
  const ctx = await getContext();
  if (!["owner", "admin"].includes(ctx.role)) redirect("/settings?error=role");
  const cfg = emailConfig();
  const db = supabaseService();
  if (!cfg || !db || !ctx.email) redirect("/settings?test=not_configured");
  const { data: s } = await db.from("agent_settings").select("signature, from_email, draft_language").eq("tenant_id", ctx.tenant.id).maybeSingle();
  const ar = (s?.draft_language ?? "ar-IQ").startsWith("ar");
  const main = ar
    ? "هذه رسالة تجريبية من وكيل المبيعات للتأكد من أن الإرسال يعمل. الرسائل الحقيقية ستصل بهذا الشكل."
    : "This is a test message from the sales agent to check that sending works. Real messages will arrive like this.";
  const body = main + (s?.signature ? `\n\n${s.signature}` : "");
  const unsubscribeUrl = `${cfg.baseUrl.replace(/\/$/, "")}/u/${unsubscribeToken(cfg.secret, ctx.tenant.id, ctx.email)}`;
  const res = await sendViaResend(cfg, {
    from: senderFor(cfg.from, s?.from_email, ctx.tenant.name),
    to: ctx.email,
    subject: ar ? "رسالة تجريبية – وكيل المبيعات" : "Test message – sales agent",
    text: composeEmailText(body, ar ? "ar" : "en", unsubscribeUrl),
    html: composeEmailHtml(main, s?.signature ?? null, ar ? "ar" : "en", unsubscribeUrl),
    unsubscribeUrl,
    idempotencyKey: `test-${ctx.tenant.id}-${Date.now()}`,
  });
  redirect(res.ok ? `/settings?test=sent&to=${encodeURIComponent(ctx.email)}` : `/settings?test=failed&err=${encodeURIComponent(res.error)}`);
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; test?: string; to?: string; err?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const { data: s } = await sb.from("agent_settings").select("*").eq("tenant_id", ctx.tenant.id).maybeSingle();
  const st = integrationStatus();
  const canEdit = ["owner", "admin"].includes(ctx.role);

  const rows: { ok: boolean; name: [string, string]; what: [string, string]; how: [string, string] }[] = [
    {
      ok: st.worker && st.workerProjectMatches,
      name: ["البحث وقراءة المواقع", "Finding companies & reading websites"],
      what: ["يبحث في OpenStreetMap (© OpenStreetMap contributors) ويقرأ مواقع الشركات العامة.", "Searches OpenStreetMap (© OpenStreetMap contributors) and reads companies' public websites."],
      how: [st.workerProjectMatches ? "مفعّل عبر ربط Supabase في Vercel." : "مفتاح Supabase في Vercel يشير إلى مشروع آخر.", st.workerProjectMatches ? "Enabled through the Supabase integration in Vercel." : "The Supabase key in Vercel points to a different project."],
    },
    {
      ok: st.ai,
      name: ["كتابة الرسائل بالذكاء الاصطناعي", "AI message writing"],
      what: ["يكتب رسالة أولى لكل شركة اعتماداً على قاعدة المعرفة وموقع الشركة فقط.", "Writes a first message to each company using only your knowledge base and the company's own website."],
      how: st.aiKeyMalformed
        ? ["القيمة في ANTHROPIC_API_KEY ليست مفتاحاً صحيحاً. الصق المفتاح فقط (يبدأ بـ sk-ant-) بدون أي نص آخر.", "The value in ANTHROPIC_API_KEY isn't a valid key. Paste only the key (starts with sk-ant-), nothing else."]
        : ["يحتاج مفتاح ANTHROPIC_API_KEY في إعدادات Vercel.", "Needs ANTHROPIC_API_KEY in the Vercel project settings."],
    },
    {
      ok: st.email,
      name: ["إرسال البريد والردود", "Sending email & replies"],
      what: ["يرسل الرسالة فور موافقتك، مع رابط إلغاء اشتراك في كل رسالة. الردود تصل إلى صندوق بريدك.", "Sends each message as soon as you approve it, with an unsubscribe link in every email. Replies arrive in your own mailbox."],
      how: ["فعّل النطاق في resend.com (سجلات DNS)، ثم أضف RESEND_API_KEY في Vercel وأعد النشر.", "Verify the domain at resend.com (DNS records), then add RESEND_API_KEY in Vercel and redeploy."],
    },
    {
      ok: st.googlePlaces,
      name: ["Google Places (اختياري)", "Google Places (optional)"],
      what: ["يبحث في Google Maps أولاً (تغطية أوسع بكثير في العراق)، ثم OpenStreetMap. يحفظ روابط فيسبوك وإنستغرام إن وُجدت. كل بحث يُسجّل في التكلفة.", "Searches Google Maps first (far wider coverage in Iraq), then OpenStreetMap. Keeps Facebook/Instagram links when listed. Every search is recorded in costs."],
      how: ["أضف GOOGLE_PLACES_API_KEY في إعدادات Vercel ثم أعد النشر. مدفوع حسب الاستخدام.", "Add GOOGLE_PLACES_API_KEY in the Vercel settings, then redeploy. Paid per use."],
    },
  ];

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">{ar ? "الإعدادات" : "Settings"}</h1>
      {sp.saved && <p className="note-info">{ar ? "تم الحفظ." : "Saved."}</p>}
      {sp.test === "sent" && <p className="note-info">{ar ? `أُرسلت رسالة تجريبية إلى ${sp.to}. تحقق من البريد الوارد (والبريد غير المرغوب).` : `A test message was sent to ${sp.to}. Check your inbox (and spam).`}</p>}
      {sp.test === "failed" && <p className="note-error">{ar ? "تعذّر الإرسال: " : "Sending failed: "}{sp.err}</p>}
      {sp.test === "not_configured" && <p className="note-error">{ar ? "الإرسال غير مفعّل بعد: أضف RESEND_API_KEY في Vercel وأعد النشر." : "Sending isn't set up yet: add RESEND_API_KEY in Vercel and redeploy."}</p>}
      {sp.error && <p className="note-error">{sp.error === "role" ? (ar ? "فقط المالك أو المسؤول." : "Owner or admin only.") : sp.error === "invalid" ? (ar ? "تحقق من القيم." : "Check the values.") : sp.error}</p>}

      <section>
        <h2 className="text-lg font-semibold">{ar ? "الوكيل" : "Agent"}</h2>
        <form action={saveSettings} className="mt-3 space-y-4 rounded-lg border border-line bg-surface p-5">
          <fieldset disabled={!canEdit} className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="paused" defaultChecked={s?.paused ?? false} className="accent-lapis" />
              {ar ? "إيقاف الوكيل مؤقتاً (يتوقف عن كل المهام فوراً)" : "Pause the agent (stops all missions immediately)"}
            </label>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="daily_draft_limit">{ar ? "حد الرسائل اليومي" : "Daily message limit"}</label>
                <input className="field" id="daily_draft_limit" name="daily_draft_limit" type="number" min={0} max={200} defaultValue={s?.daily_draft_limit ?? 20} />
              </div>
              <div>
                <label className="label" htmlFor="draft_language">{ar ? "لغة الرسائل" : "Message language"}</label>
                <select className="field" id="draft_language" name="draft_language" defaultValue={s?.draft_language ?? "ar-IQ"}>
                  <option value="ar-IQ">{ar ? "عراقي" : "Iraqi Arabic"}</option>
                  <option value="ar">{ar ? "عربي فصيح" : "Standard Arabic"}</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="sender_name">{ar ? "اسم المرسل" : "Sender name"}</label>
                <input className="field" id="sender_name" name="sender_name" defaultValue={s?.sender_name ?? ""} placeholder={ar ? "مثال: حسن" : "e.g. Hassan"} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="from_email">{ar ? "عنوان الإرسال" : "Send from"}</label>
              <input className="field" id="from_email" name="from_email" type="email" dir="ltr" defaultValue={s?.from_email ?? ""} placeholder="sales@sigensol.com" />
              <p className="mt-1 text-xs text-muted">{ar ? "يجب أن يكون نطاقه مُفعّلاً في Resend." : "Its domain must be verified in Resend."}</p>
            </div>
            <div>
              <label className="label" htmlFor="signature">{ar ? "التوقيع الثابت" : "Fixed signature"}</label>
              <textarea
                className="field min-h-28 font-mono text-sm"
                id="signature"
                name="signature"
                maxLength={600}
                defaultValue={s?.signature ?? ""}
                placeholder={"م. حسن\nSigen Solar Energy – Sigenergy Iraq\nwww.sigensol.com | www.sigenergy.com\n+964 …"}
              />
              <p className="mt-1 text-xs text-muted">
                {ar
                  ? "يُضاف كما هو إلى نهاية كل رسالة (الاسم، الهاتف، المواقع). الذكاء الاصطناعي لا يكتب توقيعاً عندما يكون هذا الحقل معبّأً."
                  : "Added exactly as written to the end of every message (name, phone, websites). The AI writes no sign-off of its own when this is filled in."}
              </p>
            </div>
            {canEdit && <button className="btn-primary">{ar ? "حفظ" : "Save"}</button>}
          </fieldset>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold">{ar ? "الاتصالات" : "Connections"}</h2>
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.name[1]} className="flex gap-4 p-4">
              <span className={`mt-1 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs ${r.ok ? "bg-lapis-soft text-lapis-deep" : "bg-paper text-muted ring-1 ring-line"}`}>
                {r.ok ? (ar ? "مفعّل" : "On") : ar ? "غير مفعّل" : "Off"}
              </span>
              <div className="text-sm">
                <p className="font-medium">{r.name[ar ? 0 : 1]}</p>
                <p className="text-muted">{r.what[ar ? 0 : 1]}</p>
                {!r.ok && <p className="mt-1 text-xs text-muted">{r.how[ar ? 0 : 1]}</p>}
                {r.name[1] === "Sending email & replies" && r.ok && canEdit && (
                  <form action={sendTestEmail} className="mt-2">
                    <button className="btn-quiet py-1 text-xs">{ar ? "أرسل رسالة تجريبية إلى بريدي" : "Send a test email to me"}</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
