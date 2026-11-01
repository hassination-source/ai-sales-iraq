"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getContext } from "@/lib/tenant";
import { rewriteDraft as agentRewrite, sendApprovedDraft, type SendOutcome } from "@ais/agent";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { emailConfig } from "@/lib/email";

const back: (q: string) => never = (q) => redirect(`/approvals?${q}`);

export async function saveDraft(draftId: string, formData: FormData) {
  const ctx = await getContext();
  const parsed = z.object({ subject: z.string().trim().min(1).max(150), body: z.string().trim().min(10).max(3000) }).safeParse({ subject: formData.get("subject"), body: formData.get("body") });
  if (!parsed.success) back("error=invalid");
  const sb = await supabaseServer();
  const { error } = await sb.from("message_drafts").update(parsed.data).eq("id", draftId).eq("tenant_id", ctx.tenant.id).eq("status", "pending_review");
  if (error) back(`error=${encodeURIComponent(error.message)}`);
  revalidatePath("/approvals");
  back("saved=1");
}

/** Approve (optionally with edits in the same step) or reject. Database triggers enforce who may do this. */
export async function reviewDraft(draftId: string, decision: "approved" | "rejected", formData: FormData) {
  const ctx = await getContext();
  if (!["owner", "admin", "manager"].includes(ctx.role)) back("error=role");
  const sb = await supabaseServer();
  if (decision === "approved") {
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (subject && body) {
      const { error } = await sb.from("message_drafts").update({ subject, body }).eq("id", draftId).eq("tenant_id", ctx.tenant.id).eq("status", "pending_review");
      if (error) back(`error=${encodeURIComponent(error.message)}`);
    }
  }
  const reason = String(formData.get("reject_reason") ?? "").trim().slice(0, 300);
  const { data: draft, error } = await sb
    .from("message_drafts")
    .update({ status: decision, reject_reason: decision === "rejected" ? reason || null : null })
    .eq("id", draftId)
    .eq("tenant_id", ctx.tenant.id)
    .eq("status", "pending_review")
    .select("company_id")
    .maybeSingle();
  if (error) back(`error=${encodeURIComponent(error.message)}`);
  if (!draft) {
    // nothing pending matched: usually a second click on the same button after the first already went through
    const { data: now } = await sb.from("message_drafts").select("status").eq("id", draftId).eq("tenant_id", ctx.tenant.id).maybeSingle();
    if (now?.status === decision || (decision === "approved" && ["sent", "failed"].includes(now?.status ?? ""))) back(decision === "approved" ? "approved=1" : "rejected=1");
    back("error=already_reviewed");
  }
  await sb.from("activities").insert({ tenant_id: ctx.tenant.id, type: decision === "approved" ? "draft.approved" : "draft.rejected", company_id: draft?.company_id ?? null, actor_id: ctx.userId, payload: { draft_id: draftId } });
  revalidatePath("/approvals");
  revalidatePath("/");
  if (decision === "rejected") back("rejected=1");
  back(sendOutcomeQuery(await trySend(ctx.tenant.id, draftId)));
}

/** Send an approved draft that wasn't sent yet (approved before email was connected, or a temporary failure). */
export async function sendDraft(draftId: string) {
  const ctx = await getContext();
  if (!["owner", "admin", "manager"].includes(ctx.role)) back("error=role");
  const outcome = await trySend(ctx.tenant.id, draftId);
  revalidatePath("/approvals");
  back(sendOutcomeQuery(outcome));
}

async function trySend(tenantId: string, draftId: string): Promise<SendOutcome | null> {
  const cfg = emailConfig();
  const db = supabaseService();
  if (!cfg || !db) return null;
  // the caller's session already proved membership; the draft lookup is scoped to the same tenant
  return sendApprovedDraft(db, cfg, tenantId, draftId);
}

function sendOutcomeQuery(o: SendOutcome | null): string {
  if (!o) return "approved=1";
  if (o.status === "sent") return `sent=${encodeURIComponent(o.to)}`;
  if (o.status === "skipped") return `approved=1&skip=${o.reason}`;
  return `approved=1&send_error=${encodeURIComponent(o.error)}`;
}

/** Let the agent write the draft again with today's knowledge base and settings, plus optional feedback. */
export async function rewriteDraft(draftId: string, formData: FormData) {
  const ctx = await getContext();
  if (!["owner", "admin", "manager"].includes(ctx.role)) back("error=role");
  const db = supabaseService();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!db || !apiKey) back("error=ai_off");
  const ai = { apiKey: apiKey!, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || undefined, model: process.env.AI_MODEL ?? "claude-sonnet-5-5", priceIn: Number(process.env.AI_PRICE_IN ?? 3), priceOut: Number(process.env.AI_PRICE_OUT ?? 15) };
  const feedback = String(formData.get("feedback") ?? "");
  const r = await agentRewrite(db!, ai, ctx.tenant.id, draftId, feedback, fetch, ctx.userId);
  if (r.status === "failed") back(`error=${encodeURIComponent(r.error)}`);
  if (r.status === "skipped") back(`error=${encodeURIComponent(r.reason || "skipped")}`);
  // the old draft is closed by the signed-in reviewer, so the audit log shows who asked for the rewrite
  const sb = await supabaseServer();
  await sb.from("message_drafts").update({ status: "rejected", reject_reason: "Rewritten by the agent" }).eq("id", draftId).eq("tenant_id", ctx.tenant.id).eq("status", "pending_review");
  revalidatePath("/approvals");
  back("rewritten=1");
}
