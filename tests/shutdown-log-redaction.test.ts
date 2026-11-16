import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("shutdown disconnect failures do not print exception contents", async () => {
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "tests/shutdown-redaction-child.ts"], { timeout: 15_000 });
  expect(stdout).toContain("shutdown completed");
  expect(stderr).not.toContain("ZZ-TEST-PRIVATE-SHUTDOWN-MARKER");
});
