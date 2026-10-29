import { getLang } from "@/lib/i18n";
import { updatePassword } from "../login/actions";

/** New-password form, reached from the emailed reset link (the link signs the user in first). */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ar = (await getLang()) === "ar";
  const errors: Record<string, [string, string]> = {
    weak: ["كلمة المرور يجب أن تكون 8 أحرف على الأقل.", "The password must be at least 8 characters."],
    mismatch: ["كلمتا المرور غير متطابقتين.", "The passwords don't match."],
  };
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">{ar ? "كلمة مرور جديدة" : "New password"}</h1>
        {sp.error && <p className="note-error mt-4">{errors[sp.error]?.[ar ? 0 : 1] ?? sp.error}</p>}
        <form action={updatePassword} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="password">{ar ? "كلمة المرور الجديدة" : "New password"}</label>
            <input className="field" id="password" name="password" type="password" minLength={8} autoComplete="new-password" required dir="ltr" />
          </div>
          <div>
            <label className="label" htmlFor="confirm">{ar ? "أعد كتابتها" : "Repeat it"}</label>
            <input className="field" id="confirm" name="confirm" type="password" minLength={8} autoComplete="new-password" required dir="ltr" />
          </div>
          <button className="btn-primary w-full">{ar ? "احفظ كلمة المرور" : "Save password"}</button>
        </form>
      </div>
    </main>
  );
}
