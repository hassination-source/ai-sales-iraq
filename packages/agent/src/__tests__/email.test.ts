import { describe, expect, it } from "vitest";
import { composeEmailHtml, composeEmailText, linkify, sendApprovedDraft, senderFor, splitSignature, suppress, unsubscribeToken, verifyUnsubscribeToken } from "../email";
import { FakeDb } from "./fake-db";

const T = "tenant-1";
const ok = async () => true;
const cfg = { apiKey: "re_test_key", from: "Sigen Solar Energy <sales@sigensol.com>", baseUrl: "https://app.example/", secret: "s3cret" };

function setup(draft: Record<string, unknown> = {}, company: Record<string, unknown> = {}) {
  const db = new FakeDb();
  db.tables.tenants = [{ id: T, name: "Sigen Solar Energy" }];
  db.tables.companies = [{ id: "c1", tenant_id: T, name: "مصنع بغداد", email: "Info@Baghdad-Factory.com", ...company }];
  db.tables.message_drafts = [{ id: "d1", tenant_id: T, company_id: "c1", channel: "email", language: "ar-IQ", subject: "حلول الطاقة", body: "السلام عليكم…\n\nم. حسن", status: "approved", ...draft }];
  return db;
}

function resend(status = 200, json: unknown = { id: "re_123" }) {
  const calls: { headers: Headers; body: Record<string, unknown> }[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { f, calls };
}

describe("unsubscribe links", () => {
  it("round-trip, and reject tampering", () => {
    const tok = unsubscribeToken("k", T, "Info@X.iq");
    expect(verifyUnsubscribeToken("k", tok)).toEqual({ tenantId: T, email: "info@x.iq" });
    expect(verifyUnsubscribeToken("other", tok)).toBeNull();
    const [p] = tok.split(".");
    const forged = Buffer.from(JSON.stringify([T, "victim@x.iq"])).toString("base64url");
    expect(verifyUnsubscribeToken("k", `${forged}.${tok.split(".")[1]}`)).toBeNull();
    expect(verifyUnsubscribeToken("k", `${p}`)).toBeNull();
    expect(verifyUnsubscribeToken("k", "garbage.sig")).toBeNull();
  });

  it("footer follows the message language; sender uses the tenant's address", () => {
    expect(composeEmailText("نص", "ar-IQ", "https://u")).toBe("نص\n\n—\nلإلغاء الاشتراك: https://u");
    expect(composeEmailText("text", "en", "https://u")).toBe("text\n\n—\nUnsubscribe: https://u");
    expect(senderFor(cfg.from, null, "X")).toBe(cfg.from);
    expect(senderFor(cfg.from, "hassan@sigensol.com", 'Sigen "Solar"')).toBe("Sigen Solar <hassan@sigensol.com>");
  });
});

describe("sendApprovedDraft", () => {
  it("sends an approved draft once, with unsubscribe headers, and records it", async () => {
    const db = setup();
    const { f, calls } = resend();
    const r = await sendApprovedDraft(db, cfg, T, "d1", f, ok);
    expect(r).toEqual({ status: "sent", to: "info@baghdad-factory.com" });
    expect(calls).toHaveLength(1);
    const { headers, body } = calls[0]!;
    expect(headers.get("Authorization")).toBe("Bearer re_test_key");
    expect(headers.get("Idempotency-Key")).toBe("draft-d1");
    expect(body).toMatchObject({ from: cfg.from, to: ["info@baghdad-factory.com"], subject: "حلول الطاقة" });
    expect(String(body.text)).toMatch(/^السلام عليكم…\n\nم\. حسن\n\n—\n/);
    expect(String(body.text)).toContain("https://app.example/u/");
    expect(String(body.html)).toContain("إلغاء الاشتراك");
    expect((body.headers as Record<string, string>)["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(db.rows("message_drafts")[0]).toMatchObject({ status: "sent", to_email: "info@baghdad-factory.com", provider_message_id: "re_123" });
    expect(db.rows("activities").map((a) => a.type)).toEqual(["message.sent"]);

    // a second call does nothing: the draft is no longer approved
    expect(await sendApprovedDraft(db, cfg, T, "d1", f, ok)).toEqual({ status: "skipped", reason: "not_approved" });
    expect(calls).toHaveLength(1);
  });

  it("never sends to an address that unsubscribed", async () => {
    const db = setup();
    await suppress(db, T, "INFO@baghdad-factory.com", "unsubscribed");
    const { f, calls } = resend();
    expect(await sendApprovedDraft(db, cfg, T, "d1", f, ok)).toEqual({ status: "skipped", reason: "suppressed" });
    expect(calls).toHaveLength(0);
  });

  it("skips drafts that aren't approved, other tenants' drafts, and companies without a valid email", async () => {
    const { f, calls } = resend();
    expect(await sendApprovedDraft(setup({ status: "pending_review" }), cfg, T, "d1", f, ok)).toMatchObject({ reason: "not_approved" });
    expect(await sendApprovedDraft(setup(), cfg, "other-tenant", "d1", f)).toMatchObject({ reason: "not_approved" });
    expect(await sendApprovedDraft(setup({}, { email: null }), cfg, T, "d1", f, ok)).toMatchObject({ reason: "no_email" });
    expect(await sendApprovedDraft(setup({}, { email: "not an email" }), cfg, T, "d1", f, ok)).toMatchObject({ reason: "no_email" });
    expect(calls).toHaveLength(0);
  });

  it("a rejected request marks the draft failed; a temporary error leaves it approved for another try", async () => {
    const db1 = setup();
    const bad = resend(422, { name: "validation_error", message: "The sigensol.com domain is not verified" });
    expect(await sendApprovedDraft(db1, cfg, T, "d1", bad.f, ok)).toMatchObject({ status: "failed", retryable: false });
    expect(db1.rows("message_drafts")[0]).toMatchObject({ status: "failed", send_error: expect.stringContaining("not verified") });

    const db2 = setup();
    const busy = resend(503, {});
    expect(await sendApprovedDraft(db2, cfg, T, "d1", busy.f, ok)).toMatchObject({ status: "failed", retryable: true });
    expect(db2.rows("message_drafts")[0]).toMatchObject({ status: "approved", send_error: "HTTP 503" });
  });
});

describe("HTML email", () => {
  it("shows short link text, keeps hrefs safe, links emails and phones", () => {
    expect(linkify("www.sigensol.com | https://www.sigenergy.com/")).toBe(
      '<a href="https://www.sigensol.com" style="color:#1f4e8c;text-decoration:none">sigensol.com</a> | <a href="https://www.sigenergy.com/" style="color:#1f4e8c;text-decoration:none">sigenergy.com</a>',
    );
    expect(linkify("+964 780 999 3770 | info@sigensol.com")).toContain('href="tel:+9647809993770"');
    expect(linkify("info@sigensol.com")).toContain('href="mailto:info@sigensol.com"');
    expect(linkify('<script>alert(1)</script> javascript:alert(1)')).not.toMatch(/<script|href="javascript/);
  });

  it("splits the fixed signature off the body and lays it out; the unsubscribe link is one short line", () => {
    const sig = "م. حسن\nSigen Solar Energy\nwww.sigensol.com";
    expect(splitSignature(`مرحبا\n\n${sig}\n`, sig)).toEqual({ main: "مرحبا", signature: sig });
    expect(splitSignature("مرحبا", sig)).toEqual({ main: "مرحبا", signature: null });
    const html = composeEmailHtml("السلام عليكم\n\nسطر ثاني", sig, "ar-IQ", "https://app/u/tok");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('<p dir="rtl" style="margin:0 0 14px">السلام عليكم</p>');
    expect(html).toContain("font-weight:bold;font-size:15px;color:#1d2433\">م. حسن</div>");
    expect(html).toContain('>sigensol.com</a>');
    expect(html).toContain('<div dir="ltr" style="font-size:13px;color:#5b6474;margin-top:2px"><a href="https://www.sigensol.com"');
    expect(html).toContain('<a href="https://app/u/tok" style="color:#8a919c">إلغاء الاشتراك</a>');
    expect(html).not.toContain(">https://app/u/tok<");
  });
});

describe("dead domains", () => {
  it("doesn't send to a domain without a mail server", async () => {
    const db = setup();
    const { f, calls } = resend();
    const r = await sendApprovedDraft(db, cfg, T, "d1", f, async (d) => d !== "baghdad-factory.com");
    expect(r).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toHaveLength(0);
    expect(db.rows("message_drafts")[0]).toMatchObject({ status: "failed", send_error: expect.stringContaining("no mail server") });
  });
});

describe("one first message per address", () => {
  it("doesn't send when a colleague's message to the same address already went out", async () => {
    const db = setup();
    db.tables.message_drafts.push({ id: "d0", tenant_id: T, company_id: "other", status: "sent", to_email: "info@baghdad-factory.com" });
    const { f, calls } = resend();
    expect(await sendApprovedDraft(db, cfg, T, "d1", f, ok)).toEqual({ status: "skipped", reason: "already_contacted" });
    expect(calls).toHaveLength(0);
  });
});
