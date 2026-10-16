import "server-only";
import { createHmac } from "node:crypto";
import type { EmailConfig } from "@ais/agent";

/** Public URL of this deployment, for links inside emails. */
export function appBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "https://ai-sales-iraq.vercel.app";
}

/** Signing key for unsubscribe links: its own env var, or derived from the service key (never sent anywhere). */
export function unsubscribeSecret(): string | null {
  if (process.env.UNSUBSCRIBE_SECRET) return process.env.UNSUBSCRIBE_SECRET;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  return base ? createHmac("sha256", base).update("ai-sales-iraq/unsubscribe/v1").digest("base64url") : null;
}

/** Null until a Resend key is configured: approving then only marks the draft approved. */
export function emailConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const secret = unsubscribeSecret();
  if (!apiKey || !secret) return null;
  return { apiKey, secret, from: process.env.EMAIL_FROM ?? "Sigen Solar Energy <sales@sigensol.com>", baseUrl: appBaseUrl() };
}
