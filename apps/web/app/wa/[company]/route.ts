import { NextResponse, type NextRequest } from "next/server";
import { getContext } from "@/lib/tenant";
import { supabaseServer } from "@/lib/supabase/server";
import { whatsappLink } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

/**
 * Opens WhatsApp for a company (optionally with a draft's text) and records that this colleague
 * contacted them, so nobody else in the company messages the same customer again.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ company: string }> }) {
  const ctx = await getContext();
  const { company } = await params;
  const draftId = req.nextUrl.searchParams.get("draft");
  const sb = await supabaseServer();
  const [{ data: c }, { data: d }, { data: settings }] = await Promise.all([
    sb.from("companies").select("id, phone").eq("id", company).eq("tenant_id", ctx.tenant.id).maybeSingle(),
    draftId ? sb.from("message_drafts").select("id, body, sender_user_id").eq("id", draftId).eq("tenant_id", ctx.tenant.id).eq("company_id", company).maybeSingle() : Promise.resolve({ data: null }),
    sb.from("agent_settings").select("signature").eq("tenant_id", ctx.tenant.id).maybeSingle(),
  ]);
  // the draft's body ends with its writer's signature; trim that one, not the company default
  const senderId = (d as { sender_user_id?: string | null } | null)?.sender_user_id;
  const { data: own } = senderId ? await sb.from("member_profiles").select("signature").eq("tenant_id", ctx.tenant.id).eq("user_id", senderId).maybeSingle() : { data: null };
  const link = whatsappLink(c?.phone, d?.body ?? undefined, own?.signature || settings?.signature);
  if (!c || !link) return NextResponse.redirect(new URL(`/leads/${company}?error=no_whatsapp`, req.url));
  await sb.from("activities").insert({ tenant_id: ctx.tenant.id, type: "message.whatsapp", company_id: c.id, actor_id: ctx.userId, payload: { draft_id: d?.id ?? null, phone: c.phone } });
  return NextResponse.redirect(link);
}
