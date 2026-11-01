import type { Db } from "./mission";

export interface SenderProfile {
  sender_name: string | null;
  signature: string | null;
  from_email: string | null;
}

/**
 * Who a message goes out as: the colleague's own profile, falling back field by field to the
 * company-wide settings. `db` is a service-role client; both reads are scoped to `tenantId`.
 */
export async function senderProfile(db: Db, tenantId: string, userId: string | null | undefined): Promise<SenderProfile> {
  const [{ data: company }, { data: mine }] = await Promise.all([
    db.from("agent_settings").select("sender_name, signature, from_email").eq("tenant_id", tenantId).maybeSingle(),
    userId ? db.from("member_profiles").select("sender_name, signature, from_email").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const pick = (k: keyof SenderProfile) => (mine?.[k] as string | null | undefined) || (company?.[k] as string | null | undefined) || null;
  return { sender_name: pick("sender_name"), signature: pick("signature"), from_email: pick("from_email") };
}
