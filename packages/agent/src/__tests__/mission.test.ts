import { describe, expect, it } from "vitest";
import { runMission, type Mission } from "../mission";
import { backoffMs, fetchPage, OVERPASS_MIRRORS, runOverpass } from "../http";
import { FakeDb } from "./fake-db";

const T = "tenant-1";

function setup(params: Partial<Mission["params"]> = {}) {
  const db = new FakeDb();
  db.tables.industry_configs = [{ tenant_id: T, pack_id: "solar-energy", pack_version: 1, overrides: { territories: ["IQ-BA"] } }];
  db.tables.tenants = [{ id: T, name: "Sigen Solar Energy" }];
  db.tables.agent_missions = [{ id: "m1", tenant_id: T, status: "running" }];
  const mission: Mission = { id: "m1", tenant_id: T, params: { segments: ["hotel"], governorates: ["IQ-BA"], limit: 10, ...params }, status: "running", phase: "discover", progress: {}, attempts: 1 };
  return { db, mission };
}

const overpassOk = {
  elements: [
    { type: "node", id: 11, tags: { name: "فندق شط العرب", tourism: "hotel", website: "https://shatt-hotel.iq", phone: "0780 111 2222" } },
    { type: "node", id: 12, tags: { name: "فندق المناوي باشا", tourism: "hotel" } },
  ],
};
const siteHtml = `<html lang="ar"><head><title>فندق شط العرب</title><meta name="description" content="فندق في البصرة"></head><body>تواصل معنا <a href="mailto:info@shatt-hotel.iq">info</a></body></html>`;

function fakeFetch(opts: { overpass?: "ok" | "busy"; ai?: unknown } = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (OVERPASS_MIRRORS.includes(url)) {
      if (opts.overpass === "busy") return new Response("busy", { status: 504 });
      expect(String(init?.body)).toMatch(/^data=/);
      return new Response(JSON.stringify(overpassOk), { status: 200 });
    }
    if (url.startsWith("https://shatt-hotel.iq")) return new Response(siteHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    if (url === "https://api.anthropic.com/v1/messages") {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toEqual({ type: "tool", name: "submit_draft" });
      expect(body.system).toContain("Never invent anything");
      return new Response(JSON.stringify(opts.ai ?? {
        content: [{ type: "tool_use", name: "submit_draft", input: { decision: "write", skip_reason: null, subject: "طاقة مستمرة لفندقكم", body: "مرحبا…", sources_used: [`kb:${"doc-1"}`, "website"], hypotheses: ["قد يعتمد الفندق على المولدات"] } }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const ai = { apiKey: "test", model: "test-model", priceIn: 3, priceOut: 15 };
const far = () => Date.now() + 10 * 60_000;

describe("mission: discover → research → draft", () => {
  it("finds companies with sources, researches websites and writes a grounded draft", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "Products", body: "Sigenergy SigenStor", status: "active", updated_at: "1" }];
    const { f } = fakeFetch();
    await runMission(mission, { db, fetch: f, ai, deadline: far() });

    const companies = db.rows("companies");
    expect(companies).toHaveLength(2);
    expect(companies[0]).toMatchObject({ source_type: "api", source_url: "https://www.openstreetmap.org/node/11", source_ref: "osm:node/11", mission_id: "m1", governorate: "IQ-BA", phone: "+9647801112222" });
    expect(companies[0]!.attributes.segment).toBe("hotel");
    expect(companies[0]!.fit_score).toBeGreaterThan(companies[1]!.fit_score); // in territory + reachable + segment

    const research = db.rows("company_research");
    expect(research).toHaveLength(1);
    expect(research[0]).toMatchObject({ status: "ok", title: "فندق شط العرب", emails: ["info@shatt-hotel.iq"] });
    expect(companies[0]!.email).toBe("info@shatt-hotel.iq"); // filled from their own site

    const drafts = db.rows("message_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ channel: "email", language: "ar-IQ", generated_by: "test-model", company_id: companies[0]!.id });
    expect(drafts[0]!.grounding.sources).toEqual(["kb:doc-1", "website"]);
    expect(db.rows("usage_events")[0]).toMatchObject({ kind: "ai.draft" });

    const m = db.rows("agent_missions")[0]!;
    expect(m).toMatchObject({ status: "done", phase: "finished" });
    const types = db.rows("agent_events").map((e) => e.type);
    expect(types).toEqual(["mission.started", "discover.found", "research.no_website", "research.done", "draft.created", "mission.done"]);
  });

  it("does not add the same directory record twice across missions", async () => {
    const { db, mission } = setup();
    const { f } = fakeFetch();
    await runMission({ ...mission, params: { ...mission.params, write_drafts: false } }, { db, fetch: f, ai: null, deadline: far() });
    db.tables.agent_missions!.push({ id: "m2", tenant_id: T, status: "running" });
    await runMission({ ...mission, id: "m2", params: { ...mission.params, write_drafts: false } }, { db, fetch: f, ai: null, deadline: far() });
    expect(db.rows("companies")).toHaveLength(2);
    expect(db.rows("agent_missions")[1]).toMatchObject({ status: "done", note: "no companies found" });
  });

  it("waits and retries when the directory is busy, rotating servers", async () => {
    const { db, mission } = setup();
    const { f, calls } = fakeFetch({ overpass: "busy" });
    await runMission(mission, { db, fetch: f, ai: null, deadline: far() });
    const m = db.rows("agent_missions")[0]!;
    expect(m.status).toBe("running");
    expect(new Date(m.next_run_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(m.progress.pairs["hotel|IQ-BA"]).toMatchObject({ status: "pending", attempts: 1 });
    expect(db.rows("agent_events").map((e) => e.type)).toContain("discover.source_busy");
    expect(calls[0]).toBe(OVERPASS_MIRRORS[0]);

    // next tick uses the next server
    await runMission({ ...mission, progress: m.progress, attempts: 2 }, { db, fetch: f, ai: null, deadline: far() });
    expect(calls.filter((c) => OVERPASS_MIRRORS.includes(c))[1]).toBe(OVERPASS_MIRRORS[1]);
  });

  it("reports what is missing instead of writing: no AI key, then no knowledge base", async () => {
    const { db, mission } = setup();
    const { f } = fakeFetch();
    await runMission(mission, { db, fetch: f, ai: null, deadline: far() });
    expect(db.rows("agent_events").map((e) => e.type)).toContain("draft.needs_ai");
    expect(db.rows("message_drafts")).toHaveLength(0);

    const s2 = setup();
    await runMission(s2.mission, { db: s2.db, fetch: f, ai, deadline: far() });
    expect(s2.db.rows("agent_events").map((e) => e.type)).toContain("draft.needs_knowledge");
    expect(s2.db.rows("message_drafts")).toHaveLength(0);
  });

  it("rejects AI output that cites sources it was not given", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "Products", body: "Sigenergy", status: "active", updated_at: "1" }];
    const { f } = fakeFetch({
      ai: { content: [{ type: "tool_use", name: "submit_draft", input: { decision: "write", skip_reason: null, subject: "x", body: "50% discount!", sources_used: ["kb:made-up"], hypotheses: [] } }], usage: { input_tokens: 10, output_tokens: 10 } },
    });
    await runMission(mission, { db, fetch: f, ai, deadline: far() });
    expect(db.rows("message_drafts")).toHaveLength(0);
    expect(db.rows("agent_events").find((e) => e.type === "draft.invalid")?.data.reason).toMatch(/unknown sources/);
    expect(db.rows("agent_missions")[0]!.status).toBe("done");
  });

  it("respects the daily draft limit", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "P", body: "Sigenergy", status: "active", updated_at: "1" }];
    db.tables.agent_settings = [{ tenant_id: T, daily_draft_limit: 0 }];
    const { f } = fakeFetch();
    await runMission(mission, { db, fetch: f, ai, deadline: far() });
    expect(db.rows("message_drafts")).toHaveLength(0);
    const m = db.rows("agent_missions")[0]!;
    expect(m.status).toBe("running");
    expect(m.note).toBe("daily draft limit reached");
  });

  it("stops if the user cancelled", async () => {
    const { db, mission } = setup();
    db.tables.agent_missions![0]!.status = "cancelled";
    const { f, calls } = fakeFetch();
    await runMission(mission, { db, fetch: f, ai, deadline: far() });
    expect(calls).toHaveLength(0);
  });
});

describe("discovery quality", () => {
  it("shares the limit across searches, dedupes by email, counts real duplicates, skips social sites", async () => {
    const { db, mission } = setup({ segments: ["hotel", "hospital"], governorates: ["IQ-BA", "IQ-BG"], limit: 8, write_drafts: false });
    const many = (gov: string, base: number) => ({
      elements: [
        ...Array.from({ length: 10 }, (_, i) => ({ type: "node", id: base + i, tags: { name: `Hotel ${gov} ${i}`, tourism: "hotel" } })),
        { type: "node", id: base + 50, tags: { name: "Yasmin hotel", email: "same@gmail.com", tourism: "hotel" } },
        { type: "node", id: base + 51, tags: { name: "AlYasmin hotel", email: "same@gmail.com", tourism: "hotel", website: "https://facebook.com/yasmin" } },
      ],
    });
    let n = 0;
    const f = (async (u: RequestInfo | URL) => {
      if (OVERPASS_MIRRORS.includes(String(u))) return new Response(JSON.stringify(many(`g${n}`, ++n * 1000)), { status: 200 });
      throw new Error("research must not fetch social pages: " + String(u));
    }) as typeof fetch;
    await runMission(mission, { db, fetch: f, ai: null, deadline: far() });
    const companies = db.rows("companies");
    expect(companies).toHaveLength(8); // 2 per search, not 8 from the first one
    expect(new Set(companies.map((c) => c.source_ref.split("/")[1]!.slice(0, 1))).size).toBe(4);
    const found = db.rows("agent_events").filter((e) => e.type === "discover.found");
    expect(found[0]!.data.duplicates).toBe(1); // the second Yasmin, not "everything over the limit"
    expect(db.rows("company_research").every((r) => r.status === "skipped" || r.status === "ok")).toBe(true);
  });
});

describe("http helpers", () => {
  it("backs off exponentially, capped", () => {
    expect([1, 2, 3, 6, 9].map((a) => backoffMs(a) / 60_000)).toEqual([1, 2, 4, 30, 30]);
  });
  it("retries strict-server errors on the next server, but not malformed queries; sends no Accept header", async () => {
    let headers: Record<string, string> = {};
    const f406 = (async (_u: RequestInfo | URL, init?: RequestInit) => { headers = init?.headers as Record<string, string>; return new Response("", { status: 406 }); }) as typeof fetch;
    expect(await runOverpass("q", 0, f406)).toMatchObject({ ok: false, retryable: true });
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("accept");
    const f400 = (async () => new Response("bad query", { status: 400 })) as typeof fetch;
    expect(await runOverpass("q", 0, f400)).toMatchObject({ ok: false, retryable: false });
  });
  it("treats Overpass timeouts inside 200 responses as retryable", async () => {
    const f = (async () => new Response(JSON.stringify({ remark: "runtime error: Query timed out" }), { status: 200 })) as typeof fetch;
    expect(await runOverpass("q", 0, f)).toMatchObject({ ok: false, retryable: true });
  });
  it("re-checks every redirect hop and refuses non-HTML", async () => {
    const f = (async (u: RequestInfo | URL) => {
      if (String(u) === "https://ok.iq/") return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      if (String(u) === "https://pdf.iq/") return new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response("x", { status: 404 });
    }) as typeof fetch;
    expect(await fetchPage("https://ok.iq/", f)).toMatchObject({ ok: false, error: "blocked address" });
    expect(await fetchPage("https://pdf.iq/", f)).toMatchObject({ ok: false, error: expect.stringMatching(/not a web page/) });
  });
});
