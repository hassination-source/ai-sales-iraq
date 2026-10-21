import { GOVERNORATES } from "@ais/core";

export type Lang = "ar" | "en";
export interface AgentEvent {
  id: number;
  type: string;
  level: "info" | "success" | "warning" | "error";
  data: Record<string, unknown>;
  company_id: string | null;
  draft_id: string | null;
  mission_id: string | null;
  created_at: string;
}

const gov = (code: unknown, lang: Lang) => {
  const g = GOVERNORATES.find((x) => x.code === code);
  return g ? g[lang] : String(code ?? "");
};
const label = (v: unknown, lang: Lang, fallback = "") => {
  if (v && typeof v === "object" && lang in (v as object)) return String((v as Record<string, string>)[lang]);
  return fallback || String(v ?? "");
};
const n = (v: unknown, lang: Lang) => new Intl.NumberFormat(lang === "ar" ? "ar-IQ" : "en-US").format(Number(v ?? 0));
const list = (v: unknown, lang: Lang, map: (x: string) => string = (x) => x) =>
  (Array.isArray(v) ? v.map((x) => map(String(x))) : []).join(lang === "ar" ? "، " : ", ");

/** One readable line per agent action. Unknown types still render, never crash the feed. */
export function describeEvent(e: AgentEvent, lang: Lang, segmentLabel: (key: string) => string): string {
  const d = e.data;
  const ar = lang === "ar";
  switch (e.type) {
    case "mission.started":
      return ar
        ? `بدأت مهمة: ${list(d.segments, lang, segmentLabel)} في ${list(d.governorates, lang, (g) => gov(g, lang))} (حتى ${n(d.limit, lang)} شركة)`
        : `Started a mission: ${list(d.segments, lang, segmentLabel)} in ${list(d.governorates, lang, (g) => gov(g, lang))} (up to ${d.limit} companies)`;
    case "discover.found": {
      const seg = label(d.segment_label, lang, segmentLabel(String(d.segment)));
      if (!Number(d.count))
        return ar ? `لم أجد ${seg} جديدة في ${gov(d.governorate, lang)}${Number(d.duplicates) ? ` (${n(d.duplicates, lang)} موجودة مسبقاً)` : ""}` : `No new ${seg.toLowerCase()} in ${gov(d.governorate, lang)}${Number(d.duplicates) ? ` (${d.duplicates} already in your leads)` : ""}`;
      return ar
        ? `وجدت ${n(d.count, lang)} من ${seg} في ${gov(d.governorate, lang)}${d.source ? ` عبر ${d.source}` : ""}${Number(d.duplicates) ? `، وتجاهلت ${n(d.duplicates, lang)} مكررة` : ""}`
        : `Found ${d.count} ${seg.toLowerCase()} in ${gov(d.governorate, lang)}${d.source ? ` via ${d.source}` : ""}${Number(d.duplicates) ? `, skipped ${d.duplicates} duplicates` : ""}`;
    }
    case "discover.source_busy":
      return ar
        ? `${d.source === "google" ? "Google Maps" : "مصدر البيانات"} مشغول الآن. سأحاول مجدداً بعد ${n(d.retry_in_min, lang)} دقيقة`
        : `${d.source === "google" ? "Google Maps" : "The directory"} is busy right now. Retrying in ${d.retry_in_min} min`;
    case "discover.google_budget":
      return ar ? `وصلت لحد بحث Google لهذه المهمة (${n(d.requests, lang)} طلب). أكمل بـOpenStreetMap` : `Reached this mission's Google search budget (${d.requests} requests). Continuing with OpenStreetMap`;
    case "discover.google_config":
      return ar ? `مفتاح Google Places مرفوض، أكملت بـOpenStreetMap فقط: ${d.error}` : `The Google Places key was refused, so I continued with OpenStreetMap only: ${d.error}`;
    case "discover.source_failed":
      return ar ? `تعذّر البحث عن ${segmentLabel(String(d.segment))} في ${gov(d.governorate, lang)}` : `Couldn't search ${segmentLabel(String(d.segment)).toLowerCase()} in ${gov(d.governorate, lang)}`;
    case "research.no_website":
      return ar ? `${n(d.count, lang)} شركة بدون موقع إلكتروني: تحتاج بحثاً أو اتصالاً يدوياً` : `${d.count} companies have no website: they need manual research or a call`;
    case "research.done":
      return ar
        ? `قرأت موقع ${d.name}${Number(d.emails) ? `: وجدت ${n(d.emails, lang)} بريد` : ""}${Number(d.phones) ? ` و${n(d.phones, lang)} هاتف` : ""}`
        : `Read ${d.name}'s website${Number(d.emails) ? `: found ${d.emails} email${Number(d.emails) > 1 ? "s" : ""}` : ""}${Number(d.phones) ? `, ${d.phones} phone${Number(d.phones) > 1 ? "s" : ""}` : ""}`;
    case "research.failed":
      return ar ? `لم أتمكن من فتح موقع ${d.name}` : `Couldn't open ${d.name}'s website`;
    case "draft.needs_ai":
      return ar ? "جاهز لكتابة الرسائل، لكن الكتابة بالذكاء الاصطناعي غير مفعّلة بعد" : "Ready to write messages, but AI writing isn't switched on yet";
    case "draft.needs_knowledge":
      return ar ? "أضف معلومات شركتك ومنتجاتك في قاعدة المعرفة حتى أكتب رسائل دقيقة" : "Add your company and product information to the knowledge base so I can write accurate messages";
    case "draft.ai_config":
      return ar ? `مفتاح الذكاء الاصطناعي يحتاج إلى ضبط: ${d.error}` : `The AI key needs attention: ${d.error}`;
    case "draft.ai_retry":
      return ar ? `خدمة الذكاء الاصطناعي لم تستجب. سأحاول مجدداً (${d.error})` : `The AI service didn't respond. Trying again (${d.error})`;
    case "draft.created":
      return ar ? `كتبت رسالة إلى ${d.name}: بانتظار موافقتك` : `Wrote a message to ${d.name}: waiting for your approval`;
    case "draft.skipped":
      return ar ? `لم أكتب إلى ${d.name}: ${d.reason}` : `Didn't write to ${d.name}: ${d.reason}`;
    case "draft.invalid":
      return ar ? `رفضت مسودة لـ${d.name} لأنها لم تلتزم بالمصادر المعتمدة` : `Discarded a draft for ${d.name}: it didn't stick to approved sources`;
    case "draft.daily_limit":
      return ar ? `وصلت للحد اليومي (${n(d.limit, lang)} رسالة). سأكمل غداً` : `Reached today's limit (${d.limit} messages). I'll continue tomorrow`;
    case "leads.claimed":
      return Number(d.count)
        ? ar ? `أخذت ${n(d.count, lang)} شركة من قائمتك المستوردة` : `Took ${d.count} companies from your imported list`
        : ar ? "لا توجد شركات مطابقة في قائمتك المستوردة (بالمحافظة والنوع المختارين، ولديها بريد)" : "No matching companies in your imported list (for the chosen governorates and types, with an email)";
    case "draft.rewritten":
      return ar ? `أعدت كتابة الرسالة إلى ${d.name}: بانتظار موافقتك` : `Rewrote the message to ${d.name}: waiting for your approval`;
    case "email.sent":
      return ar ? `أرسلت الرسالة إلى ${d.name} (${d.to})` : `Sent the message to ${d.name} (${d.to})`;
    case "email.failed":
      return ar ? `تعذّر إرسال الرسالة إلى ${d.name}: ${d.error}` : `Couldn't send the message to ${d.name}: ${d.error}`;
    case "email.unsubscribed":
      return ar ? `${d.email} طلب عدم مراسلته. لن أراسله مجدداً` : `${d.email} asked not to be contacted. I won't email them again`;
    case "mission.done":
      return ar
        ? `انتهت المهمة: ${n(d.found, lang)} شركة، ${n(d.researched, lang)} موقع، ${n(d.drafted, lang)} رسالة`
        : `Mission finished: ${d.found ?? 0} companies, ${d.researched ?? 0} websites read, ${d.drafted ?? 0} messages written`;
    case "mission.retry":
      return ar ? "حدث خطأ مؤقت. سأعيد المحاولة بعد دقيقتين" : "Something went wrong. Retrying in 2 minutes";
    case "mission.failed":
      return ar ? "توقفت المهمة بسبب خطأ متكرر" : "The mission stopped after repeated errors";
    default:
      return e.type;
  }
}
