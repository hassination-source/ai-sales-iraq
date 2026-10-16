"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";

const Doc = z.object({
  kind: z.enum(["company", "product", "pricing", "faq", "policy", "case_study", "other"]),
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().min(10).max(20000),
});
const back: (q: string) => never = (q) => redirect(`/knowledge?${q}`);

export async function saveDoc(docId: string | null, formData: FormData) {
  const ctx = await getContext();
  if (!["owner", "admin", "manager"].includes(ctx.role)) back("error=role");
  const parsed = Doc.safeParse({ kind: formData.get("kind"), title: formData.get("title"), body: formData.get("body") });
  if (!parsed.success) back("error=invalid");
  const sb = await supabaseServer();
  const { error } = docId
    ? await sb.from("knowledge_docs").update(parsed.data).eq("id", docId).eq("tenant_id", ctx.tenant.id)
    : await sb.from("knowledge_docs").insert({ ...parsed.data, tenant_id: ctx.tenant.id, created_by: ctx.userId });
  if (error) back(`error=${encodeURIComponent(error.message)}`);
  revalidatePath("/knowledge");
  revalidatePath("/");
  back("saved=1");
}

export async function setDocStatus(docId: string, status: "active" | "archived") {
  const ctx = await getContext();
  const sb = await supabaseServer();
  await sb.from("knowledge_docs").update({ status }).eq("id", docId).eq("tenant_id", ctx.tenant.id);
  revalidatePath("/knowledge");
}
