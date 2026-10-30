import { describe, expect, it } from "vitest";
import { detectColumns, readXlsxParts, sharedStringsOf } from "../index";

describe("xlsx reader", () => {
  it("reads a sheet written with a namespace prefix, empty typed cells and gaps", () => {
    // what some exporters (e.g. .NET Open XML SDK) produce
    const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
      <x:row r="1"><x:c r="A1" s="2" /><x:c r="B1" t="str" /></x:row>
      <x:row r="3"><x:c r="A3" t="str"><x:v>ID</x:v></x:c><x:c r="C3" t="str"><x:v>Företag</x:v></x:c></x:row>
      <x:row r="4"><x:c r="A4" t="n"><x:v>1001</x:v></x:c><x:c r="B4" t="str"/><x:c r="C4" t="inlineStr"><x:is><x:t>Al &amp; Co</x:t></x:is></x:c></x:row>
    </x:sheetData></x:worksheet>`;
    const rows = readXlsxParts({ sheets: { "xl/worksheets/sheet1.xml": sheet } });
    expect(rows).toEqual([["", ""], [], ["ID", "", "Företag"], ["1001", "", "Al & Co"]]);
  });

  it("resolves shared strings (with rich-text runs) and picks the first sheet in workbook order", () => {
    const shared = `<sst><si><t>Hotell</t></si><si><r><t>Baghdad </t></r><r><t xml:space="preserve">Hotel</t></r></si><si/></sst>`;
    expect(sharedStringsOf(shared)).toEqual(["Hotell", "Baghdad Hotel", ""]);
    const parts = {
      workbook: `<workbook><sheets><sheet name="Leads" sheetId="2" r:id="rId7"/><sheet name="Old" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      workbookRels: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>`,
      sharedStrings: shared,
      sheets: {
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>`,
        "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
      },
    };
    expect(readXlsxParts(parts)).toEqual([["Hotell", "Baghdad Hotel", "TRUE"]]);
  });

  it("recognises a known column name followed by a qualifier, without stealing exact matches", () => {
    const cols = detectColumns(["ID", "Bransch (katalog)", "Företag", "E-post", "Telefon", "Källsida (PDF)", "Arabiskt namn"]);
    expect(cols).toMatchObject({ industry: 1, name: 2, email: 3, phone: 4, name_alt: 6 });
    expect(cols.source_url).toBeUndefined();
  });
});
