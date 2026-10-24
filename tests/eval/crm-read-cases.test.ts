import { expect, it } from "vitest";
import { CRM_READ_CASES, CRM_READ_TOOLS, type CrmEvalWorld } from "./crm-read-cases";
it("contains exactly3 distinct synthetic read/privacy requests for each CRM tool", () => {
 expect(CRM_READ_CASES).toHaveLength(18);
 expect(new Set(CRM_READ_CASES.map(c => c.id)).size).toBe(18);
 for (const name of CRM_READ_TOOLS) expect(CRM_READ_CASES.filter(c => c.tool === name)).toHaveLength(3);
 const w: CrmEvalWorld = { deal: { id: "d", name: "Harbor renewal" }, otherDeal: { id: "d2", name: "Dock expansion" }, hiddenDeal: { id: "hidden" }, org: { id: "o", name: "Northwind Trading" }, parent: { id: "p", name: "Northwind Group" }, child: { id: "c", name: "Harbor Office" }, foreignOrg: { id: "f" }, contacts: [{ name: "Mira Patel", email: "mira@example.invalid" }, { name: "Kai Mensah", email: "kai@example.invalid" }] };
 for (const c of CRM_READ_CASES) { expect(c.prompt(w).length).toBeGreaterThan(20); expect(c.expected(w).forbidText).toEqual(expect.arrayContaining(["HIDDEN-NOTE-PRIVATE"])); }
 expect(CRM_READ_CASES.filter(c => c.intent === "privacy")).toHaveLength(4);
 expect(CRM_READ_CASES.some(c => c.intent === "injection")).toBe(true);
});
