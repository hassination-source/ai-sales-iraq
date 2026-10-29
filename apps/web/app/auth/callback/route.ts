import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** Email-confirmation landing: exchanges the one-time code for a session. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const jar = await cookies();
  // a password-reset link lands on the new-password form; only this fixed path is honoured
  const resetting = jar.get("after_auth")?.value === "/reset-password";
  const to = new URL(resetting ? "/reset-password" : "/onboarding", request.url);
  if (!code) return NextResponse.redirect(new URL("/login?error=badLogin", request.url));
  const sb = await supabaseServer();
  const { error } = await sb.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, request.url));
  const res = NextResponse.redirect(to);
  if (resetting) res.cookies.delete("after_auth");
  return res;
}
