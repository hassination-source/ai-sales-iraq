import { isFetchableUrl } from "@ais/core";

export type Fetch = typeof fetch;

export const USER_AGENT = "ai-sales-iraq-agent/0.1 (+https://ai-sales-iraq.vercel.app)";

/** Overpass servers, tried in rotation. All are public, best-effort services. */
export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** Retry delay for a busy source: 1, 2, 4, 8, 16 min, capped at 30. */
export function backoffMs(attempt: number): number {
  return Math.min(30, 2 ** Math.max(0, attempt - 1)) * 60_000;
}

export type OverpassResult = { ok: true; json: unknown; server: string } | { ok: false; retryable: boolean; error: string; server: string };

export async function runOverpass(query: string, attempt: number, f: Fetch = fetch, timeoutMs = 40_000): Promise<OverpassResult> {
  const server = OVERPASS_MIRRORS[attempt % OVERPASS_MIRRORS.length]!;
  try {
    const res = await f(server, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Accept: "application/json" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, retryable: [429, 500, 502, 503, 504].includes(res.status), error: `HTTP ${res.status}`, server };
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      // Overpass reports query timeouts inside a 200 response
      if (typeof json?.remark === "string" && /timed out|out of memory/i.test(json.remark)) return { ok: false, retryable: true, error: json.remark, server };
      return { ok: true, json, server };
    } catch {
      return { ok: false, retryable: true, error: "response was not JSON", server };
    }
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e), server };
  }
}

const MAX_BYTES = 400_000;

export type PageResult = { ok: true; url: string; html: string } | { ok: false; error: string };

/**
 * Fetch a public web page: http(s) only, no private hosts, redirects re-checked on every hop,
 * HTML only, size and time limited. The page is untrusted data.
 */
export async function fetchPage(start: string, f: Fetch = fetch, timeoutMs = 8_000): Promise<PageResult> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    if (!isFetchableUrl(url)) return { ok: false, error: "blocked address" };
    let res: Response;
    try {
      res = await f(url, { redirect: "manual", headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: `redirect without location (${res.status})` };
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) return { ok: false, error: `not a web page (${type || "unknown type"})` };
    const html = await readCapped(res, MAX_BYTES);
    return { ok: true, url, html };
  }
  return { ok: false, error: "too many redirects" };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}
