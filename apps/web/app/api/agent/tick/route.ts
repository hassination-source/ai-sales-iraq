import { after, NextResponse, type NextRequest } from "next/server";
import { tick } from "@ais/agent";
import { supabaseService } from "@/lib/supabase/service";

// Long enough for discovery + research + a few AI drafts per tick.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Called by the database every minute (pg_cron) and right after a mission is created.
 * Authenticated with a shared secret that lives in the database vault.
 */
export async function POST(req: NextRequest) {
  const db = supabaseService();
  if (!db) return NextResponse.json({ error: "worker not configured" }, { status: 503 });

  const secret = req.headers.get("x-worker-secret") ?? "";
  const { data: ok, error } = await db.rpc("worker_check_secret", { p_secret: secret });
  if (error) return NextResponse.json({ error: "secret check failed" }, { status: 500 });
  if (ok !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ai = apiKey
    ? { apiKey, model: process.env.AI_MODEL ?? "claude-sonnet-5-5", priceIn: Number(process.env.AI_PRICE_IN ?? 3), priceOut: Number(process.env.AI_PRICE_OUT ?? 15) }
    : null;

  // reply at once so the caller's short timeout doesn't cut the work off
  after(async () => {
    try {
      const results = await tick(db, ai, 270_000);
      if (results.length) console.log("[agent] tick", JSON.stringify(results));
    } catch (e) {
      console.error("[agent] tick failed", e instanceof Error ? e.message : e);
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
