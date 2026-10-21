"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { parseCsv } from "@ais/core";
import { importLeads, previewImport, type Preview } from "./actions";

/** Read CSV or Excel in the browser into rows of text; the server only ever sees plain cell values. */
async function readRows(f: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(f.name)) {
    const { default: readXlsxFile } = await import("read-excel-file");
    const rows = await readXlsxFile(f);
    return rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
  }
  return parseCsv(await f.text());
}

type Lang = "ar" | "en";
type Gov = { code: string; ar: string; en: string };

const MESSAGES: Record<string, { ar: string; en: string }> = {
  file_too_large: { ar: "الملف أكبر من 5 ميغابايت.", en: "The file is larger than 5 MB." },
  too_many_rows: { ar: "الملف يحتوي أكثر من 5000 صف. قسّمه إلى ملفات أصغر.", en: "The file has more than 5,000 rows. Split it into smaller files." },
  unreadable: { ar: "تعذّرت قراءة الملف. جرّب حفظه بصيغة xlsx أو CSV (UTF-8).", en: "Couldn't read the file. Try saving it as .xlsx or CSV (UTF-8)." },
  old_excel: { ar: "صيغة xls القديمة غير مدعومة. احفظ الملف بصيغة xlsx.", en: "The old .xls format isn't supported. Save the file as .xlsx." },
};
/** Arabic versions of the import checker's messages; English passes through unchanged. */
function localize(msg: string, lang: Lang): string {
  if (lang === "en") return msg;
  const fixed: Record<string, string> = {
    "missing company name": "اسم الشركة مفقود",
    "no company name column found": "لم نجد عموداً لاسم الشركة",
    "file is empty": "الملف فارغ",
  };
  if (fixed[msg]) return fixed[msg]!;
  const m = msg.match(/^(governorate|phone|website|email) "(.*)" (?:not recognised|is not .*)$/);
  if (m) {
    const what = { governorate: "المحافظة", phone: "رقم الهاتف", website: "الموقع", email: "البريد" }[m[1] as "governorate"];
    return `${what} «${m[2]}» غير صالح`;
  }
  return msg;
}

const ON: Record<string, { ar: string; en: string }> = {
  "name+governorate": { ar: "الاسم والمحافظة", en: "name + governorate" },
  phone: { ar: "الهاتف", en: "phone" },
  website: { ar: "الموقع", en: "website" },
};

export function Importer({ lang, governorates }: { lang: Lang; governorates: Gov[] }) {
  const ar = lang === "ar";
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [gov, setGov] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const govName = (c: string | null) => {
    const g = governorates.find((x) => x.code === c);
    return g ? (ar ? g.ar : g.en) : ar ? "غير معروف" : "Unknown";
  };
  const say = (m: string) => setMessage(MESSAGES[m]?.[lang] ?? localize(m, lang));

  async function onFile(f: File | undefined) {
    setPreview(null); setMessage(null); setDone(null);
    if (!f) return;
    if (/\.xls$/i.test(f.name)) { say("old_excel"); return; }
    let rows: string[][];
    try { rows = await readRows(f); } catch { say("unreadable"); return; }
    setFile({ name: f.name, rows });
    check(rows, gov);
  }

  function check(rows: string[][], g: string) {
    start(async () => {
      const r = await previewImport(rows, g || null);
      if (r.ok) setPreview(r); else say(r.message);
    });
  }

  function onImport() {
    if (!file) return;
    start(async () => {
      const r = await importLeads(file.rows, file.name, gov || null);
      if (r.ok) { setDone(r.imported); setPreview(null); } else say(r.message);
    });
  }

  return (
    <div className="space-y-6">
      <label className="block cursor-pointer rounded-lg border-2 border-dashed border-line bg-surface p-8 text-center hover:border-lapis">
        <span className="block font-medium">{file ? file.name : ar ? "اختر ملف Excel أو CSV" : "Choose an Excel or CSV file"}</span>
        <span className="mt-1 block text-sm text-muted">
          {ar ? "الأعمدة المعروفة: اسم الشركة، الفئة، المحافظة، الهاتف، الموقع، البريد، الشخص المسؤول — بالعربي أو الإنكليزي أو السويدي." : "Recognised columns: company name, category, governorate, phone, website, email, contact — in Arabic, English or Swedish."}
        </span>
        <input type="file" accept=".csv,text/csv,.xlsx" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
      </label>

      <div className="max-w-sm">
        <label className="label" htmlFor="default-gov">{ar ? "المحافظة إن لم تُذكر في الملف" : "Governorate when the file doesn't say"}</label>
        <select
          id="default-gov"
          className="field"
          value={gov}
          onChange={(e) => { setGov(e.target.value); if (file) check(file.rows, e.target.value); }}
        >
          <option value="">{ar ? "— غير محددة —" : "— not set —"}</option>
          {governorates.map((g) => <option key={g.code} value={g.code}>{ar ? g.ar : g.en}</option>)}
        </select>
      </div>

      {pending && <p className="note-info">{ar ? "جارٍ الفحص…" : "Checking…"}</p>}
      {message && <p className="note-error">{message}</p>}
      {done !== null && (
        <div className="note-info">
          {ar ? `تم استيراد ${done} شركة.` : `Imported ${done} companies.`}{" "}
          <Link href="/leads" className="font-medium underline">{ar ? "عرض العملاء" : "View leads"}</Link>
        </div>
      )}

      {preview && (
        <section className="space-y-6">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={ar ? "صفوف في الملف" : "Rows in file"} value={preview.total} />
            <Stat label={ar ? "جاهزة للاستيراد" : "Ready to import"} value={preview.readyCount} tone="lapis" />
            <Stat label={ar ? "مكررة (لن تُستورد)" : "Duplicates (skipped)"} value={preview.duplicates.length} />
            <Stat label={ar ? "أخطاء" : "Errors"} value={preview.errors.length} tone={preview.errors.length ? "brick" : undefined} />
          </dl>

          {preview.readyCount > 0 && (
            <div className="flex flex-wrap items-center gap-4">
              <button className="btn-primary" onClick={onImport} disabled={pending}>
                {ar ? `استيراد ${preview.readyCount} شركة` : `Import ${preview.readyCount} companies`}
              </button>
              <p className="text-sm text-muted">{ar ? "تُحفظ كبيانات غير موثّقة مع مصدرها (اسم الملف ورقم الصف)." : "Saved as unverified, with the file name and row as their source."}</p>
            </div>
          )}

          {preview.errors.length > 0 && (
            <Block title={ar ? "صفوف فيها أخطاء" : "Rows with errors"}>
              {preview.errors.map((e) => <li key={e.row}>{ar ? `صف ${e.row}: ` : `Row ${e.row}: `}{localize(e.message, lang)}</li>)}
            </Block>
          )}

          {preview.duplicates.length > 0 && (
            <Block title={ar ? "مكررات" : "Duplicates"}>
              {preview.duplicates.map((d) => (
                <li key={d.row}>
                  {ar ? `صف ${d.row}: ` : `Row ${d.row}: `}<b className="font-medium">{d.name}</b>{ar ? "، " : ", "}
                  {d.existing ? (ar ? "موجودة مسبقاً" : "already in your leads") : ar ? "مكررة داخل الملف" : "repeated in this file"} ({d.on.map((o) => ON[o]?.[lang] ?? o).join(ar ? "، " : ", ")})
                </li>
              ))}
            </Block>
          )}

          {preview.ready.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-sm">
                <caption className="p-3 text-start text-muted">{ar ? "أول 25 صفاً جاهزاً" : "First 25 ready rows"}</caption>
                <tbody>
                  {preview.ready.map((r) => (
                    <tr key={r.row} className="border-t border-line align-top">
                      <td className="px-4 py-2 text-muted tabular-nums">{r.row}</td>
                      <td className="px-4 py-2 font-medium">{r.name}</td>
                      <td className="px-4 py-2">{govName(r.governorate)}</td>
                      <td className="px-4 py-2" dir="ltr">{r.phone ?? "—"}</td>
                      <td className="px-4 py-2 text-brick">{r.warnings.map((w) => localize(w, lang)).join(ar ? "، " : "; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "lapis" | "brick" }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "lapis" ? "text-lapis" : tone === "brick" ? "text-brick" : ""}`}>{value}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-line bg-surface p-4" open>
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm">{children}</ul>
    </details>
  );
}
