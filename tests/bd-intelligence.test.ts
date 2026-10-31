import { describe, expect, it } from "vitest";
import { bdSnapshot, dealBuckets, isHppStage, isShortlistedStage, totalUsd, usd, type BdDeal } from "@/lib/bd-intelligence";
const deal = (id: string, extra: Partial<BdDeal> = {}): BdDeal => ({ id, name: id, stage: { name: "Preparing", category: "ACTIVE" }, budgetUsd: 100.01, probability: 50, netFeeRevenueUsd: 40, pwinAdjustedNfrUsd: 17.23, ...extra });
const filter = { field: "stageChangedAt" as const, start: "", end: "", undated: "include" as const };
describe("SHO-3138 current-stage BD reporting", () => {
  it("classifies actual named stages, without inventing HPP from probability", () => {
    expect(dealBuckets(deal("a", { probability: 100 }))).toEqual(["wip"]);
    expect(dealBuckets(deal("a", { stage: { name: "Under Evaluation", category: "ACTIVE" } }))).toEqual(["evaluation"]);
    expect(dealBuckets(deal("a", { stage: { name: "High-priority pursuits", category: "ACTIVE" } }))).toEqual(["hpp", "evaluation"]);
    expect(dealBuckets(deal("a", { stage: { name: "Shortlisted", category: "ACTIVE" } }))).toEqual(["shortlisted", "evaluation"]);
    expect(isHppStage("HPP")).toBe(true); expect(isHppStage("High-priority pursuits")).toBe(true);
    expect(isShortlistedStage("Not started")).toBe(false);
  });
  it("separates current submitted EOI/CV from other submitted opportunities", () => {
    const d = deal("a", { stage: { name: "Submitted", category: "ACTIVE" } });
    expect(dealBuckets(d)).toEqual(["submissions", "evaluation"]);
    for (const opportunityType of ["EOI", "CV_LTA"] as const) expect(dealBuckets({ ...d, opportunityType })).toEqual(["eoicv", "evaluation"]);
  });
  it("keeps outcome/delivery/archived/deleted states out of open-pursuit counts", () => {
    expect(dealBuckets(deal("w", { stage: { name: "Won", category: "DONE" } }))).toEqual(["wins"]);
    expect(dealBuckets(deal("l", { stage: { name: "Lost", category: "LOST" } }))).toEqual(["losses"]);
    for (const d of [deal("a", { archived: true }), deal("a", { deletedAt: "2026-10-01" }), deal("a", { stage: null }), deal("a", { stage: { name: "Delivery", category: "DELIVERY" } })]) expect(dealBuckets(d)).toEqual([]);
  });
  it("filters all buckets by the chosen period/date, preserving explicit undated policy", () => {
    const all = [deal("before", { stageChangedAt: "2026-09-30" }), deal("in", { stageChangedAt: "2026-10-01T18:30:00Z" }), deal("end", { stageChangedAt: "2026-10-31" }), deal("after", { stageChangedAt: "2026-11-01" }), deal("unknown")];
    const f = { ...filter, start: "2026-10-02", end: "2026-10-31", undated: "exclude" as const };
    expect(bdSnapshot(all, f).buckets.wip.map(d => d.id)).toEqual(["in", "end"]);
    expect(bdSnapshot(all, { ...f, undated: "include" }).buckets.wip.map(d => d.id)).toEqual(["in", "end", "unknown"]);
    expect(bdSnapshot(all, { ...f, undated: "only" }).buckets.wip.map(d => d.id)).toEqual(["unknown"]);
    expect(bdSnapshot(all, { ...f, start: "2026-11-01" }).selected).toEqual([]);
    expect(bdSnapshot([deal("x", { expectedClose: "2026-10-09" })], { ...f, field: "expectedClose" }).selected).toHaveLength(1);
  });
  it("uses USD field inputs, entered adjusted NFR and exact cent-rounded weighted budgets", () => {
    const d = deal("a");
    expect(usd(totalUsd([d], "budgetUsd").cents)).toBe("USD 100.01");
    expect(usd(totalUsd([d], "budgetUsd", true).cents)).toBe("USD 50.01");
    expect(usd(totalUsd([d], "pwinAdjustedNfrUsd").cents)).toBe("USD 17.23");
    expect(usd(totalUsd([deal("z", { budgetUsd: 0, probability: 0 })], "budgetUsd", true).cents)).toBe("USD 0.00");
  });
  it("never turns unknown values into zero; partial totals retain coverage", () => {
    expect(totalUsd([], "budgetUsd")).toEqual({ cents: null, known: 0, total: 0 });
    expect(usd(undefined)).toBe("NA");
    expect(totalUsd([deal("a", { budgetUsd: null }), deal("b", { budgetUsd: 0 })], "budgetUsd")).toEqual({ cents: BigInt(0), known: 1, total: 2 });
    expect(totalUsd([deal("a", { probability: null })], "budgetUsd", true).cents).toBe(null);
  });
  it("sums large valid deal amounts without losing cents at the aggregate safe-integer boundary", () => {
    const deals = Array.from({ length: 20 }, (_, i) => deal(String(i), { budgetUsd: 9999999999999.99, probability: 100 }));
    expect(usd(totalUsd(deals, "budgetUsd").cents)).toBe("USD 199,999,999,999,999.80");
    expect(usd(totalUsd(deals, "budgetUsd", true).cents)).toBe("USD 199,999,999,999,999.80");
  });
});
