import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const spec = readFileSync(new URL("./jobs-stalled-crm.test.ts", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./stalled-crm-fixture.ts", import.meta.url), "utf8");

describe("SHO-2903 stalled-CRM post-release contracts", () => {
  it("attributes duplicate-notice detection to the all and admins cases only", () => {
    expect(spec).toContain("all detects duplicate-notice regressions");
    expect(spec).toContain("admins detects duplicate-notice regressions");
    expect(spec).toContain("unset preserves today's visibility without claiming independent mutation detection");
  });

  it("compares the exact second-run world set instead of a cancelling before/after count", () => {
    expect(spec).toContain("expect(await worldStalledRows()).toEqual(before)");
    expect(spec).not.toMatch(/\(await worldStalledRows\(\)\)\s*-\s*before/);
  });

  it("scopes first-run assertions and deal needles to one shared world-deal definition", () => {
    expect(spec).toContain('expect(worldRowPairs(await worldStalledRows())).toEqual(expectedWorldRowPairs("all"))');
    expect(spec).toContain('expect(worldRowPairs(await worldStalledRows())).toEqual(expectedWorldRowPairs("admins"))');
    expect(fixture).toContain("export const worldDeals");
    expect(fixture).toContain("worldDeals(world).map");
    expect(fixture).toContain("for (const deal of worldDeals(world))");
  });
});
