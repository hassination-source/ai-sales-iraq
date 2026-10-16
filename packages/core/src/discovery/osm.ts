import { z } from "zod";
import { normalizeCompanyName, normalizeIraqiPhone, normalizeWebsite } from "../leads/import";
import { GOVERNORATES } from "../geo";

/**
 * OpenStreetMap discovery. OSM data is © OpenStreetMap contributors and licensed
 * under the ODbL: it may be stored and reused with attribution, which is why it is
 * the default discovery source (Google Places content may not be stored).
 */

/** One tag condition. `value` omitted = tag present with any value. */
export const OsmTagFilter = z
  .object({
    key: z.string().regex(/^[a-z_:]+$/),
    value: z.string().regex(/^[A-Za-z0-9_|;:-]+$/).optional(),
    /** treat value as a regex alternation (a|b|c) */
    regex: z.boolean().optional(),
  })
  .strict();
export type OsmTagFilter = z.infer<typeof OsmTagFilter>;

const ISO = new Set(GOVERNORATES.map((g) => g.code));
// Halabja uses an internal code; in OSM it is mapped under its own admin boundary name.
const OSM_AREA: Record<string, string> = { "IQ-HAL": 'area["name:en"="Halabja Governorate"]' };

function areaSelector(gov: string): string {
  if (!ISO.has(gov)) throw new Error(`unknown governorate ${gov}`);
  return OSM_AREA[gov] ?? `area["ISO3166-2"="${gov}"]`;
}

/** Build an Overpass QL query for named features matching any filter group inside a governorate. */
export function buildOverpassQuery(gov: string, groups: OsmTagFilter[][], limit = 200): string {
  if (groups.length === 0) throw new Error("no filters");
  const statements = groups.map((group) => {
    const conds = group
      .map((f) => {
        const k = JSON.stringify(f.key);
        if (f.value === undefined) return `[${k}]`;
        return f.regex ? `[${k}~"^(${f.value})$"]` : `[${k}=${JSON.stringify(f.value)}]`;
      })
      .join("");
    return `nwr(area.a)${conds}["name"];`;
  });
  return `[out:json][timeout:25];${areaSelector(gov)}->.a;(${statements.join("")});out tags center ${Math.max(1, Math.min(limit, 500))};`;
}

const Element = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  tags: z.record(z.string()).default({}),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
});
const Response = z.object({ elements: z.array(z.unknown()) });

export interface DiscoveredCompany {
  name: string;
  name_normalized: string;
  name_en: string | null;
  governorate: string;
  city: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  source_url: string;
  source_ref: string;
  lat: number | null;
  lon: number | null;
  tags: Record<string, string>;
}

const first = (tags: Record<string, string>, keys: string[]) => {
  for (const k of keys) if (tags[k]?.trim()) return tags[k]!.split(";")[0]!.trim();
  return null;
};

/** Parse an Overpass response into companies. Elements that fail validation are skipped, never guessed. */
export function parseOverpass(json: unknown, gov: string): DiscoveredCompany[] {
  const parsed = Response.safeParse(json);
  if (!parsed.success) return [];
  const out: DiscoveredCompany[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.elements) {
    const el = Element.safeParse(raw);
    if (!el.success) continue;
    const t = el.data.tags;
    const name = first(t, ["name:ar", "name", "name:en", "name:ku"]);
    if (!name) continue;
    const ref = `osm:${el.data.type}/${el.data.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const email = first(t, ["email", "contact:email"]);
    out.push({
      name,
      name_normalized: normalizeCompanyName(name),
      name_en: t["name:en"] && t["name:en"] !== name ? t["name:en"] : null,
      governorate: gov,
      city: first(t, ["addr:city", "is_in:city"]),
      phone: normalizeIraqiPhone(first(t, ["phone", "contact:phone", "mobile", "contact:mobile"])),
      website: normalizeWebsite(first(t, ["website", "contact:website", "url"])),
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email.toLowerCase() : null,
      source_url: `https://www.openstreetmap.org/${el.data.type}/${el.data.id}`,
      source_ref: ref,
      lat: el.data.lat ?? el.data.center?.lat ?? null,
      lon: el.data.lon ?? el.data.center?.lon ?? null,
      tags: t,
    });
  }
  return out;
}
