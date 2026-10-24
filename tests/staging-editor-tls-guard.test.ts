import { describe, expect, it, vi } from "vitest";
import { defaultConnect, productionRefusal, runStagingEditor } from "../scripts/staging-editor";
const base = "postgresql://fixture:unused@staging.invalid:25060/sho_staging?schema=sho_pr9";
const strict = "&sslmode=require&sslcert=%2Fprivate%2Fofficial-ca.crt&sslaccept=strict";
const env = (suffix: string) => ({ DATABASE_URL: base + suffix, SHO_STAGING_CONFIRM: "1", STAGING_WORKSPACE_ID: "fixture" });
describe("staging Editor strict CA transport guard", () => {
  it("constructs the real default Prisma client with strict transport without opening a connection", async () => {
    const client = defaultConnect(base + strict);
    expect(client).toBeDefined();
    await client.$disconnect();
  });
  it("allows an explicit Prisma strict CA transport without changing the guarded destination", () => {
    expect(productionRefusal(env(strict))).toBeNull();
  });
  for (const suffix of [
    "&sslcert=%2Fprivate%2Fca.crt", "&sslaccept=strict", strict.replace("strict", "accept_invalid_certs"),
    strict.replace("require", "disable"), strict.replace("%2Fprivate%2Fofficial-ca.crt", "relative.crt"),
    strict.replace("%2Fprivate%2Fofficial-ca.crt", "%2Fprivate%2F..%2Fca.crt"),
    strict + "&sslaccept=strict", strict + "&host=production.invalid", strict + "&sslrootcert=%2Fx",
  ]) it(`refuses unsafe or ambiguous CA transport before connect: ${suffix}`, async () => {
    const connect = vi.fn(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(await runStagingEditor(env(suffix), [], connect)).toBe(1); expect(connect).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it("still refuses non-staging database and unsafe DIRECT_DATABASE_URL", () => {
    expect(productionRefusal({ ...env(strict), DATABASE_URL: (base + strict).replace("/sho_staging?", "/SHO_STAGING?") })).not.toBeNull();
    expect(productionRefusal({ ...env(strict), DIRECT_DATABASE_URL: base + "&sslaccept=accept_invalid_certs" })).not.toBeNull();
  });
});
