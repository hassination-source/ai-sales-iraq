"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { appBaseUrl } from "@/lib/email";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

const Credentials = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8),
});

export async function signIn(formData: FormData) {
  const parsed = Credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect("/login?error=badLogin");
  const sb = await supabaseServer();
  const { error } = await sb.auth.signInWithPassword(parsed.data);
  if (error) redirect("/login?error=badLogin");
  redirect("/");
}

export async function signUp(formData: FormData) {
  const parsed = Credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect("/login?mode=signup&error=weakPassword");
  const sb = await supabaseServer();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await sb.auth.signUp({ ...parsed.data, options: { emailRedirectTo: `${site}/auth/callback` } });
  if (error) redirect(`/login?mode=signup&error=${encodeURIComponent(error.message)}`);
  // With email confirmation on, there is no session until the link is opened.
  if (!data.session) redirect("/login?notice=checkEmail");
  redirect("/onboarding");
}

/** Where the auth callback sends the user after the emailed link (set only by this app, never from a URL). */
const AFTER_AUTH_COOKIE = "after_auth";

/** Email a password-reset link. Always says "sent", so the form can't be used to find out who has an account. */
export async function requestPasswordReset(formData: FormData) {
  const email = z.string().trim().email().safeParse(formData.get("email"));
  if (email.success) {
    const sb = await supabaseServer();
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? appBaseUrl();
    (await cookies()).set(AFTER_AUTH_COOKIE, "/reset-password", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 });
    await sb.auth.resetPasswordForEmail(email.data, { redirectTo: `${site}/auth/callback` });
  }
  redirect("/login?notice=resetSent");
}

/** Set a new password for the signed-in user (reached through the emailed reset link). */
export async function updatePassword(formData: FormData) {
  const pw = String(formData.get("password") ?? "");
  if (pw.length < 8) redirect("/reset-password?error=weak");
  if (pw !== String(formData.get("confirm") ?? "")) redirect("/reset-password?error=mismatch");
  const sb = await supabaseServer();
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) redirect(`/reset-password?error=${encodeURIComponent(error.message)}`);
  redirect("/?notice=passwordChanged");
}
