import { createHmac, timingSafeEqual } from "node:crypto";
import type { Fetch } from "./http";
import type { Db } from "./mission";
import { redactSecrets } from "./ai";

export interface EmailConfig {
  /** Resend API key. */
  apiKey: string;
  /** Default sender, e.g. "Sigen Solar Energy <sales@sigensol.com>"; a tenant's from_email overrides the address. */
  from: string;
  /** Public base URL of the app, for unsubscribe links. */
  baseUrl: string;
  /** Secret for signing unsubscribe links. */
  secret: string;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`unsubscribe:${payload}`).digest("base64url").slice(0, 32);

/** A link token that identifies tenant + address without exposing either in a guessable form. */
export function unsubscribeToken(secret: string, tenantId: string, email: string): string {
  const payload = b64url(JSON.stringify([tenantId, email.toLowerCase()]));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): { tenantId: string; email: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const [tenantId, email] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as [unknown, unknown];
    return typeof tenantId === "string" && typeof email === "string" ? { tenantId, email } : null;
  } catch {
    return null;
  }
}

const FOOTER: Record<string, (url: string) => string> = {
  ar: (url) => `—\nإذا لا ترغبون باستلام رسائل منا، اضغطوا هنا ولن نراسلكم مجدداً:\n${url}`,
  en: (url) => `—\nIf you'd rather not hear from us, click here and we won't email you again:\n${url}`,
};

/** The text the recipient gets: the approved body plus an unsubscribe line in the message language. */
export function composeEmailText(body: string, language: string, unsubscribeUrl: string): string {
  const footer = (language.startsWith("ar") ? FOOTER.ar : FOOTER.en)!(unsubscribeUrl);
  return `${body.trimEnd()}\n\n${footer}`;
}

/** "Name <addr>" with the address swapped for the tenant's own sender address. */
export function senderFor(defaultFrom: string, tenantFrom: string | null | undefined, tenantName: string): string {
  if (!tenantFrom) return defaultFrom;
  const name = tenantName.replace(/[<>"\r\n]/g, "").trim();
  return name ? `${name} <${tenantFrom}>` : tenantFrom;
}

export type SendResult = { ok: true; id: string } | { ok: false; retryable: boolean; error: string };

export async function sendViaResend(
  cfg: Pick<EmailConfig, "apiKey">,
  msg: { from: string; to: string; subject: string; text: string; unsubscribeUrl: string; idempotencyKey: string },
  f: Fetch = fetch,
): Promise<SendResult> {
  try {
    const res = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": msg.idempotencyKey },
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        headers: { "List-Unsubscribe": `<${msg.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && json.id) return { ok: true, id: json.id };
    const error = redactSecrets(`HTTP ${res.status}${json.message ? `: ${json.message}` : ""}`).slice(0, 300);
    return { ok: false, retryable: res.status === 429 || res.status >= 500, error };
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SendOutcome =
  | { status: "sent"; to: string }
  | { status: "skipped"; reason: "not_approved" | "no_email" | "suppressed" | "not_email" }
  | { status: "failed"; error: string; retryable: boolean };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/**
 * Send one approved draft. `db` is a service-role client: every query is scoped to `tenantId`.
 * Idempotent: Resend dedupes on the draft id, and the status only moves approved → sent/failed.
 */
export async function sendApprovedDraft(db: Db, cfg: EmailConfig, tenantId: string, draftId: string, f: Fetch = fetch): Promise<SendOutcome> {
  const { data: d } = await db.from("message_drafts").select("id, status, channel, subject, body, language, company_id").eq("id", draftId).eq("tenant_id", tenantId).maybeSingle();
  if (!d || d.status !== "approved") return { status: "skipped", reason: "not_approved" };
  if (d.channel !== "email") return { status: "skipped", reason: "not_email" };

  const [{ data: company }, { data: settings }, { data: tenant }] = await Promise.all([
    d.company_id ? db.from("companies").select("email, name").eq("id", d.company_id).eq("tenant_id", tenantId).maybeSingle() : { data: null },
    db.from("agent_settings").select("from_email").eq("tenant_id", tenantId).maybeSingle(),
    db.from("tenants").select("name").eq("id", tenantId).single(),
  ]);
  const to = String(company?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { status: "skipped", reason: "no_email" };

  const { data: suppressed } = await db.from("email_suppressions").select("email").eq("tenant_id", tenantId).eq("email", to).maybeSingle();
  if (suppressed) return { status: "skipped", reason: "suppressed" };

  const unsubscribeUrl = `${cfg.baseUrl.replace(/\/$/, "")}/u/${unsubscribeToken(cfg.secret, tenantId, to)}`;
  const res = await sendViaResend(
    cfg,
    {
      from: senderFor(cfg.from, settings?.from_email, tenant?.name ?? ""),
      to,
      subject: d.subject ?? "",
      text: composeEmailText(d.body, d.language, unsubscribeUrl),
      unsubscribeUrl,
      idempotencyKey: `draft-${d.id}`,
    },
    f,
  );

  const ev = (type: string, level: string, data: Record<string, unknown>) =>
    db.from("agent_events").insert({ tenant_id: tenantId, type, level, data, company_id: d.company_id, draft_id: d.id });

  if (res.ok) {
    await db.from("message_drafts").update({ status: "sent", to_email: to, sent_at: new Date().toISOString(), provider_message_id: res.id, send_error: null }).eq("id", d.id).eq("tenant_id", tenantId).eq("status", "approved");
    await db.from("activities").insert({ tenant_id: tenantId, type: "message.sent", company_id: d.company_id, payload: { draft_id: d.id, channel: "email" } });
    await db.from("usage_events").insert({ tenant_id: tenantId, kind: "email.sent", quantity: 1, cost_usd: 0, metadata: { draft_id: d.id } });
    await ev("email.sent", "success", { name: company?.name, to });
    return { status: "sent", to };
  }
  // temporary failures stay approved so they can be sent again; permanent ones are marked failed
  if (!res.retryable) await db.from("message_drafts").update({ status: "failed", to_email: to, send_error: res.error }).eq("id", d.id).eq("tenant_id", tenantId).eq("status", "approved");
  else await db.from("message_drafts").update({ send_error: res.error }).eq("id", d.id).eq("tenant_id", tenantId);
  await ev("email.failed", "error", { name: company?.name, error: res.error, retryable: res.retryable });
  return { status: "failed", error: res.error, retryable: res.retryable };
}

/** Record an unsubscribe. Safe to call repeatedly. */
export async function suppress(db: Db, tenantId: string, email: string, reason: "unsubscribed" | "bounced" | "complained" | "manual") {
  const e = email.trim().toLowerCase();
  await db.from("email_suppressions").upsert({ tenant_id: tenantId, email: e, reason }, { onConflict: "tenant_id,email", ignoreDuplicates: true });
  await db.from("agent_events").insert({ tenant_id: tenantId, type: "email.unsubscribed", level: "warning", data: { email: e, reason } });
}
