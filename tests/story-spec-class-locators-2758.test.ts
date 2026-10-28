// SHO-2758: the story specs find elements by CSS class (".bcard", ".chip", "aside.cc-slot").
// A class is a styling detail. Renaming it for a layout change breaks a spec that was asserting behaviour,
// and the class was never something a screen reader or a person could see. The converted specs below use the
// role, the label or the text the person actually perceives.
// The files that are still class-based are the inventory in the W351 report: a class with no accessible
// equivalent is a finding about the markup, not a locator to rewrite, so those stay until the markup changes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STORIES = fileURLToPath(new URL("./e2e/stories/", import.meta.url));

/** The quoted selector of every `locator("...")` in `source` that names a CSS class. */
function classSelectors(source: string): string[] {
  const found: string[] = [];
  for (const call of source.matchAll(/locator\(\s*(["'])([^"'`]*)\1/g)) {
    const selector = call[2];
    if (/\.[a-zA-Z][\w-]*/.test(selector)) found.push(selector);
  }
  return found;
}

const read = (file: string) => readFileSync(path.join(STORIES, file), "utf8");

describe("SHO-2758: story specs locate what the person perceives, not a CSS class", () => {
  // Pin both directions (the repo's usual shape for a scan): the detector must see a class selector, and it
  // must not see a role, label or attribute selector. Without this, a broken regex turns the checks below green.
  it("the detector sees a class selector and only a class selector", () => {
    expect(classSelectors('p.locator(".bcard", { hasText: t })')).toEqual([".bcard"]);
    expect(classSelectors('p.locator("aside.cc-slot").first()')).toEqual(["aside.cc-slot"]);
    expect(classSelectors('p.getByRole("link", { name: "a.b" })')).toEqual([]);
    expect(classSelectors('p.locator("tr", { hasText: zz("23.4 ac4") })')).toEqual([]);
    expect(classSelectors('p.locator("[data-label=\'Name\'] a")')).toEqual([]);
  });

  it("APL-2567 (inline editing) uses no CSS-class locator", () => {
    expect(classSelectors(read("APL-2567.spec.ts"))).toEqual([]);
  });

  it("APL-2574 (concierge discoverability) uses no CSS-class locator", () => {
    expect(classSelectors(read("APL-2574.spec.ts"))).toEqual([]);
  });

  // The base this packet sits on gained this poll (SHO-3025 AC4 at 5ad6fcf) and the file is otherwise still
  // class-based. A later pass that converts SHO-3025 must carry the poll across, so it is pinned here.
  it("SHO-3025 keeps the answerable(dialog) focus poll before Escape", () => {
    const spec = read("SHO-3025.spec.ts");
    const poll = /await answerable\(sheet\);\s*\n\s*await page\.keyboard\.press\("Escape"\)/;
    expect(spec).toMatch(poll);
    expect(spec).toMatch(/export async function answerable|async function answerable/);
  });
});
