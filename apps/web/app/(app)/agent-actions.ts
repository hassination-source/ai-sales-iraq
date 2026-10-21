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
  const segmentKeys: [string, ...string[]] = ["_other", ...ctx.config.segments.map((s) => s.key)];
  const source = formData.get("source") === "leads" ? "leads" : "discover";
  // "_other" (uncategorised) only means something for imported lists
  const segments = formData.getAll("segments").filter((v) => source === "leads" || v !== "_other");
  const parsed = z
    .object({
      source: z.enum(["discover", "leads"]),
      segments: z.array(z.enum(segmentKeys)).min(1).max(10),
      governorates: z.array(z.enum(GOVERNORATES.map((g) => g.code) as [string, ...string[]])).min(1).max(19),
      limit: z.coerce.number().int().min(5).max(200),
      write_drafts: z.boolean(),
    })
    .safeParse({
      source,
      segments,
      governorates: formData.getAll("governorates"),
      limit: formData.get("limit"),
      write_drafts: formData.get("write_drafts") === "on",
    });
  if (!parsed.success) redirect("/?error=mission_invalid");

  const sb = await supabaseServer();
  // a double click or a resubmitted form would start the same mission twice and pay for it twice
  const { data: active } = await sb.from("agent_missions").select("params").eq("tenant_id", ctx.tenant.id).in("status", ["queued", "running"]);
  if ((active ?? []).some((a: { params: unknown }) => sameMission(a.params, parsed.data))) redirect("/?error=duplicate");
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

function sameMission(a: unknown, b: { segments: string[]; governorates: string[]; source: string }): boolean {
  const p = a as { segments?: string[]; governorates?: string[]; source?: string } | null;
  const key = (x: string[] | undefined) => [...(x ?? [])].sort().join(",");
  return (p?.source ?? "discover") === b.source && key(p?.segments) === key(b.segments) && key(p?.governorates) === key(b.governorates);
}
