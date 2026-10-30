import { describe, expect, it } from "vitest";
import { findHeaderRow, matchSegment, prepareImport, solarEnergyPack, splitMulti } from "../index";

// shape of a real exported list: title block, Swedish headers, several phones/emails per cell, no governorate
const rows = [
  ["", "", ""],
  ["Företagskontakter i Bagdad"],
  ["1 000 kontaktposter | 777 med mejladress"],
  [],
  ["ID", "Kategori", "Företag", "E-post", "Telefon", "Adress / verksamhet", "Källa (URL)", "Arabiskt namn"],
  ["1", "Hotell", "Baghdad Hotel", "info@baghdad-hotel.com", "+9647708822151; +9647857190093", "Allmän kontakt", "https://www.baghdad-hotel.com/contact.html", ""],
  ["2", "El och solenergi", "Noor Solar", "Noor@Yahoo.com; sales@noor.iq", "+9647700000001", "Baghdad- Karada", "javascript:alert(1)", "النور للطاقة"],
  ["3", "Datorer och service", "PC House", "", "+96418858342", "", "", ""],
  ["", "", "", "", "", "", "", ""],
];

describe("importing an Excel company list", () => {
  it("finds the header below a title block and reads Swedish columns", () => {
    expect(findHeaderRow(rows)).toBe(4);
    const r = prepareImport(rows, [], undefined, { defaultGovernorate: "IQ-BG" });
    expect(r.errors).toEqual([]);
    expect(r.ready.map((l) => [l.row, l.name, l.governorate])).toEqual([[6, "Baghdad Hotel", "IQ-BG"], [7, "Noor Solar", "IQ-BG"], [8, "PC House", "IQ-BG"]]);
    const [hotel, noor, pc] = r.ready;
    expect(hotel).toMatchObject({ industry: "Hotell", email: "info@baghdad-hotel.com", phone: "+9647708822151", extra_phones: ["+9647857190093"], source_url: "https://www.baghdad-hotel.com/contact.html", description: "Allmän kontakt" });
    expect(noor).toMatchObject({ email: "noor@yahoo.com", extra_emails: ["sales@noor.iq"], name_alt: "النور للطاقة", source_url: null });
    expect(pc).toMatchObject({ phone: "+96418858342", email: null });
  });

  it("splits multi-value cells and maps categories to solar segments by word start", () => {
    expect(splitMulti("a@x.iq; b@y.iq , c@z.iq")).toEqual(["a@x.iq", "b@y.iq", "c@z.iq"]);
    expect(splitMulti("+964770 / +964780")).toEqual(["+964770", "+964780"]);
    const seg = (c: string) => matchSegment(solarEnergyPack.segments, c);
    expect(seg("Hotell")).toBe("hotel");
    expect(seg("El och solenergi")).toBe("channel_partner");
    expect(seg("El- och hushållsapparater")).toBe("channel_partner");
    expect(seg("Generatorer")).toBe("channel_partner");
    expect(seg("Elmaterial")).toBe("channel_partner");
    expect(seg("Industri")).toBe("factory");
    expect(seg("Restaurang")).toBe("retail");
    expect(seg("Fastighet och bostad")).toBe("real_estate");
    expect(seg("Datorer och service")).toBeNull();
    expect(seg("فندق بابل")).toBe("hotel");
  });

  it("files without a governorate column stay unknown unless a default is given", () => {
    expect(prepareImport(rows).ready[0]!.governorate).toBeNull();
  });
});

describe("no company twice", () => {
  it("flags the same email address in the file or among existing leads", () => {
    const rows = [["Företag", "E-post"], ["A Co", "info@a.iq"], ["Noor Trading", "INFO@a.iq"], ["B Co", "b@b.iq"]];
    const r = prepareImport(rows, [{ id: "x", name_normalized: "zzz", governorate: null, phone: null, website: null, email: "b@b.iq" }]);
    expect(r.ready.map((l) => l.name)).toEqual(["A Co"]);
    expect(r.duplicates.map((d) => [d.lead.name, d.matches[0]!.kind, d.matches[0]!.on])).toEqual([["Noor Trading", "file", "email"], ["B Co", "existing", "email"]]);
  });
});
