import { describe, expect, it } from "vitest";
import { composeEmailText, sendApprovedDraft, senderFor, suppress, unsubscribeToken, verifyUnsubscribeToken } from "../email";
import { FakeDb } from "./fake-db";

const T = "tenant-1";
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
    expect(composeEmailText("نص", "ar-IQ", "https://u")).toContain("لن نراسلكم مجدداً");
    expect(composeEmailText("text", "en", "https://u")).toContain("won't email you again");
    expect(senderFor(cfg.from, null, "X")).toBe(cfg.from);
    expect(senderFor(cfg.from, "hassan@sigensol.com", 'Sigen "Solar"')).toBe("Sigen Solar <hassan@sigensol.com>");
  });
});

describe("sendApprovedDraft", () => {
  it("sends an approved draft once, with unsubscribe headers, and records it", async () => {
    const db = setup();
    const { f, calls } = resend();
    const r = await sendApprovedDraft(db, cfg, T, "d1", f);
    expect(r).toEqual({ status: "sent", to: "info@baghdad-factory.com" });
    expect(calls).toHaveLength(1);
    const { headers, body } = calls[0]!;
    expect(headers.get("Authorization")).toBe("Bearer re_test_key");
    expect(headers.get("Idempotency-Key")).toBe("draft-d1");
    expect(body).toMatchObject({ from: cfg.from, to: ["info@baghdad-factory.com"], subject: "حلول الطاقة" });
    expect(String(body.text)).toMatch(/^السلام عليكم…\n\nم\. حسن\n\n—\n/);
    expect(String(body.text)).toContain("https://app.example/u/");
    expect((body.headers as Record<string, string>)["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(db.rows("message_drafts")[0]).toMatchObject({ status: "sent", to_email: "info@baghdad-factory.com", provider_message_id: "re_123" });
    expect(db.rows("activities").map((a) => a.type)).toEqual(["message.sent"]);

    // a second call does nothing: the draft is no longer approved
    expect(await sendApprovedDraft(db, cfg, T, "d1", f)).toEqual({ status: "skipped", reason: "not_approved" });
    expect(calls).toHaveLength(1);
  });

  it("never sends to an address that unsubscribed", async () => {
    const db = setup();
    await suppress(db, T, "INFO@baghdad-factory.com", "unsubscribed");
    const { f, calls } = resend();
    expect(await sendApprovedDraft(db, cfg, T, "d1", f)).toEqual({ status: "skipped", reason: "suppressed" });
    expect(calls).toHaveLength(0);
  });

  it("skips drafts that aren't approved, other tenants' drafts, and companies without a valid email", async () => {
    const { f, calls } = resend();
    expect(await sendApprovedDraft(setup({ status: "pending_review" }), cfg, T, "d1", f)).toMatchObject({ reason: "not_approved" });
    expect(await sendApprovedDraft(setup(), cfg, "other-tenant", "d1", f)).toMatchObject({ reason: "not_approved" });
    expect(await sendApprovedDraft(setup({}, { email: null }), cfg, T, "d1", f)).toMatchObject({ reason: "no_email" });
    expect(await sendApprovedDraft(setup({}, { email: "not an email" }), cfg, T, "d1", f)).toMatchObject({ reason: "no_email" });
    expect(calls).toHaveLength(0);
  });

  it("a rejected request marks the draft failed; a temporary error leaves it approved for another try", async () => {
    const db1 = setup();
    const bad = resend(422, { name: "validation_error", message: "The sigensol.com domain is not verified" });
    expect(await sendApprovedDraft(db1, cfg, T, "d1", bad.f)).toMatchObject({ status: "failed", retryable: false });
    expect(db1.rows("message_drafts")[0]).toMatchObject({ status: "failed", send_error: expect.stringContaining("not verified") });

    const db2 = setup();
    const busy = resend(503, {});
    expect(await sendApprovedDraft(db2, cfg, T, "d1", busy.f)).toMatchObject({ status: "failed", retryable: true });
    expect(db2.rows("message_drafts")[0]).toMatchObject({ status: "approved", send_error: "HTTP 503" });
  });
});
