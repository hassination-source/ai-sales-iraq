import { describe, expect, it } from "vitest";
import { matchGovernorate, normalizeArabic, normalizeCompanyName, normalizeIraqiPhone, normalizeWebsite, parseCsv, prepareImport } from "../index";

describe("csv", () => {
  it("handles BOM, quotes, embedded commas/newlines, CRLF and Arabic", () => {
    const rows = parseCsv('﻿اسم الشركة,المحافظة\r\n"مصنع ""النور"", فرع 2",بغداد\r\n"Line\nBreak Co",Basra\r\n');
    expect(rows).toEqual([
      ["اسم الشركة", "المحافظة"],
      ['مصنع "النور", فرع 2', "بغداد"],
      ["Line\nBreak Co", "Basra"],
    ]);
  });
  it("detects semicolon delimiters", () => {
    expect(parseCsv("name;city\nA;B")).toEqual([["name", "city"], ["A", "B"]]);
  });
});

describe("normalization", () => {
  it("normalizes Arabic variants", () => {
    expect(normalizeArabic("الْبَصْرَة")).toBe(normalizeArabic("البصره"));
    expect(normalizeArabic("أربيل")).toBe("اربيل");
    expect(normalizeArabic("٠٧٧٠")).toBe("0770");
  });
  it("strips legal-form noise from company names", () => {
    expect(normalizeCompanyName("شركة الرافدين")).toBe(normalizeCompanyName("الرافدين"));
    expect(normalizeCompanyName("Rafidain Co. Ltd")).toBe(normalizeCompanyName("rafidain"));
    expect(normalizeCompanyName("شركة")).toBe("شركه"); // never empty
  });
  it("maps governorates from Arabic, English and city aliases, never guessing", () => {
    expect(matchGovernorate("محافظة البصرة")).toBe("IQ-BA");
    expect(matchGovernorate("Erbil")).toBe("IQ-AR");
    expect(matchGovernorate("Hawler")).toBe("IQ-AR");
    expect(matchGovernorate("الموصل")).toBe("IQ-NI");
    expect(matchGovernorate("Atlantis")).toBeNull();
  });
  it("normalizes Iraqi phone numbers to E.164", () => {
    expect(normalizeIraqiPhone("0770 123 4567")).toBe("+9647701234567");
    expect(normalizeIraqiPhone("+964 770 123 4567")).toBe("+9647701234567");
    expect(normalizeIraqiPhone("00964-750-1234567")).toBe("+9647501234567");
    expect(normalizeIraqiPhone("٠٧٨١٢٣٤٥٦٧٨")).toBe("+9647812345678");
    expect(normalizeIraqiPhone("12345")).toBeNull();
    expect(normalizeIraqiPhone("+46 70 123 45 67")).toBeNull();
  });
  it("normalizes websites", () => {
    expect(normalizeWebsite("www.Example.iq/about")).toBe("https://example.iq");
    expect(normalizeWebsite("not a site")).toBeNull();
    expect(normalizeWebsite("https://www.facebook.com/alnoor.hotel")).toBeNull();
    expect(normalizeWebsite("owner@gmail.com")).toBeNull();
    expect(normalizeWebsite("https://alnoor.iq/contact")).toBe("https://alnoor.iq");
  });
});

describe("prepareImport", () => {
  const csv = [
    "Company Name,Governorate,Phone,Website,Email",
    "مصنع الرافدين,بغداد,07701234567,rafidain.iq,info@rafidain.iq",
    "شركة الرافدين للصناعات,Baghdad,,,",
    "Basra Hotel,البصرة,0780 111 2222,,bad-email",
    "Duplicate Phone,Basra,+9647801112222,,",
    ",Baghdad,,,",
    "Old Customer,Erbil,,oldcustomer.com,",
    "Unknown Place,Atlantis,999,,",
  ].join("\n");

  const r = prepareImport(parseCsv(csv), [
    { id: "existing-1", name_normalized: "x", governorate: null, phone: null, website: "https://oldcustomer.com" },
  ]);

  it("detects columns and imports clean rows as unverified", () => {
    expect(r.columns).toMatchObject({ name: 0, governorate: 1, phone: 2, website: 3, email: 4 });
    const first = r.ready.find((l) => l.name === "مصنع الرافدين")!;
    expect(first).toMatchObject({ governorate: "IQ-BG", phone: "+9647701234567", website: "https://rafidain.iq", verification_status: "unverified" });
  });

  it("flags duplicates within the file and against existing data", () => {
    const dupNames = r.duplicates.map((d) => d.lead.name);
    expect(dupNames).toContain("Duplicate Phone");
    expect(r.duplicates.find((d) => d.lead.name === "Old Customer")!.matches[0]).toMatchObject({ kind: "existing", ref: "existing-1", on: "website" });
  });

  it("reports errors and warnings instead of inventing data", () => {
    expect(r.errors).toEqual([{ row: 6, message: "missing company name" }]);
    const hotel = r.ready.find((l) => l.name === "Basra Hotel")!;
    expect(hotel.email).toBeNull();
    expect(hotel.warnings[0]).toMatch(/email/);
    const unknown = r.ready.find((l) => l.name === "Unknown Place")!;
    expect(unknown.governorate).toBeNull();
    expect(unknown.phone).toBeNull();
    expect(unknown.warnings).toHaveLength(2);
  });

  it("fails clearly without a name column", () => {
    expect(prepareImport([["foo", "bar"], ["1", "2"]]).errors[0]!.message).toMatch(/no company name column/);
  });
});
