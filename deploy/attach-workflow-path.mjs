// Add workflow_run.path to each artifact by reading the GitHub Actions run.
// The path is a workflow file name, not a secret. The artifact JSON is not printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("GITHUB_REPOSITORY is missing");
  process.exit(1);
}
const data = JSON.parse(readFileSync(0, "utf8"));
const cache = new Map();
for (const artifact of data.artifacts || []) {
  const run = artifact.workflow_run;
  if (!run || run.path || !run.id) continue;
  if (!cache.has(run.id)) {
    const path = execFileSync(
      "gh",
      ["api", `/repos/${repo}/actions/runs/${run.id}`, "--jq", ".path"],
      { encoding: "utf8" },
    ).trim();
    cache.set(run.id, path);
  }
  run.path = cache.get(run.id);
}
process.stdout.write(JSON.stringify(data));
