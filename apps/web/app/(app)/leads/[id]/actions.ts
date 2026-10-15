"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { GOVERNORATES, schemaFor, scoreCompany } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { readPackFields } from "@/components/fields";

const Gov = z.enum(GOVERNORATES.map((g) => g.code) as [string, ...string[]]).nullable();

export async function updateLeadFacts(companyId: string, formData: FormData) {
  const ctx = await getContext();
  const attributes = readPackFields(ctx.config.companyFields, formData);
  const parsed = schemaFor(ctx.config.companyFields).safeParse(attributes);
  const gov = Gov.safeParse((formData.get("governorate") as string) || null);
  if (!parsed.success || !gov.success) redirect(`/leads/${companyId}?error=invalid`);

  const sb = await supabaseServer();
  const { data: company } = await sb.from("companies").select("phone, website, email, industry, subindustry, city, verification_status").eq("id", companyId).single();
  if (!company) redirect("/leads");
  const score = scoreCompany(ctx.config, { ...company, governorate: gov.data, attributes: parsed.data });
  const { error } = await sb.from("companies").update({ attributes: parsed.data, governorate: gov.data, fit_score: score.normalized }).eq("id", companyId);
  if (error) redirect(`/leads/${companyId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/leads/${companyId}`);
  redirect(`/leads/${companyId}?saved=1`);
}

const NewDeal = z.object({
  title: z.string().trim().min(2).max(200),
  value: z.union([z.literal(""), z.coerce.number().nonnegative()]),
  currency: z.enum(["USD", "IQD"]),
});

export async function createDeal(companyId: string, formData: FormData) {
  const ctx = await getContext();
  const parsed = NewDeal.safeParse({ title: formData.get("title"), value: formData.get("value") ?? "", currency: formData.get("currency") });
  if (!parsed.success) redirect(`/leads/${companyId}?error=invalid`);
  const first = ctx.stages.find((s) => s.kind === "open");
  if (!first) redirect(`/leads/${companyId}?error=no_stage`);

  const sb = await supabaseServer();
  const value = parsed.data.value === "" ? null : parsed.data.value;
  const { data, error } = await sb
    .from("deals")
    .insert({
      tenant_id: ctx.tenant.id,
      company_id: companyId,
      pipeline_id: ctx.pipelineId,
      stage_id: first.id,
      title: parsed.data.title,
      value_amount: value,
      currency: value === null ? null : parsed.data.currency,
      owner_id: ctx.userId,
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/leads/${companyId}?error=${encodeURIComponent(error?.message ?? "failed")}`);
  revalidatePath("/pipeline");
  redirect(`/deals/${data.id}`);
}
