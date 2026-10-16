import { NextResponse, type NextRequest } from "next/server";
import { suppress, verifyUnsubscribeToken } from "@ais/agent";
import { supabaseService } from "@/lib/supabase/service";
import { unsubscribeSecret } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe link from outreach emails. Public (no login). GET shows a confirm button, so link
 * scanners in mail filters can't unsubscribe anyone by prefetching; POST records the opt-out
 * (also used by mail clients' one-click "List-Unsubscribe-Post").
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ok = verify(token);
  return page(
    ok
      ? `<h1>إلغاء الاشتراك · Unsubscribe</h1>
         <p>اضغط الزر وسنتوقف عن مراسلة <b dir="ltr">${escape(ok.email)}</b>.</p>
         <p dir="ltr">Press the button and we'll stop emailing <b>${escape(ok.email)}</b>.</p>
         <form method="post"><button>إلغاء الاشتراك · Unsubscribe</button></form>`
      : invalid(),
    ok ? 200 : 400,
  );
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ok = verify(token);
  const db = supabaseService();
  if (!ok || !db) return page(invalid(), 400);
  await suppress(db, ok.tenantId, ok.email, "unsubscribed");
  return page(`<h1>تم · Done</h1><p>لن نراسلكم مجدداً على هذا العنوان.</p><p dir="ltr">You won't receive further emails from us at this address.</p>`);
}

function verify(token: string) {
  const secret = unsubscribeSecret();
  return secret ? verifyUnsubscribeToken(secret, decodeURIComponent(token)) : null;
}

const invalid = () => `<h1>الرابط غير صالح · Invalid link</h1><p>راسلنا بالرد على الرسالة وسنزيل عنوانك.</p><p dir="ltr">Reply to our email and we'll remove your address.</p>`;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(inner: string, status = 200) {
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f6f5f1;color:#1d2433;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{background:#fff;border:1px solid #e3e1da;border-radius:10px;padding:28px;max-width:440px}h1{font-size:20px;margin:0 0 12px}button{font:inherit;background:#1f4e8c;color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}</style>
</head><body><main>${inner}</main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
