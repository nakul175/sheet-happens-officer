import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = ["staging-e2e.yml", "staging-regression.yml"];

describe("staging artifact credential boundary", () => {
  it.each(workflows)("%s cannot enable credential-bearing Playwright traces", (name) => {
    const source = readFileSync(`.github/workflows/${name}`, "utf8");
    expect(source).not.toMatch(/retain-on-failure|inputs\.trace/);
    expect(source).toMatch(/TRACE: "off"/);
    expect(source).toMatch(/--trace="\$TRACE"/);
  });
});
