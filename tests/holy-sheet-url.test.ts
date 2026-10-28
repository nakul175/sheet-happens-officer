import { describe, expect, it } from "vitest";
import { holySheetDocumentId, holySheetOrigin } from "../src/lib/holy-sheet-url";
const origin = "https://staging.holysheet.aplyd.org";
const productionOrigin = "https://holysheet.aplyd.org";
const id = "12345678-1234-1234-1234-123456789abc";
describe("Holy Sheet launcher URL boundary", () => {
  it("requires explicit qualification flag and approved origin", () => {
    expect(holySheetOrigin({})).toBeNull();
    expect(holySheetOrigin({FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: origin})).toBe(origin);
    expect(holySheetOrigin({FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: productionOrigin})).toBe(productionOrigin);
    expect(holySheetOrigin({FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: "https://evil.test"})).toBeNull();
  });
  it("accepts only a page UUID at the approved origin", () => {
    expect(holySheetDocumentId(`${origin}/pages/${id}`, origin)).toBe(id);
    for (const value of [`https://evil.test/pages/${id}`, `${origin}/pages/${id}?token=secret`, `${origin}/pages/${id}#hs-user=other`, `${origin}/pages/private`, `javascript:alert(1)`, `https://user:pass@staging.holysheet.aplyd.org/pages/${id}`]) {
      expect(holySheetDocumentId(value, origin)).toBeNull();
    }
  });
});
