import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getPack, resolveConfig, type EffectiveConfig } from "@ais/core";
import { supabaseServer } from "./supabase/server";

export type Role = "owner" | "admin" | "manager" | "salesperson";

export interface TenantContext {
  userId: string;
  email: string | null;
  tenant: { id: string; name: string; default_currency: string };
  role: Role;
  config: EffectiveConfig;
  stages: { id: string; key: string; label: { ar: string; en: string }; position: number; kind: "open" | "won" | "lost"; probability: number | null }[];
  pipelineId: string;
}

/** The signed-in user's company, role and effective industry configuration. Redirects to login/onboarding as needed. */
export const getContext = cache(async (): Promise<TenantContext> => {
  const sb = await supabaseServer();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: membership } = await sb
    .from("tenant_members")
    .select("role, tenant:tenants(id, name, default_currency)")
    .eq("user_id", auth.user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!membership?.tenant) redirect("/onboarding");
  const tenant = membership.tenant as unknown as TenantContext["tenant"];

  const [{ data: cfg }, { data: pipeline }] = await Promise.all([
    sb.from("industry_configs").select("pack_id, pack_version, overrides").eq("tenant_id", tenant.id).single(),
    sb.from("pipelines").select("id, pipeline_stages(id, key, label, position, kind, probability)").eq("tenant_id", tenant.id).eq("is_default", true).single(),
  ]);
  if (!cfg || !pipeline) throw new Error("Company configuration is incomplete");

  const stages = [...((pipeline.pipeline_stages ?? []) as TenantContext["stages"])].sort((a, b) => a.position - b.position);
  return {
    userId: auth.user.id,
    email: auth.user.email ?? null,
    tenant,
    role: membership.role as Role,
    config: resolveConfig(getPack(cfg.pack_id, cfg.pack_version), cfg.overrides),
    stages,
    pipelineId: pipeline.id,
  };
});
