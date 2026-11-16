import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SCREENS, type Ids } from "./screens";

const ids: Ids = {
  project: "fixture-project", task: "fixture-task", deal: "fixture-deal",
  org: "fixture-org", person: "fixture-person", personName: "Fixture Person",
};

function pageRoutes(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return pageRoutes(join(root, entry.name), `${prefix}/${entry.name}`);
    return entry.name === "page.tsx" ? [prefix || "/"] : [];
  });
}

function normalize(path: string): string {
  const pathname = new URL(path, "http://localhost").pathname;
  return pathname.replace(/\/fixture-(?:project|task|deal|org|person)(?=\/|$)/g, "/[id]");
}

describe("viewport and axe screen catalogue", () => {
  it("maps every authenticated and public page route to a loaded browser screen", () => {
    const appRoot = join(process.cwd(), "src/app");
    const appRoutes = pageRoutes(join(appRoot, "(app)"));
    const publicRoutes = readdirSync(appRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "(app)")
      .flatMap((entry) => pageRoutes(join(appRoot, entry.name), `/${entry.name}`));
    const checked = new Set(SCREENS.map((screen) => normalize(screen.path(ids))));
    const missing = [...appRoutes, ...publicRoutes].filter((route) => !checked.has(route));
    expect(missing, "every page needs a browser screen in tests/viewport/screens.ts").toEqual([]);
  });
});
