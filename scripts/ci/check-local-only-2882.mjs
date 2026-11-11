// Collection only: no browser, signup, verification or network operation.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const workflow = readFileSync(".github/workflows/staging-e2e.yml", "utf8");
const commands = workflow.split("\n").filter(line => /^\s+npx playwright test /.test(line));
if (commands.length !== 2 || commands.some(line => !line.includes('--grep-invert "@static|@manual|@local-only"'))) throw new Error("Both staging runners must exclude @local-only by tag");
function collect(args) {
  const run = spawnSync("npx", ["playwright", "test", ...args, "--list", "--reporter=json"], { encoding: "utf8", timeout: 60000, env: { ...process.env, BASE_URL: "http://localhost:3100", TASKBOARD_URL: "http://localhost:3100", SHO_E2E_START_BASE_URL: "http://localhost:3100" } });
  if (run.error || run.signal || run.status !== 0) throw new Error("Playwright collection failed; this is not an empty-selection pass");
  const report = JSON.parse(run.stdout);
  if (report.errors?.length) throw new Error("Playwright collection reported errors");
  const specs = [];
  const walk = suite => { specs.push(...(suite.specs ?? [])); for (const child of suite.suites ?? []) walk(child); };
  for (const suite of report.suites ?? []) walk(suite);
  return specs;
}
const local = collect(["tests/e2e/stories/APL-2609.spec.ts"]);
if (local.length !== 4) throw new Error("Local APL-2609 collection must retain all four cases");
const stage = collect(["--grep-invert", "@static|@manual|@local-only"]);
if (stage.length === 0 || stage.some(spec => spec.file.endsWith("APL-2609.spec.ts") || (spec.tags ?? []).includes("@local-only"))) throw new Error("Staging selection retained a local-only case or dropped all coverage");
console.log(`SHO-2882: four local-only cases retained locally; ${stage.length} staging cases collected without local-only cases`);
