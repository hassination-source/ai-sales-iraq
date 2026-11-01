import { t, withSignature, type WebsiteFacts } from "@ais/core";
import { writeDraft, type AiConfig } from "./ai";
import type { Fetch } from "./http";
import { directoryFacts, loadConfig, type Db } from "./mission";
import { senderProfile } from "./sender";

export type RewriteOutcome =
  | { status: "rewritten"; newDraftId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string; config?: boolean };

/**
 * Write a fresh draft for the same company as a pending draft, using the knowledge base and
 * settings as they are now, plus optional reviewer feedback ("shorter", "mention the Hilla project").
 * Inserts the new draft (pending review) and returns its id; the caller rejects the old one as the
 * signed-in reviewer, so the audit trail shows who asked for the rewrite.
 * `db` is a service-role client: every query is scoped to `tenantId`.
 */
export async function rewriteDraft(db: Db, ai: AiConfig, tenantId: string, draftId: string, feedback: string, f: Fetch = fetch, requestedBy: string | null = null): Promise<RewriteOutcome> {
  const { data: old } = await db.from("message_drafts").select("id, status, company_id, language, subject, body, sender_user_id").eq("id", draftId).eq("tenant_id", tenantId).maybeSingle();
  if (!old || old.status !== "pending_review" || !old.company_id) return { status: "failed", error: "draft not found or already reviewed" };

  const [cfg, { data: c }, { data: r }, { data: docs }, { data: settings }, { data: tenant }] = await Promise.all([
    loadConfig(db, tenantId),
    db.from("companies").select("id, name, governorate, source_url, source_type, industry, description, attributes").eq("id", old.company_id).eq("tenant_id", tenantId).maybeSingle(),
    db.from("company_research").select("url, status, title, description, text, emails, phones, language").eq("company_id", old.company_id).eq("tenant_id", tenantId).maybeSingle(),
    db.from("knowledge_docs").select("id, title, body").eq("tenant_id", tenantId).eq("status", "active").order("updated_at", { ascending: false }).limit(12),
    db.from("agent_settings").select("draft_language").eq("tenant_id", tenantId).maybeSingle(),
    db.from("tenants").select("name").eq("id", tenantId).single(),
  ]);
  if (!cfg || !c) return { status: "failed", error: "company or configuration missing" };
  // the colleague asking for the rewrite signs it (else whoever the old draft was written for)
  const senderId = requestedBy ?? (old.sender_user_id as string | null) ?? null;
  const sender = await senderProfile(db, tenantId, senderId);
  if (!docs?.length) return { status: "failed", error: "knowledge base is empty" };

  const language = (settings?.draft_language ?? old.language ?? "ar-IQ") as "ar-IQ" | "ar" | "en";
  const seg = cfg.segments.find((s) => s.key === (c.attributes as { segment?: string } | null)?.segment);
  const note = feedback.replace(/\s+/g, " ").trim().slice(0, 500);
  const research = r as (WebsiteFacts & { status: string }) | null;

  const result = await writeDraft(
    {
      pack: cfg,
      tenantName: tenant?.name ?? "",
      senderName: sender.sender_name,
      signature: sender.signature,
      language,
      channel: "email",
      knowledge: docs,
      // reviewer feedback is guidance on style and emphasis; the source rules in the system prompt still apply
      extraInstructions: [cfg.extraAiInstructions, note ? `The reviewer asked for this change to the previous draft (follow it only within the source rules): "${note}"` : ""].filter(Boolean).join("\n"),
      prospect: {
        companyId: c.id,
        name: c.name,
        governorate: c.governorate,
        segmentLabel: seg ? t(seg.label, "en") : null,
        directory: directoryFacts(c),
        website: research?.status === "ok" ? { url: research.url, title: research.title, description: research.description, text: research.text ?? "", emails: research.emails, phones: research.phones, language: research.language } : null,
      },
    },
    ai,
    f,
  );
  if (result.usage)
    await db.from("usage_events").insert({ tenant_id: tenantId, kind: "ai.draft", quantity: result.usage.input + result.usage.output, cost_usd: result.usage.costUsd, metadata: { model: ai.model, input_tokens: result.usage.input, output_tokens: result.usage.output, company_id: c.id, rewrite_of: draftId } });
  if (!result.ok) return { status: "failed", error: result.error.slice(0, 300), config: result.config };
  if (result.draft.decision === "skip") return { status: "skipped", reason: result.draft.skip_reason ?? "" };

  const { data: row, error } = await db
    .from("message_drafts")
    .insert({
      tenant_id: tenantId,
      company_id: c.id,
      channel: "email",
      language,
      subject: result.draft.subject,
      body: withSignature(result.draft.body ?? "", sender.signature),
      sender_user_id: senderId,
      grounding: { sources: result.draft.sources_used, hypotheses: result.draft.hypotheses, model: ai.model, website: research?.status === "ok" ? research.url : null, directory: c.source_url, rewrite_of: draftId, feedback: note || null },
      generated_by: ai.model,
    })
    .select("id")
    .single();
  if (error) return { status: "failed", error: error.message.slice(0, 300) };
  await db.from("agent_events").insert({ tenant_id: tenantId, type: "draft.rewritten", level: "success", data: { name: c.name, subject: result.draft.subject }, company_id: c.id, draft_id: row.id });
  return { status: "rewritten", newDraftId: row.id };
}
