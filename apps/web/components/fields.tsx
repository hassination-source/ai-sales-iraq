import { GOVERNORATES, t as tx, type FieldDef } from "@ais/core";
import type { Lang } from "@/lib/i18n";

/** Form-name prefixes; the page and its server action must use the same one. */
export const COMPANY_PREFIX = "f_";
export const QUAL_PREFIX = "q_";

/**
 * Renders industry-pack fields as form inputs. Every field has an explicit
 * "unknown" state (empty) — unknown is never turned into a default value.
 */
export function PackFields({ fields, values, lang, prefix = "f_" }: { fields: FieldDef[]; values: Record<string, unknown>; lang: Lang; prefix?: string }) {
  const unknown = lang === "ar" ? "غير معروف" : "Unknown";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        const id = prefix + f.key;
        const v = values[f.key];
        const label = (
          <label className="label" htmlFor={id}>
            {tx(f.label, lang)}
            {f.unit && <span className="ms-1 font-normal text-muted">({f.unit})</span>}
          </label>
        );
        if (f.type === "boolean")
          return (
            <div key={f.key}>
              {label}
              <select className="field" id={id} name={id} defaultValue={v === true ? "true" : v === false ? "false" : ""}>
                <option value="">{unknown}</option>
                <option value="true">{lang === "ar" ? "نعم" : "Yes"}</option>
                <option value="false">{lang === "ar" ? "لا" : "No"}</option>
              </select>
            </div>
          );
        if (f.type === "enum" || f.type === "governorate") {
          const options = f.type === "enum" ? f.options!.map((o) => ({ value: o.value, label: tx(o.label, lang) })) : GOVERNORATES.map((g) => ({ value: g.code, label: lang === "ar" ? g.ar : g.en }));
          return (
            <div key={f.key}>
              {label}
              <select className="field" id={id} name={id} defaultValue={typeof v === "string" ? v : ""}>
                <option value="">{unknown}</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          );
        }
        if (f.type === "multi_enum")
          return (
            <fieldset key={f.key}>
              <legend className="label">{tx(f.label, lang)}</legend>
              {f.options!.map((o) => (
                <label key={o.value} className="me-4 inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" name={id} value={o.value} defaultChecked={Array.isArray(v) && v.includes(o.value)} className="accent-lapis" />
                  {tx(o.label, lang)}
                </label>
              ))}
            </fieldset>
          );
        return (
          <div key={f.key}>
            {label}
            <input
              className="field"
              id={id}
              name={id}
              type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
              step={f.type === "number" ? "any" : undefined}
              min={f.min}
              max={f.max}
              defaultValue={v === undefined || v === null ? "" : String(v)}
              placeholder={unknown}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Reads PackFields values from a form. Empty inputs are left out (unknown). */
export function readPackFields(fields: FieldDef[], form: FormData, prefix = "f_"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const name = prefix + f.key;
    if (f.type === "multi_enum") {
      const all = form.getAll(name).map(String).filter(Boolean);
      if (all.length) out[f.key] = all;
      continue;
    }
    const raw = String(form.get(name) ?? "").trim();
    if (raw === "") continue;
    if (f.type === "number") out[f.key] = Number(raw);
    else if (f.type === "boolean") out[f.key] = raw === "true";
    else out[f.key] = raw;
  }
  return out;
}
