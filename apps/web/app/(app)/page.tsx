import Link from "next/link";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { getLang, fmtDate, fmtMoney, fmtNumber } from "@/lib/i18n";

export default async function Overview() {
  const ctx = await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  const sb = await supabaseServer();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const tid = ctx.tenant.id;

  const [leads, newLeads, deals, tasks] = await Promise.all([
    sb.from("companies").select("*", { count: "exact", head: true }).eq("tenant_id", tid),
    sb.from("companies").select("*", { count: "exact", head: true }).eq("tenant_id", tid).gte("created_at", weekAgo),
    sb.from("deals").select("stage_id, value_amount, currency").eq("tenant_id", tid).limit(5000),
    sb.from("tasks").select("id, title, due_at, deal_id").eq("tenant_id", tid).eq("status", "open").order("due_at", { nullsFirst: false }).limit(8),
  ]);

  const kind = new Map(ctx.stages.map((s) => [s.id, s.kind]));
  const list = deals.data ?? [];
  const open = list.filter((d) => kind.get(d.stage_id) === "open");
  const won = list.filter((d) => kind.get(d.stage_id) === "won");
  const lost = list.filter((d) => kind.get(d.stage_id) === "lost");
  const sumBy = (rows: typeof list) => {
    const m = new Map<string, number>();
    for (const d of rows) if (d.value_amount !== null && d.currency) m.set(d.currency, (m.get(d.currency) ?? 0) + Number(d.value_amount));
    return [...m];
  };
  const openValue = sumBy(open);
  const winRate = won.length + lost.length > 0 ? Math.round((won.length / (won.length + lost.length)) * 100) : null;
  const empty = (leads.count ?? 0) === 0;

  return (
    <div className="max-w-5xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">{ar ? `أهلاً بك في ${ctx.tenant.name}` : `Welcome to ${ctx.tenant.name}`}</h1>
        <p className="text-sm text-muted">{ar ? "كل الأرقام هنا محسوبة من بياناتك الفعلية." : "Every number here is counted from your actual records."}</p>
      </header>

      {empty ? (
        <section className="rounded-lg border border-line bg-surface p-6">
          <h2 className="text-lg font-semibold">{ar ? "ابدأ بثلاث خطوات" : "Start in three steps"}</h2>
          <ol className="mt-4 space-y-3">
            {[
              [ar ? "استورد قائمة شركات من ملف CSV." : "Import a list of companies from a CSV file.", "/leads/import"],
              [ar ? "افتح أعلى الشركات ملاءمةً وأكمل ما تعرفه عنها." : "Open your best-fit companies and fill in what you know.", "/leads"],
              [ar ? "ابدأ صفقة وتابعها عبر مراحل البيع." : "Start a deal and move it through your stages.", "/pipeline"],
            ].map(([text, href], i) => (
              <li key={href} className="flex items-center gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-lapis-soft text-sm font-medium text-lapis">{fmtNumber(lang, i + 1)}</span>
                <Link href={href!} className="hover:text-lapis">{text}</Link>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <dl className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          <Figure label={ar ? "العملاء المحتملون" : "Leads"} value={fmtNumber(lang, leads.count ?? 0)} sub={ar ? `${fmtNumber(lang, newLeads.count ?? 0)} أُضيفت هذا الأسبوع` : `${newLeads.count ?? 0} added this week`} />
          <Figure label={ar ? "صفقات مفتوحة" : "Open deals"} value={fmtNumber(lang, open.length)} sub={openValue.length ? openValue.map(([c, v]) => fmtMoney(lang, v, c)).join(" + ") : ar ? "بدون قيمة مسجلة" : "No value recorded"} />
          <Figure label={ar ? "صفقات رابحة" : "Won"} value={fmtNumber(lang, won.length)} sub={sumBy(won).map(([c, v]) => fmtMoney(lang, v, c)).join(" + ") || "—"} tone="ochre" />
          <Figure label={ar ? "نسبة الفوز" : "Win rate"} value={winRate === null ? "—" : ar ? `${fmtNumber(lang, winRate)}٪` : `${winRate}%`} sub={ar ? `من ${fmtNumber(lang, won.length + lost.length)} صفقة مغلقة` : `of ${won.length + lost.length} closed deals`} />
        </dl>
      )}

      {!empty && (
        <section>
          <h2 className="text-lg font-semibold">{ar ? "الصفقات حسب المرحلة" : "Deals by stage"}</h2>
          <ul className="mt-4 space-y-2">
            {ctx.stages.map((s) => {
              const n = list.filter((d) => d.stage_id === s.id).length;
              const max = Math.max(1, ...ctx.stages.map((x) => list.filter((d) => d.stage_id === x.id).length));
              const bar = s.kind === "won" ? "bg-ochre" : s.kind === "lost" ? "bg-brick" : "bg-lapis";
              return (
                <li key={s.id} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-3 text-sm">
                  <span className="truncate">{s.label[ar ? "ar" : "en"]}</span>
                  <span className="h-2 rounded-full bg-lapis-soft"><span className={`block h-full rounded-full ${bar}`} style={{ width: `${(n / max) * 100}%` }} /></span>
                  <span className="text-end tabular-nums">{fmtNumber(lang, n)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold">{ar ? "المتابعات القادمة" : "Upcoming follow-ups"}</h2>
        {(tasks.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted">{ar ? "لا توجد متابعات مفتوحة. أضفها من صفحة أي صفقة." : "No open follow-ups. Add them from any deal."}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
            {tasks.data!.map((tk) => (
              <li key={tk.id} className="flex justify-between gap-4 px-4 py-3 text-sm">
                <Link href={`/deals/${tk.deal_id}`} className="hover:text-lapis">{tk.title}</Link>
                <span className={tk.due_at && new Date(tk.due_at) < new Date() ? "text-brick" : "text-muted"}>{tk.due_at ? fmtDate(lang, tk.due_at) : "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ochre" }) {
  return (
    <div className="bg-surface p-5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`mt-1 text-3xl font-semibold tabular-nums ${tone === "ochre" ? "text-ochre" : ""}`}>{value}</dd>
      <dd className="mt-1 text-xs text-muted">{sub}</dd>
    </div>
  );
}
