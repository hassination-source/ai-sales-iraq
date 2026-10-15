"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { GOVERNORATES, PACKS, resolveConfig, toPipelineStages } from "@ais/core";
import { supabaseServer } from "@/lib/supabase/server";

const Input = z.object({
  name: z.string().trim().min(2).max(200),
  packId: z.enum(Object.keys(PACKS) as [string, ...string[]]),
  currency: z.enum(["USD", "IQD"]),
  territories: z.array(z.enum(GOVERNORATES.map((g) => g.code) as [string, ...string[]])),
});

function slugFor(name: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base.length >= 2 ? base : "co"}-${suffix}`;
}

export async function createCompany(formData: FormData) {
  const parsed = Input.safeParse({
    name: formData.get("name"),
    packId: formData.get("packId"),
    currency: formData.get("currency"),
    territories: formData.getAll("territories"),
  });
  if (!parsed.success) redirect("/onboarding?error=invalid");
  const { name, packId, currency, territories } = parsed.data;

  const pack = PACKS[packId]!;
  const overrides = { territories };
  const cfg = resolveConfig(pack, overrides);

  const sb = await supabaseServer();
  const { data: tenantId, error } = await sb.rpc("create_tenant", {
    p_name: name,
    p_slug: slugFor(name),
    p_pack_id: pack.id,
    p_pack_version: pack.version,
    p_stages: toPipelineStages(cfg),
    p_currency: currency,
  });
  if (error || !tenantId) redirect(`/onboarding?error=${encodeURIComponent(error?.message ?? "failed")}`);

  if (territories.length) {
    const { error: e2 } = await sb.from("industry_configs").update({ overrides }).eq("tenant_id", tenantId);
    if (e2) redirect(`/onboarding?error=${encodeURIComponent(e2.message)}`);
  }
  redirect("/");
}
