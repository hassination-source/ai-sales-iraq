import {
  buildOverpassQuery,
  buildPlacesQuery,
  extractFacts,
  getPack,
  parseOverpass,
  parsePlaces,
  resolveConfig,
  scoreCompany,
  SOCIAL_OR_WEBMAIL,
  socialLinksFromHtml,
  socialLinksFromTags,
  t,
  withSignature,
  type DiscoveredCompany,
  type EffectiveConfig,
  type WebsiteFacts,
} from "@ais/core";
import { backoffMs, fetchPage, runOverpass, runPlacesSearch, type Fetch } from "./http";
import { writeDraft, type AiConfig } from "./ai";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Minimal surface of the Supabase client used here (service role; RLS bypassed — scope by tenant explicitly). */
export type Db = { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };

export interface Mission {
  id: string;
  tenant_id: string;
  params: { segments: string[]; governorates: string[]; limit: number; write_drafts?: boolean };
  status: string;
  phase: "discover" | "research" | "draft" | "finished";
  progress: Progress;
  attempts: number;
}

interface PairState {
  status: "pending" | "done" | "failed";
  attempts: number;
  found: number;
}
interface Progress {
  pairs?: Record<string, PairState>;
  found?: number;
  duplicates?: number;
  researched?: number;
  drafted?: number;
  skipped?: number;
  google_requests?: number;
  notified?: Record<string, boolean>;
}

export interface Deps {
  db: Db;
  fetch: Fetch;
  ai: AiConfig | null;
  /** Google Places API key; when absent the agent uses OpenStreetMap only. */
  google?: GoogleConfig | null;
  deadline: number;
  now?: () => Date;
}

export interface GoogleConfig {
  apiKey: string;
  /** USD per Text Search request (Enterprise SKU, before free usage). */
  pricePerRequest: number;
  /** Hard cap on billed requests per mission. */
  maxRequestsPerMission: number;
}

/** Google Places content may only be cached briefly; re-fetch or drop after this. */
const GOOGLE_CACHE_DAYS = 30;
/** Text Search returns up to 20 per page and at most 60 per query. */
const GOOGLE_MAX_PAGES = 3;

const TAG_KEYS = ["operator", "brand", "opening_hours", "addr:street", "addr:city", "industrial", "man_made", "tourism", "amenity", "healthcare", "shop", "office", "craft", "landuse", "building", "description"];

export async function runMission(m: Mission, deps: Deps): Promise<void> {
  const { db } = deps;
  const progress: Progress = { pairs: {}, found: 0, duplicates: 0, researched: 0, drafted: 0, skipped: 0, notified: {}, ...m.progress };
  const ev = (type: string, data: Record<string, unknown> = {}, level = "info", extra: Record<string, unknown> = {}) =>
    db.from("agent_events").insert({ tenant_id: m.tenant_id, mission_id: m.id, type, level, data, ...extra });

  const save = (patch: Record<string, unknown>) => db.from("agent_missions").update({ progress, ...patch }).eq("id", m.id).eq("tenant_id", m.tenant_id);

  // a user may have cancelled since the claim
  const { data: fresh } = await db.from("agent_missions").select("status").eq("id", m.id).single();
  if (fresh?.status === "cancelled") return;

  const cfg = await loadConfig(db, m.tenant_id);
  if (!cfg) {
    await ev("mission.failed", { reason: "config" }, "error");
    await save({ status: "failed", note: "industry configuration missing", finished_at: new Date().toISOString(), locked_until: null });
    return;
  }

  if (m.attempts <= 1 && !progress.notified?.started) {
    progress.notified = { ...progress.notified, started: true };
    await ev("mission.started", { segments: m.params.segments, governorates: m.params.governorates, limit: m.params.limit });
  }

  let phase = m.phase;
  if (phase === "discover") {
    const r = await discover(m, cfg, progress, deps, ev);
    if (r.kind === "wait") return void (await save({ status: "running", locked_until: null, next_run_at: new Date(Date.now() + r.ms).toISOString() }));
    if (r.kind === "timeup") return void (await save({ locked_until: null, next_run_at: new Date().toISOString() }));
    if ((progress.found ?? 0) === 0) {
      await ev("mission.done", { found: 0 }, "warning");
      return void (await save({ status: "done", phase: "finished", note: "no companies found", finished_at: new Date().toISOString(), locked_until: null }));
    }
    phase = "research";
    await save({ phase });
  }

  if (phase === "research") {
    const r = await research(m, cfg, progress, deps, ev);
    if (r === "timeup") return void (await save({ locked_until: null, next_run_at: new Date().toISOString() }));
    phase = m.params.write_drafts === false ? "finished" : "draft";
    await save({ phase });
  }

  if (phase === "draft") {
    const r = await draft(m, cfg, progress, deps, ev);
    if (r === "timeup") return void (await save({ locked_until: null, next_run_at: new Date().toISOString() }));
    if (r === "limit") return void (await save({ locked_until: null, next_run_at: nextLocalMidnightUtc().toISOString(), note: "daily draft limit reached" }));
  }

  await ev("mission.done", { found: progress.found, researched: progress.researched, drafted: progress.drafted }, "success");
  await save({ status: "done", phase: "finished", finished_at: new Date().toISOString(), locked_until: null });
}

async function loadConfig(db: Db, tenantId: string): Promise<EffectiveConfig | null> {
  const { data } = await db.from("industry_configs").select("pack_id, pack_version, overrides").eq("tenant_id", tenantId).single();
  if (!data) return null;
  try {
    return resolveConfig(getPack(data.pack_id, data.pack_version), data.overrides);
  } catch {
    return null;
  }
}

type Ev = (type: string, data?: Record<string, unknown>, level?: string, extra?: Record<string, unknown>) => Promise<unknown>;

/* ------------------------------------------------------------------ discover */
type DiscoverResult = { kind: "done" } | { kind: "timeup" } | { kind: "wait"; ms: number };

type Source = "osm" | "google";
/** Pair keys: "seg|gov" (OpenStreetMap, the original format) and "google:seg|gov". */
const pairKey = (src: Source, seg: string, gov: string) => (src === "osm" ? `${seg}|${gov}` : `google:${seg}|${gov}`);
function parsePairKey(key: string): { src: Source; seg: string; gov: string } {
  const google = key.startsWith("google:");
  const [seg, gov] = (google ? key.slice(7) : key).split("|") as [string, string];
  return { src: google ? "google" : "osm", seg, gov };
}

async function discover(m: Mission, cfg: EffectiveConfig, p: Progress, deps: Deps, ev: Ev): Promise<DiscoverResult> {
  const segments = cfg.segments.filter((s) => m.params.segments.includes(s.key));
  // Google first when available: it covers far more Iraqi businesses than OSM
  if (deps.google) for (const s of segments) if (s.discovery.searchTerms.length) for (const g of m.params.governorates) p.pairs![pairKey("google", s.key, g)] ??= { status: "pending", attempts: 0, found: 0 };
  for (const s of segments) if (s.discovery.osm.length) for (const g of m.params.governorates) p.pairs![pairKey("osm", s.key, g)] ??= { status: "pending", attempts: 0, found: 0 };

  let waitMs = Infinity;
  const entries = Object.entries(p.pairs!).sort(([a], [b]) => Number(b.startsWith("google:")) - Number(a.startsWith("google:")));
  for (const [key, st] of entries) {
    if (st.status !== "pending") continue;
    if ((p.found ?? 0) >= m.params.limit) break;
    if (Date.now() > deps.deadline - 45_000) return { kind: "timeup" };
    const { src, seg: segKey, gov } = parsePairKey(key);
    const seg = segments.find((s) => s.key === segKey);
    if (!seg || (src === "google" && !deps.google)) {
      st.status = "failed";
      continue;
    }
    // share the limit across every source × segment × governorate
    const quota = Math.ceil(m.params.limit / Math.max(1, Object.keys(p.pairs!).length));
    const remaining = Math.min(quota, m.params.limit - (p.found ?? 0));
    if (src === "google" && (p.google_requests ?? 0) >= deps.google!.maxRequestsPerMission) {
      st.status = "failed";
      if (!p.notified?.google_budget) {
        p.notified = { ...p.notified, google_budget: true };
        await ev("discover.google_budget", { requests: p.google_requests }, "info");
      }
      continue;
    }

    const res = src === "google" ? await searchGoogle(m, seg.discovery.searchTerms, gov, remaining, p, deps) : await searchOsm(seg.discovery.osm, gov, st.attempts, deps);
    if (!res.ok) {
      st.attempts++;
      if (res.config) {
        st.status = "failed";
        if (!p.notified?.google_config) {
          p.notified = { ...p.notified, google_config: true };
          await ev("discover.google_config", { error: res.error }, "error");
        }
      } else if (!res.retryable || st.attempts >= 6) {
        st.status = "failed";
        await ev("discover.source_failed", { segment: segKey, governorate: gov, error: res.error, source: src }, "warning");
      } else {
        waitMs = Math.min(waitMs, backoffMs(st.attempts));
        if (st.attempts === 1) await ev("discover.source_busy", { segment: segKey, governorate: gov, retry_in_min: Math.round(backoffMs(1) / 60000), source: src }, "info");
      }
      continue;
    }

    const { inserted, duplicates } = await insertCompanies(deps.db, m, cfg, segKey, src, res.companies, remaining, deps.now?.() ?? new Date());
    st.status = "done";
    st.found = inserted;
    p.found = (p.found ?? 0) + inserted;
    p.duplicates = (p.duplicates ?? 0) + duplicates;
    await ev(
      "discover.found",
      { segment: segKey, segment_label: seg.label, governorate: gov, count: inserted, duplicates, total_in_source: res.companies.length, source: src === "google" ? "Google Maps" : "OpenStreetMap" },
      inserted ? "success" : "info",
    );
  }

  const pending = Object.values(p.pairs!).some((s) => s.status === "pending");
  // wait for the shortest pending backoff, then retry the busy sources
  if (pending && (p.found ?? 0) < m.params.limit) return { kind: "wait", ms: Number.isFinite(waitMs) ? waitMs : 60_000 };
  return { kind: "done" };
}

type Found = DiscoveredCompany & { social?: string[] };
type SearchResult = { ok: true; companies: Found[] } | { ok: false; retryable: boolean; config: boolean; error: string };

async function searchOsm(osm: Parameters<typeof buildOverpassQuery>[1], gov: string, attempt: number, deps: Deps): Promise<SearchResult> {
  const res = await runOverpass(buildOverpassQuery(gov, osm, 300), attempt, deps.fetch);
  if (!res.ok) return { ok: false, retryable: res.retryable, config: false, error: res.error };
  return { ok: true, companies: parseOverpass(res.json, gov).map((c) => ({ ...c, social: socialLinksFromTags(c.tags) })) };
}

/**
 * Search terms of the segment, paging only while more results are needed (want + margin for
 * duplicates), within the mission's request budget. Each request is billed and recorded.
 */
async function searchGoogle(m: Mission, terms: Parameters<typeof buildPlacesQuery>[0][], gov: string, want: number, p: Progress, deps: Deps): Promise<SearchResult> {
  const g = deps.google!;
  const byRef = new Map<string, Found>();
  // twice what this pair needs leaves room for duplicates; a page holds 20, so usually one request
  const enough = Math.max(2 * want, want + 1);
  let requests = 0;
  try {
    for (const term of terms) {
      if (byRef.size >= enough) break;
      let token: string | undefined;
      for (let page = 0; page < GOOGLE_MAX_PAGES; page++) {
        if (Date.now() > deps.deadline - 50_000 || byRef.size >= enough) break;
        if ((p.google_requests ?? 0) + requests >= g.maxRequestsPerMission) break;
        const res = await runPlacesSearch(buildPlacesQuery(term, gov, token), g.apiKey, deps.fetch);
        requests++;
        if (!res.ok) {
          // keep what earlier pages found; fail only when nothing came back
          if (byRef.size) break;
          return res;
        }
        const parsed = parsePlaces(res.json, gov);
        for (const c of parsed.companies) if (!byRef.has(c.source_ref)) byRef.set(c.source_ref, c);
        if (!parsed.nextPageToken) break;
        token = parsed.nextPageToken;
      }
    }
  } finally {
    p.google_requests = (p.google_requests ?? 0) + requests;
    if (requests)
      await deps.db.from("usage_events").insert({ tenant_id: m.tenant_id, kind: "discover.google_places", quantity: requests, cost_usd: Number((requests * g.pricePerRequest).toFixed(4)), metadata: { governorate: gov, mission_id: m.id } });
  }
  return { ok: true, companies: [...byRef.values()] };
}

async function insertCompanies(db: Db, m: Mission, cfg: EffectiveConfig, segKey: string, src: Source, found: Found[], remaining: number, now: Date) {
  if (!found.length || remaining <= 0) return { inserted: 0, duplicates: 0 };
  const refs = found.map((c) => c.source_ref);
  const names = [...new Set(found.map((c) => c.name_normalized))];
  const phones = [...new Set(found.map((c) => c.phone).filter((x): x is string => !!x))];
  const emails = [...new Set(found.map((c) => c.email).filter((x): x is string => !!x))];
  const sites = [...new Set(found.map((c) => c.website).filter((x): x is string => !!x))];
  const [{ data: byRef }, { data: byName }, { data: byPhone }, { data: byEmail }, { data: bySite }] = await Promise.all([
    db.from("companies").select("source_ref").eq("tenant_id", m.tenant_id).in("source_ref", refs),
    db.from("companies").select("name_normalized, governorate").eq("tenant_id", m.tenant_id).in("name_normalized", names),
    phones.length ? db.from("companies").select("phone").eq("tenant_id", m.tenant_id).in("phone", phones) : { data: [] },
    emails.length ? db.from("companies").select("email").eq("tenant_id", m.tenant_id).in("email", emails) : { data: [] },
    sites.length ? db.from("companies").select("website").eq("tenant_id", m.tenant_id).in("website", sites) : { data: [] },
  ]);
  const seenRef = new Set((byRef ?? []).map((r: { source_ref: string }) => r.source_ref));
  const seenName = new Set((byName ?? []).map((r: { name_normalized: string; governorate: string | null }) => `${r.name_normalized}|${r.governorate ?? ""}`));
  const seenPhone = new Set((byPhone ?? []).map((r: { phone: string }) => r.phone));
  const seenEmail = new Set((byEmail ?? []).map((r: { email: string }) => r.email));
  const seenSite = new Set((bySite ?? []).map((r: { website: string }) => r.website));

  // same business listed several times, or found by both sources: same record, name, phone, email or website
  const fresh = found.filter((c) => {
    const nameKey = `${c.name_normalized}|${c.governorate}`;
    const dup = seenRef.has(c.source_ref) || seenName.has(nameKey) || (c.phone && seenPhone.has(c.phone)) || (c.email && seenEmail.has(c.email)) || (c.website && seenSite.has(c.website));
    seenName.add(nameKey);
    if (c.website) seenSite.add(c.website);
    if (c.phone) seenPhone.add(c.phone);
    if (c.email) seenEmail.add(c.email);
    return !dup;
  });
  const duplicates = found.length - fresh.length;
  // companies with contact details first: they are the ones the agent can act on
  fresh.sort((a, b) => Number(!!b.website || !!b.email) - Number(!!a.website || !!a.email) || Number(!!b.phone) - Number(!!a.phone));
  const take = fresh.slice(0, remaining);

  const rows = take.map((c) => {
    const osm = Object.fromEntries(Object.entries(c.tags).filter(([k]) => TAG_KEYS.includes(k)).map(([k, v]) => [k, v.slice(0, 200)]));
    const attributes: Record<string, unknown> = {
      segment: segKey,
      provider: src,
      ...(src === "osm" ? { osm } : { google: { ...c.tags, expires_at: new Date(now.getTime() + GOOGLE_CACHE_DAYS * 86_400_000).toISOString() } }),
      ...(c.social?.length ? { social: c.social } : {}),
      ...(c.name_en ? { name_en: c.name_en } : {}),
      ...(c.lat !== null ? { lat: c.lat, lon: c.lon } : {}),
    };
    const score = scoreCompany(cfg, { governorate: c.governorate, phone: c.phone, website: c.website, email: c.email, verification_status: "unverified", attributes });
    return {
      tenant_id: m.tenant_id,
      mission_id: m.id,
      name: c.name.slice(0, 300),
      name_normalized: c.name_normalized,
      governorate: c.governorate,
      city: c.city,
      phone: c.phone,
      website: c.website,
      email: c.email,
      attributes,
      source_type: "api",
      source_url: c.source_url,
      source_ref: c.source_ref,
      fit_score: score.normalized,
    };
  });
  if (!rows.length) return { inserted: 0, duplicates };

  const { data, error } = await db.from("companies").insert(rows).select("id");
  if (!error) return { inserted: data.length, duplicates };
  // a concurrent run inserted some of these: fall back to one by one, skipping duplicates
  let inserted = 0;
  for (const r of rows) {
    const { error: e } = await db.from("companies").insert(r);
    if (!e) inserted++;
  }
  return { inserted, duplicates: duplicates + (rows.length - inserted) };
}

/* ------------------------------------------------------------------ research */
async function research(m: Mission, _cfg: EffectiveConfig, p: Progress, deps: Deps, ev: Ev): Promise<"done" | "timeup"> {
  const { db } = deps;
  if (!p.notified?.no_website) {
    const { count } = await db.from("companies").select("id", { count: "exact", head: true }).eq("tenant_id", m.tenant_id).eq("mission_id", m.id).is("website", null);
    if (count) await ev("research.no_website", { count }, "info");
    p.notified = { ...p.notified, no_website: true };
  }
  for (;;) {
    if (Date.now() > deps.deadline - 20_000) return "timeup";
    const { data: batch } = await db
      .from("companies")
      .select("id, name, website, email, phone, attributes")
      .eq("tenant_id", m.tenant_id)
      .eq("mission_id", m.id)
      .not("website", "is", null)
      .order("fit_score", { ascending: false })
      .limit(200);
    const ids = (batch ?? []).map((c: { id: string }) => c.id);
    const { data: done } = ids.length ? await db.from("company_research").select("company_id").eq("tenant_id", m.tenant_id).in("company_id", ids) : { data: [] };
    const doneIds = new Set((done ?? []).map((r: { company_id: string }) => r.company_id));
    const todo = (batch ?? []).filter((c: { id: string }) => !doneIds.has(c.id)).slice(0, 4);
    if (!todo.length) return "done";

    await Promise.all(
      todo.map(async (c: { id: string; name: string; website: string; email: string | null; phone: string | null; attributes: Record<string, unknown> | null }) => {
        if (isNotCompanySite(c.website)) {
          await db.from("company_research").upsert({ tenant_id: m.tenant_id, company_id: c.id, url: c.website, status: "skipped", error: "social or webmail page" }, { onConflict: "tenant_id,company_id" });
          return;
        }
        const page = await fetchPage(c.website, deps.fetch);
        if (!page.ok) {
          await db.from("company_research").upsert({ tenant_id: m.tenant_id, company_id: c.id, url: c.website, status: "failed", error: page.error.slice(0, 300) }, { onConflict: "tenant_id,company_id" });
          await ev("research.failed", { name: c.name, error: page.error.slice(0, 120) }, "warning", { company_id: c.id });
          return;
        }
        const f = extractFacts(page.url, page.html);
        await db.from("company_research").upsert(
          { tenant_id: m.tenant_id, company_id: c.id, url: page.url, status: "ok", title: f.title, description: f.description, text: f.text, emails: f.emails, phones: f.phones, language: f.language, error: null, fetched_at: new Date().toISOString() },
          { onConflict: "tenant_id,company_id" },
        );
        // contact details published on the company's own site fill gaps (never overwrite)
        const patch: Record<string, unknown> = {};
        if (!c.email && f.emails[0]) patch.email = f.emails[0];
        if (!c.phone && f.phones[0]) patch.phone = f.phones[0];
        const known = Array.isArray(c.attributes?.social) ? (c.attributes.social as string[]) : [];
        const social = [...new Set([...known, ...socialLinksFromHtml(page.html)])].slice(0, 6);
        if (social.length > known.length) patch.attributes = { ...(c.attributes ?? {}), social };
        if (Object.keys(patch).length) await db.from("companies").update(patch).eq("id", c.id).eq("tenant_id", m.tenant_id);
        p.researched = (p.researched ?? 0) + 1;
        await ev("research.done", { name: c.name, title: f.title, emails: f.emails.length, phones: f.phones.length }, "success", { company_id: c.id });
      }),
    );
  }
}

/* ------------------------------------------------------------------ draft */
async function draft(m: Mission, cfg: EffectiveConfig, p: Progress, deps: Deps, ev: Ev): Promise<"done" | "timeup" | "limit"> {
  const { db } = deps;
  const once = async (key: string, type: string, data: Record<string, unknown> = {}) => {
    if (p.notified?.[key]) return;
    p.notified = { ...p.notified, [key]: true };
    await ev(type, data, "warning");
  };
  if (!deps.ai) {
    await once("needs_ai", "draft.needs_ai");
    return "done";
  }

  const { data: docs } = await db.from("knowledge_docs").select("id, title, body").eq("tenant_id", m.tenant_id).eq("status", "active").order("updated_at", { ascending: false }).limit(12);
  if (!docs?.length) {
    await once("needs_knowledge", "draft.needs_knowledge");
    return "done";
  }

  const [{ data: settings }, { data: tenant }] = await Promise.all([
    db.from("agent_settings").select("daily_draft_limit, draft_language, sender_name, signature").eq("tenant_id", m.tenant_id).maybeSingle(),
    db.from("tenants").select("name").eq("id", m.tenant_id).single(),
  ]);
  const limit = settings?.daily_draft_limit ?? 20;
  const language = (settings?.draft_language ?? "ar-IQ") as "ar-IQ" | "ar" | "en";

  for (;;) {
    if (Date.now() > deps.deadline - 70_000) return "timeup";
    const since = new Date();
    since.setUTCHours(-3, 0, 0, 0); // start of today in Baghdad (UTC+3)
    const { count: today } = await db.from("message_drafts").select("id", { count: "exact", head: true }).eq("tenant_id", m.tenant_id).neq("generated_by", "human").gte("created_at", since.toISOString());
    if ((today ?? 0) >= limit) {
      await once(`limit_${since.toISOString().slice(0, 10)}`, "draft.daily_limit", { limit });
      return "limit";
    }

    const [{ data: candidates }, { data: drafted }, { data: attempted }] = await Promise.all([
      db.from("companies").select("id, name, governorate, email, source_url, attributes").eq("tenant_id", m.tenant_id).eq("mission_id", m.id).order("fit_score", { ascending: false }).limit(200),
      db.from("message_drafts").select("company_id").eq("tenant_id", m.tenant_id).not("company_id", "is", null),
      db.from("agent_events").select("company_id").eq("tenant_id", m.tenant_id).eq("mission_id", m.id).in("type", ["draft.skipped", "draft.invalid"]),
    ]);
    const skip = new Set([...(drafted ?? []), ...(attempted ?? [])].map((r: { company_id: string }) => r.company_id));
    const candidateIds = (candidates ?? []).map((c: { id: string }) => c.id);
    const { data: researchRows } = candidateIds.length
      ? await db.from("company_research").select("company_id, url, status, title, description, text, emails, phones, language").eq("tenant_id", m.tenant_id).in("company_id", candidateIds)
      : { data: [] };
    const researchBy = new Map((researchRows ?? []).map((r: { company_id: string }) => [r.company_id, r]));

    // only companies the agent could actually email
    const next = (candidates ?? []).find((c: { id: string; email: string | null }) => !skip.has(c.id) && (c.email || ((researchBy.get(c.id) as { emails?: string[] } | undefined)?.emails?.length ?? 0) > 0));
    if (!next) return "done";

    const r = researchBy.get(next.id) as (WebsiteFacts & { status: string }) | undefined;
    const seg = cfg.segments.find((s) => s.key === next.attributes?.segment);
    const result = await writeDraft(
      {
        pack: cfg,
        tenantName: tenant?.name ?? "",
        senderName: settings?.sender_name ?? null,
        signature: settings?.signature ?? null,
        language,
        channel: "email",
        knowledge: docs,
        extraInstructions: cfg.extraAiInstructions,
        prospect: {
          companyId: next.id,
          name: next.name,
          governorate: next.governorate,
          segmentLabel: seg ? t(seg.label, "en") : null,
          directory: next.source_url ? directoryFacts(next.source_url, next.attributes) : null,
          website: r?.status === "ok" ? { url: r.url, title: r.title, description: r.description, text: r.text ?? "", emails: r.emails, phones: r.phones, language: r.language } : null,
        },
      },
      deps.ai,
      deps.fetch,
    );
    if (result.usage) {
      await db.from("usage_events").insert({ tenant_id: m.tenant_id, kind: "ai.draft", quantity: result.usage.input + result.usage.output, cost_usd: result.usage.costUsd, metadata: { model: deps.ai.model, input_tokens: result.usage.input, output_tokens: result.usage.output, company_id: next.id } });
    }
    if (!result.ok) {
      if (result.retryable) {
        // temporary (timeout, overload, rate limit): say so once per kind of error, then try again next tick
        await once(`ai_retry_${result.error.slice(0, 40)}`, "draft.ai_retry", { error: result.error.slice(0, 300) });
        return "timeup";
      }
      if (result.config) {
        await once("ai_config", "draft.ai_config", { error: result.error.slice(0, 300) });
        return "done";
      }
      await ev("draft.invalid", { name: next.name, reason: result.error.slice(0, 200) }, "warning", { company_id: next.id });
      continue;
    }
    if (result.draft.decision === "skip") {
      p.skipped = (p.skipped ?? 0) + 1;
      await ev("draft.skipped", { name: next.name, reason: result.draft.skip_reason }, "info", { company_id: next.id });
      continue;
    }
    const { data: row, error } = await db
      .from("message_drafts")
      .insert({
        tenant_id: m.tenant_id,
        company_id: next.id,
        channel: "email",
        language,
        subject: result.draft.subject,
        body: withSignature(result.draft.body ?? "", settings?.signature),
        grounding: { sources: result.draft.sources_used, hypotheses: result.draft.hypotheses, model: deps.ai.model, website: r?.status === "ok" ? r.url : null, directory: next.source_url },
        generated_by: deps.ai.model,
      })
      .select("id")
      .single();
    if (error) {
      await ev("draft.invalid", { name: next.name, reason: error.message.slice(0, 200) }, "error", { company_id: next.id });
      continue;
    }
    p.drafted = (p.drafted ?? 0) + 1;
    await ev("draft.created", { name: next.name, subject: result.draft.subject }, "success", { company_id: next.id, draft_id: row.id });
  }
}

/** What the directory listing says about the company, labelled with the directory it came from. */
function directoryFacts(url: string, attributes: Record<string, unknown> | null) {
  const google = attributes?.provider === "google";
  const raw = (google ? attributes?.google : attributes?.osm) as Record<string, unknown> | undefined;
  const facts = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => k !== "expires_at").map(([k, v]) => [k, String(v)]));
  return { source: google ? "Google Maps" : "OpenStreetMap", url, facts };
}

/** Pages that aren't the company's own site: reading them tells us nothing about the business. */
export function isNotCompanySite(url: string): boolean {
  try {
    return SOCIAL_OR_WEBMAIL.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

function nextLocalMidnightUtc(): Date {
  const d = new Date();
  d.setUTCHours(21, 0, 0, 0); // 00:00 in Baghdad
  if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
