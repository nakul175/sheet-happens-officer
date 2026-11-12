import { expect, it } from "vitest";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

it("permits disposable sho_test with a local app only", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(() => assertLocalFixture(`postgresql://synthetic@${host}/sho_test?schema=public`, `http://${host}:3100`)).not.toThrow();
  }
});
for (const database of [undefined, "invalid", "postgresql://synthetic@remote.invalid/sho_test", "postgresql://synthetic@localhost/defaultdb", "postgresql://synthetic@localhost/sho_staging", "postgresql://synthetic@localhost/sho_test?schema=sho_pr9", "postgresql://synthetic@localhost/sho_test?host=remote.invalid", "postgresql://synthetic@localhost/sho_test?schema=public&schema=sho_pr9", "https://localhost/sho_test"]) {
  it(`refuses unsafe database case ${database === undefined ? "missing" : String(database).split("@").at(-1)}`, () => {
    expect(() => assertLocalFixture(database)).toThrow("DISPOSABLE_LOCAL_SHO_TEST_REQUIRED");
  });
}
it("refuses a remote app or URL credentials even with a safe database", () => {
  for (const app of ["https://remote.invalid", "http://user:synthetic@localhost:3100", "file:///tmp/app", "invalid"]) {
    expect(() => assertLocalFixture("postgresql://synthetic@localhost/sho_test", app)).toThrow("DISPOSABLE_LOCAL_SHO_TEST_REQUIRED");
  }
});
