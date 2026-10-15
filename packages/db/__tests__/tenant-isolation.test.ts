import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createUser, freshDb, STAGES } from "./harness";

const A_OWNER = "00000000-0000-4000-8000-00000000000a";
const A_MANAGER = "00000000-0000-4000-8000-0000000000a2";
const A_SALES = "00000000-0000-4000-8000-0000000000a3";
const A_ADMIN = "00000000-0000-4000-8000-0000000000a4";
const B_OWNER = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let tenantA: string;
let tenantB: string;
let companyA: string;
let companyB: string;

async function makeTenant(owner: string, slug: string) {
  return asUser(
    db,
    owner,
    async (q) => (await q<{ id: string }>("select app.create_tenant($1,$2,'solar-energy',1,$3::jsonb) as id", [slug, slug, STAGES]))[0]!.id,
    { commit: true },
  );
}

async function stage(tenant: string, key: string) {
  return (await db.query<{ id: string }>("select id from pipeline_stages where tenant_id=$1 and key=$2", [tenant, key])).rows[0]!.id;
}
async function pipeline(tenant: string) {
  return (await db.query<{ id: string }>("select id from pipelines where tenant_id=$1", [tenant])).rows[0]!.id;
}

beforeAll(async () => {
  db = await freshDb();
  for (const u of [A_OWNER, A_MANAGER, A_SALES, A_ADMIN, B_OWNER]) await createUser(db, u);
  tenantA = await makeTenant(A_OWNER, "sigen-solar");
  tenantB = await makeTenant(B_OWNER, "other-co");

  await asUser(db, A_OWNER, async (q) => {
    await q("insert into tenant_members(tenant_id,user_id,role) values ($1,$2,'manager'),($1,$3,'salesperson'),($1,$4,'admin')", [tenantA, A_MANAGER, A_SALES, A_ADMIN]);
    companyA = (await q<{ id: string }>("insert into companies(tenant_id,name,name_normalized,governorate) values ($1,'مصنع الرافدين','مصنع الرافدين','IQ-BG') returning id", [tenantA]))[0]!.id;
  }, { commit: true });
  await asUser(db, B_OWNER, async (q) => {
    companyB = (await q<{ id: string }>("insert into companies(tenant_id,name,name_normalized) values ($1,'Secret B Co','secret b co') returning id", [tenantB]))[0]!.id;
  }, { commit: true });
}, 60_000);

describe("tenant isolation", () => {
  it("onboarding creates tenant, owner, config and default pipeline", async () => {
    const stages = await db.query("select key from pipeline_stages where tenant_id=$1 order by position", [tenantA]);
    expect(stages.rows.map((r: any) => r.key)).toEqual(["new", "qualified", "won", "lost"]);
    const cfg = await db.query("select pack_id from industry_configs where tenant_id=$1", [tenantA]);
    expect(cfg.rows[0]).toMatchObject({ pack_id: "solar-energy" });
  });

  it("a user cannot read another tenant's rows", async () => {
    const rows = await asUser(db, A_OWNER, (q) => q("select id from companies"));
    expect(rows.map((r: any) => r.id)).toEqual([companyA]);
    const tenants = await asUser(db, A_OWNER, (q) => q("select id from tenants"));
    expect(tenants.map((r: any) => r.id)).toEqual([tenantA]);
  });

  it("a user cannot insert into another tenant", async () => {
    await expect(
      asUser(db, A_OWNER, (q) => q("insert into companies(tenant_id,name,name_normalized) values ($1,'x','x')", [tenantB])),
    ).rejects.toThrow(/row-level security/);
  });

  it("a user cannot update or delete another tenant's rows", async () => {
    const upd = await asUser(db, A_OWNER, (q) => q("update companies set name='hacked' where id=$1 returning id", [companyB]));
    expect(upd).toHaveLength(0);
    const del = await asUser(db, A_OWNER, (q) => q("delete from companies where id=$1 returning id", [companyB]));
    expect(del).toHaveLength(0);
    const still = await db.query("select name from companies where id=$1", [companyB]);
    expect(still.rows[0]).toMatchObject({ name: "Secret B Co" });
  });

  it("rows cannot reference another tenant's rows (composite FKs)", async () => {
    const [p, s] = [await pipeline(tenantA), await stage(tenantA, "new")];
    await expect(
      asUser(db, A_OWNER, (q) => q("insert into deals(tenant_id,company_id,pipeline_id,stage_id,title) values ($1,$2,$3,$4,'x')", [tenantA, companyB, p, s])),
    ).rejects.toThrow(/foreign key/);
  });

  it("tenant_id is immutable", async () => {
    await expect(
      asUser(db, null as never, async () => {
        await db.exec("reset role");
        await db.query("update companies set tenant_id=$1 where id=$2", [tenantB, companyA]);
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("anonymous users see nothing", async () => {
    await expect(asUser(db, null, (q) => q("select * from companies"))).rejects.toThrow(/permission denied/);
  });

  it("a user who is not a member cannot call into a tenant via helper functions", async () => {
    const r = await asUser(db, B_OWNER, (q) => q<{ m: boolean }>("select app.is_member($1) as m", [tenantA]));
    expect(r[0]!.m).toBe(false);
  });
});

describe("roles and permissions", () => {
  it("salesperson cannot delete companies; manager can", async () => {
    const sales = await asUser(db, A_SALES, (q) => q("delete from companies where id=$1 returning id", [companyA]));
    expect(sales).toHaveLength(0);
    const mgr = await asUser(db, A_MANAGER, (q) => q("delete from companies where id=$1 returning id", [companyA])); // rolled back
    expect(mgr).toHaveLength(1);
  });

  it("salesperson cannot change pipeline configuration", async () => {
    const r = await asUser(db, A_SALES, (q) => q("update pipeline_stages set position=99 where tenant_id=$1 returning id", [tenantA]));
    expect(r).toHaveLength(0);
  });

  it("admin cannot grant the owner role", async () => {
    await expect(
      asUser(db, A_ADMIN, (q) => q("update tenant_members set role='owner' where tenant_id=$1 and user_id=$2", [tenantA, A_SALES])),
    ).rejects.toThrow(/only an owner/);
  });

  it("the last owner cannot be removed", async () => {
    await expect(
      asUser(db, A_OWNER, (q) => q("update tenant_members set role='admin' where tenant_id=$1 and user_id=$2", [tenantA, A_OWNER])),
    ).rejects.toThrow(/at least one owner/);
  });

  it("salesperson cannot read the audit log or usage costs; owner can read audit", async () => {
    expect(await asUser(db, A_SALES, (q) => q("select * from audit_log"))).toHaveLength(0);
    expect(await asUser(db, A_SALES, (q) => q("select * from usage_events"))).toHaveLength(0);
    const owner = await asUser(db, A_OWNER, (q) => q<{ tenant_id: string }>("select tenant_id from audit_log"));
    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it("nobody can write the audit log directly", async () => {
    await expect(
      asUser(db, A_OWNER, (q) => q("insert into audit_log(tenant_id,action,entity_type) values ($1,'x','y')", [tenantA])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("draft approval workflow", () => {
  async function newDraft(user: string, extra = "") {
    return asUser(db, user, async (q) =>
      (await q<{ id: string }>(`insert into message_drafts(tenant_id,company_id,channel,language,body,generated_by,grounding) values ($1,$2,'whatsapp','ar-IQ','مرحبا','claude-opus-5-5','{"sources":[{"type":"kb","id":"doc1"}],"hypotheses":[]}'::jsonb) returning id ${extra}`, [tenantA, companyA]))[0]!.id,
    { commit: true });
  }

  it("AI drafts without grounding are rejected", async () => {
    await expect(
      asUser(db, A_SALES, (q) => q("insert into message_drafts(tenant_id,channel,language,body,generated_by,grounding) values ($1,'email','en','hi','claude-opus-5-5','{}'::jsonb)", [tenantA])),
    ).rejects.toThrow(/grounding/);
  });

  it("salesperson can edit but not approve; manager approves", async () => {
    const id = await newDraft(A_SALES);
    const edited = await asUser(db, A_SALES, (q) => q<{ edited: boolean }>("update message_drafts set body='مرحبا بكم' where id=$1 returning edited", [id]), { commit: true });
    expect(edited[0]!.edited).toBe(true);
    await expect(
      asUser(db, A_SALES, (q) => q("update message_drafts set status='approved' where id=$1", [id])),
    ).rejects.toThrow(/managers or above/);
    const ok = await asUser(db, A_MANAGER, (q) => q<{ reviewed_by: string }>("update message_drafts set status='approved' where id=$1 returning reviewed_by", [id]), { commit: true });
    expect(ok[0]!.reviewed_by).toBe(A_MANAGER);
  });

  it("drafts cannot be sent without approval or edited after approval", async () => {
    const id = await newDraft(A_SALES);
    await expect(asUser(db, A_MANAGER, (q) => q("update message_drafts set status='sent' where id=$1", [id]))).rejects.toThrow(/only approved/);
    await asUser(db, A_MANAGER, (q) => q("update message_drafts set status='approved' where id=$1", [id]), { commit: true });
    await expect(asUser(db, A_SALES, (q) => q("update message_drafts set body='changed' where id=$1", [id]))).rejects.toThrow(/pending review/);
  });
});

describe("pipeline events", () => {
  it("stage changes are recorded as activities and lost deals need a reason", async () => {
    const p = await pipeline(tenantA);
    const [sNew, sLost] = [await stage(tenantA, "new"), await stage(tenantA, "lost")];
    await asUser(db, A_SALES, async (q) => {
      const deal = (await q<{ id: string }>("insert into deals(tenant_id,company_id,pipeline_id,stage_id,title,value_amount,currency) values ($1,$2,$3,$4,'500 kW rooftop',250000,'USD') returning id", [tenantA, companyA, p, sNew]))[0]!.id;
      await expect(q("update deals set stage_id=$1 where id=$2", [sLost, deal])).rejects.toThrow(/lost reason/);
    });
    await asUser(db, A_SALES, async (q) => {
      const deal = (await q<{ id: string }>("insert into deals(tenant_id,company_id,pipeline_id,stage_id,title) values ($1,$2,$3,$4,'x') returning id", [tenantA, companyA, p, sNew]))[0]!.id;
      const closed = await q<{ closed_at: string | null }>("update deals set stage_id=$1, lost_reason='budget' where id=$2 returning closed_at", [sLost, deal]);
      expect(closed[0]!.closed_at).not.toBeNull();
      const acts = await q<{ type: string }>("select type from activities where deal_id=$1 order by occurred_at", [deal]);
      expect(acts.map((a) => a.type)).toEqual(["deal.created", "deal.stage_changed"]);
    });
  });

  it("deal values require a currency", async () => {
    const [p, s] = [await pipeline(tenantA), await stage(tenantA, "new")];
    await expect(
      asUser(db, A_SALES, (q) => q("insert into deals(tenant_id,company_id,pipeline_id,stage_id,title,value_amount) values ($1,$2,$3,$4,'x',100)", [tenantA, companyA, p, s])),
    ).rejects.toThrow(/check constraint/);
  });

  it("verified companies must record when they were verified; web leads must record a source", async () => {
    await expect(asUser(db, A_SALES, (q) => q("insert into companies(tenant_id,name,name_normalized,verification_status) values ($1,'v','v','verified')", [tenantA]))).rejects.toThrow(/check constraint/);
    await expect(asUser(db, A_SALES, (q) => q("insert into companies(tenant_id,name,name_normalized,source_type) values ($1,'w','w','web')", [tenantA]))).rejects.toThrow(/check constraint/);
  });
});
