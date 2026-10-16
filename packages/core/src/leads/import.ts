import { matchGovernorate, normalizeArabic } from "../geo";

/* ---------------------------------------------------------------- CSV */

/** RFC 4180 CSV parser: quotes, escaped quotes, CRLF, UTF-8 BOM, auto-detects , ; or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/* ---------------------------------------------------------------- normalization */

// Arabic letters aren't \w in JS regex, so match whole words by whitespace boundaries.
const COMPANY_NOISE = /(?<=^|\s)(شركه|مؤسسه|مجموعه|company|co|corp|corporation|ltd|limited|llc|inc|group|est)(?=\s|$)/g;

/** Key used for duplicate detection. Keeps meaningful words, drops legal-form noise. */
export function normalizeCompanyName(name: string): string {
  const n = normalizeArabic(name);
  const stripped = n.replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();
  return stripped || n;
}

/**
 * Normalize Iraqi phone numbers to E.164 (+964…). Returns null when the
 * input isn't a plausible Iraqi number — it is never "fixed up" by guessing.
 * Mobile: 07XX XXX XXXX → +9647XXXXXXXXX. Landline Baghdad 01 XXX XXXX → +9641XXXXXXX.
 */
export function normalizeIraqiPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = normalizeArabic(input).replace(/\D/g, "");
  if (d.startsWith("00964")) d = d.slice(5);
  else if (d.startsWith("964")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  if (/^7[3-9]\d{8}$/.test(d)) return `+964${d}`; // mobile
  if (/^[1-6]\d{6,8}$/.test(d)) return `+964${d}`; // landline
  return null;
}

/** Hosts that are never a company's own website (social pages, webmail, link shorteners). */
export const SOCIAL_OR_WEBMAIL = /(^|\.)(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|facebook\.com|fb\.com|fb\.me|instagram\.com|tiktok\.com|twitter\.com|x\.com|t\.me|wa\.me|whatsapp\.com|youtube\.com|linkedin\.com|google\.com|goo\.gl|linktr\.ee)$/i;

export function normalizeWebsite(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  if (input.includes("@")) return null; // an email address typed into a website field
  if (SOCIAL_OR_WEBMAIL.test(input.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "")) return null; // not the company's own site
  try {
    const u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    if (!u.hostname.includes(".")) return null;
    return `https://${u.hostname.replace(/^www\./, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------------------------------------------------------------- column mapping */

export type ImportField = "name" | "industry" | "governorate" | "city" | "district" | "website" | "phone" | "email" | "description" | "contact_name" | "contact_title";

/** Header aliases (Arabic + English) recognised automatically. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  name: ["name", "company", "company name", "business", "اسم الشركة", "الشركة", "الاسم", "اسم المنشأة"],
  industry: ["industry", "sector", "category", "القطاع", "النشاط", "الصنف"],
  governorate: ["governorate", "province", "state", "المحافظة", "المحافظه"],
  city: ["city", "المدينة", "المدينه"],
  district: ["district", "area", "القضاء", "المنطقة", "المنطقه", "الحي"],
  website: ["website", "web", "url", "site", "الموقع", "الموقع الالكتروني"],
  phone: ["phone", "mobile", "tel", "telephone", "whatsapp", "الهاتف", "رقم الهاتف", "الموبايل", "واتساب"],
  email: ["email", "e-mail", "mail", "البريد", "البريد الالكتروني", "الايميل"],
  description: ["description", "notes", "about", "الوصف", "ملاحظات"],
  contact_name: ["contact", "contact name", "contact person", "الشخص المسؤول", "اسم المسؤول"],
  contact_title: ["title", "job title", "position", "المنصب", "الوظيفة"],
};

export function detectColumns(header: string[]): Partial<Record<ImportField, number>> {
  const map: Partial<Record<ImportField, number>> = {};
  header.forEach((h, i) => {
    const n = normalizeArabic(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ImportField, string[]][]) {
      if (map[field] === undefined && aliases.some((a) => normalizeArabic(a) === n)) map[field] = i;
    }
  });
  return map;
}

/* ---------------------------------------------------------------- import pipeline */

export interface NormalizedLead {
  row: number; // 1-based row in the file (header = 1)
  name: string;
  name_normalized: string;
  industry: string | null;
  governorate: string | null;
  governorate_raw: string | null;
  city: string | null;
  district: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  contact_name: string | null;
  contact_title: string | null;
  /** Imported data is never treated as verified */
  verification_status: "unverified";
  warnings: string[];
}

export interface ExistingCompanyKey {
  id: string;
  name_normalized: string;
  governorate: string | null;
  phone: string | null;
  website: string | null;
}

export interface ImportResult {
  ready: NormalizedLead[];
  duplicates: { lead: NormalizedLead; matches: { kind: "file" | "existing"; ref: string; on: "name+governorate" | "phone" | "website" }[] }[];
  errors: { row: number; message: string }[];
  columns: Partial<Record<ImportField, number>>;
}

export function prepareImport(rows: string[][], existing: ExistingCompanyKey[] = [], columns?: Partial<Record<ImportField, number>>): ImportResult {
  const [header, ...body] = rows;
  const result: ImportResult = { ready: [], duplicates: [], errors: [], columns: {} };
  if (!header) {
    result.errors.push({ row: 0, message: "file is empty" });
    return result;
  }
  const cols = columns ?? detectColumns(header);
  result.columns = cols;
  if (cols.name === undefined) {
    result.errors.push({ row: 1, message: "no company name column found" });
    return result;
  }
  const get = (r: string[], f: ImportField) => {
    const i = cols[f];
    const v = i === undefined ? "" : (r[i] ?? "").trim();
    return v === "" ? null : v;
  };

  type Index = Map<string, string>;
  const byNameGov: Index = new Map(), byPhone: Index = new Map(), bySite: Index = new Map();
  for (const e of existing) {
    byNameGov.set(`${e.name_normalized}|${e.governorate ?? ""}`, e.id);
    if (e.phone) byPhone.set(e.phone, e.id);
    if (e.website) bySite.set(e.website, e.id);
  }
  const fileNameGov: Index = new Map(), filePhone: Index = new Map(), fileSite: Index = new Map();

  body.forEach((r, idx) => {
    const rowNo = idx + 2;
    const name = get(r, "name");
    if (!name) {
      result.errors.push({ row: rowNo, message: "missing company name" });
      return;
    }
    const warnings: string[] = [];
    const govRaw = get(r, "governorate") ?? get(r, "city");
    const governorate = matchGovernorate(govRaw);
    if (govRaw && !governorate) warnings.push(`governorate "${govRaw}" not recognised`);
    const phoneRaw = get(r, "phone");
    const phone = normalizeIraqiPhone(phoneRaw);
    if (phoneRaw && !phone) warnings.push(`phone "${phoneRaw}" is not a valid Iraqi number`);
    const siteRaw = get(r, "website");
    const website = normalizeWebsite(siteRaw);
    if (siteRaw && !website) warnings.push(`website "${siteRaw}" is not a valid URL`);
    const emailRaw = get(r, "email");
    const email = emailRaw && EMAIL.test(emailRaw) ? emailRaw.toLowerCase() : null;
    if (emailRaw && !email) warnings.push(`email "${emailRaw}" is not valid`);

    const lead: NormalizedLead = {
      row: rowNo,
      name,
      name_normalized: normalizeCompanyName(name),
      industry: get(r, "industry"),
      governorate,
      governorate_raw: govRaw,
      city: get(r, "city"),
      district: get(r, "district"),
      website,
      phone,
      email,
      description: get(r, "description"),
      contact_name: get(r, "contact_name"),
      contact_title: get(r, "contact_title"),
      verification_status: "unverified",
      warnings,
    };

    const matches: ImportResult["duplicates"][number]["matches"] = [];
    const ng = `${lead.name_normalized}|${lead.governorate ?? ""}`;
    const check = (idx: Index, key: string | null, kind: "file" | "existing", on: "name+governorate" | "phone" | "website") => {
      if (key && idx.has(key)) matches.push({ kind, ref: idx.get(key)!, on });
    };
    check(byNameGov, ng, "existing", "name+governorate");
    check(byPhone, phone, "existing", "phone");
    check(bySite, website, "existing", "website");
    check(fileNameGov, ng, "file", "name+governorate");
    check(filePhone, phone, "file", "phone");
    check(fileSite, website, "file", "website");

    if (matches.length) {
      result.duplicates.push({ lead, matches });
      return;
    }
    fileNameGov.set(ng, `row ${rowNo}`);
    if (phone) filePhone.set(phone, `row ${rowNo}`);
    if (website) fileSite.set(website, `row ${rowNo}`);
    result.ready.push(lead);
  });
  return result;
}
