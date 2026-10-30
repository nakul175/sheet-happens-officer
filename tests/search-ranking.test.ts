import { describe, expect, it } from "vitest";
import { searchExcerpt, searchTerms } from "@/lib/search-ranking";

describe("SHO-2587 search input and excerpts", () => {
  it("bounds and deduplicates Unicode words without treating punctuation as SQL", () => {
    expect(searchTerms("Bihar BIHAR livelihoods; ' OR 1=1 -- bid")).toEqual(["bihar", "livelihoods", "or", "bid"]);
    expect(searchTerms("बिहार budget")).toEqual(["बिहार", "budget"]);
    expect(searchTerms(Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "))).toHaveLength(12);
  });
  it("returns a bounded plain-text excerpt around a matched term", () => {
    const result = searchExcerpt("before ".repeat(40) + "budget <script>alert(1)</script>\nrevised " + "after ".repeat(70), ["budget"]);
    expect(result).toContain("budget");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("\n");
    expect(result.length).toBeLessThanOrEqual(222);
    expect(result.startsWith("…")).toBe(true);
  });
  it("centres plural and typo queries on the actual word in a long record", () => {
    for (const query of ["budgets", "budegt", "budgeet"]) {
      const result = searchExcerpt("unrelated ".repeat(80) + "budget approved " + "later ".repeat(80), [query]);
      expect(result).toContain("budget approved");
      expect(result.length).toBeLessThanOrEqual(222);
    }
  });
});
