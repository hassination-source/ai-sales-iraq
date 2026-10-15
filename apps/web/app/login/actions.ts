"use server";

import { redirect } from "next/navigation";
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
