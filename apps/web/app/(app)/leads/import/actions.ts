"use server";

import { revalidatePath } from "next/cache";
import { parseCsv, prepareImport, scoreCompany, type ImportResult } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";

const MAX_BYTES = 5_000_000;
const MAX_ROWS = 5_000;

export interface Preview {
  ok: true;
  total: number;
  ready: { row: number; name: string; governorate: string | null; phone: string | null; warnings: string[] }[];
  readyCount: number;
  duplicates: { row: number; name: string; on: string[]; existing: boolean }[];
  errors: ImportResult["errors"];
  detected: string[];
}
type Failure = { ok: false; message: string };

async function prepare(text: string): Promise<{ result: ImportResult; total: number } | Failure> {
  if (text.length > MAX_BYTES) return { ok: false, message: "file_too_large" };
  const rows = parseCsv(text);
  if (rows.length - 1 > MAX_ROWS) return { ok: false, message: "too_many_rows" };
  const ctx = await getContext();
  const sb = await supabaseServer();
  const { data: existing, error } = await sb.from("companies").select("id, name_normalized, governorate, phone, website").eq("tenant_id", ctx.tenant.id).limit(50_000);
  if (error) return { ok: false, message: error.message };
  return { result: prepareImport(rows, existing ?? []), total: Math.max(0, rows.length - 1) };
}

export async function previewImport(text: string): Promise<Preview | Failure> {
  const p = await prepare(text);
  if ("ok" in p) return p;
  const { result, total } = p;
  return {
    ok: true,
    total,
    readyCount: result.ready.length,
    ready: result.ready.slice(0, 25).map((l) => ({ row: l.row, name: l.name, governorate: l.governorate, phone: l.phone, warnings: l.warnings })),
    duplicates: result.duplicates.map((d) => ({ row: d.lead.row, name: d.lead.name, on: [...new Set(d.matches.map((m) => m.on))], existing: d.matches.some((m) => m.kind === "existing") })),
    errors: result.errors,
    detected: Object.keys(result.columns),
  };
}

export async function importLeads(text: string, fileName: string): Promise<{ ok: true; imported: number } | Failure> {
  const p = await prepare(text);
  if ("ok" in p) return p;
  const ctx = await getContext();
  const sb = await supabaseServer();
  const leads = p.result.ready;
  let imported = 0;

  for (let i = 0; i < leads.length; i += 500) {
    const chunk = leads.slice(i, i + 500);
    const rows = chunk.map((l) => ({
      tenant_id: ctx.tenant.id,
      name: l.name,
      name_normalized: l.name_normalized,
      industry: l.industry,
      governorate: l.governorate,
      city: l.city,
      district: l.district,
      website: l.website,
      phone: l.phone,
      email: l.email,
      description: l.description,
      source_type: "csv_import",
      source_ref: `${fileName.slice(0, 120)}#row${l.row}`,
      fit_score: scoreCompany(ctx.config, l).normalized,
      owner_id: ctx.userId,
    }));
    const { data: inserted, error } = await sb.from("companies").insert(rows).select("id, source_ref");
    if (error) return { ok: false, message: error.message };

    const byRef = new Map(inserted.map((r) => [r.source_ref, r.id]));
    const contacts = chunk
      .filter((l) => l.contact_name)
      .map((l) => ({
        tenant_id: ctx.tenant.id,
        company_id: byRef.get(`${fileName.slice(0, 120)}#row${l.row}`),
        full_name: l.contact_name,
        job_title: l.contact_title,
        phone: l.phone,
        email: l.email,
      }));
    if (contacts.length) {
      const { error: ce } = await sb.from("contacts").insert(contacts);
      if (ce) return { ok: false, message: ce.message };
    }
    await sb.from("activities").insert(inserted.map((r) => ({ tenant_id: ctx.tenant.id, type: "lead.imported", company_id: r.id, actor_id: ctx.userId, payload: { source: "csv_import" } })));
    imported += inserted.length;
  }
  revalidatePath("/leads");
  revalidatePath("/");
  return { ok: true, imported };
}
