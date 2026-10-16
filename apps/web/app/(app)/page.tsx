import Link from "next/link";
import { GOVERNORATES, t as tx } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { integrationStatus } from "@/lib/supabase/service";
import { getLang, fmtNumber } from "@/lib/i18n";
import { ActivityFeed } from "@/components/activity-feed";
import type { AgentEvent } from "@/lib/events";
import { cancelMission, startMission } from "./agent-actions";

export default async function AgentHome({ searchParams }: { searchParams: Promise<{ error?: string; started?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const tid = ctx.tenant.id;
  const since = new Date();
  since.setUTCHours(-3, 0, 0, 0); // start of today in Baghdad

  const [events, missions, foundToday, researchedToday, waiting, docs, settings] = await Promise.all([
    sb.from("agent_events").select("id, type, level, data, company_id, draft_id, mission_id, created_at").eq("tenant_id", tid).order("id", { ascending: false }).limit(60),
    sb.from("agent_missions").select("id, params, status, phase, progress, note, next_run_at, created_at").eq("tenant_id", tid).order("created_at", { ascending: false }).limit(6),
    sb.from("companies").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("source_type", "api").gte("created_at", since.toISOString()),
    sb.from("company_research").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("status", "ok").gte("fetched_at", since.toISOString()),
    sb.from("message_drafts").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("status", "pending_review"),
    sb.from("knowledge_docs").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("status", "active"),
    sb.from("agent_settings").select("paused").eq("tenant_id", tid).maybeSingle(),
  ]);

  const integrations = integrationStatus();
  const active = (missions.data ?? []).filter((m) => ["queued", "running"].includes(m.status));
  const working = active.length > 0 && !settings.data?.paused;
  const canRun = ["owner", "admin", "manager"].includes(ctx.role);
  const segLabel = Object.fromEntries(ctx.config.segments.map((s) => [s.key, tx(s.label, lang)]));
  const govName = (c: string) => GOVERNORATES.find((g) => g.code === c)?.[lang] ?? c;
  const defaultGovs = ctx.config.territories.length ? ctx.config.territories : ["IQ-BG"];
  const errors: Record<string, [string, string]> = {
    mission_invalid: ["اختر قطاعاً ومحافظة واحدة على الأقل.", "Choose at least one segment and one governorate."],
    duplicate: ["هذه المهمة قيد التنفيذ بالفعل.", "This mission is already running."],
    too_many: ["هناك 3 مهام قيد التنفيذ. انتظر انتهاء إحداها أو ألغِها.", "Three missions are already running. Wait for one to finish or cancel it."],
    role: ["فقط المدير أو المسؤول يمكنه تشغيل الوكيل.", "Only a manager or admin can run the agent."],
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{ar ? "وكيل المبيعات" : "Sales agent"}</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted">
            <span className={`size-2 rounded-full ${settings.data?.paused ? "bg-ochre" : working ? "animate-pulse bg-lapis" : "bg-muted/40"}`} aria-hidden="true" />
            {settings.data?.paused ? (ar ? "متوقف مؤقتاً" : "Paused") : working ? (ar ? "يعمل الآن" : "Working") : ar ? "بانتظار مهمة" : "Waiting for a mission"}
          </p>
        </div>
        <dl className="flex gap-6 text-sm">
          <Stat label={ar ? "شركات وُجدت اليوم" : "Found today"} value={fmtNumber(lang, foundToday.count ?? 0)} />
          <Stat label={ar ? "مواقع قُرئت اليوم" : "Researched today"} value={fmtNumber(lang, researchedToday.count ?? 0)} />
          <Stat label={ar ? "بانتظار موافقتك" : "Waiting for you"} value={fmtNumber(lang, waiting.count ?? 0)} href={(waiting.count ?? 0) > 0 ? "/approvals" : undefined} strong={(waiting.count ?? 0) > 0} />
        </dl>
      </header>

      {sp.error && <p className="note-error">{errors[sp.error]?.[ar ? 0 : 1] ?? sp.error}</p>}
      {sp.started && <p className="note-info">{ar ? "بدأ الوكيل العمل. ستظهر خطواته هنا خلال دقيقة." : "The agent has started. Its steps will show up here within a minute."}</p>}

      <div className="grid gap-8 xl:grid-cols-[1fr_22rem]">
        <section aria-labelledby="feed-title" className="min-w-0">
          <h2 id="feed-title" className="mb-3 text-lg font-semibold">{ar ? "ماذا يفعل الوكيل" : "What the agent is doing"}</h2>
          <div className="rounded-lg border border-line bg-surface p-3">
            <ActivityFeed initial={(events.data ?? []) as AgentEvent[]} lang={lang} segments={segLabel} live={working} />
          </div>
        </section>

        <aside className="space-y-6">
          {canRun && (
            <section className="rounded-lg border border-line bg-surface p-5">
              <h2 className="font-semibold">{ar ? "مهمة جديدة" : "New mission"}</h2>
              <p className="mt-1 text-sm text-muted">{ar ? "أخبر الوكيل عن من يبحث وأين." : "Tell the agent who to look for, and where."}</p>
              <form action={startMission} className="mt-4 space-y-4">
                <fieldset>
                  <legend className="label">{ar ? "نوع العملاء" : "Type of customer"}</legend>
                  <div className="mt-1 space-y-1.5">
                    {ctx.config.segments.map((s, i) => (
                      <label key={s.key} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="segments" value={s.key} defaultChecked={i < 2} className="accent-lapis" />
                        {tx(s.label, lang)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="label">{ar ? "المحافظات" : "Governorates"}</legend>
                  <div className="mt-1 grid max-h-44 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto pe-1">
                    {GOVERNORATES.map((g) => (
                      <label key={g.code} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="governorates" value={g.code} defaultChecked={defaultGovs.includes(g.code)} className="accent-lapis" />
                        {g[lang]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <label className="label" htmlFor="limit">{ar ? "أقصى عدد شركات" : "At most"}</label>
                  <select className="field" id="limit" name="limit" defaultValue="25">
                    {[10, 25, 50, 100, 200].map((v) => <option key={v} value={v}>{ar ? `${fmtNumber(lang, v)} شركة` : `${v} companies`}</option>)}
                  </select>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="write_drafts" defaultChecked className="mt-1 accent-lapis" />
                  <span>{ar ? "اكتب رسالة أولى لكل شركة لديها بريد (تنتظر موافقتك قبل أي إرسال)" : "Write a first message to each company with an email (waits for your approval before anything is sent)"}</span>
                </label>
                <button className="btn-primary w-full">{ar ? "ابدأ" : "Start"}</button>
              </form>
            </section>
          )}

          {(missions.data ?? []).length > 0 && (
            <section className="rounded-lg border border-line bg-surface p-5">
              <h2 className="font-semibold">{ar ? "المهام" : "Missions"}</h2>
              <ul className="mt-3 space-y-3">
                {missions.data!.map((m) => {
                  const p = (m.progress ?? {}) as { found?: number; researched?: number; drafted?: number };
                  const params = m.params as { segments: string[]; governorates: string[]; limit: number };
                  const status: Record<string, [string, string]> = {
                    queued: ["في الانتظار", "Queued"], running: ["قيد التنفيذ", "Running"], done: ["انتهت", "Done"],
                    blocked: ["متوقفة", "Blocked"], failed: ["فشلت", "Failed"], cancelled: ["أُلغيت", "Cancelled"],
                  };
                  return (
                    <li key={m.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                      <p className="text-sm font-medium">{params.segments.map((s) => segLabel[s] ?? s).join(ar ? "، " : ", ")}</p>
                      <p className="text-xs text-muted">{params.governorates.map(govName).join(ar ? "، " : ", ")}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs">
                        <span className={m.status === "running" ? "text-lapis" : m.status === "failed" ? "text-brick" : "text-muted"}>{status[m.status]?.[ar ? 0 : 1]}</span>
                        <span className="tabular-nums text-muted">
                          {ar ? `${fmtNumber(lang, p.found ?? 0)} شركة · ${fmtNumber(lang, p.researched ?? 0)} موقع · ${fmtNumber(lang, p.drafted ?? 0)} رسالة` : `${p.found ?? 0} found · ${p.researched ?? 0} researched · ${p.drafted ?? 0} drafted`}
                        </span>
                        {["queued", "running"].includes(m.status) && canRun && (
                          <form action={cancelMission.bind(null, m.id)} className="ms-auto">
                            <button className="text-brick hover:underline">{ar ? "إلغاء" : "Cancel"}</button>
                          </form>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="font-semibold">{ar ? "جاهزية الوكيل" : "Agent setup"}</h2>
            <ul className="mt-3 space-y-2.5 text-sm">
              <Check ok={integrations.worker && integrations.workerProjectMatches} href="/settings" text={ar ? "البحث عن الشركات وقراءة مواقعها" : "Finding companies and reading their websites"} />
              <Check ok={(docs.count ?? 0) > 0} href="/knowledge" text={ar ? `قاعدة المعرفة (${fmtNumber(lang, docs.count ?? 0)} مستند)` : `Knowledge base (${docs.count ?? 0} documents)`} />
              <Check ok={integrations.ai} href="/settings" text={ar ? "كتابة الرسائل بالذكاء الاصطناعي" : "AI message writing"} />
              <Check ok={integrations.email} href="/settings" text={ar ? "إرسال البريد واستقبال الردود" : "Sending email and reading replies"} soon />
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, href, strong }: { label: string; value: string; href?: string; strong?: boolean }) {
  const body = (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${strong ? "text-lapis" : ""}`}>{value}</dd>
    </>
  );
  return href ? <Link href={href} className="block hover:text-lapis">{body}</Link> : <div>{body}</div>;
}

function Check({ ok, text, href, soon }: { ok: boolean; text: string; href: string; soon?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full text-[10px] text-white ${ok ? "bg-lapis" : soon ? "bg-line" : "bg-ochre"}`} aria-hidden="true">{ok ? "✓" : ""}</span>
      <Link href={href} className={`hover:text-lapis ${ok ? "" : "text-muted"}`}>{text}</Link>
    </li>
  );
}
