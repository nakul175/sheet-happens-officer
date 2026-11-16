import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const deployWorkflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const sharedWorkflow = readFileSync(new URL("../.github/workflows/qualification.yml", import.meta.url), "utf8");
const releaseScript = readFileSync(new URL("../deploy/release.sh", import.meta.url), "utf8");

it("keeps return-path logging enabled in the Test and deploy server", () => {
  expect(deployWorkflow).toContain("uses: ./.github/workflows/qualification.yml");
  expect(sharedWorkflow).toContain("RETURN_PATH_LOG=1 NODE_ENV=production PORT=3100 node --import tsx server.js");
});

it("does not require the deploy user to read the machine-local job secret", () => {
  expect(releaseScript).toContain("[ ! -r /etc/sho/local.env ] || . /etc/sho/local.env");
});
