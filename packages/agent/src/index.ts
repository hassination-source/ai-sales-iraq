import { runMission, type Db, type GoogleConfig, type Mission } from "./mission";
import { redactSecrets, type AiConfig } from "./ai";

export { runMission, type Db, type Mission, type GoogleConfig } from "./mission";
export type { AiConfig } from "./ai";
export { looksLikeAnthropicKey, redactSecrets } from "./ai";

/**
 * One worker tick: claim due missions and advance each within the time budget.
 * `db` must be a service-role Supabase client (RLS bypassed); every query in the
 * mission code is scoped to the mission's tenant explicitly.
 */
export async function tick(db: Db, ai: AiConfig | null, budgetMs = 240_000, f: typeof fetch = fetch, google: GoogleConfig | null = null) {
  const deadline = Date.now() + budgetMs;
  const { data: missions, error } = await db.rpc("worker_claim_missions", { p_limit: 2 });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const m of (missions ?? []) as Mission[]) {
    try {
      await runMission(m, { db, fetch: f, ai, google, deadline });
      results.push({ id: m.id, ok: true });
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e));
      const giveUp = m.attempts >= 10;
      await db.from("agent_events").insert({ tenant_id: m.tenant_id, mission_id: m.id, type: giveUp ? "mission.failed" : "mission.retry", level: giveUp ? "error" : "warning", data: { error: msg.slice(0, 200) } });
      await db
        .from("agent_missions")
        .update(giveUp ? { status: "failed", note: msg.slice(0, 300), finished_at: new Date().toISOString(), locked_until: null } : { locked_until: null, next_run_at: new Date(Date.now() + 2 * 60_000).toISOString() })
        .eq("id", m.id);
      results.push({ id: m.id, ok: false, error: msg });
    }
  }
  return results;
}
