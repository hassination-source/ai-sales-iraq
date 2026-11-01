import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createUser, freshDb, STAGES } from "./harness";

const OWNER = "00000000-0000-4000-8000-0000000000c1";
const SALES = "00000000-0000-4000-8000-0000000000c2";
const OTHER = "00000000-0000-4000-8000-0000000000c3";
let db: PGlite;
let tenant: string;
let other: string;

const params = JSON.stringify({ segments: ["hotel"], governorates: ["IQ-BA"], limit: 20 });

/** Run as the worker (service role, bypasses RLS like Supabase's service key). */
async function asWorker<T>(fn: () => Promise<T>) {
  await db.exec("begin; set local role service_role;");
  try {
    const r = await fn();
    await db.exec("commit");
    return r;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

beforeAll(async () => {
  db = await freshDb();
  for (const u of [OWNER, SALES, OTHER]) await createUser(db, u);
  tenant = await asUser(db, OWNER, async (q) => (await q<{ id: string }>("select app.create_tenant('Sigen','sigen-x','solar-energy',1,$1::jsonb) as id", [STAGES]))[0]!.id, { commit: true });
  other = await asUser(db, OTHER, async (q) => (await q<{ id: string }>("select app.create_tenant('Other','other-x','auto-parts',1,$1::jsonb) as id", [STAGES]))[0]!.id, { commit: true });
  await asUser(db, OWNER, (q) => q("insert into tenant_members(tenant_id,user_id,role) values ($1,$2,'salesperson')", [tenant, SALES]), { commit: true });
}, 60_000);

describe("agent missions", () => {
  it("managers create missions, the worker is kicked, salespeople cannot", async () => {
    const before = (await db.query<{ n: number }>("select count(*)::int n from net.calls")).rows[0]!.n;
    await asUser(db, OWNER, (q) => q("insert into agent_missions(tenant_id, params) values ($1, $2::jsonb)", [tenant, params]), { commit: true });
    const after = (await db.query<{ n: number; h: Record<string, string> }>("select count(*)::int n, max(headers::text)::jsonb h from net.calls")).rows[0]!;
    expect(after.n).toBe(before + 1);
    expect(after.h["x-worker-secret"]).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.query<{ url: string }>("select url from net.calls order by id desc limit 1")).rows[0]!.url).toBe("https://ai-sales-iraq.vercel.app/api/agent/tick");
    await expect(asUser(db, SALES, (q) => q("insert into agent_missions(tenant_id, params) values ($1, $2::jsonb)", [tenant, params]))).rejects.toThrow(/row-level security/);
  });

  it("rejects bad parameters, pre-set progress and more than 3 active missions", async () => {
    await expect(asUser(db, OWNER, (q) => q(`insert into agent_missions(tenant_id, params) values ($1, '{"segments":[],"governorates":["IQ-BA"],"limit":5}'::jsonb)`, [tenant]))).rejects.toThrow(/invalid mission/);
    await expect(asUser(db, OWNER, (q) => q("insert into agent_missions(tenant_id, params, status) values ($1, $2::jsonb, 'done')", [tenant, params]))).rejects.toThrow(/start queued/);
    await asUser(db, OWNER, async (q) => {
      await q("insert into agent_missions(tenant_id, params) values ($1, $2::jsonb), ($1, $2::jsonb)", [tenant, params]);
      await expect(q("insert into agent_missions(tenant_id, params) values ($1, $2::jsonb)", [tenant, params])).rejects.toThrow(/at most 3/);
    });
  });

  it("users can cancel but not otherwise change a mission", async () => {
    const id = (await db.query<{ id: string }>("select id from agent_missions where tenant_id=$1 limit 1", [tenant])).rows[0]!.id;
    await expect(asUser(db, OWNER, (q) => q("update agent_missions set progress='{\"x\":1}' where id=$1", [id]))).rejects.toThrow(/only be cancelled/);
    const r = await asUser(db, OWNER, (q) => q<{ status: string; finished_at: string }>("update agent_missions set status='cancelled' where id=$1 returning status, finished_at", [id]));
    expect(r[0]).toMatchObject({ status: "cancelled" });
    expect(r[0]!.finished_at).not.toBeNull();
  });

  it("missions and events are invisible to other tenants; users cannot write events or research", async () => {
    await asWorker(() => db.query("insert into agent_events(tenant_id, type, data) values ($1, 'discover.found', '{\"count\":3}')", [tenant]));
    expect(await asUser(db, OTHER, (q) => q("select * from agent_missions"))).toHaveLength(0);
    expect(await asUser(db, OTHER, (q) => q("select * from agent_events"))).toHaveLength(0);
    expect((await asUser(db, SALES, (q) => q("select * from agent_events"))).length).toBeGreaterThan(0);
    await expect(asUser(db, OWNER, (q) => q("insert into agent_events(tenant_id, type) values ($1, 'x')", [tenant]))).rejects.toThrow(/permission denied/);
  });

  it("the worker claims each due mission once and skips paused tenants", async () => {
    const first = await asWorker(() => db.query<{ id: string; status: string }>("select * from app.claim_missions(10)"));
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.every((m) => m.status === "running")).toBe(true);
    const second = await asWorker(() => db.query("select * from app.claim_missions(10)"));
    expect(second.rows).toHaveLength(0); // locked

    await asUser(db, OTHER, (q) => q("insert into agent_missions(tenant_id, params) values ($1, $2::jsonb)", [other, JSON.stringify({ segments: ["workshop"], governorates: ["IQ-BG"], limit: 5 })]), { commit: true });
    await asUser(db, OTHER, (q) => q("insert into agent_settings(tenant_id, paused) values ($1, true)", [other]), { commit: true });
    const third = await asWorker(() => db.query("select * from app.claim_missions(10)"));
    expect(third.rows).toHaveLength(0);
  });

  it("only the worker can claim missions or read the secret", async () => {
    await expect(asUser(db, OWNER, (q) => q("select * from app.claim_missions(1)"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, OWNER, (q) => q("select app.check_worker_secret('x')"))).rejects.toThrow(/permission denied/);
    const ok = await asWorker(() => db.query<{ ok: boolean }>("select app.check_worker_secret((select decrypted_secret from vault.decrypted_secrets where name='agent_worker_secret')) ok"));
    expect(ok.rows[0]!.ok).toBe(true);
    expect((await asWorker(() => db.query<{ ok: boolean }>("select app.check_worker_secret('wrong') ok"))).rows[0]!.ok).toBe(false);
  });

  it("directory records are added once per tenant", async () => {
    await asWorker(() => db.query("insert into companies(tenant_id,name,name_normalized,source_type,source_url,source_ref) values ($1,'Hotel','hotel','api','https://www.openstreetmap.org/node/1','osm:node/1')", [tenant]));
    await expect(asWorker(() => db.query("insert into companies(tenant_id,name,name_normalized,source_type,source_url,source_ref) values ($1,'Hotel','hotel','api','https://www.openstreetmap.org/node/1','osm:node/1')", [tenant]))).rejects.toThrow(/duplicate key/);
    // another tenant can find the same business independently
    await asWorker(() => db.query("insert into companies(tenant_id,name,name_normalized,source_type,source_url,source_ref) values ($1,'Hotel','hotel','api','https://www.openstreetmap.org/node/1','osm:node/1')", [other]));
  });

  it("knowledge docs: managers write, salespeople read, versions bump", async () => {
    const id = await asUser(db, OWNER, async (q) => (await q<{ id: string }>("insert into knowledge_docs(tenant_id, kind, title, body) values ($1,'product','Products','Sigenergy SigenStor hybrid inverter and battery system.') returning id", [tenant]))[0]!.id, { commit: true });
    await expect(asUser(db, SALES, (q) => q("insert into knowledge_docs(tenant_id, title, body) values ($1,'x','xxxxxxxxxxxx')", [tenant]))).rejects.toThrow(/row-level security/);
    expect(await asUser(db, SALES, (q) => q("select id from knowledge_docs"))).toHaveLength(1);
    const v = await asUser(db, OWNER, (q) => q<{ version: number }>("update knowledge_docs set body='Updated product description text.' where id=$1 returning version", [id]));
    expect(v[0]!.version).toBe(2);
  });

  it("email delivery: only the sending service marks drafts sent; opt-outs are per tenant", async () => {
    const draft = await asUser(db, OWNER, async (q) => {
      const [d] = await q<{ id: string }>("insert into message_drafts(tenant_id, channel, language, subject, body) values ($1,'email','ar','s','body text') returning id", [tenant]);
      await q("update message_drafts set status='approved' where id=$1", [d!.id]);
      return d!.id;
    }, { commit: true });
    await expect(asUser(db, OWNER, (q) => q("update message_drafts set status='sent' where id=$1", [draft]))).rejects.toThrow(/sending service only/);
    await expect(asUser(db, SALES, (q) => q("update message_drafts set to_email='x@y.iq' where id=$1", [draft]))).rejects.toThrow(/sending service only/);
    const sent = await asWorker(async () => (await db.query<{ status: string }>("update message_drafts set status='sent', to_email='info@x.iq', sent_at=now(), provider_message_id='re_1' where id=$1 returning status", [draft])).rows);
    expect(sent[0]!.status).toBe("sent");

    await asUser(db, SALES, (q) => q("insert into email_suppressions(tenant_id, email, reason) values ($1,'info@x.iq','manual')", [tenant]), { commit: true });
    await expect(asUser(db, OWNER, (q) => q("insert into email_suppressions(tenant_id, email, reason) values ($1,'Upper@X.iq','manual')", [tenant]))).rejects.toThrow(/check/);
    expect(await asUser(db, OTHER, (q) => q("select * from email_suppressions"))).toHaveLength(0);
    await expect(asUser(db, OTHER, (q) => q("insert into email_suppressions(tenant_id, email, reason) values ($1,'a@b.iq','manual')", [tenant]))).rejects.toThrow(/row-level security/);
  });

  it("an empty tenant can be deleted (its audit trail goes with it)", async () => {
    const t = await asUser(db, OTHER, async (q) => (await q<{ id: string }>("select app.create_tenant('Spare','spare-x','solar-energy',1,$1::jsonb) as id", [STAGES]))[0]!.id, { commit: true });
    await asWorker(() => db.query("delete from tenants where id=$1", [t]));
    expect((await db.query("select 1 from tenants where id=$1", [t])).rows).toHaveLength(0);
    expect((await db.query("select 1 from audit_log where tenant_id=$1", [t])).rows).toHaveLength(0);
  });

  it("member profiles: everyone edits only their own, colleagues can read, other tenants see nothing", async () => {
    await asUser(db, SALES, (q) => q("insert into member_profiles(tenant_id, user_id, sender_name, signature) values ($1,$2,'Ali','م. علي')", [tenant, SALES]), { commit: true });
    await expect(asUser(db, SALES, (q) => q("insert into member_profiles(tenant_id, user_id, sender_name) values ($1,$2,'fake')", [tenant, OWNER]))).rejects.toThrow(/row-level security/);
    const upd = await asUser(db, OWNER, (q) => q("update member_profiles set sender_name='hijack' where user_id=$1 returning 1", [SALES]));
    expect(upd).toHaveLength(0);
    expect(await asUser(db, OWNER, (q) => q("select sender_name from member_profiles"))).toEqual([{ sender_name: "Ali" }]);
    expect(await asUser(db, OTHER, (q) => q("select * from member_profiles"))).toHaveLength(0);
  });

  it("the cron schedule is registered", async () => {
    const j = await db.query<{ schedule: string }>("select schedule from cron.jobs where name='agent-worker-tick'");
    expect(j.rows[0]!.schedule).toBe("* * * * *");
  });
});
