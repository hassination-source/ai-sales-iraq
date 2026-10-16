"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { GOVERNORATES } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import type { AgentEvent } from "@/lib/events";

/** Newer feed events (RLS limits to the user's company). */
export async function loadEvents(afterId: number): Promise<AgentEvent[]> {
  const ctx = await getContext();
  const sb = await supabaseServer();
  const { data } = await sb
    .from("agent_events")
    .select("id, type, level, data, company_id, draft_id, mission_id, created_at")
    .eq("tenant_id", ctx.tenant.id)
    .gt("id", afterId)
    .order("id", { ascending: false })
    .limit(50);
  return (data ?? []) as AgentEvent[];
}

export async function startMission(formData: FormData) {
  const ctx = await getContext();
  if (!["owner", "admin", "manager"].includes(ctx.role)) redirect("/?error=role");
  const segmentKeys = ctx.config.segments.map((s) => s.key) as [string, ...string[]];
  const parsed = z
    .object({
      segments: z.array(z.enum(segmentKeys)).min(1).max(10),
      governorates: z.array(z.enum(GOVERNORATES.map((g) => g.code) as [string, ...string[]])).min(1).max(19),
      limit: z.coerce.number().int().min(5).max(200),
      write_drafts: z.boolean(),
    })
    .safeParse({
      segments: formData.getAll("segments"),
      governorates: formData.getAll("governorates"),
      limit: formData.get("limit"),
      write_drafts: formData.get("write_drafts") === "on",
    });
  if (!parsed.success) redirect("/?error=mission_invalid");

  const sb = await supabaseServer();
  const { error } = await sb.from("agent_missions").insert({ tenant_id: ctx.tenant.id, params: parsed.data });
  if (error) redirect(`/?error=${encodeURIComponent(error.message.includes("at most 3") ? "too_many" : error.message)}`);
  revalidatePath("/");
  redirect("/?started=1");
}

export async function cancelMission(missionId: string) {
  const ctx = await getContext();
  const sb = await supabaseServer();
  await sb.from("agent_missions").update({ status: "cancelled" }).eq("id", missionId).eq("tenant_id", ctx.tenant.id);
  revalidatePath("/");
}
