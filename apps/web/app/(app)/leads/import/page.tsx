import { GOVERNORATES } from "@ais/core";
import { getContext } from "@/lib/tenant";
import { getLang } from "@/lib/i18n";
import { Importer } from "./importer";

export default async function ImportPage() {
  await getContext();
  const lang = await getLang();
  const ar = lang === "ar";
  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{ar ? "استيراد العملاء المحتملين" : "Import leads"}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          {ar
            ? "نفحص الملف قبل الحفظ: نوحّد أرقام الهواتف العراقية وأسماء المحافظات، ونكشف المكرر داخل الملف ومع عملائك الحاليين. لا يُحفظ شيء حتى تضغط استيراد."
            : "We check the file before saving: Iraqi phone numbers and governorate names are standardised, and duplicates are flagged within the file and against your existing leads. Nothing is saved until you press Import."}
        </p>
        <a href="/sample-leads.csv" download className="mt-2 inline-block text-sm text-lapis hover:underline">
          {ar ? "تنزيل ملف نموذجي" : "Download a sample file"}
        </a>
      </header>
      <Importer lang={lang} governorates={GOVERNORATES.map(({ code, ar: a, en }) => ({ code, ar: a, en }))} />
    </div>
  );
}
