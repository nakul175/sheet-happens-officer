import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dealCreate, dealDetailsEdit } from "@/lib/schemas";
import { dealClassificationFields } from "@/lib/deal-classification";
import { DealBdFacts, DealBdFields } from "@/components/DealBdFields";

describe("SHO-3139 USD commercial fields", () => {
  it("validates nullable fields on create and partial edits, preserving zero and cents", () => {
    const fields = { partner: "  Delivery Partner  ", athenaRole: "SUB", budgetUsd: 1000.25, pwinAdjustedNfrUsd: 0 };
    expect(dealDetailsEdit.parse(fields)).toMatchObject({ ...fields, partner: "Delivery Partner" });
    expect(dealCreate.parse({ ...fields, name: "Example", organisationId: "buyer", pipelineId: "pipeline", leaderId: "leader", whyPursue: "Fit", nextStep: { title: "Follow up", dueDate: "2026-12-01" } })).toMatchObject({ ...fields, partner: "Delivery Partner" });
    expect(dealClassificationFields.parse({})).toEqual({});
    expect(dealDetailsEdit.parse({ partner: " ", athenaRole: null, budgetUsd: null, pwinAdjustedNfrUsd: null })).toMatchObject({ partner: null, athenaRole: null, budgetUsd: null, pwinAdjustedNfrUsd: null });
  });

  it.each(["budgetUsd", "pwinAdjustedNfrUsd"])("rejects non-numeric, non-USD objects, invalid precision and out-of-range %s", (field) => {
    for (const value of ["100", "EUR 100", { amount: 100, currency: "EUR" }, NaN, Infinity, -0.01, 1.001, 10000000000000]) {
      expect(dealDetailsEdit.safeParse({ [field]: value }).success, `${field} ${String(value)}`).toBe(false);
    }
  });

  it("accepts only the three role codes and bounded partner text", () => {
    for (const athenaRole of ["PRIME", "SUB", "SOLO"]) expect(dealDetailsEdit.safeParse({ athenaRole }).success).toBe(true);
    for (const athenaRole of ["OTHER", "ADMIN", "prime"]) expect(dealDetailsEdit.safeParse({ athenaRole }).success).toBe(false);
    expect(dealDetailsEdit.safeParse({ partner: "x".repeat(201) }).success).toBe(false);
  });

  it("uses fixed-USD labels and gives legacy/null rows no invented amounts", () => {
    expect(renderToStaticMarkup(<DealBdFacts values={{}} />)).toBe("");
    const facts = renderToStaticMarkup(<DealBdFacts values={{ partner: "Partner & Co", athenaRole: "PRIME", budgetUsd: 0, pwinAdjustedNfrUsd: 250.25 }} />);
    expect(facts).toContain("Partner &amp; Co");
    expect(facts).toContain("Prime");
    expect(facts).toContain("USD 0.00");
    expect(facts).toContain("USD 250.25");
    expect(facts).not.toMatch(/EUR|INR/);
    const form = renderToStaticMarkup(<DealBdFields values={{ partner: "", athenaRole: "", budgetUsd: "", pwinAdjustedNfrUsd: "" }} onChange={() => {}} />);
    for (const label of ["Partner", "Athena role", "Budget (USD)", "PWin-adjusted NFR (USD)"]) expect(form).toContain(label);
  });
});
