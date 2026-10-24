import { expect, it } from "vitest";
import { namedCrmLinks } from "./crm-read-grading";
it("requires deal, fetched Buyer and next-step links if those names appear", () => {
 const data = { deals: [{ id: "d", name: "Harbor renewal", organisation: { id: "o", name: "Northwind Trading" }, nextStep: { id: "t", title: "Send proposal" } }] };
 const links = namedCrmLinks([{ content: JSON.stringify({ untrusted_data: data }) }], "Harbor renewal — Northwind Trading — Send proposal");
 expect(links).toEqual([{ label: "Harbor renewal", href: "/projects/d" }, { label: "Northwind Trading", href: "/accounts/o" }, { label: "Send proposal", href: "/tasks/t" }]);
});
it("contact links go to the fetched Account, and unreturned IDs cannot be fabricated", () => {
 const data = { contacts: [{ id: "c", name: "Mira Patel", organisation: { id: "o", name: "Northwind Trading" } }] };
 expect(namedCrmLinks([{ content: { untrusted_data: data } }], "Mira Patel")).toEqual([{ label: "Mira Patel", href: "/accounts/o" }]);
 expect(namedCrmLinks([], "Mira Patel")).toEqual([]);
});
