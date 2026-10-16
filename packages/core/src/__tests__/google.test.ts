import { describe, expect, it } from "vitest";
import { buildPlacesQuery, parsePlaces, socialLinksFromHtml, socialLinksFromTags, solarEnergyPack } from "../index";

describe("Google Places source", () => {
  it("builds an Arabic, Iraq-scoped text search from the pack's search terms", () => {
    const term = solarEnergyPack.segments.find((s) => s.key === "hotel")!.discovery.searchTerms[0]!;
    expect(buildPlacesQuery(term, "IQ-BA")).toEqual({ textQuery: "فندق في البصرة", languageCode: "ar", regionCode: "IQ", pageSize: 20 });
    expect(buildPlacesQuery(term, "IQ-BA", "tok")).toMatchObject({ pageToken: "tok" });
    expect(() => buildPlacesQuery(term, "IQ-XX")).toThrow();
  });

  it("every solar and auto-parts segment has at least one search term", async () => {
    const { PACKS } = await import("../index");
    for (const p of Object.values(PACKS)) for (const s of p.segments) expect(s.discovery.searchTerms.length, `${p.id}/${s.key}`).toBeGreaterThan(0);
  });

  it("parses places: keeps operating businesses in the right governorate, splits social links from websites", () => {
    const json = {
      nextPageToken: "next",
      places: [
        { id: "A1", displayName: { text: "فندق المنصور ميليا" }, formattedAddress: "شارع حيفا، بغداد، العراق", internationalPhoneNumber: "+964 770 123 4567", websiteUri: "https://www.mansourmelia.com/ar", googleMapsUri: "https://maps.google.com/?cid=1", types: ["lodging", "hotel"], primaryType: "hotel", businessStatus: "OPERATIONAL", location: { latitude: 33.3, longitude: 44.4 } },
        { id: "A2", displayName: { text: "فندق الزهراء" }, formattedAddress: "الكرادة، بغداد", websiteUri: "https://www.facebook.com/alzahraa.hotel", businessStatus: "OPERATIONAL", primaryType: "hotel" },
        { id: "A3", displayName: { text: "فندق مغلق" }, formattedAddress: "بغداد", businessStatus: "CLOSED_PERMANENTLY" },
        { id: "A4", displayName: { text: "فندق في البصرة" }, formattedAddress: "العشار، البصرة، العراق", businessStatus: "OPERATIONAL" },
        { id: "A5", displayName: { text: "منزل الحاج علي" }, formattedAddress: "بغداد" },
        { nope: true },
      ],
    };
    const page = parsePlaces(json, "IQ-BG");
    expect(page.nextPageToken).toBe("next");
    expect(page.companies.map((c) => c.name)).toEqual(["فندق المنصور ميليا", "فندق الزهراء"]);
    expect(page.companies[0]).toMatchObject({ source_ref: "gplace:A1", source_url: "https://maps.google.com/?cid=1", phone: "+9647701234567", website: "https://mansourmelia.com", governorate: "IQ-BG", lat: 33.3 });
    expect(page.companies[1]).toMatchObject({ website: null, social: ["https://www.facebook.com/alzahraa.hotel"] });
    expect(page.skipped).toEqual({ closed: 1, otherGovernorate: 1, private: 1 });
    expect(parsePlaces({ error: "x" }, "IQ-BG").companies).toEqual([]);
  });

  it("collects social links from OSM tags and website HTML, ignoring share widgets", () => {
    expect(socialLinksFromTags({ "contact:facebook": "alnoor.hotel", instagram: "@alnoor", "contact:whatsapp": "https://wa.me/9647701234567" })).toEqual([
      "https://www.facebook.com/alnoor.hotel",
      "https://www.instagram.com/alnoor",
      "https://wa.me/9647701234567",
    ]);
    const html = `<a href="https://www.facebook.com/AlNoorPlastic/">fb</a> <a href="https://instagram.com/alnoor_iq?igsh=x">ig</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a> <a href="https://www.facebook.com/tr?id=1">pixel</a>`;
    expect(socialLinksFromHtml(html)).toEqual(["https://www.facebook.com/AlNoorPlastic", "https://instagram.com/alnoor_iq"]);
  });
});

describe("withSignature", () => {
  it("appends a trimmed signature after one blank line, and leaves the body alone without one", async () => {
    const { withSignature } = await import("../index");
    expect(withSignature("نص الرسالة\n\n", "  م. حسن\nwww.sigenergy.com  ")).toBe("نص الرسالة\n\nم. حسن\nwww.sigenergy.com");
    expect(withSignature("نص", null)).toBe("نص");
    expect(withSignature("نص", "   ")).toBe("نص");
  });
});
