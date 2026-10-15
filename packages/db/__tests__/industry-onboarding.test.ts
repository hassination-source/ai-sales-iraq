import { describe, expect, it } from "vitest";
import { getPack, resolveConfig, toPipelineStages } from "@ais/core";
import { asUser, createUser, freshDb } from "./harness";

describe("onboarding with real industry packs", () => {
  it("solar and auto-parts tenants get their own pipelines from the same core", async () => {
    const db = await freshDb();
    const users = { solar: "00000000-0000-4000-8000-000000000051", auto: "00000000-0000-4000-8000-000000000052" };
    await createUser(db, users.solar);
    await createUser(db, users.auto);

    const ids: Record<string, string> = {};
    for (const [who, packId] of [["solar", "solar-energy"], ["auto", "auto-parts"]] as const) {
      const pack = getPack(packId);
      const cfg = resolveConfig(pack, { territories: ["IQ-BG"] });
      ids[who] = await asUser(
        db,
        users[who],
        async (q) => (await q<{ id: string }>("select app.create_tenant($1,$2,$3,$4,$5::jsonb) as id", [`${who} co`, `${who}-co`, pack.id, pack.version, JSON.stringify(toPipelineStages(cfg))]))[0]!.id,
        { commit: true },
      );
    }

    const keys = async (t: string) => (await db.query<{ key: string }>("select key from pipeline_stages where tenant_id=$1 order by position", [t])).rows.map((r) => r.key);
    expect(await keys(ids.solar!)).toEqual(getPack("solar-energy").stages.map((s) => s.key));
    expect(await keys(ids.auto!)).toEqual(getPack("auto-parts").stages.map((s) => s.key));

    const won = await db.query("select kind from pipeline_stages where tenant_id=$1 and key='account_opened'", [ids.auto]);
    expect(won.rows[0]).toMatchObject({ kind: "won" });

    // each owner sees only their own pipeline
    const seen = await asUser(db, users.auto, (q) => q<{ tenant_id: string }>("select distinct tenant_id from pipeline_stages"));
    expect(seen.map((r) => r.tenant_id)).toEqual([ids.auto]);
  }, 60_000);
});
