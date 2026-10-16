import { z } from "zod";
import { GOVERNORATES, normalizeArabic } from "../geo";
import { normalizeCompanyName, normalizeIraqiPhone, normalizeWebsite } from "../leads/import";
import type { LocalizedText } from "../i18n";
import { looksPrivate, type DiscoveredCompany } from "./osm";

/**
 * Google Places API (New) — Text Search.
 * Terms: Google content may not be cached long-term (place IDs may be kept indefinitely).
 * Records from Google carry `data_expires_at`; see docs for the refresh policy.
 */

export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.location",
  "nextPageToken",
].join(",");

export function buildPlacesQuery(term: LocalizedText, governorate: string, pageToken?: string) {
  const g = GOVERNORATES.find((x) => x.code === governorate);
  if (!g) throw new Error(`unknown governorate ${governorate}`);
  return {
    textQuery: `${term.ar} في ${g.ar}`,
    languageCode: "ar",
    regionCode: "IQ",
    pageSize: 20,
    ...(pageToken ? { pageToken } : {}),
  };
}

const Place = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  websiteUri: z.string().optional(),
  googleMapsUri: z.string().optional(),
  types: z.array(z.string()).default([]),
  primaryType: z.string().optional(),
  businessStatus: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
});
const PlacesResponse = z.object({ places: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });

export interface GooglePlacesPage {
  companies: (DiscoveredCompany & { social: string[]; types: string[] })[];
  nextPageToken: string | null;
  skipped: { closed: number; otherGovernorate: number; private: number };
}

/** True when the address clearly names a different governorate than the one searched. */
function inOtherGovernorate(address: string, gov: string): boolean {
  const a = normalizeArabic(address);
  const mentioned = GOVERNORATES.filter((g) => [g.ar, g.en, ...g.aliases].some((n) => a.includes(normalizeArabic(n))));
  return mentioned.length > 0 && !mentioned.some((g) => g.code === gov);
}

const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|tiktok\.com|t\.me|wa\.me|linkedin\.com|x\.com|twitter\.com)$/i;

export function parsePlaces(json: unknown, gov: string): GooglePlacesPage {
  const out: GooglePlacesPage = { companies: [], nextPageToken: null, skipped: { closed: 0, otherGovernorate: 0, private: 0 } };
  const parsed = PlacesResponse.safeParse(json);
  if (!parsed.success) return out;
  out.nextPageToken = parsed.data.nextPageToken ?? null;
  for (const raw of parsed.data.places) {
    const p = Place.safeParse(raw);
    if (!p.success) continue;
    const pl = p.data;
    const name = pl.displayName?.text?.trim();
    if (!name) continue;
    if (pl.businessStatus && pl.businessStatus !== "OPERATIONAL") {
      out.skipped.closed++;
      continue;
    }
    if (pl.formattedAddress && inOtherGovernorate(pl.formattedAddress, gov)) {
      out.skipped.otherGovernorate++;
      continue;
    }
    const homeLike = pl.types.some((t) => ["premise", "street_address", "subpremise"].includes(t)) && !pl.primaryType;
    if (homeLike || looksPrivate(name, {})) {
      out.skipped.private++;
      continue;
    }
    let host = "";
    try {
      host = pl.websiteUri ? new URL(pl.websiteUri).hostname : "";
    } catch {
      host = "";
    }
    const social = pl.websiteUri && SOCIAL.test(host) ? [pl.websiteUri] : [];
    out.companies.push({
      name,
      name_normalized: normalizeCompanyName(name),
      name_en: null,
      governorate: gov,
      city: null,
      phone: normalizeIraqiPhone(pl.internationalPhoneNumber ?? pl.nationalPhoneNumber),
      website: social.length ? null : normalizeWebsite(pl.websiteUri),
      email: null,
      source_url: pl.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${pl.id}`,
      source_ref: `gplace:${pl.id}`,
      lat: pl.location?.latitude ?? null,
      lon: pl.location?.longitude ?? null,
      tags: { ...(pl.formattedAddress ? { address: pl.formattedAddress } : {}), ...(pl.primaryType ? { primary_type: pl.primaryType } : {}) },
      social,
      types: pl.types,
    });
  }
  return out;
}

/** Social-profile links found in OSM tags or on a website (the salesperson contacts these manually). */
export function socialLinksFromTags(tags: Record<string, string>): string[] {
  const keys = ["contact:facebook", "facebook", "contact:instagram", "instagram", "contact:tiktok", "contact:telegram", "contact:whatsapp"];
  const links: string[] = [];
  for (const k of keys) {
    const v = tags[k]?.trim();
    if (!v) continue;
    if (/^https?:\/\//i.test(v)) links.push(v);
    else if (k.includes("facebook")) links.push(`https://www.facebook.com/${v.replace(/^@/, "")}`);
    else if (k.includes("instagram")) links.push(`https://www.instagram.com/${v.replace(/^@/, "")}`);
  }
  return [...new Set(links)].slice(0, 5);
}

export function socialLinksFromHtml(html: string): string[] {
  const found = html.match(/https?:\/\/(?:www\.|m\.)?(?:facebook\.com|instagram\.com|tiktok\.com|t\.me|wa\.me)\/[A-Za-z0-9_.\-/?=]+/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[?#].*$/, "").replace(/\/$/, "")))]
    .filter((u) => !/\/(sharer|share|plugins|tr|dialog|login|intent)(\/|$)|\.php$/i.test(u))
    .slice(0, 5);
}
