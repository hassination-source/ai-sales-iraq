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

export type ImportField = "name" | "name_alt" | "industry" | "governorate" | "city" | "district" | "website" | "phone" | "email" | "description" | "contact_name" | "contact_title" | "source_url";

/** Header aliases (Arabic, English, Swedish) recognised automatically. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  name: ["name", "company", "company name", "business", "اسم الشركة", "الشركة", "الاسم", "اسم المنشأة", "företag", "företagsnamn", "namn"],
  name_alt: ["arabic name", "name ar", "name (ar)", "الاسم بالعربي", "الاسم العربي", "arabiskt namn"],
  industry: ["industry", "sector", "category", "القطاع", "النشاط", "الصنف", "kategori", "bransch"],
  governorate: ["governorate", "province", "state", "المحافظة", "المحافظه", "guvernement", "provins"],
  city: ["city", "المدينة", "المدينه", "stad", "ort"],
  district: ["district", "area", "القضاء", "المنطقة", "المنطقه", "الحي", "område"],
  website: ["website", "web", "url", "site", "الموقع", "الموقع الالكتروني", "webbplats", "hemsida"],
  phone: ["phone", "phones", "mobile", "tel", "telephone", "whatsapp", "الهاتف", "رقم الهاتف", "الموبايل", "واتساب", "telefon", "mobil"],
  email: ["email", "e-mail", "mail", "البريد", "البريد الالكتروني", "الايميل", "e-post", "epost", "mejl", "mejladress"],
  description: ["description", "notes", "about", "address", "الوصف", "ملاحظات", "العنوان", "beskrivning", "adress", "adress / verksamhet", "verksamhet"],
  contact_name: ["contact", "contact name", "contact person", "الشخص المسؤول", "اسم المسؤول", "kontaktperson"],
  contact_title: ["title", "job title", "position", "المنصب", "الوظيفة", "titel", "befattning"],
  source_url: ["source", "source url", "المصدر", "källa", "källa (url)", "källa url"],
};

/** Many exported lists start with a title block: the header is the first row that names a company column. */
export function findHeaderRow(rows: string[][], maxScan = 30): number {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) if (detectColumns(rows[i] ?? []).name !== undefined) return i;
  return 0;
}

/** Split a cell holding several values ("a@x.iq; b@y.iq", "+964770… / +964780…"). */
export function splitMulti(v: string | null): string[] {
  return (v ?? "").split(/[;,\n|]|\s\/\s/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Segment whose import keywords start a word in a category/industry value ("Elmaterial" matches
 * "elmaterial", "Hotell" doesn't match "el"). Prefix matching handles Swedish compounds and plurals.
 */
export function matchSegment(segments: { key: string; discovery: { importKeywords: string[] } }[], industry: string | null): string | null {
  if (!industry) return null;
  const n = ` ${normalizeArabic(industry)}`;
  for (const s of segments) if (s.discovery.importKeywords.some((k) => n.includes(` ${normalizeArabic(k)}`))) return s.key;
  return null;
}

export function detectColumns(header: string[]): Partial<Record<ImportField, number>> {
  const map: Partial<Record<ImportField, number>> = {};
  const taken = new Set<number>();
  // exact names first; then a known name followed by a qualifier ("Bransch (katalog)", "Phone (mobile)")
  for (const exact of [true, false]) {
    header.forEach((h, i) => {
      if (taken.has(i)) return;
      const n = normalizeArabic(String(h ?? ""));
      if (!n) return;
      for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ImportField, string[]][]) {
        if (map[field] !== undefined) continue;
        const hit = aliases.some((a) => {
          const k = normalizeArabic(a);
          return exact ? n === k : n.startsWith(`${k} `);
        });
        if (hit) {
          map[field] = i;
          taken.add(i);
          return;
        }
      }
    });
  }
  return map;
}

/* ---------------------------------------------------------------- import pipeline */

export interface NormalizedLead {
  row: number; // 1-based row in the file (header = 1)
  name: string;
  name_normalized: string;
  /** Second-language name from the file (e.g. the Arabic name next to an English one) */
  name_alt: string | null;
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
  /** Further phones and emails listed in the same cell */
  extra_phones: string[];
  extra_emails: string[];
  /** Where the row's data came from, when the file says (http(s) only) */
  source_url: string | null;
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
  email?: string | null;
}

export interface ImportResult {
  ready: NormalizedLead[];
  duplicates: { lead: NormalizedLead; matches: { kind: "file" | "existing"; ref: string; on: "name+governorate" | "phone" | "website" | "email" }[] }[];
  errors: { row: number; message: string }[];
  columns: Partial<Record<ImportField, number>>;
}

export interface ImportOptions {
  /** Used when the file has no governorate (or it's empty), e.g. a list of Baghdad companies */
  defaultGovernorate?: string | null;
}

export function prepareImport(allRows: string[][], existing: ExistingCompanyKey[] = [], columns?: Partial<Record<ImportField, number>>, opts: ImportOptions = {}): ImportResult {
  const headerAt = columns ? 0 : findHeaderRow(allRows);
  const [header, ...body] = allRows.slice(headerAt);
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
  const byNameGov: Index = new Map(), byPhone: Index = new Map(), bySite: Index = new Map(), byEmail: Index = new Map();
  for (const e of existing) {
    byNameGov.set(`${e.name_normalized}|${e.governorate ?? ""}`, e.id);
    if (e.phone) byPhone.set(e.phone, e.id);
    if (e.website) bySite.set(e.website, e.id);
    if (e.email) byEmail.set(e.email.toLowerCase(), e.id);
  }
  const fileNameGov: Index = new Map(), filePhone: Index = new Map(), fileSite: Index = new Map(), fileEmail: Index = new Map();

  body.forEach((r, idx) => {
    if (r.every((c) => !String(c ?? "").trim())) return; // blank line
    const rowNo = headerAt + idx + 2;
    const name = get(r, "name");
    if (!name) {
      result.errors.push({ row: rowNo, message: "missing company name" });
      return;
    }
    const warnings: string[] = [];
    const govRaw = get(r, "governorate") ?? get(r, "city");
    const governorate = matchGovernorate(govRaw) ?? (opts.defaultGovernorate && (!govRaw || !get(r, "governorate")) ? opts.defaultGovernorate : null);
    if (govRaw && !governorate) warnings.push(`governorate "${govRaw}" not recognised`);
    const phoneRaw = get(r, "phone");
    const phones = [...new Set(splitMulti(phoneRaw).map((x) => normalizeIraqiPhone(x)).filter((x): x is string => !!x))];
    const phone = phones[0] ?? null;
    if (phoneRaw && !phone) warnings.push(`phone "${phoneRaw}" is not a valid Iraqi number`);
    const siteRaw = get(r, "website");
    const website = normalizeWebsite(siteRaw);
    if (siteRaw && !website) warnings.push(`website "${siteRaw}" is not a valid URL`);
    const emailRaw = get(r, "email");
    const emails = [...new Set(splitMulti(emailRaw).map((x) => x.toLowerCase()).filter((x) => EMAIL.test(x)))];
    const email = emails[0] ?? null;
    if (emailRaw && !email) warnings.push(`email "${emailRaw}" is not valid`);
    const srcRaw = get(r, "source_url");

    const lead: NormalizedLead = {
      row: rowNo,
      name,
      name_normalized: normalizeCompanyName(name),
      name_alt: get(r, "name_alt"),
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
      extra_phones: phones.slice(1, 6),
      extra_emails: emails.slice(1, 6),
      source_url: srcRaw && /^https?:\/\/[^\s]+$/i.test(srcRaw) ? srcRaw.slice(0, 1000) : null,
      verification_status: "unverified",
      warnings,
    };

    const matches: ImportResult["duplicates"][number]["matches"] = [];
    const ng = `${lead.name_normalized}|${lead.governorate ?? ""}`;
    const check = (idx: Index, key: string | null, kind: "file" | "existing", on: "name+governorate" | "phone" | "website" | "email") => {
      if (key && idx.has(key)) matches.push({ kind, ref: idx.get(key)!, on });
    };
    check(byNameGov, ng, "existing", "name+governorate");
    check(byPhone, phone, "existing", "phone");
    check(bySite, website, "existing", "website");
    check(byEmail, email, "existing", "email");
    check(fileNameGov, ng, "file", "name+governorate");
    check(filePhone, phone, "file", "phone");
    check(fileSite, website, "file", "website");
    check(fileEmail, email, "file", "email");

    if (matches.length) {
      result.duplicates.push({ lead, matches });
      return;
    }
    fileNameGov.set(ng, `row ${rowNo}`);
    if (phone) filePhone.set(phone, `row ${rowNo}`);
    if (website) fileSite.set(website, `row ${rowNo}`);
    if (email) fileEmail.set(email, `row ${rowNo}`);
    result.ready.push(lead);
  });
  return result;
}
