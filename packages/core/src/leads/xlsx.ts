/**
 * Minimal, dependency-free reader for the first worksheet of an .xlsx file, from its XML parts.
 * Tolerant of what different writers produce: namespace prefixes (<x:c>), shared, inline and
 * formula strings, empty typed cells (<c t="str"/>), rich-text runs and gaps in the columns.
 * Unzipping is the caller's job (browser or server), so this stays pure and testable.
 */

export interface XlsxParts {
  workbook?: string; // xl/workbook.xml
  workbookRels?: string; // xl/_rels/workbook.xml.rels
  sharedStrings?: string; // xl/sharedStrings.xml
  sheets: Record<string, string>; // path -> xml, e.g. "xl/worksheets/sheet1.xml"
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => tag.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`))?.[1];

/** Text of every <t> run inside a fragment (handles rich text with several runs). */
const texts = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1]!)).join("");

export function sharedStringsOf(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)].map((m) => (m[1] ? texts(m[1]) : ""));
}

/** "AB12" -> 27 (0-based column index) */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Path of the first sheet in workbook order, falling back to the first sheet file found. */
export function firstSheetPath(parts: XlsxParts): string | undefined {
  const firstSheet = parts.workbook?.match(/<(?:\w+:)?sheet\s[^>]*>/)?.[0];
  const rid = firstSheet ? attr(firstSheet, "id") : undefined;
  if (rid && parts.workbookRels) {
    for (const m of parts.workbookRels.matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)) {
      if (attr(m[0], "Id") === rid) {
        const target = attr(m[0], "Target") ?? "";
        const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
        if (parts.sheets[path]) return path;
      }
    }
  }
  return Object.keys(parts.sheets).sort()[0];
}

export function readSheetXml(sheetXml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const cellRe = /<(?:\w+:)?c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  for (const rm of sheetXml.matchAll(/<(?:\w+:)?row(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const r = Number(attr(rm[1] ?? "", "r") ?? rows.length + 1);
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(cellRe)) {
      const a = cm[1] ?? "";
      const ref = attr(a, "r");
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = attr(a, "t") ?? "n";
      const inner = cm[2] ?? "";
      const v = inner.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      let value = "";
      if (type === "s") value = v !== undefined ? shared[Number(v)] ?? "" : "";
      else if (type === "inlineStr") value = texts(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else value = v !== undefined ? decode(v) : "";
      row[col] = value.trim();
    }
    rows[r - 1] = Array.from(row, (x) => x ?? "");
  }
  return Array.from(rows, (x) => x ?? []);
}

export function readXlsxParts(parts: XlsxParts): string[][] {
  const path = firstSheetPath(parts);
  if (!path) throw new Error("no worksheet found");
  return readSheetXml(parts.sheets[path]!, sharedStringsOf(parts.sharedStrings));
}
