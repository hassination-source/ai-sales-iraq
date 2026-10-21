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
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.tools[0].name).toBe("submit_draft");
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

const ai = { apiKey: "sk-ant-test-" + "x".repeat(30), model: "test-model", priceIn: 3, priceOut: 15 };
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

  it("stops drafting with one clear message when the AI key needs attention", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "P", body: "Sigenergy", status: "active", updated_at: "1" }];
    let calls = 0;
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u) === "https://api.anthropic.com/v1/messages") {
        calls++;
        expect((init?.headers as Record<string, string>)["anthropic-workspace-id"]).toBe("wrkspc_1");
        return new Response(JSON.stringify({ error: { message: "This API key is not scoped to a workspace" } }), { status: 400 });
      }
      return fakeFetch().f(u, init);
    }) as typeof fetch;
    await runMission(mission, { db, fetch: f, ai: { ...ai, workspaceId: "wrkspc_1" }, deadline: far() });
    expect(calls).toBe(1); // didn't burn through every company
    const types = db.rows("agent_events").map((e) => e.type);
    expect(types.filter((t) => t === "draft.ai_config")).toHaveLength(1);
    expect(types).not.toContain("draft.invalid");
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

describe("key safety", () => {
  it("refuses a pasted cURL command as a key without calling the API, and never stores the key", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "P", body: "Sigenergy", status: "active", updated_at: "1" }];
    let apiCalls = 0;
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).includes("anthropic")) apiCalls++;
      return fakeFetch().f(u, init);
    }) as typeof fetch;
    const pasted = 'curl https://api.anthropic.com/v1/messages --header "x-api-key: sk-ant-usr-SECRETSECRETSECRETSECRET"';
    await runMission(mission, { db, fetch: f, ai: { ...ai, apiKey: pasted }, deadline: far() });
    expect(apiCalls).toBe(0);
    const stored = JSON.stringify(db.tables);
    expect(stored).not.toContain("SECRETSECRET");
    expect(db.rows("agent_events").find((e) => e.type === "draft.ai_config")?.data.error).toMatch(/paste only the key/);
  });
  it("redacts keys from any message", async () => {
    const { redactSecrets, looksLikeAnthropicKey } = await import("../ai");
    expect(redactSecrets('boom x-api-key: sk-ant-api03-abcDEF123_- end')).not.toMatch(/abcDEF/);
    expect(looksLikeAnthropicKey("sk-ant-api03-" + "a".repeat(40))).toBe(true);
    expect(looksLikeAnthropicKey("curl https://x --header sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
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

describe("Google Places source", () => {
  const PLACES = "https://places.googleapis.com/v1/places:searchText";
  const google = { apiKey: "AIza-test-key", pricePerRequest: 0.035, maxRequestsPerMission: 40 };
  const page1 = {
    nextPageToken: "p2",
    places: [
      // same hotel as OSM node 11 (same website): must not be stored twice
      { id: "G1", displayName: { text: "فندق شط العرب" }, formattedAddress: "العشار، البصرة، العراق", websiteUri: "https://shatt-hotel.iq/", googleMapsUri: "https://maps.google.com/?cid=1", businessStatus: "OPERATIONAL", primaryType: "hotel" },
      { id: "G2", displayName: { text: "فندق البصرة الدولي" }, formattedAddress: "البصرة، العراق", internationalPhoneNumber: "+964 780 333 4444", websiteUri: "https://www.facebook.com/basrahintl", googleMapsUri: "https://maps.google.com/?cid=2", businessStatus: "OPERATIONAL", primaryType: "hotel" },
    ],
  };
  const page2 = { places: [{ id: "G3", displayName: { text: "فندق الكورنيش" }, formattedAddress: "البصرة", googleMapsUri: "https://maps.google.com/?cid=3", businessStatus: "OPERATIONAL", primaryType: "hotel" }] };

  function withPlaces(status = 200) {
    const base = fakeFetch();
    const bodies: Record<string, unknown>[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === PLACES) {
        const h = new Headers(init?.headers);
        expect(h.get("X-Goog-Api-Key")).toBe(google.apiKey);
        expect(h.get("X-Goog-FieldMask")).toContain("places.websiteUri");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (status !== 200) return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project" } }), { status });
        return new Response(JSON.stringify(body.pageToken ? page2 : page1), { status: 200 });
      }
      return base.f(input, init);
    }) as typeof fetch;
    return { f, bodies, calls: base.calls };
  }

  it("searches Google first, pages through results, dedupes against OSM and records the cost", async () => {
    const { db, mission } = setup();
    const { f, bodies } = withPlaces();
    await runMission({ ...mission, params: { ...mission.params, write_drafts: false } }, { db, fetch: f, ai: null, google, deadline: far() });

    // one search term for hotels × 2 pages
    expect(bodies.map((b) => b.textQuery)).toEqual(["فندق في البصرة", "فندق في البصرة"]);
    const companies = db.rows("companies");
    expect(companies.map((c) => c.name).sort()).toEqual(["فندق البصرة الدولي", "فندق الكورنيش", "فندق المناوي باشا", "فندق شط العرب"].sort());
    const shatt = companies.find((c) => c.name === "فندق شط العرب")!;
    expect(shatt).toMatchObject({ source_ref: "gplace:G1", website: "https://shatt-hotel.iq" });
    expect(shatt.attributes).toMatchObject({ provider: "google" });
    expect(companies.find((c) => c.source_ref === "gplace:G2")!.attributes).toMatchObject({ social: ["https://www.facebook.com/basrahintl"] });
    expect(db.rows("usage_events")).toEqual([expect.objectContaining({ kind: "discover.google_places", quantity: 2, cost_usd: 0.07 })]);
    const sources = db.rows("agent_events").filter((e) => e.type === "discover.found").map((e) => (e.data as { source: string }).source);
    expect(sources).toEqual(["Google Maps", "OpenStreetMap"]);
  });

  it("pages only while more companies are needed, and stops at the mission's request budget", async () => {
    const { db, mission } = setup({ limit: 2, write_drafts: false });
    const { f, bodies } = withPlaces();
    await runMission(mission, { db, fetch: f, ai: null, google, deadline: far() });
    expect(bodies).toHaveLength(1); // quota 1 per pair: the first page (2 results) is plenty

    const s2 = setup({ write_drafts: false });
    const w2 = withPlaces();
    await runMission(s2.mission, { db: s2.db, fetch: w2.f, ai: null, google: { ...google, maxRequestsPerMission: 1 }, deadline: far() });
    expect(w2.bodies).toHaveLength(1);
    expect(s2.db.rows("agent_events").map((e) => e.type)).not.toContain("discover.google_config");
  });

  it("a rejected key is reported once and OpenStreetMap still runs", async () => {
    const { db, mission } = setup();
    const { f } = withPlaces(403);
    await runMission({ ...mission, params: { ...mission.params, write_drafts: false } }, { db, fetch: f, ai: null, google, deadline: far() });
    const types = db.rows("agent_events").map((e) => e.type);
    expect(types.filter((t) => t === "discover.google_config")).toHaveLength(1);
    expect(db.rows("companies").map((c) => c.source_ref).sort()).toEqual(["osm:node/11", "osm:node/12"]);
  });

  it("without a key it never calls Google", async () => {
    const { db, mission } = setup();
    const { f, calls } = withPlaces();
    await runMission(mission, { db, fetch: f, ai: null, deadline: far() });
    expect(calls).not.toContain(PLACES);
    expect(Object.keys((db.rows("agent_missions")[0]!.progress as { pairs: object }).pairs)).toEqual(["hotel|IQ-BA"]);
  });

  it("research adds social links found on the company's own website", async () => {
    const { db, mission } = setup();
    const { f } = fakeFetch();
    const g = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://shatt-hotel.iq")
        ? new Response(siteHtml.replace("</body>", '<a href="https://www.instagram.com/shatt.hotel/">ig</a></body>'), { status: 200, headers: { "content-type": "text/html" } })
        : f(input, init)) as typeof fetch;
    await runMission({ ...mission, params: { ...mission.params, write_drafts: false } }, { db, fetch: g, ai: null, deadline: far() });
    const shatt = db.rows("companies").find((c) => c.source_ref === "osm:node/11")!;
    expect(shatt.attributes).toMatchObject({ provider: "osm", social: ["https://www.instagram.com/shatt.hotel"] });
  });
});

describe("fixed signature", () => {
  it("is appended verbatim to the draft and the model is told not to sign", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "Products", body: "Sigenergy SigenStor", status: "active", updated_at: "1" }];
    db.tables.agent_settings = [{ tenant_id: T, daily_draft_limit: 20, draft_language: "ar-IQ", sender_name: "حسن", signature: "م. حسن\nSigen Solar Energy\nwww.sigenergy.com" }];
    const { f } = fakeFetch();
    let system = "";
    const g = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.anthropic.com/v1/messages") system = JSON.parse(String(init?.body)).system;
      return f(input, init);
    }) as typeof fetch;
    await runMission(mission, { db, fetch: g, ai, deadline: far() });
    expect(system).toContain("fixed signature");
    expect(system).not.toContain("Sign as");
    expect(db.rows("message_drafts")[0]!.body).toBe("مرحبا…\n\nم. حسن\nSigen Solar Energy\nwww.sigenergy.com");
  });
});

describe("opt-outs", () => {
  it("never drafts for a company whose address unsubscribed", async () => {
    const { db, mission } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "Products", body: "Sigenergy SigenStor", status: "active", updated_at: "1" }];
    db.tables.email_suppressions = [{ tenant_id: T, email: "info@shatt-hotel.iq", reason: "unsubscribed" }];
    const { f } = fakeFetch();
    await runMission(mission, { db, fetch: f, ai, deadline: far() });
    expect(db.rows("message_drafts")).toHaveLength(0);
  });
});

describe("rewrite", () => {
  it("writes a new pending draft with current knowledge and the reviewer's feedback", async () => {
    const { rewriteDraft } = await import("../rewrite");
    const { db } = setup();
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "References", body: "Babylon Pharmaceutical, Hilla: 3 MW", status: "active", updated_at: "2" }];
    db.tables.agent_settings = [{ tenant_id: T, draft_language: "ar-IQ", sender_name: "حسن", signature: "م. حسن\nwww.sigenergy.com" }];
    db.tables.companies = [{ id: "c1", tenant_id: T, name: "مصنع بغداد", governorate: "IQ-BG", source_url: "https://maps.google.com/?cid=1", attributes: { segment: "factory", provider: "google", google: { address: "بغداد" } } }];
    db.tables.message_drafts = [{ id: "old", tenant_id: T, company_id: "c1", status: "pending_review", language: "ar-IQ", subject: "x", body: "y" }];
    let sent: { system: string; messages: { content: string }[] } | null = null;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "submit_draft", input: { decision: "write", skip_reason: null, subject: "جديد", body: "نص جديد", sources_used: ["kb:doc-1"], hypotheses: [] } }], usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200 });
    }) as typeof fetch;
    const r = await rewriteDraft(db, ai, T, "old", "اذكر مشروع الحلة", f);
    expect(r.status).toBe("rewritten");
    expect(JSON.stringify(sent)).toContain("اذكر مشروع الحلة");
    expect(JSON.stringify(sent)).toContain("Google Maps");
    const fresh = db.rows("message_drafts").find((d) => d.id !== "old")!;
    expect(fresh).toMatchObject({ subject: "جديد", body: "نص جديد\n\nم. حسن\nwww.sigenergy.com", company_id: "c1" });
    expect(fresh.grounding).toMatchObject({ rewrite_of: "old" });
    expect(db.rows("usage_events")).toHaveLength(1);

    // an already reviewed draft can't be rewritten
    db.tables.message_drafts[0]!.status = "approved";
    expect((await rewriteDraft(db, ai, T, "old", "", f)).status).toBe("failed");
  });
});

describe("missions over imported leads", () => {
  it("takes matching imported companies (best first, with email), never searches, and drafts for them", async () => {
    const { db, mission } = setup({ source: "leads", segments: ["hotel", "_other"], governorates: ["IQ-BG"], limit: 2 });
    db.tables.knowledge_docs = [{ id: "doc-1", tenant_id: T, title: "Products", body: "Sigenergy SigenStor", status: "active", updated_at: "1" }];
    const co = (id: string, extra: Record<string, unknown>) => ({ id, tenant_id: T, name: id, governorate: "IQ-BG", source_type: "xlsx_import", mission_id: null, email: `${id}@x.iq`, fit_score: 50, attributes: { segment: "hotel" }, ...extra });
    db.tables.companies = [
      co("h-low", { fit_score: 10 }),
      co("h-high", { fit_score: 90 }),
      co("pc", { attributes: {}, fit_score: 60 }), // uncategorised: included through "_other"
      co("factory", { attributes: { segment: "factory" }, fit_score: 99 }),
      co("no-mail", { email: null, fit_score: 99 }),
      co("basra", { governorate: "IQ-BA", fit_score: 99 }),
      co("taken", { mission_id: "other-mission", fit_score: 99 }),
      co("found-online", { source_type: "api", fit_score: 99 }),
    ];
    // imported leads have no website: the draft may only cite the knowledge base
    const { f, calls } = fakeFetch({ ai: { content: [{ type: "tool_use", name: "submit_draft", input: { decision: "write", skip_reason: null, subject: "s", body: "b", sources_used: ["kb:doc-1"], hypotheses: [] } }], usage: { input_tokens: 10, output_tokens: 10 } } });
    await runMission(mission, { db, fetch: f, ai, deadline: far() });
    expect(calls.some((u) => OVERPASS_MIRRORS.includes(u))).toBe(false);
    expect(db.rows("companies").filter((c) => c.mission_id === "m1").map((c) => c.id).sort()).toEqual(["h-high", "pc"]);
    expect(db.rows("message_drafts").map((d) => d.company_id).sort()).toEqual(["h-high", "pc"]);
    expect(db.rows("agent_events").map((e) => e.type)).toContain("leads.claimed");
  });
});
