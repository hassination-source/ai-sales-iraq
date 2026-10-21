import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveMx } from "node:dns/promises";
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

const FOOTER_TEXT: Record<string, (url: string) => string> = {
  ar: (url) => `—\nلإلغاء الاشتراك: ${url}`,
  en: (url) => `—\nUnsubscribe: ${url}`,
};

/** Plain-text part: the approved body plus a short unsubscribe line in the message language. */
export function composeEmailText(body: string, language: string, unsubscribeUrl: string): string {
  const footer = (language.startsWith("ar") ? FOOTER_TEXT.ar : FOOTER_TEXT.en)!(unsubscribeUrl);
  return `${body.trimEnd()}\n\n${footer}`;
}

/** Split a fixed signature off the end of a draft body, so the HTML can lay it out as a signature block. */
export function splitSignature(body: string, signature: string | null | undefined): { main: string; signature: string | null } {
  const sig = signature?.trim();
  const b = body.replace(/\r\n/g, "\n").trimEnd();
  if (sig && b.endsWith(sig.replace(/\r\n/g, "\n"))) return { main: b.slice(0, b.length - sig.length).trimEnd(), signature: sig };
  return { main: b, signature: null };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Escape a line and turn URLs, emails and phone numbers into links whose visible text is short
 * ("sigensol.com", not "https://www.sigensol.com/"). Only http(s), mailto and tel links are produced.
 */
export function linkify(line: string): string {
  const re = /(https?:\/\/[^\s|<>"']+|www\.[^\s|<>"']+\.[a-z]{2,}[^\s|<>"']*)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\+\d[\d\s-]{7,}\d)/g;
  let out = "";
  let last = 0;
  for (const m of line.matchAll(re)) {
    out += esc(line.slice(last, m.index));
    const [whole, url, email, phone] = m;
    if (url) {
      const href = url.startsWith("http") ? url : `https://${url}`;
      const shown = url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      out += `<a href="${esc(href)}" style="color:#1f4e8c;text-decoration:none">${esc(shown)}</a>`;
    } else if (email) out += `<a href="mailto:${esc(email)}" style="color:#1f4e8c;text-decoration:none">${esc(email)}</a>`;
    else if (phone) out += `<a href="tel:${esc(phone.replace(/[\s-]/g, ""))}" style="color:#1f4e8c;text-decoration:none" dir="ltr">${esc(phone)}</a>`;
    last = m.index! + whole.length;
  }
  return out + esc(line.slice(last));
}

/** Lines with any Arabic read right-to-left as a whole; Latin-only lines (addresses, links) left-to-right. */
const lineDir = (l: string) => (/[\u0600-\u06FF]/.test(l) ? "rtl" : "ltr");

const UNSUB_LABEL: Record<string, [string, string]> = {
  ar: ["لا ترغبون باستلام رسائل منا؟", "إلغاء الاشتراك"],
  en: ["Prefer not to hear from us?", "Unsubscribe"],
};

/**
 * HTML part. Every line gets dir="auto" so Arabic and English lines each read in their own direction;
 * the signature is laid out as a block (name bold, details smaller); the unsubscribe link is one short line.
 */
export function composeEmailHtml(body: string, signature: string | null, language: string, unsubscribeUrl: string): string {
  const rtl = language.startsWith("ar");
  const paras = body
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p dir="${lineDir(p)}" style="margin:0 0 14px">${p.split("\n").map(linkify).join("<br>")}</p>`)
    .join("");
  const sigLines = (signature ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const sig = sigLines.length
    ? `<div style="margin-top:22px;padding-top:14px;border-top:2px solid #e8b931">${sigLines
        .map((l, i) =>
          i === 0
            ? `<div dir="${lineDir(l)}" style="font-weight:bold;font-size:15px;color:#1d2433">${linkify(l)}</div>`
            : `<div dir="${lineDir(l)}" style="font-size:13px;color:${i === 1 ? "#1d2433" : "#5b6474"};margin-top:2px">${linkify(l)}</div>`,
        )
        .join("")}</div>`
    : "";
  const [q, a] = rtl ? UNSUB_LABEL.ar! : UNSUB_LABEL.en!;
  return `<!doctype html><html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff">
<div dir="${rtl ? "rtl" : "ltr"}" style="max-width:600px;padding:20px 16px;font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1d2433;text-align:${rtl ? "right" : "left"}">
${paras}${sig}
<p dir="${rtl ? "rtl" : "ltr"}" style="margin:28px 0 0;font-size:11px;color:#8a919c">${esc(q)} <a href="${esc(unsubscribeUrl)}" style="color:#8a919c">${esc(a)}</a></p>
</div></body></html>`;
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
  msg: { from: string; to: string; subject: string; text: string; html?: string; unsubscribeUrl: string; idempotencyKey: string },
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
        ...(msg.html ? { html: msg.html } : {}),
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

/** Does the domain accept mail at all? Old lists contain dead domains; every bounce hurts the sender's reputation. */
export type DomainCheck = (domain: string) => Promise<boolean>;
export const hasMailServer: DomainCheck = async (domain) => {
  try {
    const mx = await Promise.race([resolveMx(domain), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 5000))]);
    return mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (e) {
    // NXDOMAIN / no records: no mail server. A timeout is not proof either way: let it through.
    return e instanceof Error && e.message === "timeout";
  }
};

/**
 * Send one approved draft. `db` is a service-role client: every query is scoped to `tenantId`.
 * Idempotent: Resend dedupes on the draft id, and the status only moves approved → sent/failed.
 */
export async function sendApprovedDraft(db: Db, cfg: EmailConfig, tenantId: string, draftId: string, f: Fetch = fetch, checkDomain: DomainCheck = hasMailServer): Promise<SendOutcome> {
  const { data: d } = await db.from("message_drafts").select("id, status, channel, subject, body, language, company_id").eq("id", draftId).eq("tenant_id", tenantId).maybeSingle();
  if (!d || d.status !== "approved") return { status: "skipped", reason: "not_approved" };
  if (d.channel !== "email") return { status: "skipped", reason: "not_email" };

  const [{ data: company }, { data: settings }, { data: tenant }] = await Promise.all([
    d.company_id ? db.from("companies").select("email, name").eq("id", d.company_id).eq("tenant_id", tenantId).maybeSingle() : { data: null },
    db.from("agent_settings").select("from_email, signature").eq("tenant_id", tenantId).maybeSingle(),
    db.from("tenants").select("name").eq("id", tenantId).single(),
  ]);
  const to = String(company?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { status: "skipped", reason: "no_email" };

  const { data: suppressed } = await db.from("email_suppressions").select("email").eq("tenant_id", tenantId).eq("email", to).maybeSingle();
  if (suppressed) return { status: "skipped", reason: "suppressed" };

  if (!(await checkDomain(to.split("@")[1]!))) {
    const error = `${to.split("@")[1]} does not receive email (no mail server)`;
    await db.from("message_drafts").update({ status: "failed", to_email: to, send_error: error }).eq("id", d.id).eq("tenant_id", tenantId).eq("status", "approved");
    await db.from("agent_events").insert({ tenant_id: tenantId, type: "email.failed", level: "error", data: { name: company?.name, error, retryable: false }, company_id: d.company_id, draft_id: d.id });
    return { status: "failed", error, retryable: false };
  }

  const unsubscribeUrl = `${cfg.baseUrl.replace(/\/$/, "")}/u/${unsubscribeToken(cfg.secret, tenantId, to)}`;
  const res = await sendViaResend(
    cfg,
    {
      from: senderFor(cfg.from, settings?.from_email, tenant?.name ?? ""),
      to,
      subject: d.subject ?? "",
      text: composeEmailText(d.body, d.language, unsubscribeUrl),
      html: (() => {
        const parts = splitSignature(d.body, settings?.signature);
        return composeEmailHtml(parts.main, parts.signature, d.language, unsubscribeUrl);
      })(),
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
