"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { missingForStage, validateQualification } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { readPackFields, QUAL_PREFIX } from "@/components/fields";

const back: (id: string, q: string) => never = (id, q) => redirect(`/deals/${id}?${q}`);

export async function updateQualification(dealId: string, formData: FormData) {
  const ctx = await getContext();
  const values = readPackFields(ctx.config.qualificationFields, formData, QUAL_PREFIX);
  const parsed = validateQualification(ctx.config, values);
  if (!parsed.success) back(dealId, "error=invalid");
  const sb = await supabaseServer();
  const { error } = await sb.from("deals").update({ qualification: parsed.data }).eq("id", dealId);
  if (error) back(dealId, `error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/deals/${dealId}`);
  back(dealId, "saved=1");
}

export async function moveStage(dealId: string, formData: FormData) {
  const ctx = await getContext();
  const stageId = String(formData.get("stage_id") ?? "");
  const stage = ctx.stages.find((s) => s.id === stageId);
  if (!stage) back(dealId, "error=invalid");
  const lostReason = String(formData.get("lost_reason") ?? "").trim();

  const sb = await supabaseServer();
  const { data: deal } = await sb.from("deals").select("qualification").eq("id", dealId).single();
  if (!deal) redirect("/pipeline");

  const missing = missingForStage(ctx.config, stage!.key, (deal.qualification ?? {}) as Record<string, unknown>);
  if (missing.length) back(dealId, `missing=${missing.join(",")}&target=${stage!.key}`);
  if (stage!.kind === "lost" && !lostReason) back(dealId, "error=lost_reason");

  const { error } = await sb
    .from("deals")
    .update({ stage_id: stageId, lost_reason: stage!.kind === "lost" ? lostReason : null, closed_at: stage!.kind === "open" ? null : undefined })
    .eq("id", dealId);
  if (error) back(dealId, `error=${encodeURIComponent(error.message)}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  back(dealId, "moved=1");
}

const NewTask = z.object({ title: z.string().trim().min(2).max(300), due: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) });

export async function addTask(dealId: string, formData: FormData) {
  const ctx = await getContext();
  const parsed = NewTask.safeParse({ title: formData.get("title"), due: formData.get("due") ?? "" });
  if (!parsed.success) back(dealId, "error=invalid");
  const sb = await supabaseServer();
  const { data: deal } = await sb.from("deals").select("company_id").eq("id", dealId).single();
  const { error } = await sb.from("tasks").insert({
    tenant_id: ctx.tenant.id,
    deal_id: dealId,
    company_id: deal?.company_id ?? null,
    title: parsed.data.title,
    due_at: parsed.data.due ? `${parsed.data.due}T09:00:00+03:00` : null, // 9:00 Baghdad time
    assignee_id: ctx.userId,
  });
  if (error) back(dealId, `error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/");
  back(dealId, "task=1");
}

export async function completeTask(dealId: string, taskId: string) {
  await getContext();
  const sb = await supabaseServer();
  const { error } = await sb.from("tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", taskId).eq("status", "open");
  if (error) back(dealId, `error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/");
}
