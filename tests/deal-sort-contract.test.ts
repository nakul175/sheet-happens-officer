import { describe, expect, it } from "vitest";
import { sortDeals, type BoardDeal, type BoardStage, type DealSort } from "@/components/DealBoard";

const stages = [
  { id: "first", name: "First", category: "ACTIVE" },
  { id: "second", name: "Second", category: "ACTIVE" },
] as BoardStage[];
const deal = (id: string, name: string, stageId: string, submissionDeadline: string | null) => ({
  id, name, stage: { id: stageId, name: stageId, category: "ACTIVE" }, submissionDeadline,
}) as BoardDeal;

describe("explicit deal sort contract", () => {
  const input = [
    deal("d", "delta", "second", null),
    deal("a", "Alpha", "second", null),
    deal("c", "Alpha", "first", "2026-11-01"),
    deal("b", "beta", "first", "2026-11-04"),
  ];
  const expected: Record<DealSort, string[]> = {
    "name-asc": ["a", "c", "b", "d"],
    "name-desc": ["d", "b", "a", "c"],
    stage: ["b", "c", "a", "d"],
    "date-asc": ["c", "b", "a", "d"],
    "date-desc": ["b", "c", "a", "d"],
  };

  it.each(Object.entries(expected) as [DealSort, string[]][])("sorts %s with stable ID ties and null dates last", (sort, order) => {
    const original = input.map((item) => item.id);
    const result = sortDeals(input, sort, stages).map((item) => item.id);
    expect(result).toEqual(order);
    expect(result.slice().sort()).toEqual(original.slice().sort());
    expect(input.map((item) => item.id)).toEqual(original);
  });
});
