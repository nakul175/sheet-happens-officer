import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const spec = readFileSync(new URL("./crm-visible-modes-server.test.ts", import.meta.url), "utf8");
const helper = readFileSync(new URL("./crm-mode-seed-api.ts", import.meta.url), "utf8");

describe("SHO-2753 CRM mode fixture API", () => {
  it("keeps direct database mutations out of the mode spec", () => {
    expect(spec).not.toMatch(/\bdb\.[\w]+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(spec).toContain('from "./crm-mode-seed-api"');
  });

  it("keeps local, loopback, token and ZZ-TEST guards beside the fixture writes", () => {
    expect(helper).toContain("Refusing CRM fixture writes outside the local test database");
    expect(helper).toContain('req.socket.remoteAddress');
    expect(helper).toContain('authorization !== `Bearer ${token}`');
    expect(helper).toContain("Refusing non-ZZ-TEST people");
    expect(helper).toContain("Refusing non-ZZ-TEST projects");
  });
});
