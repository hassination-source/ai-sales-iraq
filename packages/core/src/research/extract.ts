import { normalizeIraqiPhone } from "../leads/import";

/**
 * Facts extracted from a company's own website. Everything here is what the
 * page literally says — no inference. The page is untrusted input: it is only
 * ever passed to the AI inside a clearly delimited data block.
 */
export interface WebsiteFacts {
  url: string;
  title: string | null;
  description: string | null;
  /** readable text, whitespace-collapsed, capped */
  text: string;
  emails: string[];
  phones: string[];
  language: string | null;
}

const MAX_TEXT = 4000;

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const clean = (s: string | null | undefined) => {
  const v = s ? decodeEntities(s).replace(/\s+/g, " ").trim() : "";
  return v || null;
};

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return clean(tag?.match(/content=["']([^"']*)["']/i)?.[1]);
}

export function extractFacts(url: string, html: string): WebsiteFacts {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ");
  const title = clean(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = meta(body, "description") ?? meta(body, "og:description");
  const language = body.match(/<html[^>]+lang=["']([a-zA-Z-]+)["']/i)?.[1] ?? null;
  const text = (clean(body.replace(/<[^>]+>/g, " ")) ?? "").slice(0, MAX_TEXT);

  const mailtos = [...body.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]!));
  const inline = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const emails = [...new Set([...mailtos, ...inline].map((e) => e.toLowerCase()).filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/.test(e)))].slice(0, 5);

  const telLinks = [...body.matchAll(/tel:([+\d\s()-]{7,})/gi)].map((m) => m[1]!);
  const textPhones = text.match(/(?:\+|00)?964[\s-]?\d[\d\s-]{7,12}|0?7[3-9]\d[\s-]?\d{3}[\s-]?\d{4}/g) ?? [];
  const phones = [...new Set([...telLinks, ...textPhones].map((p) => normalizeIraqiPhone(p)).filter((p): p is string => !!p))].slice(0, 5);

  return { url, title, description, text, emails, phones, language };
}

/** Only fetch ordinary public web pages: blocks private/loopback hosts and non-http(s) schemes (SSRF guard). */
export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.port && !["80", "443"].includes(u.port)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return false; // raw IPs
  return h.includes(".");
}
